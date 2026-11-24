import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx as auditarTx } from "@/lib/server/auditoria";
import { puedeCerrarSemana, puedeReabrirSemana } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";
import { asegurarFisicoYCapas } from "./estimacion-cliente";

type Cliente = Prisma.TransactionClient;

function requerirCerrar(usuario: UsuarioSesion): string {
  if (!puedeCerrarSemana(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

function requerirReabrir(usuario: UsuarioSesion): string {
  if (!puedeReabrirSemana(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// ---------------------------------------------------------------------------
// Candado para avance.ts — semana cerrada bloquea todo; un concepto que ya
// forma parte de un corte LIQUIDADO queda protegido aunque la semana esté
// abierta (reapertura parcial, sección "reconciliación" del diseño).
// ---------------------------------------------------------------------------

export async function verificarSemanaEditable(
  proyectoId: string,
  semanaId: string,
  conceptoIds: string[]
): Promise<void> {
  const cierre = await db.cierreSemanaProyecto.findUnique({
    where: { proyectoId_semanaId: { proyectoId, semanaId } },
  });
  if (cierre?.estatus === "CERRADA") {
    throw new ValidacionError(
      "Esta semana ya está cerrada. Reábrela antes de modificar el avance."
    );
  }

  if (conceptoIds.length === 0) return;

  // Congelado si ya está LIQUIDADO, o si ya tiene un recibo VIGENTE con
  // evidencia firmada — un recibo firmado es un compromiso real ya entregado
  // al contratista, aunque Reporte General todavía no lo marque Liquidado
  // (el flujo real es jueves firma, viernes se paga y ahí sí se liquida).
  const bloqueados = await db.corteSemanalConcepto.findMany({
    where: {
      conceptoId: { in: conceptoIds },
      corteSemanal: {
        semanaId,
        OR: [
          { movimientoSemanal: { estatusPago: "LIQUIDADO" } },
          {
            recibos: {
              some: { estatus: "VIGENTE", archivoEvidenciaRef: { not: null } },
            },
          },
        ],
      },
    },
    select: { descripcionConcepto: true },
  });
  if (bloqueados.length > 0) {
    const nombres = [...new Set(bloqueados.map((b) => b.descripcionConcepto))].join(", ");
    const plural = bloqueados.length === 1 ? "" : "n";
    throw new ValidacionError(
      `${nombres} ya forma${plural} parte de un corte liquidado o con recibo firmado, y no puede${plural} modificarse.`
    );
  }
}

// ---------------------------------------------------------------------------
// Resumen — lo usa tanto la tarjeta de "Avance de obra" como, dentro de la
// transacción de cerrarSemana, la revalidación de las reglas de bloqueo (así
// nunca hay desfase entre lo que se muestra y lo que en verdad se exige).
// ---------------------------------------------------------------------------

type LineaAvanceParaCierre = {
  conceptoId: string;
  descripcionConcepto: string;
  unidad: string;
  avanceConceptoId: string;
  cantidadEjecutada: number;
  // Monto exacto capturado (AvanceConcepto.montoEjecutado) — cuando existe,
  // es el importe real de esta línea; nunca se recalcula desde
  // cantidadEjecutada, que solo guarda 3 decimales (ver importeLinea).
  montoEjecutado: number | null;
  contratoConceptoId: string | null;
  contratoContratistaId: string | null;
  beneficiarioProyectoId: string | null;
  precioUnitarioContratista: number | null;
};

// Importe real de una línea de avance — el monto exacto capturado si existe,
// o cantidad × P.U. como fallback (captura hecha por Cantidad directamente,
// o conceptos sin P.U. contratado). Única fórmula, reutilizada por el resumen
// y por la generación real del corte para que nunca puedan disentir entre sí.
function importeLinea(linea: LineaAvanceParaCierre): number {
  return linea.montoEjecutado ?? linea.cantidadEjecutada * (linea.precioUnitarioContratista ?? 0);
}

async function obtenerLineasAvanceAprobado(
  cliente: Cliente,
  proyectoId: string,
  semanaId: string
): Promise<LineaAvanceParaCierre[]> {
  const avances = await cliente.avanceConcepto.findMany({
    where: {
      semanaId,
      cantidadEjecutada: { gt: 0 },
      estatusAprobacion: "APROBADO",
      concepto: { partida: { proyectoId } },
    },
    select: {
      id: true,
      conceptoId: true,
      cantidadEjecutada: true,
      montoEjecutado: true,
      concepto: {
        select: {
          descripcion: true,
          unidad: true,
          // conceptoId es @unique en ContratoConcepto — a lo más una asignación.
          asignaciones: {
            select: {
              id: true,
              precioUnitarioContratista: true,
              contratoContratista: {
                select: { id: true, beneficiarioProyectoId: true },
              },
            },
          },
        },
      },
    },
  });

  return avances.map((a) => {
    const asignacion = a.concepto.asignaciones[0] ?? null;
    return {
      conceptoId: a.conceptoId,
      descripcionConcepto: a.concepto.descripcion,
      unidad: a.concepto.unidad,
      avanceConceptoId: a.id,
      cantidadEjecutada: Number(a.cantidadEjecutada),
      montoEjecutado: a.montoEjecutado !== null ? Number(a.montoEjecutado) : null,
      contratoConceptoId: asignacion?.id ?? null,
      contratoContratistaId: asignacion?.contratoContratista.id ?? null,
      beneficiarioProyectoId: asignacion?.contratoContratista.beneficiarioProyectoId ?? null,
      precioUnitarioContratista: asignacion ? Number(asignacion.precioUnitarioContratista) : null,
    };
  });
}

export type ResumenCierreSemana = {
  estatus: "NUNCA_CERRADA" | "ABIERTA" | "CERRADA";
  cerradoPorNombre: string | null;
  cerradoEn: string | null;
  reabiertoPorNombre: string | null;
  reabiertoEn: string | null;
  motivoReapertura: string | null;
  // Semana histórica migrada desde Excel — nunca se reabre ni se materializa.
  historicoImportado: boolean;
  conceptosConAvance: number;
  avancesAprobados: number;
  pendientesPorAprobar: number;
  contratistasInvolucrados: number;
  montoManoDeObraAprobado: number;
  conceptosSinContratista: { id: string; descripcion: string }[];
  puedeCerrar: boolean;
  cortes: {
    beneficiarioProyectoId: string;
    nombreContratista: string;
    montoNeto: number;
    estatus: "GENERADO" | "ANULADO";
  }[];
};

// Sin gate de rol propio: visible a los mismos 4 roles que ya ven Avance de
// obra (obtenerAvanceSemanal tampoco lo tiene) — quien no puede cerrar/
// reabrir de todas formas no verá los botones (eso sí lo decide el caller
// con puedeCerrarSemana/puedeReabrirSemana), pero sí necesita saber que la
// semana está cerrada para entender por qué el formulario está en solo
// lectura.
export async function obtenerResumenCierreSemana(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<ResumenCierreSemana> {
  await obtenerProyecto(usuario, proyectoId);

  const [cierre, conceptosConAvance, pendientes, lineas, cortes] = await Promise.all([
    db.cierreSemanaProyecto.findUnique({
      where: { proyectoId_semanaId: { proyectoId, semanaId } },
      include: {
        cerradoPor: { select: { nombre: true } },
        reabiertoPor: { select: { nombre: true } },
      },
    }),
    db.avanceConcepto.count({
      where: { semanaId, cantidadEjecutada: { gt: 0 }, concepto: { partida: { proyectoId } } },
    }),
    db.avanceConcepto.count({
      where: {
        semanaId,
        estatusAprobacion: "PENDIENTE",
        cantidadEjecutada: { gt: 0 },
        concepto: { partida: { proyectoId } },
      },
    }),
    obtenerLineasAvanceAprobado(db, proyectoId, semanaId),
    db.corteSemanal.findMany({
      where: { proyectoId, semanaId },
      include: { beneficiarioProyecto: { include: { beneficiario: { select: { nombre: true } } } } },
    }),
  ]);

  const conceptosSinContratistaMap = new Map<string, string>();
  const beneficiariosInvolucrados = new Set<string>();
  let montoManoDeObraAprobado = 0;

  for (const linea of lineas) {
    if (!linea.beneficiarioProyectoId || linea.precioUnitarioContratista === null) {
      conceptosSinContratistaMap.set(linea.conceptoId, linea.descripcionConcepto);
      continue;
    }
    beneficiariosInvolucrados.add(linea.beneficiarioProyectoId);
    montoManoDeObraAprobado += importeLinea(linea);
  }

  return {
    estatus: !cierre ? "NUNCA_CERRADA" : cierre.estatus,
    cerradoPorNombre: cierre?.cerradoPor.nombre ?? null,
    cerradoEn: cierre?.cerradoEn.toISOString() ?? null,
    reabiertoPorNombre: cierre?.reabiertoPor?.nombre ?? null,
    reabiertoEn: cierre?.reabiertoEn?.toISOString() ?? null,
    motivoReapertura: cierre?.motivoReapertura ?? null,
    historicoImportado: cierre?.historicoImportado ?? false,
    conceptosConAvance,
    avancesAprobados: lineas.length,
    pendientesPorAprobar: pendientes,
    contratistasInvolucrados: beneficiariosInvolucrados.size,
    montoManoDeObraAprobado,
    conceptosSinContratista: [...conceptosSinContratistaMap.entries()].map(([id, descripcion]) => ({
      id,
      descripcion,
    })),
    puedeCerrar: pendientes === 0 && conceptosSinContratistaMap.size === 0,
    cortes: cortes.map((c) => ({
      beneficiarioProyectoId: c.beneficiarioProyectoId,
      nombreContratista: c.beneficiarioProyecto.beneficiario.nombre,
      montoNeto: Number(c.montoNeto),
      estatus: c.estatus,
    })),
  };
}

// ---------------------------------------------------------------------------
// Cerrar semana — crea o reconcilia el corte de cada contratista, y su
// MovimientoSemanal, dentro de una sola transacción atómica.
// ---------------------------------------------------------------------------

// Auditoría pendiente — se acumula durante el loop de contratistas y se
// escribe en una sola sentencia INSERT al final (ver cerrarSemana), en vez de
// 2-3 INSERT por contratista. Un registro por entidad modificada, igual que
// antes — nunca uno global (Etapa C, auditoría de rendimiento, agosto 2026).
type AuditoriaPendiente = {
  entidad: string;
  entidadId: string;
  accion: "CREAR" | "EDITAR" | "CAMBIAR_ESTATUS";
  valorAnterior: Record<string, unknown> | null;
  valorNuevo: Record<string, unknown>;
};

type ResultadoCorte =
  | { tipo: "OMITIDO_LIQUIDADO"; auditorias: AuditoriaPendiente[] }
  | { tipo: "CREADO" | "RECONCILIADO" | "SIN_CAMBIOS"; montoNeto: number; auditorias: AuditoriaPendiente[] };

// Todos los cortes ya existentes de este proyecto+semana, con su movimiento,
// detalle anterior y recibo vigente — en UNA consulta (batch, decompuesta por
// Prisma en un puñado de queries por relación, nunca una por contratista),
// en vez de un findUnique con include por cada contratista dentro del loop.
async function precargarCortesExistentes(tx: Cliente, proyectoId: string, semanaId: string) {
  return tx.corteSemanal.findMany({
    where: { proyectoId, semanaId },
    include: {
      movimientoSemanal: true,
      detalle: true,
      recibos: { where: { estatus: "VIGENTE" } },
    },
  });
}

type CorteExistente = Awaited<ReturnType<typeof precargarCortesExistentes>>[number];

async function generarOReconciliarCorte(
  tx: Cliente,
  ctx: {
    empresaId: string;
    proyectoId: string;
    semanaId: string;
    cierreSemanaProyectoId: string;
    beneficiarioProyectoId: string;
    usuarioId: string;
  },
  lineas: LineaAvanceParaCierre[],
  existente: CorteExistente | null,
  numeroParaCrear: number
): Promise<ResultadoCorte> {
  const reciboVigente = existente?.recibos[0] ?? null;

  // Financieramente congelado — no se toca nada, ni siquiera el detalle. Un
  // recibo VIGENTE ya firmado cuenta igual que LIQUIDADO (ver
  // verificarSemanaEditable, mismo criterio).
  if (
    existente?.movimientoSemanal?.estatusPago === "LIQUIDADO" ||
    reciboVigente?.archivoEvidenciaRef
  ) {
    return { tipo: "OMITIDO_LIQUIDADO", auditorias: [] };
  }

  const montoBruto = lineas.reduce((t, l) => t + importeLinea(l), 0);
  const ajustes = existente ? Number(existente.ajustes) : 0;
  const montoNeto = montoBruto + ajustes;
  // > 0 vigente; = 0 (sin avance aprobado tras una reapertura) se anula, no
  // se borra — mismo criterio para su MovimientoSemanal (ver abajo).
  const nuevoEstatusCorte: "GENERADO" | "ANULADO" = montoNeto > 0 ? "GENERADO" : "ANULADO";

  // Un solo ContratoContratista involucrado → se anota en el movimiento
  // (mismo criterio "preparación, no implementado" que ya trae el schema);
  // más de uno → null, no se puede atribuir a uno solo.
  const contratosUnicos = new Set(
    lineas.map((l) => l.contratoContratistaId).filter((id): id is string => id !== null)
  );
  const contratoContratistaId = contratosUnicos.size === 1 ? [...contratosUnicos][0] : null;

  const datosDetalle = lineas.map((l) => ({
    conceptoId: l.conceptoId,
    contratoConceptoId: l.contratoConceptoId!,
    avanceConceptoId: l.avanceConceptoId,
    descripcionConcepto: l.descripcionConcepto,
    unidad: l.unidad,
    cantidadEjecutada: l.cantidadEjecutada,
    precioUnitarioContratista: l.precioUnitarioContratista ?? 0,
    importe: importeLinea(l),
  }));

  if (existente) {
    // ¿Cambió algo de verdad? — mismo criterio de "no auditar/escribir lo que
    // no cambió" ya usado al editar conceptos (estructura-contractual.ts).
    const anteriorOrdenado = [...existente.detalle].sort((a, b) =>
      a.conceptoId.localeCompare(b.conceptoId)
    );
    const nuevoOrdenado = [...datosDetalle].sort((a, b) => a.conceptoId.localeCompare(b.conceptoId));
    const sinCambios =
      Number(existente.montoNeto) === montoNeto &&
      existente.estatus === nuevoEstatusCorte &&
      anteriorOrdenado.length === nuevoOrdenado.length &&
      anteriorOrdenado.every(
        (d, i) =>
          d.conceptoId === nuevoOrdenado[i].conceptoId &&
          Number(d.cantidadEjecutada) === nuevoOrdenado[i].cantidadEjecutada &&
          Number(d.precioUnitarioContratista) === nuevoOrdenado[i].precioUnitarioContratista &&
          Number(d.importe) === nuevoOrdenado[i].importe
      );

    if (sinCambios) return { tipo: "SIN_CAMBIOS", montoNeto, auditorias: [] };

    const valorAnterior = {
      montoBruto: Number(existente.montoBruto),
      montoNeto: Number(existente.montoNeto),
      estatus: existente.estatus,
      detalle: anteriorOrdenado.map((d) => ({
        conceptoId: d.conceptoId,
        descripcionConcepto: d.descripcionConcepto,
        cantidadEjecutada: Number(d.cantidadEjecutada),
        precioUnitarioContratista: Number(d.precioUnitarioContratista),
        importe: Number(d.importe),
      })),
    };

    await tx.corteSemanalConcepto.deleteMany({ where: { corteSemanalId: existente.id } });
    // `detalle` fuera del `data` de update — un update con relación anidada
    // obliga a Prisma a hacer un SELECT de reconfirmación después (medido:
    // Etapa C, auditoría de rendimiento, agosto 2026); separarlo en un
    // createMany aparte lo evita, sin cambiar qué queda guardado.
    const corte = await tx.corteSemanal.update({
      where: { id: existente.id },
      data: { montoBruto, montoNeto, estatus: nuevoEstatusCorte },
    });
    if (datosDetalle.length > 0) {
      await tx.corteSemanalConcepto.createMany({
        data: datosDetalle.map((d) => ({ ...d, corteSemanalId: corte.id })),
      });
    }

    const movimientoAnterior = existente.movimientoSemanal!;
    const movimiento = await tx.movimientoSemanal.update({
      where: { id: movimientoAnterior.id },
      data: {
        montoFinSemana: montoNeto,
        estatusAprobacion: nuevoEstatusCorte === "ANULADO" ? "CANCELADO" : "APROBADO",
        estatusPago: nuevoEstatusCorte === "ANULADO" ? "SIN_MOVIMIENTO" : "PENDIENTE_PAGO",
      },
    });

    const auditorias: AuditoriaPendiente[] = [
      {
        entidad: "CorteSemanal",
        entidadId: corte.id,
        accion: "EDITAR",
        valorAnterior,
        valorNuevo: { montoBruto, montoNeto, estatus: nuevoEstatusCorte, detalle: datosDetalle },
      },
      {
        entidad: "MovimientoSemanal",
        entidadId: movimiento.id,
        accion: "EDITAR",
        valorAnterior: {
          montoFinSemana: Number(movimientoAnterior.montoFinSemana),
          estatusAprobacion: movimientoAnterior.estatusAprobacion,
          estatusPago: movimientoAnterior.estatusPago,
        },
        valorNuevo: {
          montoFinSemana: montoNeto,
          estatusAprobacion: movimiento.estatusAprobacion,
          estatusPago: movimiento.estatusPago,
        },
      },
    ];

    // Si había un recibo VIGENTE (sin firmar — si tuviera firma, ni siquiera
    // habríamos llegado aquí, se habría omitido arriba), ya no refleja el
    // monto correcto: pasa a SUPERSEDIDO. No se genera uno nuevo solo — eso
    // requiere una acción explícita de "Generar" para no emitir folios que
    // nadie pidió.
    if (reciboVigente) {
      await tx.reciboPago.update({
        where: { id: reciboVigente.id },
        data: { estatus: "SUPERSEDIDO" },
      });
      auditorias.push({
        entidad: "ReciboPago",
        entidadId: reciboVigente.id,
        accion: "CAMBIAR_ESTATUS",
        valorAnterior: { estatus: "VIGENTE" },
        valorNuevo: { estatus: "SUPERSEDIDO", motivo: "corte reconciliado" },
      });
    }

    return { tipo: "RECONCILIADO", montoNeto, auditorias };
  }

  // No existe corte todavía — nace GENERADO siempre, aunque el monto diera 0
  // no tiene sentido nacer ya anulado (no hay nada previo que congelar). El
  // número correlativo llega precalculado (ver cerrarSemana) — ya no se
  // recuenta con un COUNT por contratista dentro del loop.
  const movimiento = await tx.movimientoSemanal.create({
    data: {
      beneficiarioProyectoId: ctx.beneficiarioProyectoId,
      semanaId: ctx.semanaId,
      contratoContratistaId,
      origen: "CORTE_CONTRATISTA",
      montoFinSemana: montoNeto,
      estatusAprobacion: "APROBADO",
      estatusPago: "PENDIENTE_PAGO",
      enviadoPorId: ctx.usuarioId,
      aprobadoPorId: ctx.usuarioId,
    },
  });

  // `detalle` fuera del `data` de create, mismo motivo que en el update de
  // arriba — evita el SELECT de reconfirmación posterior al insert anidado.
  const corte = await tx.corteSemanal.create({
    data: {
      empresaId: ctx.empresaId,
      proyectoId: ctx.proyectoId,
      semanaId: ctx.semanaId,
      cierreSemanaProyectoId: ctx.cierreSemanaProyectoId,
      beneficiarioProyectoId: ctx.beneficiarioProyectoId,
      numero: numeroParaCrear,
      montoBruto,
      montoNeto,
      estatus: "GENERADO",
      movimientoSemanalId: movimiento.id,
      generadoPorId: ctx.usuarioId,
    },
  });
  if (datosDetalle.length > 0) {
    await tx.corteSemanalConcepto.createMany({
      data: datosDetalle.map((d) => ({ ...d, corteSemanalId: corte.id })),
    });
  }

  const auditorias: AuditoriaPendiente[] = [
    {
      entidad: "CorteSemanal",
      entidadId: corte.id,
      accion: "CREAR",
      valorAnterior: null,
      valorNuevo: { montoBruto, montoNeto, estatus: "GENERADO", detalle: datosDetalle },
    },
    {
      entidad: "MovimientoSemanal",
      entidadId: movimiento.id,
      accion: "CREAR",
      valorAnterior: null,
      valorNuevo: {
        beneficiarioProyectoId: ctx.beneficiarioProyectoId,
        semanaId: ctx.semanaId,
        montoFinSemana: montoNeto,
        estatusAprobacion: "APROBADO",
        estatusPago: "PENDIENTE_PAGO",
      },
    },
  ];

  return { tipo: "CREADO", montoNeto, auditorias };
}

export type ResultadoCierreSemana = {
  yaEstabaCerrada: boolean;
  cortesGenerados: number;
  cortesReconciliados: number;
  cortesOmitidosPorLiquidado: number;
  montoTotalGenerado: number;
  estimacionClienteOmitidaPorEmitida: boolean;
};

export async function cerrarSemana(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<ResultadoCierreSemana> {
  const empresaId = requerirCerrar(usuario);

  try {
    return await db.$transaction(
      async (tx) => {
        const proyecto = await tx.proyecto.findFirst({ where: { id: proyectoId, empresaId } });
        if (!proyecto) throw new RegistroNoEncontradoError("El proyecto");
        const semana = await tx.semana.findFirst({ where: { id: semanaId, empresaId } });
        if (!semana) throw new RegistroNoEncontradoError("La semana");

        const cierreExistente = await tx.cierreSemanaProyecto.findUnique({
          where: { proyectoId_semanaId: { proyectoId, semanaId } },
        });

        // No-op real: cerrar dos veces (doble clic, reintento) no crea ni
        // duplica nada.
        if (cierreExistente?.estatus === "CERRADA") {
          return {
            yaEstabaCerrada: true,
            cortesGenerados: 0,
            cortesReconciliados: 0,
            cortesOmitidosPorLiquidado: 0,
            montoTotalGenerado: 0,
            estimacionClienteOmitidaPorEmitida: false,
          };
        }

        // Se revalidan las reglas de bloqueo DENTRO de la transacción — evita
        // que algo cambie entre ver el resumen y darle clic al botón.
        const pendientes = await tx.avanceConcepto.count({
          where: {
            semanaId,
            estatusAprobacion: "PENDIENTE",
            cantidadEjecutada: { gt: 0 },
            concepto: { partida: { proyectoId } },
          },
        });
        if (pendientes > 0) {
          const plural = pendientes === 1 ? "" : "s";
          throw new ValidacionError(
            `Hay ${pendientes} avance${plural} pendiente${plural} por aprobar esta semana. Apruébalo${plural} o recházalo${plural} antes de cerrar.`
          );
        }

        const lineas = await obtenerLineasAvanceAprobado(tx, proyectoId, semanaId);
        const sinContratista = lineas.filter((l) => !l.beneficiarioProyectoId);
        if (sinContratista.length > 0) {
          const nombres = [...new Set(sinContratista.map((l) => l.descripcionConcepto))].join(", ");
          const plural = sinContratista.length === 1 ? "" : "s";
          const verbo = sinContratista.length === 1 ? "tiene" : "tienen";
          throw new ValidacionError(
            `${sinContratista.length} concepto${plural} con avance aprobado no ${verbo} contratista asignado: ${nombres}.`
          );
        }

        const cierre = cierreExistente
          ? await tx.cierreSemanaProyecto.update({
              where: { id: cierreExistente.id },
              data: { estatus: "CERRADA", cerradoPorId: usuario.id, cerradoEn: new Date() },
            })
          : await tx.cierreSemanaProyecto.create({
              data: {
                empresaId,
                proyectoId,
                semanaId,
                estatus: "CERRADA",
                cerradoPorId: usuario.id,
              },
            });

        await auditarTx(tx, {
          empresaId,
          usuarioId: usuario.id,
          entidad: "CierreSemanaProyecto",
          entidadId: cierre.id,
          accion: cierreExistente ? "CAMBIAR_ESTATUS" : "CREAR",
          valorAnterior: cierreExistente ? { estatus: cierreExistente.estatus } : null,
          valorNuevo: { estatus: "CERRADA" },
        });

        const porContratista = new Map<string, LineaAvanceParaCierre[]>();
        for (const linea of lineas) {
          const grupo = porContratista.get(linea.beneficiarioProyectoId!) ?? [];
          grupo.push(linea);
          porContratista.set(linea.beneficiarioProyectoId!, grupo);
        }

        // Precarga — todos los cortes ya existentes de este proyecto+semana,
        // con movimiento/detalle/recibo vigente, en una sola consulta batch
        // (antes: un findUnique con include por cada contratista, dentro del
        // loop). También resuelve, sin query aparte, qué contratistas tenían
        // corte vigente en un cierre anterior pero ya no aparecen en `lineas`
        // (avance aprobado bajó a 0 tras una reapertura) — hay que
        // reconciliarlos igual, para que su corte pase a ANULADO en vez de
        // quedar con un monto obsoleto.
        const cortesExistentes = await precargarCortesExistentes(tx, proyectoId, semanaId);
        const existentePorBeneficiario = new Map(
          cortesExistentes.map((c) => [c.beneficiarioProyectoId, c])
        );
        for (const c of cortesExistentes) {
          if (c.estatus === "GENERADO" && !porContratista.has(c.beneficiarioProyectoId)) {
            porContratista.set(c.beneficiarioProyectoId, []);
          }
        }

        // Correlativo de CorteSemanal.numero — antes se recalculaba con un
        // COUNT por contratista dentro del loop. Toda la operación ocurre
        // dentro de esta misma transacción atómica, así que nadie más puede
        // insertar un corte de este proyecto mientras tanto: precalcularlo
        // una vez y llevarlo en memoria da exactamente los mismos números,
        // en el mismo orden que antes.
        let siguienteNumero = (await tx.corteSemanal.count({ where: { proyectoId } })) + 1;

        let cortesGenerados = 0;
        let cortesReconciliados = 0;
        let cortesOmitidosPorLiquidado = 0;
        let montoTotalGenerado = 0;
        const todasLasAuditorias: AuditoriaPendiente[] = [];

        for (const [beneficiarioProyectoId, grupoLineas] of porContratista) {
          const resultado = await generarOReconciliarCorte(
            tx,
            {
              empresaId,
              proyectoId,
              semanaId,
              cierreSemanaProyectoId: cierre.id,
              beneficiarioProyectoId,
              usuarioId: usuario.id,
            },
            grupoLineas,
            existentePorBeneficiario.get(beneficiarioProyectoId) ?? null,
            siguienteNumero
          );
          todasLasAuditorias.push(...resultado.auditorias);
          if (resultado.tipo === "OMITIDO_LIQUIDADO") {
            cortesOmitidosPorLiquidado++;
          } else {
            if (resultado.tipo === "CREADO") {
              cortesGenerados++;
              siguienteNumero++;
            }
            if (resultado.tipo === "RECONCILIADO") cortesReconciliados++;
            montoTotalGenerado += resultado.montoNeto;
          }
        }

        // Auditoría de todos los cortes/movimientos/recibos tocados en el
        // loop, en una sola sentencia INSERT — un registro por entidad
        // modificada (nunca uno global), igual trazabilidad que antes, sin
        // 2-3 queries de auditoría por contratista.
        if (todasLasAuditorias.length > 0) {
          await tx.registroAuditoria.createMany({
            data: todasLasAuditorias.map((a) => ({
              empresaId,
              usuarioId: usuario.id,
              entidad: a.entidad,
              entidadId: a.entidadId,
              accion: a.accion,
              valorAnterior: a.valorAnterior
                ? (JSON.parse(JSON.stringify(a.valorAnterior)) as Prisma.InputJsonValue)
                : undefined,
              valorNuevo: JSON.parse(JSON.stringify(a.valorNuevo)) as Prisma.InputJsonValue,
            })),
          });
        }

        // Estimación Cliente — una sola vez por proyecto+semana (no por
        // contratista), después de los cortes, dentro de la misma
        // transacción atómica. En cuanto cualquiera de las dos capas ya esté
        // EMITIDA, el físico queda congelado para siempre (ver
        // asegurarFisicoYCapas).
        const resultadoEstimacion = await asegurarFisicoYCapas(
          tx,
          { empresaId, proyectoId, semanaId, usuarioId: usuario.id },
          semana
        );

        return {
          yaEstabaCerrada: false,
          cortesGenerados,
          cortesReconciliados,
          cortesOmitidosPorLiquidado,
          montoTotalGenerado,
          estimacionClienteOmitidaPorEmitida: resultadoEstimacion.tipo === "CONGELADO",
        };
      },
      { timeout: 20000 }
    );
  } catch (error) {
    // Carrera real (doble clic simultáneo): otro proceso ganó el candado
    // único de CierreSemanaProyecto — se trata como éxito idempotente, no
    // como error del usuario.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const cierre = await db.cierreSemanaProyecto.findUnique({
        where: { proyectoId_semanaId: { proyectoId, semanaId } },
      });
      if (cierre?.estatus === "CERRADA") {
        return {
          yaEstabaCerrada: true,
          cortesGenerados: 0,
          cortesReconciliados: 0,
          cortesOmitidosPorLiquidado: 0,
          montoTotalGenerado: 0,
          estimacionClienteOmitidaPorEmitida: false,
        };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reabrir — solo cambia el candado de captura; nunca toca CorteSemanal ni
// MovimientoSemanal (eso solo pasa en un recierre posterior, y ahí un corte
// ya LIQUIDADO queda protegido — ver generarOReconciliarCorte).
// ---------------------------------------------------------------------------

const MotivoReaperturaSchema = z
  .string()
  .trim()
  .min(1, "El motivo de la reapertura es obligatorio.");

export async function reabrirSemana(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  motivoCrudo: unknown
) {
  const empresaId = requerirReabrir(usuario);
  const motivo = MotivoReaperturaSchema.parse(motivoCrudo);
  await obtenerProyecto(usuario, proyectoId);

  const cierre = await db.cierreSemanaProyecto.findFirst({
    where: { proyectoId, semanaId, empresaId },
  });
  if (!cierre) throw new RegistroNoEncontradoError("El cierre de esta semana");
  if (cierre.estatus === "ABIERTA") return cierre;

  // Semana histórica migrada: reabrirla permitiría que un recierre generara
  // cortes y estimación de todo el avance histórico (doble pago/cobro).
  if (cierre.historicoImportado) {
    throw new ValidacionError(
      "Esta semana es histórica (migrada desde Excel) y no se puede reabrir."
    );
  }

  // Bloqueo de reapertura después de emitir (arquitectura por capas, agosto
  // 2026) — EstimacionClienteConcepto es la verdad física que sustenta un
  // documento contractual ya emitido; reabrir la semana permitiría que el
  // avance cambiara por debajo de una estimación EMITIDA. En cuanto
  // cualquiera de las dos capas (OPERATIVO o PRIVADO) llegó a EMITIDA, la
  // semana ya no puede reabrirse — las correcciones posteriores se manejan
  // en semanas posteriores, nunca reescribiendo esta.
  const algunaCapaEmitida = await db.estimacionClienteCapa.findFirst({
    where: { estatus: "EMITIDA", estimacionCliente: { proyectoId, semanaId } },
    select: { id: true },
  });
  if (algunaCapaEmitida) {
    throw new ValidacionError(
      "La semana no puede reabrirse porque ya existe una estimación de cliente emitida."
    );
  }

  const actualizado = await db.cierreSemanaProyecto.update({
    where: { id: cierre.id },
    data: {
      estatus: "ABIERTA",
      reabiertoPorId: usuario.id,
      reabiertoEn: new Date(),
      motivoReapertura: motivo,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "CierreSemanaProyecto",
    entidadId: actualizado.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: "CERRADA" },
    valorNuevo: { estatus: "ABIERTA", motivo },
  });

  return actualizado;
}

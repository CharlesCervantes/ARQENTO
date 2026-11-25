import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria } from "@/lib/server/auditoria";
import { puedeReportarAvance, puedeAdministrarProyectos } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import type { EstatusAprobacionAvance } from "@/lib/generated/prisma/enums";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import {
  partidasConConceptosOperativo,
  resolverContratistaPorConcepto,
  RegistroNoEncontradoError,
} from "./estructura-contractual";
import { verificarSemanaEditable } from "./cierre-semana";
import { sumaEjecutadaPorConcepto, sumaHistoricaImportadaPorConcepto } from "./avance-calculo";

export { sumaEjecutadaPorConcepto };

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// ---------------------------------------------------------------------------
// Cálculo (nada de esto se guarda — siempre se deriva de AvanceConcepto)
// ---------------------------------------------------------------------------

export type EstadoAvanceConcepto = "SIN_INICIAR" | "EN_PROCESO" | "TERMINADO";

export type AvanceCalculado = {
  cantidadTotal: number;
  acumulado: number;
  pendiente: number;
  avancePorcentaje: number;
  estado: EstadoAvanceConcepto;
};

function calcularEstado(acumulado: number, total: number): EstadoAvanceConcepto {
  if (acumulado <= 0) return "SIN_INICIAR";
  if (acumulado >= total) return "TERMINADO";
  return "EN_PROCESO";
}

function calcularAvance(cantidadTotal: number, acumulado: number): AvanceCalculado {
  return {
    cantidadTotal,
    acumulado,
    pendiente: cantidadTotal - acumulado,
    avancePorcentaje: cantidadTotal > 0 ? (acumulado / cantidadTotal) * 100 : 0,
    estado: calcularEstado(acumulado, cantidadTotal),
  };
}

// ---------------------------------------------------------------------------
// Lectura — pestaña Avance de obra (una semana específica)
// ---------------------------------------------------------------------------

type ConceptoBase = Awaited<
  ReturnType<typeof partidasConConceptosOperativo>
>[number]["conceptos"][number];

// Campos Decimal de Concepto (presupuesto de Contrato General, capa
// operativa) — se convierten explícitamente a number antes de devolverse,
// porque esta forma cruza hacia FormAvanceSemanal ("use client") y las
// instancias de Prisma.Decimal no son serializables de Server a Client
// Component. No afecta lo que se guarda en Postgres/Prisma, solo esta
// lectura. Indirectos/Herramienta/%Utilidad/P.U.Privado/CantidadPrivado ya NO
// se seleccionan de la base de datos (partidasConConceptosOperativo, no
// partidasConConceptos) — confirmado que Avance de obra nunca los usa ni los
// muestra (auditoría de rendimiento, agosto 2026): antes viajaban sin usarse,
// incluyendo hacia el navegador de un Supervisor.
type CamposDecimalConcepto =
  | "cantidadContratada"
  | "precioUnitarioContratista"
  | "precioUnitarioMateriales"
  | "porcentajeAdministracion";

export type ConceptoConAvance = Omit<ConceptoBase, CamposDecimalConcepto> &
  AvanceCalculado & {
    cantidadContratada: number;
    precioUnitarioContratista: number | null;
    precioUnitarioMateriales: number | null;
    porcentajeAdministracion: number | null;
    anterior: number;
    estaSemana: number;
    // Monto exacto ya guardado esta semana (AvanceConcepto.montoEjecutado) —
    // null = todavía no se capturó monto (fila nueva, o se capturó por
    // Cantidad directamente). La pantalla lo usa para mostrar el Monto tal
    // cual quedó guardado, nunca recalculado desde estaSemana × P.U.
    montoEstaSemana: number | null;
    // null = nada capturado todavía esta semana (no hay fila que aprobar).
    estatusAprobacion: EstatusAprobacionAvance | null;
    // P.U. CONTRATADO (resuelto vía ContratoConcepto) — distinto del
    // presupuesto `Concepto.precioUnitarioContratista` (Etapa B, Contrato
    // General) que ya viene incluido arriba. null si el concepto no tiene
    // contratista asignado o si tiene varios (no atribuible, sección 49.8).
    // Visible a los 4 roles (sección 49.9, sustituye el gate por
    // puedeAdministrarProyectos que tenía esta pantalla antes).
    precioUnitarioContratistaContratado: number | null;
  };

function numOrNull(valor: { toNumber(): number } | null): number | null {
  return valor === null ? null : valor.toNumber();
}

export async function obtenerAvanceSemanal(
  usuario: UsuarioSesion,
  proyectoId: string,
  semana: { id: string; fechaInicio: Date }
) {
  await obtenerProyecto(usuario, proyectoId);

  // resolverContratistaPorConcepto no depende de conceptoIds (filtra por
  // proyectoId directamente) — va en la primera fase junto con partidas, no
  // en la segunda, donde tendría que esperar sin necesidad.
  const [partidas, resolucionContratista] = await Promise.all([
    partidasConConceptosOperativo(proyectoId),
    resolverContratistaPorConcepto(proyectoId),
  ]);
  const conceptoIds = partidas.flatMap((p) => p.conceptos.map((c) => c.id));

  const [anteriorPorConcepto, filasEstaSemana] = await Promise.all([
    sumaEjecutadaPorConcepto(conceptoIds, semana.fechaInicio),
    db.avanceConcepto.findMany({
      where: { conceptoId: { in: conceptoIds }, semanaId: semana.id },
    }),
  ]);
  const estaSemanaPorConcepto = new Map(
    filasEstaSemana.map((f) => [f.conceptoId, Number(f.cantidadEjecutada)])
  );
  // Monto exacto ya guardado esta semana (AvanceConcepto.montoEjecutado) — la
  // pantalla lo usa para mostrar el mismo monto tal cual quedó guardado, en
  // vez de recalcularlo desde la cantidad (que solo guarda 3 decimales y
  // volvería a mostrar el monto impreciso al reabrir/recargar).
  const montoEstaSemanaPorConcepto = new Map(
    filasEstaSemana.map((f) => [f.conceptoId, f.montoEjecutado !== null ? Number(f.montoEjecutado) : null])
  );
  const estatusPorConcepto = new Map(
    filasEstaSemana.map((f) => [f.conceptoId, f.estatusAprobacion])
  );

  return partidas.map((partida) => ({
    ...partida,
    conceptos: partida.conceptos.map((concepto): ConceptoConAvance => {
      const anterior = anteriorPorConcepto.get(concepto.id) ?? 0;
      const estaSemana = estaSemanaPorConcepto.get(concepto.id) ?? 0;
      const montoEstaSemana = montoEstaSemanaPorConcepto.get(concepto.id) ?? null;
      // El acumulado "oficial" solo suma lo APROBADO. Mientras esta semana
      // esté pendiente/rechazada, Acumulado/Pendiente/% no se mueven todavía
      // — la vista de captura sigue mostrando lo tecleado, pero lo que cuenta
      // como oficial (aquí y en Contratistas) espera la aprobación.
      const estatusSemana = estatusPorConcepto.get(concepto.id) ?? null;
      const acumulado = anterior + (estatusSemana === "APROBADO" ? estaSemana : 0);
      return {
        ...concepto,
        cantidadContratada: Number(concepto.cantidadContratada),
        precioUnitarioContratista: numOrNull(concepto.precioUnitarioContratista),
        precioUnitarioMateriales: numOrNull(concepto.precioUnitarioMateriales),
        porcentajeAdministracion: numOrNull(concepto.porcentajeAdministracion),
        anterior,
        estaSemana,
        montoEstaSemana,
        estatusAprobacion: estatusSemana,
        precioUnitarioContratistaContratado:
          resolucionContratista.get(concepto.id)?.precioUnitarioContratista ?? null,
        ...calcularAvance(Number(concepto.cantidadContratada), acumulado),
      };
    }),
  }));
}

// En semana cerrada, solo se muestran conceptos con avance real registrado
// ESA semana (estaSemana > 0) — una partida sin ningún concepto con
// movimiento tampoco se muestra. Compartido por Avance de obra y por Cliente/
// Cliente Priv. (misma regla, un solo lugar — sección 4/5 del diseño de
// Cliente, agosto 2026).
export function filtrarPartidasConMovimiento<
  P extends { conceptos: { estaSemana: number }[] },
>(partidas: P[]): P[] {
  return partidas
    .map((p) => ({ ...p, conceptos: p.conceptos.filter((c) => c.estaSemana > 0) }))
    .filter((p) => p.conceptos.length > 0);
}

// ---------------------------------------------------------------------------
// Lectura — enriquecer Contratistas con avance acumulado a la fecha
// ---------------------------------------------------------------------------

// Avance de un concepto visto desde su contratista. `historicoSinAtribuir`
// es lo ejecutado en semanas históricas importadas: NO cuenta como ejecutado
// del contratista asignado (pudo hacerlo otro); se muestra aparte.
export type AvanceContratista = AvanceCalculado & { historicoSinAtribuir: number };

export async function obtenerAvanceAcumuladoPorConcepto(
  usuario: UsuarioSesion,
  proyectoId: string
): Promise<Map<string, AvanceContratista>> {
  await obtenerProyecto(usuario, proyectoId);

  // Se resuelve por proyectoId, no a partir de la lista de conceptos de
  // `partidas` — así el caller no tiene que esperar a que esa consulta
  // termine primero y puede pedir todo en un solo Promise.all.
  const conceptos = await db.concepto.findMany({
    where: { partida: { proyectoId } },
    select: { id: true, cantidadContratada: true, asignaciones: { select: { cantidad: true } } },
  });
  const conceptoIds = conceptos.map((c) => c.id);
  const [acumuladoPorConcepto, historicoPorConcepto] = await Promise.all([
    sumaEjecutadaPorConcepto(conceptoIds),
    sumaHistoricaImportadaPorConcepto(proyectoId, conceptoIds),
  ]);

  const resultado = new Map<string, AvanceContratista>();
  for (const concepto of conceptos) {
    const historico = historicoPorConcepto.get(concepto.id) ?? 0;
    const acumulado = (acumuladoPorConcepto.get(concepto.id) ?? 0) - historico;
    // Sin histórico importado: igual que siempre (total del concepto). Con
    // histórico: el total es la cantidad asignada al contratista, que ya
    // excluye lo ejecutado antes (ver asignarConcepto).
    const asignada = concepto.asignaciones[0];
    const total = historico > 0 && asignada ? Number(asignada.cantidad) : Number(concepto.cantidadContratada);
    resultado.set(concepto.id, { ...calcularAvance(total, acumulado), historicoSinAtribuir: historico });
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Escritura — captura en lote
// ---------------------------------------------------------------------------

const FilaCapturaSchema = z.object({
  conceptoId: z.string().min(1),
  cantidadEjecutada: z.coerce.number().min(0, "La cantidad no puede ser negativa."),
  // Monto exacto tecleado (cuando la captura fue por el campo Monto) — ver
  // comentario de AvanceConcepto.montoEjecutado en el schema.
  montoEjecutado: z.coerce.number().nonnegative().optional().nullable(),
});

const CapturaAvanceSchema = z.object({
  semanaId: z.string().min(1),
  filas: z.array(FilaCapturaSchema),
});

export async function guardarAvanceSemanal(
  usuario: UsuarioSesion,
  proyectoId: string,
  datosCrudos: unknown
): Promise<{ guardados: number }> {
  if (!puedeReportarAvance(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const datos = CapturaAvanceSchema.parse(datosCrudos);
  if (datos.filas.length === 0) return { guardados: 0 };

  const semana = await db.semana.findFirst({ where: { id: datos.semanaId, empresaId } });
  if (!semana) throw new RegistroNoEncontradoError("La semana");

  // Bloqueo general: la semana está cerrada para este proyecto (candado
  // fino por concepto liquidado se revisa más abajo, una vez resuelto qué
  // conceptos de verdad van a cambiar).
  await verificarSemanaEditable(proyectoId, semana.id, []);

  // Solo conceptos que en verdad pertenecen a este proyecto (protege contra
  // enviar ids de otro proyecto/empresa).
  const conceptoIds = datos.filas.map((f) => f.conceptoId);
  const conceptos = await db.concepto.findMany({
    where: { id: { in: conceptoIds }, partida: { proyectoId } },
    select: { id: true, descripcion: true, cantidadContratada: true },
  });
  const conceptoPorId = new Map(conceptos.map((c) => [c.id, c]));

  const [anteriorPorConcepto, existentes] = await Promise.all([
    sumaEjecutadaPorConcepto([...conceptoPorId.keys()], semana.fechaInicio),
    db.avanceConcepto.findMany({
      where: { conceptoId: { in: [...conceptoPorId.keys()] }, semanaId: semana.id },
    }),
  ]);
  const existentePorConcepto = new Map(existentes.map((f) => [f.conceptoId, f]));

  // Pase 1: validar TODO antes de escribir nada — si algo excede lo
  // contratado, no se guarda ni siquiera lo que sí era válido en el mismo envío.
  const porGuardar: {
    conceptoId: string;
    cantidadEjecutada: number;
    montoEjecutado: number | null;
    existenteId?: string;
    valorPrevio: number;
    montoPrevio: number | null;
  }[] = [];

  for (const fila of datos.filas) {
    const concepto = conceptoPorId.get(fila.conceptoId);
    if (!concepto) continue; // no pertenece a este proyecto — se ignora

    const existente = existentePorConcepto.get(fila.conceptoId);
    const valorPrevio = existente ? Number(existente.cantidadEjecutada) : 0;
    const montoPrevio = existente?.montoEjecutado != null ? Number(existente.montoEjecutado) : null;
    const montoNuevo = fila.montoEjecutado ?? null;
    if (fila.cantidadEjecutada === valorPrevio && montoNuevo === montoPrevio) continue; // sin cambios

    // Un monto menor a 0.001 unidades daría cantidad 0: no contaría en nada.
    if (fila.cantidadEjecutada === 0 && (montoNuevo ?? 0) > 0) {
      throw new ValidacionError(`"${concepto.descripcion}": el monto es muy pequeño para su precio unitario.`);
    }

    const anterior = anteriorPorConcepto.get(fila.conceptoId) ?? 0;
    const acumuladoProspectivo = anterior + fila.cantidadEjecutada;
    const total = Number(concepto.cantidadContratada);

    if (acumuladoProspectivo > total) {
      throw new ValidacionError(
        `"${concepto.descripcion}" excede la cantidad contratada (${total}). ` +
          `El acumulado resultante sería ${acumuladoProspectivo}.`
      );
    }

    porGuardar.push({
      conceptoId: fila.conceptoId,
      cantidadEjecutada: fila.cantidadEjecutada,
      montoEjecutado: montoNuevo,
      existenteId: existente?.id,
      valorPrevio,
      montoPrevio,
    });
  }

  if (porGuardar.length === 0) return { guardados: 0 };

  // Candado fino: aunque la semana esté abierta (nunca se cerró, o se
  // reabrió), un concepto que ya forma parte de un corte LIQUIDADO queda
  // protegido — solo se revisa contra lo que de verdad va a cambiar. Se
  // revisa ANTES de escribir nada, con el mismo criterio de "validar todo,
  // escribir después" del resto de la función.
  await verificarSemanaEditable(
    proyectoId,
    semana.id,
    porGuardar.map((f) => f.conceptoId)
  );

  // Pase 2: escribir + auditar en una sola transacción, agrupado en un
  // puñado de queries en vez de 2×N (antes: un upsert + un registrarAuditoria
  // por fila, secuenciales — confirmado con evidencia real que esto escala
  // linealmente, ~96ms por concepto adicional; auditoría de rendimiento,
  // agosto 2026, Etapa B). "Cualquier guardado regresa el registro a
  // PENDIENTE" (aprobar sigue siendo una acción explícita aparte) se
  // conserva exactamente igual, tanto para lo nuevo como para lo editado.
  const paraCrear = porGuardar.filter((f) => !f.existenteId);
  const paraActualizar = porGuardar.filter(
    (f): f is typeof f & { existenteId: string } => f.existenteId !== undefined
  );

  type AuditoriaPendiente = {
    entidadId: string;
    accion: "CREAR" | "EDITAR";
    valorAnterior: Record<string, unknown> | null;
    valorNuevo: Record<string, unknown>;
  };

  try {
    await db.$transaction(async (tx) => {
      const auditorias: AuditoriaPendiente[] = [];

      // Nuevo: una sola sentencia INSERT ... VALUES (...), (...), ... para
      // todas las filas nuevas — createManyAndReturn regresa los ids
      // generados, necesarios para auditar cada uno por separado después.
      if (paraCrear.length > 0) {
        const creados = await tx.avanceConcepto.createManyAndReturn({
          data: paraCrear.map((f) => ({
            empresaId,
            conceptoId: f.conceptoId,
            semanaId: semana.id,
            cantidadEjecutada: f.cantidadEjecutada,
            montoEjecutado: f.montoEjecutado,
            registradoPorId: usuario.id,
            estatusAprobacion: "PENDIENTE",
          })),
          select: { id: true, conceptoId: true },
        });
        const idPorConcepto = new Map(creados.map((c) => [c.conceptoId, c.id]));
        for (const f of paraCrear) {
          const id = idPorConcepto.get(f.conceptoId);
          if (!id) continue; // createManyAndReturn siempre regresa lo insertado; defensivo
          auditorias.push({
            entidadId: id,
            accion: "CREAR",
            valorAnterior: null,
            valorNuevo: { cantidadEjecutada: f.cantidadEjecutada, montoEjecutado: f.montoEjecutado },
          });
        }
      }

      // Existente: una sola sentencia UPDATE ... FROM (VALUES ...) — Postgres
      // actualiza cada fila con su propio valor de cantidad en un solo
      // round-trip, en vez de N UPDATE separados. Los ids interpolados vienen
      // de `existenteId` (ids ya resueltos server-side contra este proyecto/
      // semana, nunca del input crudo del usuario) y cada valor pasa por el
      // mecanismo de parámetros de Prisma (tagged template + Prisma.sql/
      // Prisma.join) — nunca concatenación de texto, cero riesgo de
      // inyección SQL.
      if (paraActualizar.length > 0) {
        const valores = Prisma.join(
          paraActualizar.map(
            (f) =>
              Prisma.sql`(${f.existenteId}::text, ${f.cantidadEjecutada}::numeric, ${f.montoEjecutado}::numeric)`
          ),
          ", "
        );
        await tx.$executeRaw`
          UPDATE avance_conceptos AS a
          SET
            "cantidadEjecutada" = v.cantidad,
            "montoEjecutado" = v.monto,
            "registradoPorId" = ${usuario.id},
            "estatusAprobacion" = 'PENDIENTE'::"EstatusAprobacionAvance",
            "aprobadoPorId" = NULL,
            "fechaAprobacion" = NULL,
            "updatedAt" = now()
          FROM (VALUES ${valores}) AS v(id, cantidad, monto)
          WHERE a.id = v.id
        `;
        for (const f of paraActualizar) {
          auditorias.push({
            entidadId: f.existenteId,
            accion: "EDITAR",
            valorAnterior: { cantidadEjecutada: f.valorPrevio, montoEjecutado: f.montoPrevio },
            valorNuevo: { cantidadEjecutada: f.cantidadEjecutada, montoEjecutado: f.montoEjecutado },
          });
        }
      }

      // Auditoría: un registro por concepto (nunca uno global) en una sola
      // sentencia INSERT — mismo contenido que registrarAuditoria/Tx
      // generarían fila por fila, solo agrupado.
      if (auditorias.length > 0) {
        await tx.registroAuditoria.createMany({
          data: auditorias.map((a) => ({
            empresaId,
            usuarioId: usuario.id,
            entidad: "AvanceConcepto",
            entidadId: a.entidadId,
            accion: a.accion,
            valorAnterior: a.valorAnterior
              ? (JSON.parse(JSON.stringify(a.valorAnterior)) as Prisma.InputJsonValue)
              : undefined,
            valorNuevo: JSON.parse(JSON.stringify(a.valorNuevo)) as Prisma.InputJsonValue,
          })),
        });
      }
    });
  } catch (error) {
    // Carrera real: dos requests intentando CREAR (nunca antes capturado)
    // avance para el mismo concepto+semana al mismo tiempo — el @@unique lo
    // impide a nivel de base de datos, la segunda transacción completa se
    // revierte (nunca una escritura parcial) y se le pide reintentar con
    // datos frescos, en vez de pisar en silencio lo que la primera ya guardó.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ValidacionError(
        "Alguien más acaba de capturar avance para uno de estos conceptos en esta semana. Actualiza la página e intenta de nuevo."
      );
    }
    throw error;
  }

  return { guardados: porGuardar.length };
}

// ---------------------------------------------------------------------------
// Aprobación
// ---------------------------------------------------------------------------

export async function cambiarEstatusAprobacionAvance(
  usuario: UsuarioSesion,
  conceptoId: string,
  semanaId: string,
  nuevoEstatus: "APROBADO" | "RECHAZADO"
) {
  if (!puedeAdministrarProyectos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const avance = await db.avanceConcepto.findFirst({
    where: { conceptoId, semanaId, empresaId },
    include: { concepto: { select: { partida: { select: { proyectoId: true } } } } },
  });
  if (!avance) throw new RegistroNoEncontradoError("El avance de este concepto");

  await verificarSemanaEditable(avance.concepto.partida.proyectoId, semanaId, [conceptoId]);

  const actualizado = await db.avanceConcepto.update({
    where: { id: avance.id },
    data: {
      estatusAprobacion: nuevoEstatus,
      aprobadoPorId: usuario.id,
      fechaAprobacion: new Date(),
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "AvanceConcepto",
    entidadId: actualizado.id,
    accion: nuevoEstatus === "APROBADO" ? "CONFIRMAR" : "RECHAZAR",
    valorAnterior: { estatusAprobacion: avance.estatusAprobacion },
    valorNuevo: { estatusAprobacion: actualizado.estatusAprobacion },
  });

  return actualizado;
}

// ---------------------------------------------------------------------------
// Aviso en el listado de Control de Obra
// ---------------------------------------------------------------------------

export async function contarPendientesPorProyecto(
  empresaId: string
): Promise<Map<string, number>> {
  const filas = await db.avanceConcepto.findMany({
    where: { empresaId, estatusAprobacion: "PENDIENTE" },
    select: { concepto: { select: { partida: { select: { proyectoId: true } } } } },
  });

  const conteo = new Map<string, number>();
  for (const fila of filas) {
    const proyectoId = fila.concepto.partida.proyectoId;
    conteo.set(proyectoId, (conteo.get(proyectoId) ?? 0) + 1);
  }
  return conteo;
}

// Aviso en el sidebar dentro de un proyecto ("Avance de obra") — a
// diferencia de contarPendientesPorProyecto (empresa completa, para la lista
// de Proyectos), este ya viene escopado a un solo proyecto: evita traer y
// agrupar el avance pendiente de toda la empresa solo para leer una entrada
// (sidebar con indicador de pendientes, septiembre 2026).
export async function hayAvancePendiente(proyectoId: string): Promise<boolean> {
  const total = await db.avanceConcepto.count({
    where: { estatusAprobacion: "PENDIENTE", concepto: { partida: { proyectoId } } },
  });
  return total > 0;
}

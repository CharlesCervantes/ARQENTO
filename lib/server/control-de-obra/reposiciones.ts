import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeCapturarGastos, puedeRegistrarAbonoReposicion, puedeVerContabilidad } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { formatMoney } from "@/lib/dinero";
import { liquidarMovimientoTx } from "../reporte-general/liquidar";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";
import { EMPRESA_PROYECTO_LABEL } from "./proyecto-oficina";
import {
  estadoDeReposicion,
  type EstadoReposicion,
  type MotivoRevisionReposicion,
} from "@/lib/control-de-obra/reposicion-estado";

type Cliente = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// La Reposición ya no es un segundo flujo de aprobación — es el agrupador de
// pago que se arma solo cuando se aprueba un gasto pagado personalmente
// (aprobarGasto, en gastos.ts, es el único punto de entrada; nunca se llama
// directamente desde una Server Action ni desde la UI). Colapso de doble
// aprobación Gastos→Reposiciones, agosto 2026.
// ---------------------------------------------------------------------------

async function crearReposicionAutomaticaTx(
  tx: Cliente,
  ctx: { empresaId: string; usuarioId: string; proyectoId: string; semanaId: string; beneficiarioId: string }
) {
  const empresa = await tx.empresa.update({
    where: { id: ctx.empresaId },
    data: { ultimoFolioReposicion: { increment: 1 } },
    // Solo el contador: sin select, Prisma devuelve TODAS las columnas de
    // empresas y el folio queda acoplado a columnas ajenas (incidente PRD
    // nov-2026, inteligenciaHabilitada sin migrar).
    select: { ultimoFolioReposicion: true },
  });
  const folio = `REP-${String(empresa.ultimoFolioReposicion).padStart(6, "0")}`;

  try {
    const reposicion = await tx.reposicionGastos.create({
      data: {
        empresaId: ctx.empresaId,
        proyectoId: ctx.proyectoId,
        semanaId: ctx.semanaId,
        beneficiarioId: ctx.beneficiarioId,
        folio,
        numeroFolio: empresa.ultimoFolioReposicion,
        // Ya no hay borrador/envío a revisión — el contenido de una
        // reposición siempre está aprobado por construcción (cada gasto que
        // entra ya pasó su propia aprobación).
        estatus: "APROBADA",
        creadoPorId: ctx.usuarioId,
      },
    });
    await registrarAuditoriaTx(tx, {
      empresaId: ctx.empresaId,
      usuarioId: ctx.usuarioId,
      entidad: "ReposicionGastos",
      entidadId: reposicion.id,
      accion: "CREAR",
      valorNuevo: { folio: reposicion.folio, beneficiarioId: ctx.beneficiarioId },
    });
    return reposicion;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Carrera real contra el índice único parcial (dos gastos del mismo
      // beneficiario aprobados casi al mismo tiempo) — nunca se duplica,
      // se reutiliza la que ganó la carrera.
      return tx.reposicionGastos.findFirstOrThrow({
        where: {
          proyectoId: ctx.proyectoId,
          semanaId: ctx.semanaId,
          beneficiarioId: ctx.beneficiarioId,
          cerrada: false,
          estatus: { not: "RECHAZADA" },
        },
      });
    }
    throw error;
  }
}

// Llamada exclusivamente desde aprobarGasto (gastos.ts), dentro de su misma
// transacción — nunca expuesta como Server Action propia. Encuentra o crea
// la reposición abierta de este beneficiario+proyecto+semana, le agrega el
// gasto y crea/reconcilia su MovimientoSemanal en un solo paso.
export async function asignarGastoAReposicionTx(
  tx: Cliente,
  ctx: {
    empresaId: string;
    usuarioId: string;
    proyectoId: string;
    semanaId: string;
    beneficiarioId: string;
    gastoId: string;
  }
): Promise<void> {
  let reposicion = await tx.reposicionGastos.findFirst({
    where: {
      empresaId: ctx.empresaId,
      proyectoId: ctx.proyectoId,
      semanaId: ctx.semanaId,
      beneficiarioId: ctx.beneficiarioId,
      cerrada: false,
      estatus: { not: "RECHAZADA" },
    },
  });

  if (reposicion) {
    // Orden de bloqueo único en todo el ciclo de reposiciones (R2, octubre
    // 2026): primero su MovimientoSemanal, después la reposición — igual que
    // liquidar y registrar abonos, para que nunca se bloqueen en orden
    // inverso. El movimiento de una reposición nunca cambia una vez creado.
    if (reposicion.movimientoSemanalId) {
      await tx.$queryRaw`SELECT id FROM movimientos_semanales WHERE id = ${reposicion.movimientoSemanalId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM reposiciones_gastos WHERE id = ${reposicion.id} FOR UPDATE`;
    const releida = await tx.reposicionGastos.findUniqueOrThrow({
      where: { id: reposicion.id },
      include: {
        gastos: { select: { monto: true } },
        abonos: { select: { monto: true } },
        movimientoSemanal: { select: { estatusPago: true, montoEntreSemana: true, montoFinSemana: true } },
      },
    });

    // Una reposición inconsistente (p. ej. liquidada sin cerrar, abonos que
    // exceden el total) nunca se corrige en silencio ni recibe gastos nuevos:
    // queda tal cual para revisión y la operación completa (incluida la
    // aprobación del gasto) se revierte. Antes de esta corrección, una
    // liquidada sin cerrar se marcaba `cerrada` aquí mismo.
    const { estado } = estadoDeReposicion({
      total: releida.gastos.reduce((t, g) => t + Number(g.monto), 0),
      abonado: releida.abonos.reduce((t, a) => t + Number(a.monto), 0),
      cerrada: releida.cerrada,
      estatusPago: releida.movimientoSemanal?.estatusPago ?? null,
      montoMovimiento: releida.movimientoSemanal
        ? Number(releida.movimientoSemanal.montoEntreSemana) + Number(releida.movimientoSemanal.montoFinSemana)
        : null,
    });
    if (estado === "REQUIERE_REVISION") {
      throw new ValidacionError(
        `La reposición ${releida.folio} de este beneficiario requiere revisión (sus abonos, su cierre o su importe no coinciden). No se aprobó el gasto ni se modificó la reposición.`
      );
    }

    // Se liquidó mientras se esperaba el bloqueo: el gasto va a una
    // reposición complementaria nueva, nunca a una ya cerrada.
    reposicion = releida.cerrada ? null : releida;
  }

  if (!reposicion) {
    reposicion = await crearReposicionAutomaticaTx(tx, ctx);
  }

  await tx.gastoObra.update({
    where: { id: ctx.gastoId },
    data: { reposicionGastosId: reposicion.id },
  });

  const gastosIncluidos = await tx.gastoObra.findMany({
    where: { reposicionGastosId: reposicion.id },
    select: { monto: true },
  });
  const total = gastosIncluidos.reduce((t, g) => t + Number(g.monto), 0);

  // Requerido por MovimientoSemanal.beneficiarioProyectoId — nunca crea un
  // ContratoContratista, así que nunca hace que este beneficiario aparezca
  // como Contratista solo por tener una reposición.
  const beneficiarioProyecto = await tx.beneficiarioProyecto.upsert({
    where: {
      beneficiarioId_proyectoId: { beneficiarioId: ctx.beneficiarioId, proyectoId: ctx.proyectoId },
    },
    update: {},
    create: { beneficiarioId: ctx.beneficiarioId, proyectoId: ctx.proyectoId },
  });

  if (reposicion.movimientoSemanalId) {
    const anterior = await tx.movimientoSemanal.findUniqueOrThrow({
      where: { id: reposicion.movimientoSemanalId },
    });
    if (Number(anterior.montoFinSemana) !== total) {
      await tx.movimientoSemanal.update({
        where: { id: reposicion.movimientoSemanalId },
        data: { montoFinSemana: total },
      });
      await registrarAuditoriaTx(tx, {
        empresaId: ctx.empresaId,
        usuarioId: ctx.usuarioId,
        entidad: "MovimientoSemanal",
        entidadId: reposicion.movimientoSemanalId,
        accion: "EDITAR",
        valorAnterior: { montoFinSemana: Number(anterior.montoFinSemana) },
        valorNuevo: { montoFinSemana: total },
      });
    }
  } else {
    const movimiento = await tx.movimientoSemanal.create({
      data: {
        beneficiarioProyectoId: beneficiarioProyecto.id,
        semanaId: ctx.semanaId,
        origen: "REPOSICION_GASTOS",
        montoFinSemana: total,
        estatusAprobacion: "APROBADO",
        estatusPago: "PENDIENTE_PAGO",
        enviadoPorId: ctx.usuarioId,
        aprobadoPorId: ctx.usuarioId,
      },
    });
    await tx.reposicionGastos.update({
      where: { id: reposicion.id },
      data: { movimientoSemanalId: movimiento.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId: ctx.empresaId,
      usuarioId: ctx.usuarioId,
      entidad: "MovimientoSemanal",
      entidadId: movimiento.id,
      accion: "CREAR",
      valorNuevo: { origen: "REPOSICION_GASTOS", montoFinSemana: total, reposicionId: reposicion.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export type FilaGastoReposicion = {
  id: string;
  descripcion: string;
  fecha: string;
  monto: number;
};

export type FilaAbonoReposicion = {
  id: string;
  monto: number;
  fecha: string;
  metodoPago: string;
  referencia: string | null;
  notas: string | null;
  registradoPorNombre: string;
};

export type FilaReposicion = {
  id: string;
  folio: string;
  beneficiarioNombre: string;
  total: number;
  cantidadGastos: number;
  estatusPago: string | null;
  cerrada: boolean;
  creadoPorNombre: string;
  createdAt: string;
  gastos: FilaGastoReposicion[];
  abonos: FilaAbonoReposicion[];
  // Derivados — nunca persistidos (reposiciones parciales, septiembre 2026).
  abonado: number;
  saldoPendiente: number;
  esParcial: boolean;
  // R2 (octubre 2026) — ver reposicion-estado.ts. PAGADA incluye las
  // históricas liquidadas sin abonos (clase A, pendiente 0);
  // REQUIERE_REVISION señala inconsistencias (clase B) sin corregirlas.
  estado: EstadoReposicion;
  requiereRevision: boolean;
  motivosRevision: MotivoRevisionReposicion[];
};

export async function obtenerReposiciones(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<FilaReposicion[]> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  await obtenerProyecto(usuario, proyectoId);

  const reposiciones = await db.reposicionGastos.findMany({
    where: { proyectoId, semanaId },
    include: {
      beneficiario: { select: { nombre: true } },
      creadoPor: { select: { nombre: true } },
      gastos: { select: { id: true, descripcion: true, fecha: true, monto: true } },
      movimientoSemanal: { select: { estatusPago: true, montoEntreSemana: true, montoFinSemana: true } },
      abonos: {
        include: { registradoPor: { select: { nombre: true } } },
        orderBy: { fecha: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return reposiciones.map((r) => {
    const total = r.gastos.reduce((t, g) => t + Number(g.monto), 0);
    const abonado = r.abonos.reduce((t, a) => t + Number(a.monto), 0);
    const { estado, motivos, saldoPendiente } = estadoDeReposicion({
      total,
      abonado,
      cerrada: r.cerrada,
      estatusPago: r.movimientoSemanal?.estatusPago ?? null,
      montoMovimiento: r.movimientoSemanal
        ? Number(r.movimientoSemanal.montoEntreSemana) + Number(r.movimientoSemanal.montoFinSemana)
        : null,
    });
    return {
      id: r.id,
      folio: r.folio,
      beneficiarioNombre: r.beneficiario.nombre,
      total,
      cantidadGastos: r.gastos.length,
      estatusPago: r.movimientoSemanal?.estatusPago ?? null,
      cerrada: r.cerrada,
      creadoPorNombre: r.creadoPor.nombre,
      createdAt: r.createdAt.toISOString(),
      gastos: r.gastos.map((g) => ({
        id: g.id,
        descripcion: g.descripcion,
        fecha: g.fecha.toISOString(),
        monto: Number(g.monto),
      })),
      abonos: r.abonos.map((a) => ({
        id: a.id,
        monto: Number(a.monto),
        fecha: a.fecha.toISOString(),
        metodoPago: a.metodoPago,
        referencia: a.referencia,
        notas: a.notas,
        registradoPorNombre: a.registradoPor.nombre,
      })),
      abonado,
      saldoPendiente,
      esParcial: estado === "ABIERTA" && abonado > 0 && saldoPendiente > 0,
      estado,
      requiereRevision: estado === "REQUIERE_REVISION",
      motivosRevision: motivos,
    };
  });
}

// ---------------------------------------------------------------------------
// Abonos parciales — mismo nivel de autorización que liquidar (Administrador/
// Director). "Reposición parcial" es siempre un dato calculado (total −
// Σ abonos), nunca un estado nuevo en EstatusPago: cuando el saldo llega a
// $0 se dispara el liquidarMovimiento normal sobre el MovimientoSemanal de la
// reposición, con la fecha/método de ESTE abono como evidencia del pago
// final (reposiciones parciales, septiembre 2026).
// ---------------------------------------------------------------------------

const DatosAbonoSchema = z.object({
  monto: z.coerce.number().positive("El monto debe ser mayor a cero."),
  fecha: z.coerce.date(),
  metodoPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO"]),
  referencia: z.string().trim().optional().nullable(),
  notas: z.string().trim().optional().nullable(),
});

export async function registrarAbonoReposicion(
  usuario: UsuarioSesion,
  reposicionGastosId: string,
  datosCrudos: unknown
) {
  if (!puedeRegistrarAbonoReposicion(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;
  const datos = DatosAbonoSchema.parse(datosCrudos);

  return db.$transaction(async (tx) => {
    // Orden de bloqueo único en todo el ciclo de reposiciones (R2, octubre
    // 2026): primero su MovimientoSemanal, después la reposición — el mismo
    // que liquidar en Reporte General, así un abono y una liquidación
    // simultáneos siempre se serializan. Se relee todo con el bloqueo tomado.
    const referencia = await tx.reposicionGastos.findFirst({
      where: { id: reposicionGastosId, empresaId },
      select: { movimientoSemanalId: true },
    });
    if (!referencia) throw new RegistroNoEncontradoError("La reposición");
    if (referencia.movimientoSemanalId) {
      await tx.$queryRaw`SELECT id FROM movimientos_semanales WHERE id = ${referencia.movimientoSemanalId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM reposiciones_gastos WHERE id = ${reposicionGastosId} FOR UPDATE`;

    const reposicion = await tx.reposicionGastos.findFirst({
      where: { id: reposicionGastosId, empresaId },
      include: {
        gastos: { select: { monto: true } },
        abonos: { select: { monto: true } },
        movimientoSemanal: { select: { estatusPago: true } },
      },
    });
    if (!reposicion) throw new RegistroNoEncontradoError("La reposición");
    if (reposicion.cerrada || reposicion.movimientoSemanal?.estatusPago === "LIQUIDADO") {
      throw new ValidacionError("Esta reposición ya está liquidada — no admite más abonos.");
    }

    const total = reposicion.gastos.reduce((t, g) => t + Number(g.monto), 0);
    const abonadoPrevio = reposicion.abonos.reduce((t, a) => t + Number(a.monto), 0);
    const saldoPendiente = total - abonadoPrevio;
    if (datos.monto > saldoPendiente) {
      throw new ValidacionError(`El abono excede el saldo pendiente (${formatMoney(saldoPendiente)}).`);
    }

    const abono = await tx.abonoReposicion.create({
      data: {
        reposicionGastosId: reposicion.id,
        monto: datos.monto,
        fecha: datos.fecha,
        metodoPago: datos.metodoPago,
        referencia: datos.referencia || null,
        notas: datos.notas || null,
        registradoPorId: usuario.id,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "AbonoReposicion",
      entidadId: abono.id,
      accion: "CREAR",
      valorNuevo: { reposicionGastosId: reposicion.id, monto: datos.monto, fecha: datos.fecha.toISOString() },
    });

    // Saldo en $0 — el abono que cierra la reposición dispara el
    // liquidarMovimiento normal, con su propia fecha/método como evidencia.
    const nuevoSaldo = saldoPendiente - datos.monto;
    if (nuevoSaldo <= 0 && reposicion.movimientoSemanalId) {
      await liquidarMovimientoTx(tx, { empresaId, usuarioId: usuario.id }, reposicion.movimientoSemanalId, {
        fechaPago: datos.fecha,
        metodoPago: datos.metodoPago,
        referenciaPago: datos.referencia,
        notasPago: datos.notas,
      });
    }

    return abono;
  });
}

// ---------------------------------------------------------------------------
// Resumen transversal (todos los proyectos de la Empresa) — para Inicio/
// Dashboard y sus alertas (Rediseño de Inicio, septiembre 2026). Mismo gate
// que Contabilidad: es información financiera de compromisos pendientes, no
// una pantalla operativa de una obra puntual.
// ---------------------------------------------------------------------------

export type ReposicionPendienteResumen = {
  id: string;
  folio: string;
  proyectoNombre: string;
  beneficiarioNombre: string;
  saldoPendiente: number;
  diasAbierta: number;
};

export async function obtenerReposicionesPendientes(
  usuario: UsuarioSesion
): Promise<ReposicionPendienteResumen[]> {
  if (!puedeVerContabilidad(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;

  const abiertas = await db.reposicionGastos.findMany({
    where: { empresaId, cerrada: false, estatus: { not: "RECHAZADA" } },
    include: {
      proyecto: { select: { nombre: true, tipo: true } },
      beneficiario: { select: { nombre: true } },
      gastos: { select: { monto: true } },
      abonos: { select: { monto: true } },
    },
  });

  const hoy = Date.now();
  return abiertas
    .map((r) => {
      const total = r.gastos.reduce((t, g) => t + Number(g.monto), 0);
      const abonado = r.abonos.reduce((t, a) => t + Number(a.monto), 0);
      return {
        id: r.id,
        folio: r.folio,
        proyectoNombre: r.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : r.proyecto.nombre,
        beneficiarioNombre: r.beneficiario.nombre,
        saldoPendiente: total - abonado,
        diasAbierta: Math.floor((hoy - r.createdAt.getTime()) / 86400000),
      };
    })
    .filter((r) => r.saldoPendiente > 0)
    .sort((a, b) => b.diasAbierta - a.diasAbierta);
}

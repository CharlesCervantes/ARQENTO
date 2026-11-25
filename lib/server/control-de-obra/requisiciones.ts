import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeCapturarGastos, puedeAutorizarOrdenesCompra } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";
import { filtroRequisicionesVisibles } from "./obras-visibles";
import { EMPRESA_PROYECTO_LABEL } from "./proyecto-oficina";

// Requisición = la necesidad detectada en obra/Empresa, sin proveedor ni
// precio todavía (eso es Cotizacion/OrdenCompra) — Compras, septiembre 2026.
// Nunca vuelve a capturar lo que la Orden de Compra ya formaliza; solo lo
// referencia una vez convertida (ver OrdenCompra.requisicionId).

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

const ESTATUS_EDITABLES_REQUISICION = ["PENDIENTE", "EN_COTIZACION"] as const;

const DatosRequisicionSchema = z.object({
  concepto: z.string().trim().min(1, "El concepto es obligatorio."),
  descripcion: z.string().trim().optional().nullable(),
  cantidad: z.coerce.number().positive("La cantidad debe ser mayor a cero."),
  unidad: z.string().trim().min(1, "La unidad es obligatoria."),
  prioridad: z.enum(["NORMAL", "URGENTE"]).default("NORMAL"),
  fechaRequerida: z.coerce.date().optional().nullable(),
  comentarios: z.string().trim().optional().nullable(),
  conceptoContractualId: z.string().trim().optional().nullable(),
  evidenciaRef: z.string().trim().optional().nullable(),
  evidenciaNombre: z.string().trim().optional().nullable(),
});

export async function crearRequisicion(usuario: UsuarioSesion, proyectoId: string, datosCrudos: unknown) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosRequisicionSchema.parse(datosCrudos);

  const requisicion = await db.requisicion.create({
    data: {
      empresaId,
      proyectoId,
      solicitantePorId: usuario.id,
      concepto: datos.concepto,
      descripcion: datos.descripcion || null,
      cantidad: datos.cantidad,
      unidad: datos.unidad,
      prioridad: datos.prioridad,
      fechaRequerida: datos.fechaRequerida || null,
      comentarios: datos.comentarios || null,
      conceptoContractualId: datos.conceptoContractualId || null,
      evidenciaRef: datos.evidenciaRef || null,
      evidenciaNombre: datos.evidenciaNombre || null,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Requisicion",
    entidadId: requisicion.id,
    accion: "CREAR",
    valorNuevo: { concepto: requisicion.concepto, cantidad: datos.cantidad, unidad: datos.unidad },
  });

  return requisicion;
}

export async function editarRequisicion(usuario: UsuarioSesion, requisicionId: string, datosCrudos: unknown) {
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosRequisicionSchema.parse(datosCrudos);

  const anterior = await db.requisicion.findFirst({ where: { id: requisicionId, empresaId, ...filtroRequisicionesVisibles(usuario) } });
  if (!anterior) throw new RegistroNoEncontradoError("La requisición");
  if (!ESTATUS_EDITABLES_REQUISICION.includes(anterior.estatus as (typeof ESTATUS_EDITABLES_REQUISICION)[number])) {
    throw new ValidacionError("Esta requisición ya no se puede editar.");
  }
  if (anterior.solicitantePorId !== usuario.id && !puedeAutorizarOrdenesCompra(usuario)) {
    throw new SinPermisoError();
  }

  const requisicion = await db.requisicion.update({
    where: { id: requisicionId },
    data: {
      concepto: datos.concepto,
      descripcion: datos.descripcion || null,
      cantidad: datos.cantidad,
      unidad: datos.unidad,
      prioridad: datos.prioridad,
      fechaRequerida: datos.fechaRequerida || null,
      comentarios: datos.comentarios || null,
      conceptoContractualId: datos.conceptoContractualId || null,
      ...(datos.evidenciaRef && { evidenciaRef: datos.evidenciaRef, evidenciaNombre: datos.evidenciaNombre || null }),
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Requisicion",
    entidadId: requisicion.id,
    accion: "EDITAR",
    valorNuevo: { concepto: requisicion.concepto, cantidad: datos.cantidad },
  });

  return requisicion;
}

const MotivoSchema = z.string().trim().min(3, "Indica un motivo.");

export async function rechazarRequisicion(usuario: UsuarioSesion, requisicionId: string, motivoCrudo: unknown) {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const motivo = MotivoSchema.parse(motivoCrudo);

  const requisicion = await db.requisicion.findFirst({ where: { id: requisicionId, empresaId } });
  if (!requisicion) throw new RegistroNoEncontradoError("La requisición");
  if (!ESTATUS_EDITABLES_REQUISICION.includes(requisicion.estatus as (typeof ESTATUS_EDITABLES_REQUISICION)[number])) {
    throw new ValidacionError("Esta requisición ya no se puede rechazar.");
  }

  const actualizada = await db.requisicion.update({
    where: { id: requisicionId },
    data: { estatus: "RECHAZADA", motivoRechazo: motivo, revisadoPorId: usuario.id, revisadoEn: new Date() },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Requisicion",
    entidadId: actualizada.id,
    accion: "RECHAZAR",
    valorAnterior: { estatus: requisicion.estatus },
    valorNuevo: { estatus: "RECHAZADA", motivo },
  });

  return actualizada;
}

// Cancelar es acción del propio solicitante (se equivocó/ya no se necesita)
// o de Administrador/Director — nunca disponible una vez CONVERTIDA (la OC
// resultante tiene su propio ciclo de vida y su propia cancelación).
export async function cancelarRequisicion(usuario: UsuarioSesion, requisicionId: string, motivoCrudo: unknown) {
  const empresaId = requerirEmpresa(usuario);
  const motivo = MotivoSchema.parse(motivoCrudo);

  const requisicion = await db.requisicion.findFirst({ where: { id: requisicionId, empresaId, ...filtroRequisicionesVisibles(usuario) } });
  if (!requisicion) throw new RegistroNoEncontradoError("La requisición");
  if (requisicion.solicitantePorId !== usuario.id && !puedeAutorizarOrdenesCompra(usuario)) {
    throw new SinPermisoError();
  }
  if (!ESTATUS_EDITABLES_REQUISICION.includes(requisicion.estatus as (typeof ESTATUS_EDITABLES_REQUISICION)[number])) {
    throw new ValidacionError("Esta requisición ya no se puede cancelar.");
  }

  const actualizada = await db.requisicion.update({
    where: { id: requisicionId },
    data: { estatus: "CANCELADA", motivoRechazo: motivo },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Requisicion",
    entidadId: actualizada.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: requisicion.estatus },
    valorNuevo: { estatus: "CANCELADA", motivo },
  });

  return actualizada;
}

// ---------------------------------------------------------------------------
// Cotizaciones — una opción comercial de UN proveedor. A lo más una
// seleccionada por Requisición, garantizado por el índice único parcial de
// la migración (WHERE seleccionada = true), no solo por este servicio.
// ---------------------------------------------------------------------------

const DatosCotizacionSchema = z.object({
  proveedorBeneficiarioId: z.string().trim().min(1, "Selecciona un proveedor."),
  importe: z.coerce.number().positive("El importe debe ser mayor a cero."),
  vigenciaHasta: z.coerce.date().optional().nullable(),
  tiempoEntregaDias: z.coerce.number().int().positive().optional().nullable(),
  observaciones: z.string().trim().optional().nullable(),
  archivoRef: z.string().trim().optional().nullable(),
  archivoNombre: z.string().trim().optional().nullable(),
});

export async function agregarCotizacion(usuario: UsuarioSesion, requisicionId: string, datosCrudos: unknown) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosCotizacionSchema.parse(datosCrudos);

  const requisicion = await db.requisicion.findFirst({ where: { id: requisicionId, empresaId, ...filtroRequisicionesVisibles(usuario) } });
  if (!requisicion) throw new RegistroNoEncontradoError("La requisición");
  if (!ESTATUS_EDITABLES_REQUISICION.includes(requisicion.estatus as (typeof ESTATUS_EDITABLES_REQUISICION)[number])) {
    throw new ValidacionError("Esta requisición ya no acepta nuevas cotizaciones.");
  }

  return db.$transaction(async (tx) => {
    const cotizacion = await tx.cotizacion.create({
      data: {
        requisicionId,
        proveedorBeneficiarioId: datos.proveedorBeneficiarioId,
        importe: datos.importe,
        vigenciaHasta: datos.vigenciaHasta || null,
        tiempoEntregaDias: datos.tiempoEntregaDias || null,
        observaciones: datos.observaciones || null,
        archivoRef: datos.archivoRef || null,
        archivoNombre: datos.archivoNombre || null,
        registradoPorId: usuario.id,
      },
    });

    if (requisicion.estatus === "PENDIENTE") {
      await tx.requisicion.update({ where: { id: requisicionId }, data: { estatus: "EN_COTIZACION" } });
    }

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "Cotizacion",
      entidadId: cotizacion.id,
      accion: "CREAR",
      valorNuevo: { requisicionId, proveedorBeneficiarioId: datos.proveedorBeneficiarioId, importe: datos.importe },
    });

    return cotizacion;
  });
}

// Marcar una cotización como seleccionada — decisión de compra, mismo
// criterio de sensibilidad que autorizar la Orden de Compra que resultará de
// ella (Administrador/Director). Desmarca cualquier otra seleccionada de la
// misma Requisición en la misma transacción — el índice único parcial es la
// garantía real, esto es solo para que la operación sea atómica y visible de
// inmediato.
export async function seleccionarCotizacion(usuario: UsuarioSesion, cotizacionId: string) {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const cotizacion = await db.cotizacion.findFirst({
    where: { id: cotizacionId, requisicion: { empresaId } },
    include: { requisicion: { select: { id: true, estatus: true } } },
  });
  if (!cotizacion) throw new RegistroNoEncontradoError("La cotización");
  if (!ESTATUS_EDITABLES_REQUISICION.includes(cotizacion.requisicion.estatus as (typeof ESTATUS_EDITABLES_REQUISICION)[number])) {
    throw new ValidacionError("Esta requisición ya no admite cambiar la cotización seleccionada.");
  }

  return db.$transaction(async (tx) => {
    await tx.cotizacion.updateMany({
      where: { requisicionId: cotizacion.requisicionId, seleccionada: true },
      data: { seleccionada: false },
    });
    const actualizada = await tx.cotizacion.update({
      where: { id: cotizacionId },
      data: { seleccionada: true },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "Cotizacion",
      entidadId: actualizada.id,
      accion: "CAMBIAR_ESTATUS",
      valorNuevo: { seleccionada: true },
    });

    return actualizada;
  });
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export type FilaCotizacion = {
  id: string;
  proveedorBeneficiarioId: string;
  proveedorNombre: string;
  importe: number;
  vigenciaHasta: string | null;
  tiempoEntregaDias: number | null;
  observaciones: string | null;
  archivoRef: string | null;
  archivoNombre: string | null;
  seleccionada: boolean;
  registradoPorNombre: string;
};

export type FilaRequisicion = {
  id: string;
  proyectoId: string;
  proyectoNombre: string;
  fecha: string;
  concepto: string;
  descripcion: string | null;
  cantidad: number;
  unidad: string;
  prioridad: string;
  fechaRequerida: string | null;
  comentarios: string | null;
  evidenciaRef: string | null;
  evidenciaNombre: string | null;
  estatus: string;
  motivoRechazo: string | null;
  solicitantePorNombre: string;
  ordenCompraId: string | null;
  ordenCompraFolio: string | null;
  cotizaciones: FilaCotizacion[];
};

function aFilaRequisicion(r: {
  id: string;
  proyectoId: string;
  proyecto: { nombre: string; tipo: string };
  fecha: Date;
  concepto: string;
  descripcion: string | null;
  cantidad: unknown;
  unidad: string;
  prioridad: string;
  fechaRequerida: Date | null;
  comentarios: string | null;
  evidenciaRef: string | null;
  evidenciaNombre: string | null;
  estatus: string;
  motivoRechazo: string | null;
  solicitante: { nombre: string };
  ordenCompra: { id: string; folio: string } | null;
  cotizaciones: {
    id: string;
    proveedorBeneficiarioId: string;
    proveedor: { nombre: string };
    importe: unknown;
    vigenciaHasta: Date | null;
    tiempoEntregaDias: number | null;
    observaciones: string | null;
    archivoRef: string | null;
    archivoNombre: string | null;
    seleccionada: boolean;
    registradoPor: { nombre: string };
  }[];
}): FilaRequisicion {
  return {
    id: r.id,
    proyectoId: r.proyectoId,
    proyectoNombre: r.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : r.proyecto.nombre,
    fecha: r.fecha.toISOString(),
    concepto: r.concepto,
    descripcion: r.descripcion,
    cantidad: Number(r.cantidad),
    unidad: r.unidad,
    prioridad: r.prioridad,
    fechaRequerida: r.fechaRequerida?.toISOString() ?? null,
    comentarios: r.comentarios,
    evidenciaRef: r.evidenciaRef,
    evidenciaNombre: r.evidenciaNombre,
    estatus: r.estatus,
    motivoRechazo: r.motivoRechazo,
    solicitantePorNombre: r.solicitante.nombre,
    ordenCompraId: r.ordenCompra?.id ?? null,
    ordenCompraFolio: r.ordenCompra?.folio ?? null,
    cotizaciones: r.cotizaciones.map((c) => ({
      id: c.id,
      proveedorBeneficiarioId: c.proveedorBeneficiarioId,
      proveedorNombre: c.proveedor.nombre,
      importe: Number(c.importe),
      vigenciaHasta: c.vigenciaHasta?.toISOString() ?? null,
      tiempoEntregaDias: c.tiempoEntregaDias,
      observaciones: c.observaciones,
      archivoRef: c.archivoRef,
      archivoNombre: c.archivoNombre,
      seleccionada: c.seleccionada,
      registradoPorNombre: c.registradoPor.nombre,
    })),
  };
}

const INCLUDE_REQUISICION = {
  proyecto: { select: { nombre: true, tipo: true } },
  solicitante: { select: { nombre: true } },
  ordenCompra: { select: { id: true, folio: true } },
  cotizaciones: {
    include: { proveedor: { select: { nombre: true } }, registradoPor: { select: { nombre: true } } },
    orderBy: { createdAt: "desc" as const },
  },
} as const;

export async function obtenerRequisiciones(usuario: UsuarioSesion, proyectoId: string): Promise<FilaRequisicion[]> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  await obtenerProyecto(usuario, proyectoId);

  const requisiciones = await db.requisicion.findMany({
    where: { proyectoId, ...filtroRequisicionesVisibles(usuario) },
    include: INCLUDE_REQUISICION,
    orderBy: { createdAt: "desc" },
  });

  return requisiciones.map(aFilaRequisicion);
}

export async function obtenerRequisicion(usuario: UsuarioSesion, requisicionId: string): Promise<FilaRequisicion> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const requisicion = await db.requisicion.findFirst({
    where: { id: requisicionId, empresaId, ...filtroRequisicionesVisibles(usuario) },
    include: INCLUDE_REQUISICION,
  });
  if (!requisicion) throw new RegistroNoEncontradoError("La requisición");

  return aFilaRequisicion(requisicion);
}

// Referencias de almacenamiento para los endpoints de descarga autenticada —
// mismo gate que el resto de lectura de Requisiciones/Cotizaciones.
export async function obtenerRefEvidenciaRequisicion(
  usuario: UsuarioSesion,
  requisicionId: string
): Promise<string | null> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const requisicion = await db.requisicion.findFirst({
    where: { id: requisicionId, empresaId, ...filtroRequisicionesVisibles(usuario) },
    select: { evidenciaRef: true },
  });
  if (!requisicion) throw new RegistroNoEncontradoError("La requisición");
  return requisicion.evidenciaRef;
}

export async function obtenerRefArchivoCotizacion(usuario: UsuarioSesion, cotizacionId: string): Promise<string | null> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const cotizacion = await db.cotizacion.findFirst({
    where: { id: cotizacionId, requisicion: { empresaId, ...filtroRequisicionesVisibles(usuario) } },
    select: { archivoRef: true },
  });
  if (!cotizacion) throw new RegistroNoEncontradoError("La cotización");
  return cotizacion.archivoRef;
}

// Todas las requisiciones de la Empresa que necesitan atención de
// Administrador/Director — para el módulo global "Compras" (Fase 4). Nunca
// duplica obtenerRequisiciones, solo agrega el filtro cross-proyecto.
export type FilaRequisicionGlobal = FilaRequisicion & { empresaId: string };

export async function obtenerRequisicionesGlobal(usuario: UsuarioSesion): Promise<FilaRequisicionGlobal[]> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const requisiciones = await db.requisicion.findMany({
    where: { empresaId, ...filtroRequisicionesVisibles(usuario), estatus: { in: ["PENDIENTE", "EN_COTIZACION"] } },
    include: INCLUDE_REQUISICION,
    orderBy: { createdAt: "desc" },
  });

  return requisiciones.map((r) => ({ ...aFilaRequisicion(r), empresaId }));
}

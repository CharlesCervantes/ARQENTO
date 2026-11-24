import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import {
  puedeCapturarGastos,
  puedeAutorizarOrdenesCompra,
} from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";
import { CATEGORIAS_GASTO } from "@/lib/control-de-obra/categorias-gasto";
import { EMPRESA_PROYECTO_LABEL } from "./proyecto-oficina";
import { obtenerBrandingEmpresa, type BrandingEmpresa } from "@/lib/server/branding";
import { obtenerArchivo } from "@/lib/server/archivos";

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

const ESTATUS_EDITABLES = ["BORRADOR", "PENDIENTE_AUTORIZACION"] as const;

const LineaSchema = z.object({
  concepto: z.string().trim().min(1, "El concepto es obligatorio."),
  descripcion: z.string().trim().optional().nullable(),
  unidad: z.string().trim().min(1, "La unidad es obligatoria."),
  cantidad: z.coerce.number().positive("La cantidad debe ser mayor a cero."),
  precioUnitario: z.coerce.number().nonnegative(),
});

const DatosOrdenCompraSchema = z.object({
  proveedorBeneficiarioId: z.string().trim().min(1, "Selecciona un proveedor."),
  fecha: z.coerce.date(),
  metodoPago: z
    .enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO"])
    .optional()
    .nullable(),
  requiereFactura: z.coerce.boolean().default(false),
  notas: z.string().trim().optional().nullable(),
  tratamientoCliente: z
    .enum(["INCLUIDO_EN_CONTRATO", "COBRABLE_EN_ESTIMACION", "NO_COBRABLE"])
    .default("NO_COBRABLE"),
  detalle: z.array(LineaSchema).min(1, "Agrega al menos una línea."),
});

function totalDetalle(detalle: { cantidad: number; precioUnitario: number }[]): number {
  return detalle.reduce((t, l) => t + l.cantidad * l.precioUnitario, 0);
}

// `requisicionId` opcional — cuando se genera la OC desde una Requisición
// (Compras, septiembre 2026), el proveedor y la referencia de cotización se
// leen SIEMPRE de la Cotización seleccionada (nunca del `datosCrudos` del
// cliente, para que la OC no pueda terminar con un proveedor distinto al que
// realmente se decidió comparando cotizaciones) — el usuario solo captura el
// detalle formal (conceptos/cantidades/precios). La Requisición pasa a
// CONVERTIDA en la misma transacción; el `@unique` en `requisicionId`
// garantiza que nunca se genere una segunda OC desde la misma Requisición.
export async function crearOrdenCompra(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  datosCrudos: unknown,
  requisicionId?: string
) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosOrdenCompraSchema.parse(datosCrudos);

  const semana = await db.semana.findFirst({ where: { id: semanaId, empresaId } });
  if (!semana) throw new RegistroNoEncontradoError("La semana");

  let proveedorBeneficiarioId = datos.proveedorBeneficiarioId;
  let cotizacionRef: string | null = null;
  let cotizacionNombre: string | null = null;

  if (requisicionId) {
    const requisicion = await db.requisicion.findFirst({
      where: { id: requisicionId, empresaId, proyectoId },
      include: { cotizaciones: { where: { seleccionada: true } }, ordenCompra: { select: { id: true } } },
    });
    if (!requisicion) throw new RegistroNoEncontradoError("La requisición");
    if (requisicion.ordenCompra) {
      throw new ValidacionError("Esta requisición ya generó una Orden de Compra.");
    }
    if (!["PENDIENTE", "EN_COTIZACION"].includes(requisicion.estatus)) {
      throw new ValidacionError("Esta requisición ya no se puede convertir en Orden de Compra.");
    }
    const seleccionada = requisicion.cotizaciones[0];
    if (!seleccionada) {
      throw new ValidacionError("Selecciona una cotización antes de generar la Orden de Compra.");
    }
    proveedorBeneficiarioId = seleccionada.proveedorBeneficiarioId;
    cotizacionRef = seleccionada.archivoRef;
    cotizacionNombre = seleccionada.archivoNombre;
  }

  return db.$transaction(async (tx) => {
    const empresa = await tx.empresa.update({
      where: { id: empresaId },
      data: { ultimoFolioOrdenCompra: { increment: 1 } },
      select: { ultimoFolioOrdenCompra: true },
    });
    const folio = `OC-${String(empresa.ultimoFolioOrdenCompra).padStart(6, "0")}`;

    // Nace siempre PENDIENTE_AUTORIZACION, sin importar el rol que la
    // captura — misma consistencia que GastoObra/AvanceConcepto.
    const oc = await tx.ordenCompra.create({
      data: {
        empresaId,
        proyectoId,
        semanaId,
        folio,
        numeroFolio: empresa.ultimoFolioOrdenCompra,
        requisicionId: requisicionId || null,
        proveedorBeneficiarioId,
        cotizacionRef,
        cotizacionNombre,
        fecha: datos.fecha,
        metodoPago: datos.metodoPago || null,
        requiereFactura: datos.requiereFactura,
        notas: datos.notas || null,
        tratamientoCliente: datos.tratamientoCliente,
        creadoPorId: usuario.id,
        detalle: { create: datos.detalle },
      },
    });

    if (requisicionId) {
      await tx.requisicion.update({ where: { id: requisicionId }, data: { estatus: "CONVERTIDA" } });
    }

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "OrdenCompra",
      entidadId: oc.id,
      accion: "CREAR",
      valorNuevo: { folio: oc.folio, total: totalDetalle(datos.detalle), requisicionId: requisicionId ?? null },
    });

    return oc;
  });
}

export async function editarOrdenCompra(usuario: UsuarioSesion, ocId: string, datosCrudos: unknown) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosOrdenCompraSchema.parse(datosCrudos);

  const anterior = await db.ordenCompra.findFirst({ where: { id: ocId, empresaId } });
  if (!anterior) throw new RegistroNoEncontradoError("La orden de compra");
  if (!ESTATUS_EDITABLES.includes(anterior.estatus as (typeof ESTATUS_EDITABLES)[number])) {
    throw new ValidacionError("Esta orden de compra ya no se puede editar.");
  }
  if (anterior.creadoPorId !== usuario.id && !puedeAutorizarOrdenesCompra(usuario)) {
    throw new SinPermisoError();
  }

  return db.$transaction(async (tx) => {
    await tx.ordenCompraConcepto.deleteMany({ where: { ordenCompraId: ocId } });
    const oc = await tx.ordenCompra.update({
      where: { id: ocId },
      data: {
        proveedorBeneficiarioId: datos.proveedorBeneficiarioId,
        fecha: datos.fecha,
        metodoPago: datos.metodoPago || null,
        requiereFactura: datos.requiereFactura,
        notas: datos.notas || null,
        tratamientoCliente: datos.tratamientoCliente,
        detalle: { create: datos.detalle },
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "OrdenCompra",
      entidadId: oc.id,
      accion: "EDITAR",
      valorAnterior: { total: null },
      valorNuevo: { total: totalDetalle(datos.detalle) },
    });

    return oc;
  });
}

// ---------------------------------------------------------------------------
// Autorizar — congela el total, crea el MovimientoSemanal en Reporte
// General. Mismo candado/idempotencia que aprobarReposicion.
// ---------------------------------------------------------------------------

export async function autorizarOrdenCompra(usuario: UsuarioSesion, ocId: string) {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ordenes_compra WHERE id = ${ocId} FOR UPDATE`;

    const oc = await tx.ordenCompra.findFirst({
      where: { id: ocId, empresaId },
      include: { detalle: true },
    });
    if (!oc) throw new RegistroNoEncontradoError("La orden de compra");
    if (oc.estatus === "AUTORIZADA") return oc;
    if (oc.estatus !== "PENDIENTE_AUTORIZACION") {
      throw new ValidacionError("Solo se puede autorizar una orden de compra pendiente.");
    }

    const total = oc.detalle.reduce((t, l) => t + Number(l.cantidad) * Number(l.precioUnitario), 0);
    if (total <= 0) {
      throw new ValidacionError("No se puede autorizar una orden de compra sin importe.");
    }

    // El proveedor del catálogo global no necesita haber sido asignado antes
    // a este proyecto — se crea aquí su participación si hace falta.
    // Idempotente por el @@unique([beneficiarioId, proyectoId]), mismo
    // patrón que obtenerOCrearParticipacionContratista/aprobarReposicion.
    const beneficiarioProyecto = await tx.beneficiarioProyecto.upsert({
      where: {
        beneficiarioId_proyectoId: {
          beneficiarioId: oc.proveedorBeneficiarioId,
          proyectoId: oc.proyectoId,
        },
      },
      update: {},
      create: {
        beneficiarioId: oc.proveedorBeneficiarioId,
        proyectoId: oc.proyectoId,
      },
    });

    const movimiento = await tx.movimientoSemanal.create({
      data: {
        beneficiarioProyectoId: beneficiarioProyecto.id,
        semanaId: oc.semanaId,
        origen: "ORDEN_COMPRA",
        montoFinSemana: total,
        estatusAprobacion: "APROBADO",
        estatusPago: "PENDIENTE_PAGO",
        enviadoPorId: usuario.id,
        aprobadoPorId: usuario.id,
      },
    });

    const actualizada = await tx.ordenCompra.update({
      where: { id: ocId },
      data: {
        estatus: "AUTORIZADA",
        totalAutorizado: total,
        autorizadoPorId: usuario.id,
        autorizadoEn: new Date(),
        movimientoSemanalId: movimiento.id,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "OrdenCompra",
      entidadId: actualizada.id,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "PENDIENTE_AUTORIZACION" },
      valorNuevo: { estatus: "AUTORIZADA", total, movimientoSemanalId: movimiento.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoSemanal",
      entidadId: movimiento.id,
      accion: "CREAR",
      valorNuevo: { origen: "ORDEN_COMPRA", montoFinSemana: total, ordenCompraId: ocId },
    });

    return actualizada;
  });
}

const MotivoRechazoSchema = z.string().trim().min(1, "El motivo del rechazo es obligatorio.");

export async function rechazarOrdenCompra(usuario: UsuarioSesion, ocId: string, motivoCrudo: unknown) {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const motivo = MotivoRechazoSchema.parse(motivoCrudo);

  const oc = await db.ordenCompra.findFirst({ where: { id: ocId, empresaId } });
  if (!oc) throw new RegistroNoEncontradoError("La orden de compra");
  if (oc.estatus !== "PENDIENTE_AUTORIZACION") {
    throw new ValidacionError("Solo se puede rechazar una orden de compra pendiente.");
  }

  const actualizada = await db.ordenCompra.update({
    where: { id: ocId },
    data: { estatus: "RECHAZADA", notas: [oc.notas, `Rechazada: ${motivo}`].filter(Boolean).join(" — ") },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "OrdenCompra",
    entidadId: actualizada.id,
    accion: "RECHAZAR",
    valorAnterior: { estatus: "PENDIENTE_AUTORIZACION" },
    valorNuevo: { estatus: "RECHAZADA", motivo },
  });

  return actualizada;
}

export async function cancelarOrdenCompra(usuario: UsuarioSesion, ocId: string) {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const oc = await db.ordenCompra.findFirst({ where: { id: ocId, empresaId } });
  if (!oc) throw new RegistroNoEncontradoError("La orden de compra");
  if (oc.estatus === "AUTORIZADA") {
    throw new ValidacionError("Una orden de compra ya autorizada no se puede cancelar aquí.");
  }

  const actualizada = await db.ordenCompra.update({
    where: { id: ocId },
    data: { estatus: "CANCELADA" },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "OrdenCompra",
    entidadId: actualizada.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: oc.estatus },
    valorNuevo: { estatus: "CANCELADA" },
  });

  return actualizada;
}

// ---------------------------------------------------------------------------
// Generar gasto desde una OC ejecutada (sección 28, opción B) — nace
// APROBADO directamente porque ya pasó por la autorización de la OC, no
// tiene sentido pedir una segunda revisión. pagadorBeneficiarioId siempre
// null: Conkuali pagó directo vía la OC, no hay reposición a nadie.
// ---------------------------------------------------------------------------

// El monto SIEMPRE es oc.totalAutorizado — nunca se vuelve a pedir ni se
// permite una segunda cifra para la misma compra (Compras, septiembre 2026).
// Si más adelante llega una factura con un importe distinto, la diferencia
// se muestra como advertencia fiscal/contable con el mecanismo ya existente
// de diferencia CFDI (obtenerFacturasConDiferencia) — nunca se reescribe
// este Gasto en silencio.
const DatosGastoDesdeOCSchema = z.object({
  fecha: z.coerce.date(),
  categoria: z.enum(CATEGORIAS_GASTO).default("MATERIAL"),
  metodoPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO"]),
  comentario: z.string().trim().optional().nullable(),
  comprobantePagoRef: z.string().trim().optional().nullable(),
  comprobantePagoNombre: z.string().trim().optional().nullable(),
});

export async function generarGastoDesdeOrdenCompra(
  usuario: UsuarioSesion,
  ocId: string,
  datosCrudos: unknown
) {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosGastoDesdeOCSchema.parse(datosCrudos);

  const oc = await db.ordenCompra.findFirst({
    where: { id: ocId, empresaId },
    include: { _count: { select: { gastosGenerados: true } } },
  });
  if (!oc) throw new RegistroNoEncontradoError("La orden de compra");
  if (oc.estatus !== "AUTORIZADA") {
    throw new ValidacionError("Solo se puede generar el gasto real de una orden de compra autorizada.");
  }
  if (oc._count.gastosGenerados > 0) {
    throw new ValidacionError("Esta orden de compra ya tiene un gasto generado.");
  }
  if (oc.totalAutorizado === null) {
    throw new ValidacionError("Esta orden de compra no tiene un total autorizado.");
  }
  const monto = Number(oc.totalAutorizado);

  return db.$transaction(async (tx) => {
    if (datos.comprobantePagoRef) {
      await tx.ordenCompra.update({
        where: { id: ocId },
        data: {
          comprobantePagoRef: datos.comprobantePagoRef,
          comprobantePagoNombre: datos.comprobantePagoNombre || null,
        },
      });
    }

    const gasto = await tx.gastoObra.create({
      data: {
        empresaId,
        proyectoId: oc.proyectoId,
        semanaId: oc.semanaId,
        fecha: datos.fecha,
        descripcion: `Compra ${oc.folio}`,
        categoria: datos.categoria,
        monto,
        metodoPago: datos.metodoPago,
        pagadorBeneficiarioId: null,
        proveedorBeneficiarioId: oc.proveedorBeneficiarioId,
        comentario: datos.comentario || null,
        requiereFactura: oc.requiereFactura,
        tratamientoCliente: oc.tratamientoCliente,
        ordenCompraId: oc.id,
        estatus: "APROBADO",
        capturadoPorId: usuario.id,
        revisadoPorId: usuario.id,
        revisadoEn: new Date(),
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "GastoObra",
      entidadId: gasto.id,
      accion: "CREAR",
      valorNuevo: { descripcion: gasto.descripcion, monto, ordenCompraId: oc.id },
    });

    return gasto;
  });
}

// ---------------------------------------------------------------------------
// Recepción — INDEPENDIENTE del pago y del Gasto documental (Compras,
// septiembre 2026). Puede marcarse en cualquier momento después de
// autorizada, sin importar si ya se generó el gasto o si ya se pagó.
// ---------------------------------------------------------------------------

const DatosRecepcionSchema = z.object({
  estatusRecepcion: z.enum(["PARCIAL", "COMPLETA"]),
  evidenciaRecepcionRef: z.string().trim().optional().nullable(),
  evidenciaRecepcionNombre: z.string().trim().optional().nullable(),
  comentarioRecepcion: z.string().trim().optional().nullable(),
});

export async function marcarRecepcionOrdenCompra(usuario: UsuarioSesion, ocId: string, datosCrudos: unknown) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosRecepcionSchema.parse(datosCrudos);

  const oc = await db.ordenCompra.findFirst({ where: { id: ocId, empresaId } });
  if (!oc) throw new RegistroNoEncontradoError("La orden de compra");
  if (oc.estatus !== "AUTORIZADA") {
    throw new ValidacionError("Solo se puede registrar la recepción de una orden de compra autorizada.");
  }

  const actualizada = await db.ordenCompra.update({
    where: { id: ocId },
    data: {
      estatusRecepcion: datos.estatusRecepcion,
      recibidoEn: new Date(),
      recibidoPorId: usuario.id,
      evidenciaRecepcionRef: datos.evidenciaRecepcionRef || null,
      evidenciaRecepcionNombre: datos.evidenciaRecepcionNombre || null,
      comentarioRecepcion: datos.comentarioRecepcion || null,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "OrdenCompra",
    entidadId: actualizada.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatusRecepcion: oc.estatusRecepcion },
    valorNuevo: { estatusRecepcion: datos.estatusRecepcion },
  });

  return actualizada;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export type LineaOrdenCompra = {
  id: string;
  concepto: string;
  descripcion: string | null;
  unidad: string;
  cantidad: number;
  precioUnitario: number;
  importe: number;
};

export type FilaOrdenCompra = {
  id: string;
  folio: string;
  requisicionId: string | null;
  proveedorBeneficiarioId: string;
  proveedorNombre: string;
  fecha: string;
  estatus: string;
  total: number;
  estatusPago: string | null;
  requiereFactura: boolean;
  tratamientoCliente: string;
  creadoPorNombre: string;
  autorizadoPorNombre: string | null;
  tieneGastoGenerado: boolean;
  // Recepción — SIEMPRE independiente de estatus/estatusPago (Compras,
  // septiembre 2026), nunca se combinan en un solo indicador.
  estatusRecepcion: string;
  recibidoEn: string | null;
  recibidoPorNombre: string | null;
  comentarioRecepcion: string | null;
  detalle: LineaOrdenCompra[];
};

const INCLUDE_OC = {
  proveedor: { select: { nombre: true } },
  creadoPor: { select: { nombre: true } },
  autorizadoPor: { select: { nombre: true } },
  recibidoPor: { select: { nombre: true } },
  movimientoSemanal: { select: { estatusPago: true } },
  detalle: true,
  _count: { select: { gastosGenerados: true } },
} as const;

type OCConIncludes = Prisma.OrdenCompraGetPayload<{ include: typeof INCLUDE_OC }>;

function filaOrdenCompra(oc: OCConIncludes): FilaOrdenCompra {
  const detalle = oc.detalle.map((l) => ({
    id: l.id,
    concepto: l.concepto,
    descripcion: l.descripcion,
    unidad: l.unidad,
    cantidad: Number(l.cantidad),
    precioUnitario: Number(l.precioUnitario),
    importe: Number(l.cantidad) * Number(l.precioUnitario),
  }));
  const total = oc.totalAutorizado !== null ? Number(oc.totalAutorizado) : detalle.reduce((t, l) => t + l.importe, 0);

  return {
    id: oc.id,
    folio: oc.folio,
    requisicionId: oc.requisicionId,
    proveedorBeneficiarioId: oc.proveedorBeneficiarioId,
    proveedorNombre: oc.proveedor.nombre,
    fecha: oc.fecha.toISOString(),
    estatus: oc.estatus,
    total,
    estatusPago: oc.movimientoSemanal?.estatusPago ?? null,
    requiereFactura: oc.requiereFactura,
    tratamientoCliente: oc.tratamientoCliente,
    creadoPorNombre: oc.creadoPor.nombre,
    autorizadoPorNombre: oc.autorizadoPor?.nombre ?? null,
    tieneGastoGenerado: oc._count.gastosGenerados > 0,
    estatusRecepcion: oc.estatusRecepcion,
    recibidoEn: oc.recibidoEn?.toISOString() ?? null,
    recibidoPorNombre: oc.recibidoPor?.nombre ?? null,
    comentarioRecepcion: oc.comentarioRecepcion,
    detalle,
  };
}

export async function obtenerOrdenesCompra(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<FilaOrdenCompra[]> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  await obtenerProyecto(usuario, proyectoId);

  const ordenes = await db.ordenCompra.findMany({
    where: { proyectoId, semanaId },
    include: INCLUDE_OC,
    orderBy: { createdAt: "desc" },
  });

  return ordenes.map(filaOrdenCompra);
}

// ---------------------------------------------------------------------------
// Vista global "Compras" (Administrador/Director, todas las obras + Empresa)
// — Fase 4, Compras septiembre 2026. Transversal sobre las mismas OC ya
// existentes, nunca un segundo modelo ni una segunda consulta de negocio.
// ---------------------------------------------------------------------------

export type FilaOrdenCompraGlobal = FilaOrdenCompra & { proyectoId: string; proyectoNombre: string };

export async function obtenerOrdenesCompraPendientesGlobal(usuario: UsuarioSesion): Promise<{
  pendientesAutorizacion: FilaOrdenCompraGlobal[];
  pendientesPago: FilaOrdenCompraGlobal[];
  pendientesRecepcion: FilaOrdenCompraGlobal[];
}> {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const ordenes = await db.ordenCompra.findMany({
    where: {
      empresaId,
      OR: [
        { estatus: "PENDIENTE_AUTORIZACION" },
        { estatus: "AUTORIZADA", movimientoSemanal: { estatusPago: "PENDIENTE_PAGO" } },
        { estatus: "AUTORIZADA", estatusRecepcion: { not: "COMPLETA" } },
      ],
    },
    include: { ...INCLUDE_OC, proyecto: { select: { id: true, nombre: true, tipo: true } } },
    orderBy: { createdAt: "desc" },
  });

  const pendientesAutorizacion: FilaOrdenCompraGlobal[] = [];
  const pendientesPago: FilaOrdenCompraGlobal[] = [];
  const pendientesRecepcion: FilaOrdenCompraGlobal[] = [];

  for (const oc of ordenes) {
    const fila: FilaOrdenCompraGlobal = {
      ...filaOrdenCompra(oc),
      proyectoId: oc.proyecto.id,
      proyectoNombre: oc.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : oc.proyecto.nombre,
    };
    if (oc.estatus === "PENDIENTE_AUTORIZACION") pendientesAutorizacion.push(fila);
    if (oc.estatus === "AUTORIZADA" && oc.movimientoSemanal?.estatusPago === "PENDIENTE_PAGO") pendientesPago.push(fila);
    if (oc.estatus === "AUTORIZADA" && oc.estatusRecepcion !== "COMPLETA") pendientesRecepcion.push(fila);
  }

  return { pendientesAutorizacion, pendientesPago, pendientesRecepcion };
}

// Gastos generados desde una OC que siguen esperando factura — mismo
// criterio exacto que obtenerFacturasPendientes (Contabilidad), acotado a
// origen Compras (GastoObra.ordenCompraId no nulo) para el panel global.
// Nunca un sistema de facturas paralelo — Contabilidad sigue siendo la
// fuente fiscal.
export type FilaFacturaPendienteCompra = {
  gastoId: string;
  ordenCompraFolio: string;
  proyectoNombre: string;
  monto: number;
  fecha: string;
};

export async function obtenerFacturasPendientesCompras(usuario: UsuarioSesion): Promise<FilaFacturaPendienteCompra[]> {
  if (!puedeAutorizarOrdenesCompra(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const gastos = await db.gastoObra.findMany({
    where: { empresaId, estatus: "APROBADO", requiereFactura: true, facturaRef: null, ordenCompraId: { not: null } },
    include: { ordenCompra: { select: { folio: true } }, proyecto: { select: { nombre: true, tipo: true } } },
    orderBy: { fecha: "desc" },
  });

  return gastos.map((g) => ({
    gastoId: g.id,
    ordenCompraFolio: g.ordenCompra?.folio ?? "",
    proyectoNombre: g.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : g.proyecto.nombre,
    monto: Number(g.monto),
    fecha: g.fecha.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// PDF — documento externo que se le entrega al proveedor (Compras, Fase 5,
// septiembre 2026). Branding en VIVO (nombre/razón social/logo actuales de
// Empresa) — a diferencia de Recibo/Estimación, una Orden de Compra no
// necesita un snapshot histórico congelado del branding: es un documento
// que se genera y se envía en el momento, no se re-descarga meses después
// para comparar contra un corte contable pasado.
// ---------------------------------------------------------------------------

export type DatosPdfOrdenCompra = {
  folio: string;
  fecha: string;
  proyectoNombre: string;
  proveedorNombre: string;
  proveedorRazonSocial: string | null;
  proveedorRfc: string | null;
  notas: string | null;
  total: number;
  branding: BrandingEmpresa;
  logoBuffer: Buffer | null;
  detalle: LineaOrdenCompra[];
};

export async function obtenerDatosPdfOrdenCompra(usuario: UsuarioSesion, ocId: string): Promise<DatosPdfOrdenCompra> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const oc = await db.ordenCompra.findFirst({
    where: { id: ocId, empresaId },
    include: {
      proyecto: { select: { nombre: true, tipo: true } },
      proveedor: { select: { nombre: true, proveedor: { select: { razonSocial: true, rfc: true } } } },
      detalle: true,
    },
  });
  if (!oc) throw new RegistroNoEncontradoError("La orden de compra");

  const [branding, detalleConImporte] = [
    await obtenerBrandingEmpresa(empresaId),
    oc.detalle.map((l) => ({
      id: l.id,
      concepto: l.concepto,
      descripcion: l.descripcion,
      unidad: l.unidad,
      cantidad: Number(l.cantidad),
      precioUnitario: Number(l.precioUnitario),
      importe: Number(l.cantidad) * Number(l.precioUnitario),
    })),
  ];
  const logoBuffer = branding.logoRef ? await obtenerArchivo(branding.logoRef).catch(() => null) : null;
  const total =
    oc.totalAutorizado !== null ? Number(oc.totalAutorizado) : detalleConImporte.reduce((t, l) => t + l.importe, 0);

  return {
    folio: oc.folio,
    fecha: oc.fecha.toISOString(),
    proyectoNombre: oc.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : oc.proyecto.nombre,
    proveedorNombre: oc.proveedor.nombre,
    proveedorRazonSocial: oc.proveedor.proveedor?.razonSocial ?? null,
    proveedorRfc: oc.proveedor.proveedor?.rfc ?? null,
    notas: oc.notas,
    total,
    branding,
    logoBuffer,
    detalle: detalleConImporte,
  };
}

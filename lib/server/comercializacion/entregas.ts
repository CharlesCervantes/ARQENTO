import "server-only";
import { randomBytes } from "crypto";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { eliminarArchivo, obtenerArchivo, subirBytes } from "@/lib/server/archivos";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { requerirAdministracionComercial, requerirUsoComercial } from "@/lib/server/comercializacion/acceso";
import { alcance } from "@/lib/server/comercializacion/cotizaciones";
import { hoyDeEmpresa } from "@/lib/server/comercializacion/cuentas";
import { aMilesimas, formatearCantidad, normalizarCantidad } from "@/lib/comercializacion/importes";
import { dateAFecha, fechaADate, normalizarFecha } from "@/lib/comercializacion/fechas";
import {
  MAX_BYTES_EVIDENCIAS_POR_ENTREGA,
  MAX_EVIDENCIAS_POR_ENTREGA,
  avancePartida,
  estadoEntrega,
  type EstadoEntrega,
} from "@/lib/comercializacion/entregas";
import { nombreSeguroDeArchivo, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";

// Entregas parciales al cliente/obra — B6A (noviembre 2026).
// docs/negocio/comercializacion.md §20 (B6A). Reglas:
// - Una entrega pertenece a una OV aceptada de la Empresa. Registran:
//   Administrador/Director (toda la Empresa) y el vendedor asignado (solo sus
//   OV). Solo administración anula, con motivo.
// - pendiente por entregar = vendido − Σ cantidades de entregas CONFIRMADAS.
//   Cantidades positivas, de hasta 3 decimales, sin superar lo pendiente; una
//   partida una sola vez por entrega. La OV se bloquea al registrar, así que
//   dos registros simultáneos no pueden superar juntos lo vendido (y la base
//   lo vuelve a comprobar).
// - Se registra CONFIRMADA con al menos una evidencia válida (fotografía o
//   remisión). Si un archivo es inválido, no se registra nada.
// - Acredita entrega AL CLIENTE contra la OV: no se vincula a una compra
//   (COC), no marca compras como recibidas, no crea inventario y no toca
//   precios, compras, cuentas, cobros, pagos ni construcción.
// - No se edita ni se borra: se anula (conserva registro y evidencias).

export const ENTIDAD_ENTREGA = "EntregaComercial";
const MAX_PARTIDAS = 200;

type Cliente = Prisma.TransactionClient | typeof db;
export type ArchivoEvidenciaEntrega = { nombre: string | null; bytes: Uint8Array };

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

async function eliminarSinFallar(refs: string[]) {
  for (const ref of refs) {
    try {
      await eliminarArchivo(ref);
    } catch {
      // Un archivo huérfano no compromete datos: ninguna fila lo referencia.
    }
  }
}

/** OV dentro del alcance del usuario (Empresa y, para el vendedor, sus OV). */
async function ordenEnAlcance(cliente: Cliente, usuario: UsuarioSesion, empresaId: string, ordenVentaId: unknown) {
  if (typeof ordenVentaId !== "string" || !ordenVentaId) throw new RegistroNoEncontradoError("La orden de venta");
  const ov = await cliente.ordenVenta.findFirst({
    where: { id: ordenVentaId, empresaId, cotizacion: { ...alcance(usuario, empresaId), estatus: "ACEPTADA" } },
    select: { id: true, folio: true, cotizacionId: true },
  });
  if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
  return ov;
}

// ---------------------------------------------------------------------------
// Cantidades y estado
// ---------------------------------------------------------------------------

export type PartidaAvanceEntrega = {
  partidaVentaId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  vendido: string;
  entregado: string;
  pendiente: string;
  completa: boolean;
};

async function avanceDeOrden(cliente: Cliente, empresaId: string, cotizacionId: string): Promise<PartidaAvanceEntrega[]> {
  const partidas = await cliente.partidaCotizacionVenta.findMany({
    where: { cotizacionId, empresaId },
    orderBy: { orden: "asc" },
    select: {
      id: true,
      codigo: true,
      descripcion: true,
      unidad: true,
      cantidad: true,
      partidasEntrega: { where: { entrega: { estatus: "CONFIRMADA" } }, select: { cantidad: true } },
    },
  });
  return partidas.map((p) => ({
    partidaVentaId: p.id,
    codigo: p.codigo,
    descripcion: p.descripcion,
    unidad: p.unidad,
    ...avancePartida(
      p.cantidad.toFixed(3),
      p.partidasEntrega.map((e) => e.cantidad.toFixed(3))
    ),
  }));
}

export type EntregaDetalle = {
  id: string;
  numero: number;
  estatus: "CONFIRMADA" | "ANULADA";
  fechaEntrega: string;
  recibidoPor: string | null;
  observaciones: string | null;
  registradaPorNombre: string;
  registradaEn: string;
  anulada: { en: string; porNombre: string | null; motivo: string } | null;
  partidas: { codigo: string; descripcion: string; unidad: string; cantidad: string }[];
  evidencias: { id: string; nombre: string; clase: "FOTOGRAFIA" | "REMISION"; bytes: number }[];
};

export type ResumenEntregasOrden = {
  ordenVentaId: string;
  folio: string;
  estado: EstadoEntrega;
  completas: number;
  totalPartidas: number;
  partidas: PartidaAvanceEntrega[];
  entregas: EntregaDetalle[];
  puedeAnular: boolean;
  hoy: string;
};

/** Bloque «Entregas y documentos» de una OV — administración y vendedor asignado. */
export async function resumenEntregasOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<ResumenEntregasOrden> {
  const empresaId = requerirUsoComercial(usuario);
  const ov = await ordenEnAlcance(db, usuario, empresaId, ordenVentaId);
  const [partidas, entregas, hoy] = await Promise.all([
    avanceDeOrden(db, empresaId, ov.cotizacionId),
    db.entregaComercial.findMany({
      where: { ordenVentaId: ov.id, empresaId },
      orderBy: { numero: "desc" },
      select: {
        id: true,
        numero: true,
        estatus: true,
        fechaEntrega: true,
        recibidoPor: true,
        observaciones: true,
        createdAt: true,
        registradaPor: { select: { nombre: true } },
        anuladaEn: true,
        anuladaPor: { select: { nombre: true } },
        motivoAnulacion: true,
        partidas: {
          select: { cantidad: true, partidaVenta: { select: { codigo: true, descripcion: true, unidad: true, orden: true } } },
          orderBy: { partidaVenta: { orden: "asc" } },
        },
        evidencias: { select: { id: true, nombre: true, clase: true, bytes: true }, orderBy: { orden: "asc" } },
      },
    }),
    hoyDeEmpresa(db, empresaId),
  ]);
  const { estado, completas, total } = estadoEntrega(partidas);
  return {
    ordenVentaId: ov.id,
    folio: ov.folio,
    estado,
    completas,
    totalPartidas: total,
    partidas,
    puedeAnular: esAdministradorComercial(usuario),
    hoy,
    entregas: entregas.map((e) => ({
      id: e.id,
      numero: e.numero,
      estatus: e.estatus,
      fechaEntrega: dateAFecha(e.fechaEntrega),
      recibidoPor: e.recibidoPor,
      observaciones: e.observaciones,
      registradaPorNombre: e.registradaPor.nombre,
      registradaEn: e.createdAt.toISOString(),
      anulada: e.anuladaEn ? { en: e.anuladaEn.toISOString(), porNombre: e.anuladaPor?.nombre ?? null, motivo: e.motivoAnulacion ?? "" } : null,
      partidas: e.partidas.map((p) => ({
        codigo: p.partidaVenta.codigo,
        descripcion: p.partidaVenta.descripcion,
        unidad: p.partidaVenta.unidad,
        cantidad: p.cantidad.toFixed(3),
      })),
      evidencias: e.evidencias,
    })),
  };
}

export type EstadoEntregaOrden = { estado: EstadoEntrega; completas: number; total: number };

/** Estado de entrega de varias OV (listado). Solo las del alcance del usuario. */
export async function estadoEntregaDeOrdenes(usuario: UsuarioSesion, ordenIds: string[]): Promise<Map<string, EstadoEntregaOrden>> {
  const empresaId = requerirUsoComercial(usuario);
  if (ordenIds.length === 0) return new Map();
  const ordenes = await db.ordenVenta.findMany({
    where: { id: { in: ordenIds }, empresaId, cotizacion: alcance(usuario, empresaId) },
    select: {
      id: true,
      cotizacion: {
        select: {
          partidas: {
            select: { cantidad: true, partidasEntrega: { where: { entrega: { estatus: "CONFIRMADA" } }, select: { cantidad: true } } },
          },
        },
      },
    },
  });
  return new Map(
    ordenes.map((o) => [
      o.id,
      estadoEntrega(o.cotizacion.partidas.map((p) => avancePartida(p.cantidad.toFixed(3), p.partidasEntrega.map((e) => e.cantidad.toFixed(3))))),
    ])
  );
}

/**
 * Indicador «Entregas pendientes» (B6B, solo administración): número de OV
 * aceptadas de la Empresa con al menos una partida pendiente de entregar,
 * una vez por OV, con las reglas de B6A (entregas anuladas no cuentan). No
 * suma cantidades de unidades distintas.
 */
export async function contarOrdenesConEntregaPendiente(usuario: UsuarioSesion): Promise<number> {
  const empresaId = requerirAdministracionComercial(usuario);
  const ordenes = await db.ordenVenta.findMany({
    where: { empresaId },
    select: {
      cotizacion: {
        select: {
          partidas: {
            select: { cantidad: true, partidasEntrega: { where: { entrega: { estatus: "CONFIRMADA" } }, select: { cantidad: true } } },
          },
        },
      },
    },
  });
  return ordenes.filter(
    (o) => estadoEntrega(o.cotizacion.partidas.map((p) => avancePartida(p.cantidad.toFixed(3), p.partidasEntrega.map((e) => e.cantidad.toFixed(3))))).estado !== "COMPLETA"
  ).length;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

const textoOpcional = (max: number, campo: string) =>
  z
    .string()
    .trim()
    .max(max, `${campo} admite máximo ${max} caracteres.`)
    .nullish()
    .transform((v) => (v ? v : null));

const esquemaEntrega = z.object({
  fechaEntrega: z.unknown(),
  recibidoPor: textoOpcional(150, "Quién recibe"),
  observaciones: textoOpcional(1000, "Las observaciones"),
  partidas: z
    .array(z.object({ partidaVentaId: z.string().min(1), cantidad: z.unknown() }), { error: "Indica las cantidades entregadas." })
    .max(MAX_PARTIDAS, "Demasiadas partidas."),
});

type EvidenciaValidada = { nombre: string; tipo: "application/pdf" | "image/jpeg" | "image/png"; bytes: Uint8Array };

/** Valida TODAS las evidencias antes de subir nada: una inválida rechaza el registro completo. */
export function validarEvidenciasEntrega(archivos: ArchivoEvidenciaEntrega[] | null | undefined): EvidenciaValidada[] {
  const lista = (archivos ?? []).filter((a) => a && a.bytes && a.bytes.length > 0);
  if (lista.length === 0) throw new ValidacionError("Adjunta al menos una evidencia de la entrega (fotografía JPG/PNG o remisión PDF).");
  if (lista.length > MAX_EVIDENCIAS_POR_ENTREGA) throw new ValidacionError(`Adjunta máximo ${MAX_EVIDENCIAS_POR_ENTREGA} evidencias por entrega.`);
  const mb = MAX_BYTES_EVIDENCIAS_POR_ENTREGA / (1024 * 1024);
  const total = lista.reduce((s, a) => s + a.bytes.length, 0);
  if (total > MAX_BYTES_EVIDENCIAS_POR_ENTREGA) throw new ValidacionError(`Las evidencias suman más de ${mb} MB. Reduce el tamaño o la cantidad de archivos.`);
  const ahora = new Date();
  return lista.map((a) => {
    // Tipo REAL por contenido, nunca por el nombre ni por lo que declara el navegador.
    const tipo = tipoArchivoDetectado(a.bytes);
    if (!tipo) throw new ValidacionError(`«${(a.nombre ?? "archivo").slice(0, 80)}» no es una fotografía JPG/PNG ni un PDF válido. No se registró la entrega.`);
    return { nombre: nombreSeguroDeArchivo(a.nombre, tipo, ahora), tipo, bytes: a.bytes };
  });
}

export type ResultadoEntrega = { entregaId: string; numero: number; existente: boolean };

export async function registrarEntregaComercial(
  usuario: UsuarioSesion,
  ordenVentaId: string,
  datosCrudos: unknown,
  archivos: ArchivoEvidenciaEntrega[] | null | undefined,
  claveCruda: unknown
): Promise<ResultadoEntrega> {
  const empresaId = requerirUsoComercial(usuario);
  const clave = z.string({ error: "Clave de registro inválida. Recarga la página." }).trim().min(8).max(100).parse(claveCruda);

  // Idempotencia: la misma clave devuelve la misma entrega, sin subir archivos.
  const previa = async (): Promise<ResultadoEntrega | null> => {
    const e = await db.entregaComercial.findFirst({ where: { empresaId, claveRegistro: clave }, select: { id: true, numero: true, ordenVentaId: true } });
    if (!e) return null;
    if (e.ordenVentaId !== ordenVentaId) throw new ValidacionError("Clave de registro inválida. Recarga la página.");
    return { entregaId: e.id, numero: e.numero, existente: true };
  };
  const ov = await ordenEnAlcance(db, usuario, empresaId, ordenVentaId);
  const repetida = await previa();
  if (repetida) return repetida;

  const d = esquemaEntrega.parse(datosCrudos ?? {});
  const fechaEntrega = normalizarFecha(d.fechaEntrega);
  if (!fechaEntrega) throw new ValidacionError("Indica la fecha real de la entrega (AAAA-MM-DD).");
  if (fechaEntrega > (await hoyDeEmpresa(db, empresaId))) throw new ValidacionError("La fecha de entrega no puede ser futura.");
  const lineas: { partidaVentaId: string; cantidad: string }[] = [];
  for (const p of d.partidas) {
    // Una fila vacía o en cero es «no se entregó»; cualquier otro valor debe ser una cantidad válida.
    if (p.cantidad === undefined || p.cantidad === null || (typeof p.cantidad === "string" && /^\s*0*(\.0*)?\s*$/.test(p.cantidad))) continue;
    const cantidad = normalizarCantidad(p.cantidad);
    if (!cantidad) throw new ValidacionError("Las cantidades deben ser positivas, con máximo 3 decimales.");
    if (lineas.some((l) => l.partidaVentaId === p.partidaVentaId)) throw new ValidacionError("Una partida aparece una sola vez en cada entrega.");
    lineas.push({ partidaVentaId: p.partidaVentaId, cantidad });
  }
  if (lineas.length === 0) throw new ValidacionError("Indica al menos una cantidad entregada.");
  const evidencias = validarEvidenciasEntrega(archivos);

  // 1) Evidencias al almacenamiento (fuera de la transacción). 2) Todo lo
  // demás es UNA transacción: si falla, se eliminan los archivos recién
  // subidos y no queda ninguna cantidad aplicada.
  const refs: string[] = [];
  try {
    for (const ev of evidencias) {
      const ref = `comercializacion/${empresaId}/entregas/${ov.id}/${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "")}-${ev.nombre}`;
      await subirBytes(ref, ev.bytes, ev.tipo);
      refs.push(ref);
    }
  } catch (error) {
    await eliminarSinFallar(refs);
    throw error;
  }

  try {
    return await db.$transaction(async (tx) => {
      // Bloqueo de la OV (mismo orden que compras: OV primero) y alcance revalidado.
      const veTodaLaEmpresa = esAdministradorComercial(usuario);
      const filas = await tx.$queryRaw<{ id: string }[]>`
        SELECT ov.id FROM ordenes_venta ov
        JOIN cotizaciones_venta c ON c.id = ov."cotizacionId"
        WHERE ov.id = ${ov.id} AND ov."empresaId" = ${empresaId}
          AND (${veTodaLaEmpresa}::boolean OR c."vendedorId" = ${usuario.id})
        FOR UPDATE OF ov`;
      if (filas.length === 0) throw new RegistroNoEncontradoError("La orden de venta");

      const avance = new Map((await avanceDeOrden(tx, empresaId, ov.cotizacionId)).map((p) => [p.partidaVentaId, p]));
      for (const l of lineas) {
        const p = avance.get(l.partidaVentaId);
        if (!p) throw new ValidacionError("Una de las partidas no pertenece a esta orden de venta.");
        if (aMilesimas(l.cantidad) > aMilesimas(p.pendiente)) {
          throw new ValidacionError(
            `${p.codigo}: la entrega (${formatearCantidad(l.cantidad)} ${p.unidad}) supera lo pendiente por entregar (${formatearCantidad(p.pendiente)} ${p.unidad}).`
          );
        }
      }
      const ultima = await tx.entregaComercial.aggregate({ where: { ordenVentaId: ov.id }, _max: { numero: true } });
      const numero = (ultima._max.numero ?? 0) + 1;
      const entrega = await tx.entregaComercial.create({
        data: {
          empresaId,
          ordenVentaId: ov.id,
          numero,
          fechaEntrega: fechaADate(fechaEntrega),
          recibidoPor: d.recibidoPor,
          observaciones: d.observaciones,
          claveRegistro: clave,
          registradaPorId: usuario.id,
        },
        select: { id: true },
      });
      await tx.partidaEntregaComercial.createMany({
        data: lineas.map((l) => ({ empresaId, entregaId: entrega.id, partidaVentaId: l.partidaVentaId, cantidad: l.cantidad })),
      });
      await tx.evidenciaEntregaComercial.createMany({
        data: evidencias.map((ev, i) => ({
          empresaId,
          entregaId: entrega.id,
          orden: i,
          clase: ev.tipo === "application/pdf" ? ("REMISION" as const) : ("FOTOGRAFIA" as const),
          ref: refs[i],
          nombre: ev.nombre,
          tipo: ev.tipo,
          bytes: ev.bytes.length,
        })),
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_ENTREGA,
        entidadId: entrega.id,
        accion: "CREAR",
        valorNuevo: {
          ordenVenta: ov.folio,
          numero,
          fechaEntrega,
          recibidoPor: d.recibidoPor,
          partidas: lineas.map((l) => ({ codigo: avance.get(l.partidaVentaId)!.codigo, cantidad: l.cantidad })),
          evidencias: evidencias.map((ev) => ({ nombre: ev.nombre, tipo: ev.tipo, bytes: ev.bytes.length })),
        },
      });
      return { entregaId: entrega.id, numero, existente: false };
    });
  } catch (error) {
    await eliminarSinFallar(refs);
    // Reintento simultáneo con la misma clave: devuelve la entrega ganadora.
    if (esUnica(error)) {
      const ganadora = await previa().catch(() => null);
      if (ganadora) return ganadora;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Anular (solo administración)
// ---------------------------------------------------------------------------

export async function anularEntregaComercial(
  usuario: UsuarioSesion,
  entregaId: unknown,
  motivoCrudo: unknown
): Promise<{ existente: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof entregaId !== "string" || !entregaId) throw new RegistroNoEncontradoError("La entrega");
  const motivo = z
    .string({ error: "Indica el motivo de la anulación." })
    .trim()
    .min(3, "Indica el motivo de la anulación (mínimo 3 caracteres).")
    .max(500, "El motivo admite máximo 500 caracteres.")
    .parse(motivoCrudo);
  const base = await db.entregaComercial.findFirst({ where: { id: entregaId, empresaId }, select: { ordenVentaId: true } });
  if (!base) throw new RegistroNoEncontradoError("La entrega");

  return db.$transaction(async (tx) => {
    // Mismo orden de bloqueo que el registro: OV y después la entrega.
    await tx.$queryRaw`SELECT id FROM ordenes_venta WHERE id = ${base.ordenVentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    const [e] = await tx.$queryRaw<{ estatus: string; numero: number }[]>`
      SELECT estatus::text AS estatus, numero FROM entregas_comerciales WHERE id = ${entregaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    if (!e) throw new RegistroNoEncontradoError("La entrega");
    if (e.estatus === "ANULADA") return { existente: true }; // idempotente
    await tx.entregaComercial.update({
      where: { id: entregaId },
      data: { estatus: "ANULADA", anuladaEn: new Date(), anuladaPorId: usuario.id, motivoAnulacion: motivo },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_ENTREGA,
      entidadId: entregaId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "CONFIRMADA" },
      valorNuevo: { estatus: "ANULADA", numero: e.numero, motivo },
    });
    return { existente: false };
  });
}

// ---------------------------------------------------------------------------
// Evidencias (descarga)
// ---------------------------------------------------------------------------

/** Evidencia de entrega — mismo alcance que la OV (Empresa y vendedor asignado). */
export async function obtenerEvidenciaEntrega(usuario: UsuarioSesion, evidenciaId: string): Promise<{ bytes: Buffer; tipo: string; nombre: string }> {
  const empresaId = requerirUsoComercial(usuario);
  if (typeof evidenciaId !== "string" || !evidenciaId) throw new RegistroNoEncontradoError("La evidencia");
  const ev = await db.evidenciaEntregaComercial.findFirst({
    where: { id: evidenciaId, empresaId, entrega: { empresaId, ordenVenta: { empresaId, cotizacion: alcance(usuario, empresaId) } } },
    select: { ref: true, tipo: true, nombre: true },
  });
  if (!ev) throw new RegistroNoEncontradoError("La evidencia");
  return { bytes: await obtenerArchivo(ev.ref), tipo: ev.tipo, nombre: ev.nombre };
}


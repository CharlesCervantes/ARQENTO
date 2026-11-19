import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { requerirUsoComercial } from "@/lib/server/comercializacion/acceso";
import {
  ConflictoEdicionError,
  ENTIDAD_COTIZACION,
  alcance,
  crearCotizacionVenta,
} from "@/lib/server/comercializacion/cotizaciones";
import { calcularImportePartida, calcularTotalesCotizacion, comoTratamientoVenta } from "@/lib/comercializacion/importes";
import { dateAFecha, hoyNegocio } from "@/lib/comercializacion/fechas";
import { leerDocumentoEmitido, type DocumentoCotizacion } from "@/lib/comercializacion/documento";

// Emisión y duplicado de cotizaciones de venta — B3 (noviembre 2026).
// docs/negocio/comercializacion.md §20 (B3). Emitir NO envía nada al cliente
// ni significa aceptación: congela el documento (copia histórica) y lo deja
// listo para PDF y para registrar la aceptación.

const SELECT_PARA_DOCUMENTO = {
  id: true,
  empresaId: true,
  folio: true,
  estatus: true,
  version: true,
  fecha: true,
  vigenciaHasta: true,
  descripcion: true,
  condiciones: true,
  observaciones: true,
  subtotal: true,
  iva: true,
  total: true,
  vendedorId: true,
  cliente: { select: { nombre: true, contacto: true, telefono: true } },
  obra: { select: { nombre: true, ubicacion: true } },
  vendedor: { select: { nombre: true } },
  empresa: { select: { nombre: true, razonSocial: true, logoRef: true } },
  partidas: {
    orderBy: { orden: "asc" },
    select: {
      codigo: true,
      descripcion: true,
      unidad: true,
      cantidad: true,
      precioUnitario: true,
      importe: true,
      tratamientoImpuesto: true,
      tasaIva: true,
      producto: { select: { activo: true } },
    },
  },
} as const satisfies Prisma.CotizacionVentaSelect;

type CotizacionParaDocumento = Prisma.CotizacionVentaGetPayload<{ select: typeof SELECT_PARA_DOCUMENTO }>;

/**
 * Arma el documento con datos ACTUALES (al emitir, o como vista previa de un
 * borrador). Los importes se recalculan con las reglas exactas de B2 a partir
 * de cantidad y precio guardados; no se confía en el importe almacenado.
 */
function armarDocumento(c: CotizacionParaDocumento): DocumentoCotizacion {
  const partidas = c.partidas.map((p) => {
    const cantidad = p.cantidad.toFixed(3);
    const precioUnitario = p.precioUnitario.toFixed(2);
    return {
      codigo: p.codigo,
      descripcion: p.descripcion,
      unidad: p.unidad,
      cantidad,
      precioUnitario,
      importe: calcularImportePartida(cantidad, precioUnitario),
      tratamientoImpuesto: comoTratamientoVenta(p.tratamientoImpuesto),
      tasaIva: p.tasaIva === null ? null : p.tasaIva.toFixed(2),
    };
  });
  return {
    version: 1,
    folio: c.folio,
    fecha: dateAFecha(c.fecha),
    vigenciaHasta: c.vigenciaHasta ? dateAFecha(c.vigenciaHasta) : null,
    descripcion: c.descripcion,
    condiciones: c.condiciones,
    observaciones: c.observaciones,
    empresa: { nombre: c.empresa.nombre, razonSocial: c.empresa.razonSocial, logoRef: c.empresa.logoRef },
    cliente: c.cliente ? { nombre: c.cliente.nombre, contacto: c.cliente.contacto, telefono: c.cliente.telefono } : null,
    obra: c.obra ? { nombre: c.obra.nombre, ubicacion: c.obra.ubicacion } : null,
    vendedor: { nombre: c.vendedor.nombre },
    partidas,
    totales: calcularTotalesCotizacion(partidas),
  };
}

/** Vista previa de un borrador (en vivo) — el PDF la marca como BORRADOR. */
export async function documentoDeBorrador(usuario: UsuarioSesion, cotizacionId: string): Promise<DocumentoCotizacion> {
  const empresaId = requerirUsoComercial(usuario);
  const c = await db.cotizacionVenta.findFirst({ where: { id: cotizacionId, ...alcance(usuario, empresaId) }, select: SELECT_PARA_DOCUMENTO });
  if (!c) throw new RegistroNoEncontradoError("La cotización");
  return armarDocumento(c);
}

/** Requisitos para emitir — devuelve la lista de faltantes (vacía = se puede). */
async function faltantesParaEmitir(tx: Prisma.TransactionClient, c: CotizacionParaDocumento & { clienteId: string | null; obraId: string | null }) {
  const faltan: string[] = [];
  if (!c.clienteId) faltan.push("cliente");
  if (!c.obraId) faltan.push("obra del cliente");
  if (!c.descripcion?.trim()) faltan.push("descripción");
  if (!c.vigenciaHasta) faltan.push("vigencia");
  if (c.partidas.length === 0) faltan.push("al menos un material");
  const vendedorElegible = await tx.usuario.findFirst({
    where: {
      id: c.vendedorId,
      empresaId: c.empresaId,
      activo: true,
      OR: [{ rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } }, { rol: "SUPERVISOR", vendedorComercial: true }],
    },
    select: { id: true },
  });
  if (!vendedorElegible) faltan.push("un vendedor elegible (el asignado ya no lo es)");
  return faltan;
}

const esquemaVersion = z.number({ error: "Versión inválida." }).int().min(1);

export async function emitirCotizacionVenta(
  usuario: UsuarioSesion,
  cotizacionId: string,
  versionLeida: unknown
): Promise<{ id: string; version: number }> {
  const empresaId = requerirUsoComercial(usuario);
  const version = esquemaVersion.parse(versionLeida);
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");

  return db.$transaction(async (tx) => {
    const veTodaLaEmpresa = esAdministradorComercial(usuario);
    const bloqueada = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cotizaciones_venta
      WHERE id = ${cotizacionId} AND "empresaId" = ${empresaId}
        AND (${veTodaLaEmpresa}::boolean OR "vendedorId" = ${usuario.id})
      FOR UPDATE`;
    if (bloqueada.length === 0) throw new RegistroNoEncontradoError("La cotización");

    const c = await tx.cotizacionVenta.findFirstOrThrow({
      where: { id: cotizacionId, ...alcance(usuario, empresaId) },
      select: { ...SELECT_PARA_DOCUMENTO, clienteId: true, obraId: true },
    });
    if (c.estatus === "RECHAZADA" || c.estatus === "CANCELADA") {
      throw new ValidacionError(`Esta cotización está ${c.estatus === "RECHAZADA" ? "rechazada" : "cancelada"}: no se emite. Duplícala para una nueva venta.`);
    }
    if (c.estatus !== "BORRADOR") throw new ValidacionError("Esta cotización ya fue emitida.");
    if (c.version !== version) throw new ConflictoEdicionError();

    const faltan = await faltantesParaEmitir(tx, c);
    if (faltan.length > 0) throw new ValidacionError(`Para emitir falta: ${faltan.join(", ")}.`);
    const hoy = hoyNegocio();
    const vigencia = dateAFecha(c.vigenciaHasta!);
    if (vigencia < hoy) throw new ValidacionError("La vigencia ya pasó. Indica una vigencia de hoy en adelante para emitir.");
    const inactivos = c.partidas.filter((p) => !p.producto.activo).map((p) => p.codigo);
    if (inactivos.length > 0) {
      throw new ValidacionError(`Hay materiales desactivados en el catálogo (${inactivos.join(", ")}). Quítalos para emitir.`);
    }

    const documento = armarDocumento(c);
    // Los totales guardados deben coincidir con el recálculo exacto; si no,
    // algo alteró las partidas fuera del servicio y no se emite.
    if (documento.totales.total !== c.total.toFixed(2) || documento.totales.iva !== c.iva.toFixed(2)) {
      throw new ValidacionError("Los totales guardados no coinciden con el cálculo. Guarda el borrador de nuevo antes de emitir.");
    }

    const nuevaVersion = c.version + 1;
    await tx.cotizacionVenta.update({
      where: { id: cotizacionId },
      data: {
        estatus: "EMITIDA",
        emitidaEn: new Date(),
        emitidaPorId: usuario.id,
        documentoEmitido: documento as unknown as Prisma.InputJsonValue,
        version: nuevaVersion,
        actualizadoPorId: usuario.id,
      },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COTIZACION,
      entidadId: cotizacionId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "BORRADOR", version: c.version },
      valorNuevo: { estatus: "EMITIDA", version: nuevaVersion, total: documento.totales.total, vigenciaHasta: vigencia },
    });
    return { id: cotizacionId, version: nuevaVersion };
  });
}

/**
 * Duplicar una cotización EMITIDA o ACEPTADA en un borrador nuevo (folio
 * nuevo, vínculo al origen). El original no se toca. Reglas (provisionales,
 * ver §20 B3):
 * - Pasa por crearCotizacionVenta: mismos permisos y validaciones de B2.
 * - Productos desactivados se omiten (y se informan); el resto toma los datos
 *   ACTUALES del catálogo (código, unidad, impuesto, precio base).
 * - Administración conserva el precio aplicado del original (queda como
 *   ajuste suyo si difiere del catálogo actual). El vendedor recibe el precio
 *   actual de catálogo: no puede usar el duplicado para fijar precios.
 * - Vendedor: el vendedor queda él mismo; administración conserva al vendedor
 *   original si sigue siendo elegible (si no, queda ella misma).
 * - Fecha = hoy; vigencia se conserva solo si sigue vigente.
 */
export async function duplicarCotizacionVenta(
  usuario: UsuarioSesion,
  cotizacionId: string,
  claveCreacion?: unknown
): Promise<{ id: string; folio: string; omitidos: string[]; reintento: boolean }> {
  const empresaId = requerirUsoComercial(usuario);
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");
  const o = await db.cotizacionVenta.findFirst({
    where: { id: cotizacionId, ...alcance(usuario, empresaId) },
    select: {
      id: true,
      estatus: true,
      clienteId: true,
      obraId: true,
      descripcion: true,
      condiciones: true,
      observaciones: true,
      vigenciaHasta: true,
      vendedorId: true,
      partidas: {
        orderBy: { orden: "asc" },
        select: { productoId: true, codigo: true, cantidad: true, precioUnitario: true, producto: { select: { activo: true } } },
      },
    },
  });
  if (!o) throw new RegistroNoEncontradoError("La cotización");
  // B8B: también se duplican las rechazadas y canceladas (el original no cambia).
  if (o.estatus === "BORRADOR") throw new ValidacionError("Un borrador se edita directamente; solo se duplican cotizaciones emitidas, aceptadas, rechazadas o canceladas.");

  const esAdmin = esAdministradorComercial(usuario);
  const omitidos = o.partidas.filter((p) => !p.producto.activo).map((p) => p.codigo);
  const partidas = o.partidas
    .filter((p) => p.producto.activo)
    .map((p) => ({
      productoId: p.productoId,
      cantidad: p.cantidad.toFixed(3),
      ...(esAdmin ? { precioUnitario: p.precioUnitario.toFixed(2) } : {}),
    }));

  let vendedorId: string | undefined;
  if (esAdmin) {
    const elegible = await db.usuario.findFirst({
      where: {
        id: o.vendedorId,
        empresaId,
        activo: true,
        OR: [{ rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } }, { rol: "SUPERVISOR", vendedorComercial: true }],
      },
      select: { id: true },
    });
    vendedorId = elegible ? o.vendedorId : usuario.id;
  }
  const hoy = hoyNegocio();
  const vigencia = o.vigenciaHasta ? dateAFecha(o.vigenciaHasta) : null;

  const r = await crearCotizacionVenta(
    usuario,
    {
      clienteId: o.clienteId,
      obraId: o.obraId,
      descripcion: o.descripcion,
      ...(vendedorId ? { vendedorId } : {}),
      fecha: hoy,
      vigenciaHasta: vigencia && vigencia >= hoy ? vigencia : null,
      condiciones: o.condiciones,
      observaciones: o.observaciones,
      partidas,
    },
    claveCreacion,
    { origenId: o.id }
  );
  return { ...r, omitidos };
}

/** Para el PDF: documento emitido (copia) o vista previa de borrador. */
export async function obtenerDocumentoParaPdf(
  usuario: UsuarioSesion,
  cotizacionId: string
): Promise<{ documento: DocumentoCotizacion; borrador: boolean }> {
  const empresaId = requerirUsoComercial(usuario);
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");
  const c = await db.cotizacionVenta.findFirst({
    where: { id: cotizacionId, ...alcance(usuario, empresaId) },
    select: { estatus: true, documentoEmitido: true },
  });
  if (!c) throw new RegistroNoEncontradoError("La cotización");
  if (c.estatus === "BORRADOR") return { documento: await documentoDeBorrador(usuario, cotizacionId), borrador: true };
  // B8B: un borrador cancelado nunca se emitió; no tiene documento.
  if (!c.documentoEmitido) throw new RegistroNoEncontradoError("El documento de la cotización");
  return { documento: leerDocumentoEmitido(c.documentoEmitido), borrador: false };
}

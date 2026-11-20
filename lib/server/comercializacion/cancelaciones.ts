import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { requerirAdministracionComercial } from "@/lib/server/comercializacion/acceso";
import { ENTIDAD_COTIZACION } from "@/lib/server/comercializacion/cotizaciones";
import { ENTIDAD_CUENTA } from "@/lib/server/comercializacion/cuentas";
import { ENTIDAD_ORDEN_VENTA } from "@/lib/server/comercializacion/ordenes";

// B8B — rechazo/cancelación de cotizaciones y cancelación básica de la OV.
// docs/negocio/comercializacion.md §20 (B8B). Reglas:
// - SOLO Administrador/Director de la Empresa (también por id directo).
// - Rechazo: solo de una cotización EMITIDA. Cancelación: BORRADOR o EMITIDA.
//   Ambos exigen motivo y son terminales: no se editan, emiten ni aceptan; se
//   conservan partidas, folio, copia emitida e historial, y se puede Duplicar.
//   Una cotización ACEPTADA se gestiona con su OV.
// - Cancelar la OV es definitivo y solo procede SIN dinero ni dependencias
//   vigentes: ningún historial de cobros/pagos (aunque estén anulados) en su
//   cuenta, compras o gastos; ninguna compra en borrador o confirmada; ningún
//   gasto, entrega ni vínculo de surtido vigente. No cancela dependencias por
//   su cuenta: muestra los bloqueos con enlaces. La cuenta por cobrar se
//   anula en la MISMA transacción conservando total, calendario e historial.
//   La cotización sigue ACEPTADA y no genera otra OV; para vender de nuevo se
//   duplica.
// - Reintentos: devuelven el resultado existente sin repetir efectos ni
//   sobrescribir el motivo original.
// - Concurrencia: bloqueo de la cotización (emitir/aceptar/rechazar/cancelar)
//   y de la OV → cuenta (mismo orden que B8A); la base lo vuelve a exigir.

const esquemaMotivo = (accion: string) =>
  z
    .string({ error: `Indica el motivo ${accion}.` })
    .trim()
    .min(3, `Indica el motivo ${accion}.`)
    .max(500, "El motivo admite máximo 500 caracteres.");

const ETIQUETA_ESTATUS: Record<string, string> = {
  BORRADOR: "en borrador",
  EMITIDA: "emitida",
  ACEPTADA: "aceptada",
  RECHAZADA: "rechazada",
  CANCELADA: "cancelada",
};

async function bloquearCotizacion(tx: Prisma.TransactionClient, empresaId: string, cotizacionId: unknown) {
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");
  const [c] = await tx.$queryRaw<{ id: string; folio: string; estatus: string; version: number }[]>`
    SELECT id, folio, estatus::text AS estatus, version FROM cotizaciones_venta
    WHERE id = ${cotizacionId} AND "empresaId" = ${empresaId}
    FOR UPDATE`;
  if (!c) throw new RegistroNoEncontradoError("La cotización");
  return c;
}

async function cerrarCotizacion(
  usuario: UsuarioSesion,
  cotizacionId: unknown,
  motivoCrudo: unknown,
  destino: "RECHAZADA" | "CANCELADA"
): Promise<{ yaRegistrado: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const motivo = esquemaMotivo(destino === "RECHAZADA" ? "del rechazo" : "de la cancelación").parse(motivoCrudo);
  return db.$transaction(async (tx) => {
    const c = await bloquearCotizacion(tx, empresaId, cotizacionId);
    // Reintento: mismo resultado, sin repetir efectos ni cambiar el motivo.
    if (c.estatus === destino) return { yaRegistrado: true };
    if (c.estatus === "ACEPTADA") {
      throw new ValidacionError("La cotización ya fue aceptada: se gestiona desde su orden de venta (Cancelar OV).");
    }
    const permitidos = destino === "RECHAZADA" ? ["EMITIDA"] : ["BORRADOR", "EMITIDA"];
    if (!permitidos.includes(c.estatus)) {
      throw new ValidacionError(
        destino === "RECHAZADA"
          ? `Solo se registra el rechazo de una cotización emitida (esta está ${ETIQUETA_ESTATUS[c.estatus] ?? c.estatus}).`
          : `Solo se cancela una cotización en borrador o emitida (esta está ${ETIQUETA_ESTATUS[c.estatus] ?? c.estatus}).`
      );
    }
    const nuevaVersion = c.version + 1;
    await tx.cotizacionVenta.update({
      where: { id: c.id },
      data: { estatus: destino, cerradaEn: new Date(), cerradaPorId: usuario.id, motivoCierre: motivo, version: nuevaVersion, actualizadoPorId: usuario.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COTIZACION,
      entidadId: c.id,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: c.estatus, version: c.version },
      valorNuevo: { estatus: destino, motivo, version: nuevaVersion },
    });
    return { yaRegistrado: false };
  });
}

export const rechazarCotizacionVenta = (usuario: UsuarioSesion, cotizacionId: unknown, motivo: unknown) =>
  cerrarCotizacion(usuario, cotizacionId, motivo, "RECHAZADA");

export const cancelarCotizacionVenta = (usuario: UsuarioSesion, cotizacionId: unknown, motivo: unknown) =>
  cerrarCotizacion(usuario, cotizacionId, motivo, "CANCELADA");

// ---------------------------------------------------------------------------
// Cancelación básica de la OV
// ---------------------------------------------------------------------------

export type BloqueoCancelacionOrden = { texto: string; enlaces: { href: string; etiqueta: string }[] };

type Cliente = Prisma.TransactionClient | typeof db;

/** Motivos concretos que impiden cancelar la OV, con enlaces para atenderlos. */
async function bloqueosCancelacionTx(cliente: Cliente, empresaId: string, ordenVentaId: string, cotizacionId: string): Promise<BloqueoCancelacionOrden[]> {
  const detalle = `/comercializacion/cotizaciones/${cotizacionId}`;
  const [cuenta, compras, gastos, entregas, vinculos] = await Promise.all([
    cliente.cuentaComercial.findFirst({ where: { empresaId, ordenVentaId }, select: { tuvoMovimientos: true } }),
    cliente.compraComercial.findMany({
      where: { empresaId, ordenVentaId },
      orderBy: { numeroFolio: "asc" },
      select: { id: true, folio: true, estatus: true, cuenta: { select: { tuvoMovimientos: true } } },
    }),
    cliente.gastoComercial.findMany({
      where: { empresaId, ordenVentaId },
      orderBy: { numero: "asc" },
      select: { id: true, numero: true, estatus: true, cuenta: { select: { tuvoMovimientos: true } } },
    }),
    cliente.entregaComercial.findMany({ where: { empresaId, ordenVentaId, estatus: "CONFIRMADA" }, orderBy: { numero: "asc" }, select: { id: true, numero: true } }),
    cliente.vinculoSurtidoComercial.findMany({
      where: { empresaId, ordenVentaId, estatus: "VIGENTE", partidaEntrega: { entrega: { estatus: "CONFIRMADA" } }, partidaCompra: { compra: { estatus: "CONFIRMADA" } } },
      select: { partidaEntrega: { select: { entrega: { select: { id: true, numero: true } } } } },
    }),
  ]);
  const b: BloqueoCancelacionOrden[] = [];
  const compra = (c: { id: string; folio: string }) => ({ href: `/comercializacion/compras/${c.id}`, etiqueta: c.folio });
  const gasto = (g: { id: string; numero: number }) => ({ href: `${detalle}#gasto-${g.id}`, etiqueta: `Gasto ${g.numero}` });
  const entrega = (e: { id: string; numero: number }) => ({ href: `${detalle}#entrega-${e.id}`, etiqueta: `Entrega ${e.numero}` });

  if (cuenta?.tuvoMovimientos) b.push({ texto: "La cuenta por cobrar tiene historial de cobros (aunque estén anulados).", enlaces: [{ href: `${detalle}#cobros`, etiqueta: "Cobros del cliente" }] });
  const conPagos = compras.filter((c) => c.cuenta?.tuvoMovimientos);
  if (conPagos.length) b.push({ texto: "Hay compras con historial de pagos al proveedor (aunque estén anulados).", enlaces: conPagos.map(compra) });
  const gastosConPagos = gastos.filter((g) => g.cuenta?.tuvoMovimientos);
  if (gastosConPagos.length) b.push({ texto: "Hay gastos adicionales con historial de pagos (aunque estén anulados).", enlaces: gastosConPagos.map(gasto) });
  const borradores = compras.filter((c) => c.estatus === "BORRADOR");
  if (borradores.length) b.push({ texto: "Hay compras en borrador: descártalas.", enlaces: borradores.map(compra) });
  const confirmadas = compras.filter((c) => c.estatus === "CONFIRMADA");
  if (confirmadas.length) b.push({ texto: "Hay compras confirmadas vigentes: anúlalas primero.", enlaces: confirmadas.map(compra) });
  const gastosVigentes = gastos.filter((g) => g.estatus === "VIGENTE");
  if (gastosVigentes.length) b.push({ texto: "Hay gastos adicionales vigentes: anúlalos primero.", enlaces: gastosVigentes.map(gasto) });
  if (entregas.length) b.push({ texto: "Hay entregas vigentes al cliente: anúlalas primero.", enlaces: entregas.map(entrega) });
  if (vinculos.length) {
    const unicas = [...new Map(vinculos.map((v) => [v.partidaEntrega.entrega.id, v.partidaEntrega.entrega])).values()].sort((x, y) => x.numero - y.numero);
    b.push({ texto: "Hay vínculos de surtido vigentes.", enlaces: unicas.map(entrega) });
  }
  return b;
}

export type EstadoCancelacionOrden = {
  cancelada: { en: string; porNombre: string; motivo: string } | null;
  bloqueos: BloqueoCancelacionOrden[];
};

/** Estado de cancelación de la OV para la pantalla de administración. */
export async function estadoCancelacionOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<EstadoCancelacionOrden> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof ordenVentaId !== "string" || !ordenVentaId) throw new RegistroNoEncontradoError("La orden de venta");
  const ov = await db.ordenVenta.findFirst({
    where: { id: ordenVentaId, empresaId },
    select: { id: true, cotizacionId: true, estatus: true, canceladaEn: true, motivoCancelacion: true, canceladaPor: { select: { nombre: true } } },
  });
  if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
  if (ov.estatus === "CANCELADA") {
    return { cancelada: { en: ov.canceladaEn!.toISOString(), porNombre: ov.canceladaPor?.nombre ?? "—", motivo: ov.motivoCancelacion ?? "" }, bloqueos: [] };
  }
  return { cancelada: null, bloqueos: await bloqueosCancelacionTx(db, empresaId, ov.id, ov.cotizacionId) };
}

export async function cancelarOrdenVenta(usuario: UsuarioSesion, ordenVentaId: unknown, motivoCrudo: unknown): Promise<{ yaCancelada: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const motivo = esquemaMotivo("de la cancelación").parse(motivoCrudo);
  if (typeof ordenVentaId !== "string" || !ordenVentaId) throw new RegistroNoEncontradoError("La orden de venta");
  return db.$transaction(async (tx) => {
    // Orden de bloqueo: OV → cuenta (igual que B8A). Una compra, gasto,
    // entrega, vínculo o cobro simultáneo espera a la OV o a la cuenta y,
    // al continuar, ve la OV cancelada o la cuenta anulada.
    const [ov] = await tx.$queryRaw<{ id: string; folio: string; estatus: string; cotizacionId: string }[]>`
      SELECT id, folio, estatus::text AS estatus, "cotizacionId" FROM ordenes_venta
      WHERE id = ${ordenVentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
    if (ov.estatus === "CANCELADA") return { yaCancelada: true };
    await tx.$queryRaw`SELECT id FROM cuentas_comerciales WHERE "ordenVentaId" = ${ov.id} AND "empresaId" = ${empresaId} FOR UPDATE`;
    const bloqueos = await bloqueosCancelacionTx(tx, empresaId, ov.id, ov.cotizacionId);
    if (bloqueos.length > 0) {
      throw new ValidacionError(`No se puede cancelar ${ov.folio}: ${bloqueos.map((x) => `${x.texto.replace(/\.$/, "")} (${x.enlaces.map((e) => e.etiqueta).join(", ")})`).join("; ")}.`);
    }
    const ahora = new Date();
    const cuenta = await tx.cuentaComercial.findFirst({ where: { empresaId, ordenVentaId: ov.id }, select: { id: true, estatus: true } });
    if (cuenta && cuenta.estatus === "VIGENTE") {
      // Total, calendario y su historial se conservan: solo cambia el estado.
      await tx.cuentaComercial.update({
        where: { id: cuenta.id },
        data: { estatus: "ANULADA", anuladaEn: ahora, anuladaPorId: usuario.id, motivoAnulacion: motivo, version: { increment: 1 } },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_CUENTA,
        entidadId: cuenta.id,
        accion: "CAMBIAR_ESTATUS",
        valorAnterior: { estatus: "VIGENTE" },
        valorNuevo: { estatus: "ANULADA", motivo, origen: "cancelación de la orden de venta" },
      });
    }
    await tx.ordenVenta.update({ where: { id: ov.id }, data: { estatus: "CANCELADA", canceladaEn: ahora, canceladaPorId: usuario.id, motivoCancelacion: motivo } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_ORDEN_VENTA,
      entidadId: ov.id,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "VIGENTE" },
      valorNuevo: { estatus: "CANCELADA", motivo, folio: ov.folio },
    });
    return { yaCancelada: false };
  });
}

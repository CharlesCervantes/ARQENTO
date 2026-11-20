import "server-only";
import { randomBytes } from "crypto";
import * as z from "zod";
import { db } from "@/lib/server/db";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { eliminarArchivo, obtenerArchivo, subirBytes } from "@/lib/server/archivos";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { requerirUsoComercial } from "@/lib/server/comercializacion/acceso";
import { ENTIDAD_COTIZACION, alcance } from "@/lib/server/comercializacion/cotizaciones";
import { crearCuentaTx } from "@/lib/server/comercializacion/cuentas";
import { nombreSeguroDeArchivo, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";
import { MAX_BYTES_POR_CARGA, MB_POR_CARGA, formatearTamano } from "@/lib/comercializacion/cargas";
import { dateAFecha, fechaADate, hoyNegocio, normalizarFecha } from "@/lib/comercializacion/fechas";

// Aceptación del cliente y orden de venta (OV) — B3 (noviembre 2026).
// docs/negocio/comercializacion.md §20 (B3). Decisiones confirmadas:
// - Folio interno OV-000001 con consecutivo propio por Empresa; la OC del
//   cliente se guarda aparte y es opcional.
// - Registran la aceptación: Administrador, Director y el vendedor asignado
//   (solo sobre sus cotizaciones). Evidencia adjunta OBLIGATORIA.
// - Registro interno de evidencia, no firma electrónica del cliente.
// - Una sola OV por cotización: reintentos, doble clic y solicitudes
//   simultáneas devuelven la MISMA OV.
// - La OV no crea compras, cuotas, cobros/pagos ni entregas (B4+).
// Decisión provisional: una cotización emitida VENCIDA no se acepta; se
// duplica y se emite de nuevo.

export const ENTIDAD_ORDEN_VENTA = "OrdenVenta";
const PREFIJO_OV = "OV-";
const formatoFolioOv = (n: number) => `${PREFIJO_OV}${String(n).padStart(6, "0")}`;

const esquemaAceptacion = z.object({
  fechaAceptacion: z.unknown(),
  referenciaOcCliente: z
    .string()
    .trim()
    .max(100, "La referencia de OC del cliente admite máximo 100 caracteres.")
    .nullish()
    .transform((v) => (v ? v : null)),
});

export type ArchivoEvidencia = { nombre: string | null; bytes: Uint8Array };

// B8B: una cotización rechazada o cancelada es terminal (no se acepta).
const mensajeCerrada = (estatus: string) =>
  `La cotización está ${estatus === "RECHAZADA" ? "rechazada" : "cancelada"}: no se registra su aceptación. Duplícala para una nueva venta.`;

export type ResultadoAceptacion = { ordenId: string; folio: string; existente: boolean };

function validarEvidencia(archivo: ArchivoEvidencia | null | undefined) {
  if (!archivo || !archivo.bytes || archivo.bytes.length === 0) {
    throw new ValidacionError("Adjunta la evidencia de aceptación del cliente (PDF, JPG o PNG).");
  }
  if (archivo.bytes.length > MAX_BYTES_POR_CARGA) {
    throw new ValidacionError(`La evidencia pesa ${formatearTamano(archivo.bytes.length)}; el máximo es ${MB_POR_CARGA} MB. No se registró la aceptación.`);
  }
  // Tipo REAL por contenido, nunca por el nombre ni por lo que declara el navegador.
  const tipo = tipoArchivoDetectado(archivo.bytes);
  if (!tipo) throw new ValidacionError("La evidencia debe ser un PDF, JPG o PNG.");
  return tipo;
}

async function ordenExistente(cotizacionId: string): Promise<ResultadoAceptacion | null> {
  const ov = await db.ordenVenta.findFirst({ where: { cotizacionId }, select: { id: true, folio: true } });
  return ov ? { ordenId: ov.id, folio: ov.folio, existente: true } : null;
}

async function eliminarSinFallar(ref: string) {
  try {
    await eliminarArchivo(ref);
  } catch {
    // La evidencia huérfana no compromete datos: no está referida por ninguna fila.
  }
}

export async function registrarAceptacionCotizacion(
  usuario: UsuarioSesion,
  cotizacionId: string,
  datosCrudos: unknown,
  archivo: ArchivoEvidencia | null | undefined
): Promise<ResultadoAceptacion> {
  const empresaId = requerirUsoComercial(usuario);
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");

  // Alcance: administración de la Empresa o el vendedor asignado.
  const c = await db.cotizacionVenta.findFirst({
    where: { id: cotizacionId, ...alcance(usuario, empresaId) },
    select: { id: true, estatus: true, fecha: true, vigenciaHasta: true },
  });
  if (!c) throw new RegistroNoEncontradoError("La cotización");

  // Idempotencia: si ya está aceptada se devuelve la misma OV, sin subir nada.
  if (c.estatus === "ACEPTADA") {
    const ov = await ordenExistente(cotizacionId);
    if (ov) return ov;
  }
  if (c.estatus === "RECHAZADA" || c.estatus === "CANCELADA") throw new ValidacionError(mensajeCerrada(c.estatus));
  if (c.estatus !== "EMITIDA") throw new ValidacionError("Solo se puede registrar la aceptación de una cotización emitida.");

  const { fechaAceptacion: fechaCruda, referenciaOcCliente } = esquemaAceptacion.parse(datosCrudos ?? {});
  const fechaAceptacion = normalizarFecha(fechaCruda);
  if (!fechaAceptacion) throw new ValidacionError("Indica la fecha de aceptación (AAAA-MM-DD).");
  const hoy = hoyNegocio();
  if (fechaAceptacion > hoy) throw new ValidacionError("La fecha de aceptación no puede ser futura.");
  if (fechaAceptacion < dateAFecha(c.fecha)) throw new ValidacionError("La fecha de aceptación no puede ser anterior a la fecha de la cotización.");
  if (c.vigenciaHasta && dateAFecha(c.vigenciaHasta) < hoy) {
    throw new ValidacionError("La cotización está vencida: duplícala y emite una nueva para registrar la aceptación.");
  }
  const tipo = validarEvidencia(archivo);

  // 1) Evidencia al almacenamiento (fuera de la transacción). 2) Todo lo demás
  // es UNA transacción: si falla, se elimina la evidencia recién subida y la
  // cotización sigue EMITIDA, sin folio consumido.
  const nombre = nombreSeguroDeArchivo(archivo!.nombre, tipo, new Date());
  const ref = `comercializacion/${empresaId}/aceptaciones/${cotizacionId}/${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "")}-${nombre}`;
  await subirBytes(ref, archivo!.bytes, tipo);

  let resultado: ResultadoAceptacion;
  try {
    resultado = await db.$transaction(async (tx) => {
      const veTodaLaEmpresa = esAdministradorComercial(usuario);
      const filas = await tx.$queryRaw<{ estatus: string }[]>`
        SELECT estatus::text AS estatus FROM cotizaciones_venta
        WHERE id = ${cotizacionId} AND "empresaId" = ${empresaId}
          AND (${veTodaLaEmpresa}::boolean OR "vendedorId" = ${usuario.id})
        FOR UPDATE`;
      if (filas.length === 0) throw new RegistroNoEncontradoError("La cotización");
      if (filas[0].estatus === "ACEPTADA") {
        // Otra solicitud ganó mientras esta subía su evidencia.
        const ov = await tx.ordenVenta.findFirstOrThrow({ where: { cotizacionId }, select: { id: true, folio: true } });
        return { ordenId: ov.id, folio: ov.folio, existente: true };
      }
      if (filas[0].estatus === "RECHAZADA" || filas[0].estatus === "CANCELADA") throw new ValidacionError(mensajeCerrada(filas[0].estatus));
      if (filas[0].estatus !== "EMITIDA") throw new ValidacionError("Solo se puede registrar la aceptación de una cotización emitida.");

      const cot = await tx.cotizacionVenta.findUniqueOrThrow({
        where: { id: cotizacionId },
        select: { version: true, subtotal: true, iva: true, total: true, folio: true, vigenciaHasta: true },
      });
      if (cot.vigenciaHasta && dateAFecha(cot.vigenciaHasta) < hoyNegocio()) {
        throw new ValidacionError("La cotización está vencida: duplícala y emite una nueva para registrar la aceptación.");
      }
      const { ultimoFolioOrdenVenta: numero } = await tx.empresa.update({
        where: { id: empresaId },
        data: { ultimoFolioOrdenVenta: { increment: 1 } },
        select: { ultimoFolioOrdenVenta: true },
      });
      const folio = formatoFolioOv(numero);
      const ov = await tx.ordenVenta.create({
        data: {
          empresaId,
          folio,
          numeroFolio: numero,
          cotizacionId,
          fechaAceptacion: fechaADate(fechaAceptacion),
          referenciaOcCliente,
          evidenciaRef: ref,
          evidenciaNombre: nombre,
          evidenciaTipo: tipo,
          evidenciaBytes: archivo!.bytes.length,
          registradaPorId: usuario.id,
          subtotal: cot.subtotal,
          iva: cot.iva,
          total: cot.total,
        },
        select: { id: true },
      });
      await tx.cotizacionVenta.update({
        where: { id: cotizacionId },
        data: { estatus: "ACEPTADA", version: cot.version + 1, actualizadoPorId: usuario.id },
      });
      // B5: la cuenta por cobrar nace con la OV, en la misma transacción
      // (condiciones por definir; no registra dinero).
      await crearCuentaTx(tx, { empresaId, usuarioId: usuario.id, ordenVentaId: ov.id, total: cot.total });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_COTIZACION,
        entidadId: cotizacionId,
        accion: "CAMBIAR_ESTATUS",
        valorAnterior: { estatus: "EMITIDA" },
        valorNuevo: { estatus: "ACEPTADA", ordenVenta: folio },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_ORDEN_VENTA,
        entidadId: ov.id,
        accion: "CREAR",
        valorNuevo: {
          folio,
          cotizacion: cot.folio,
          fechaAceptacion,
          referenciaOcCliente,
          evidencia: { nombre, tipo, bytes: archivo!.bytes.length },
          total: cot.total.toFixed(2),
        },
      });
      return { ordenId: ov.id, folio, existente: false };
    });
  } catch (error) {
    await eliminarSinFallar(ref);
    // Dos solicitudes simultáneas: la que pierde por el índice único devuelve la ganadora.
    const ov = await ordenExistente(cotizacionId).catch(() => null);
    if (ov) return ov;
    throw error;
  }
  if (resultado.existente) await eliminarSinFallar(ref);
  return resultado;
}

/** Evidencia de aceptación — mismo alcance que la cotización (empresa y vendedor). */
export async function obtenerEvidenciaOrdenVenta(
  usuario: UsuarioSesion,
  ordenId: string
): Promise<{ bytes: Buffer; tipo: string; nombre: string }> {
  const empresaId = requerirUsoComercial(usuario);
  if (typeof ordenId !== "string" || !ordenId) throw new RegistroNoEncontradoError("La orden de venta");
  const ov = await db.ordenVenta.findFirst({
    where: { id: ordenId, empresaId, cotizacion: alcance(usuario, empresaId) },
    select: { evidenciaRef: true, evidenciaTipo: true, evidenciaNombre: true },
  });
  if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
  return { bytes: await obtenerArchivo(ov.evidenciaRef), tipo: ov.evidenciaTipo, nombre: ov.evidenciaNombre };
}

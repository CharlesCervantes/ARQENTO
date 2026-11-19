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
import { requerirAdministracionComercial } from "@/lib/server/comercializacion/acceso";
import { anularCuentaDeGastoTx, crearCuentaTx, detallesCuentasDeGastos, hoyDeEmpresa, type DetalleCuenta } from "@/lib/server/comercializacion/cuentas";
import { cantidadesDeOrden } from "@/lib/server/comercializacion/compras";
import { calcularImpuesto, normalizarImporte, normalizarTasa, TRATAMIENTOS_IMPUESTO, type TratamientoImpuesto, comoTratamientoVenta } from "@/lib/comercializacion/importes";
import { dateAFecha, fechaADate, normalizarFecha } from "@/lib/comercializacion/fechas";
import { MAX_BYTES_POR_CARGA, MB_POR_CARGA, formatearTamano } from "@/lib/comercializacion/cargas";
import { calcularResultado, type ResultadoEstimado } from "@/lib/comercializacion/resultado";
import { exigirOrdenVigenteTx } from "@/lib/server/comercializacion/orden-vigente";
import { nombreSeguroDeArchivo, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";

// Gastos adicionales de una OV y resultado estimado — B7 (noviembre 2026).
// docs/negocio/comercializacion.md §20 (B7). SOLO Administrador/Director.
// - Un gasto pertenece a UNA OV aceptada de la Empresa; no es una partida de
//   compra ni consume cantidades vendidas.
// - «Guardar gasto» lo registra VIGENTE y crea su cuenta por pagar (B5) por el
//   total con impuestos, en una transacción. Guardarlo no es pagarlo.
// - El impuesto es explícito (gravado con tasa, tasa 0 % o exento): no se
//   asume 16 % ni se infiere por tener comprobante.
// - No se edita ni se borra. Sin historial de pagos (ni anulados) se anula con
//   motivo junto con su cuenta, atómicamente; con historial, no.
// - El resultado estimado usa importes SIN IVA de venta, compras confirmadas y
//   gastos vigentes; nunca cobros ni pagos.

export const ENTIDAD_GASTO = "GastoComercial";

type Tx = Prisma.TransactionClient;

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

async function eliminarSinFallar(ref: string | null) {
  if (!ref) return;
  try {
    await eliminarArchivo(ref);
  } catch {
    // Un archivo huérfano no compromete datos: ninguna fila lo referencia.
  }
}

/** OV aceptada de la Empresa (administración ve toda la Empresa). */
async function ordenDeEmpresa(empresaId: string, ordenVentaId: unknown) {
  if (typeof ordenVentaId !== "string" || !ordenVentaId) throw new RegistroNoEncontradoError("La orden de venta");
  const ov = await db.ordenVenta.findFirst({
    where: { id: ordenVentaId, empresaId, cotizacion: { estatus: "ACEPTADA" } },
    select: { id: true, folio: true, cotizacionId: true, subtotal: true, estatus: true },
  });
  if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
  return ov;
}

// ---------------------------------------------------------------------------
// Beneficiarios elegibles (catálogo existente, sin cambiar sus reglas)
// ---------------------------------------------------------------------------

/** Proveedores y contratistas activos de la Empresa (sin alias de «misma persona»). */
export async function listarBeneficiariosGasto(usuario: UsuarioSesion): Promise<{ id: string; nombre: string }[]> {
  const empresaId = requerirAdministracionComercial(usuario);
  return db.beneficiario.findMany({
    where: { empresaId, tipo: { in: ["PROVEEDOR", "CONTRATISTA"] }, activo: true, mismaPersonaQueId: null },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export type GastoDetalle = {
  id: string;
  numero: number;
  concepto: string;
  beneficiarioNombre: string;
  fecha: string;
  subtotal: string;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null;
  iva: string;
  total: string;
  observaciones: string | null;
  comprobanteNombre: string | null;
  estatus: "VIGENTE" | "ANULADO";
  registradoPorNombre: string;
  registradoEn: string;
  anulado: { en: string; porNombre: string; motivo: string } | null;
  cuenta: DetalleCuenta | null;
};

export type ResumenGastosOrden = { ordenVentaId: string; folio: string; hoy: string; gastos: GastoDetalle[] };

/** Bloque «Gastos adicionales» del detalle de la OV — solo administración. */
export async function resumenGastosOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<ResumenGastosOrden> {
  const empresaId = requerirAdministracionComercial(usuario);
  const ov = await ordenDeEmpresa(empresaId, ordenVentaId);
  const [gastos, cuentas, hoy] = await Promise.all([
    db.gastoComercial.findMany({
      where: { empresaId, ordenVentaId: ov.id },
      orderBy: { numero: "desc" },
      include: { registradoPor: { select: { nombre: true } }, anuladoPor: { select: { nombre: true } } },
    }),
    detallesCuentasDeGastos(usuario, ov.id),
    hoyDeEmpresa(db, empresaId),
  ]);
  return {
    ordenVentaId: ov.id,
    folio: ov.folio,
    hoy,
    gastos: gastos.map((g) => ({
      id: g.id,
      numero: g.numero,
      concepto: g.concepto,
      beneficiarioNombre: g.beneficiarioNombre,
      fecha: dateAFecha(g.fecha),
      subtotal: g.subtotal.toFixed(2),
      tratamientoImpuesto: comoTratamientoVenta(g.tratamientoImpuesto),
      tasaIva: g.tasaIva?.toFixed(2) ?? null,
      iva: g.iva.toFixed(2),
      total: g.total.toFixed(2),
      observaciones: g.observaciones,
      comprobanteNombre: g.comprobanteNombre,
      estatus: g.estatus,
      registradoPorNombre: g.registradoPor.nombre,
      registradoEn: g.createdAt.toISOString(),
      anulado: g.anuladoEn ? { en: g.anuladoEn.toISOString(), porNombre: g.anuladoPor?.nombre ?? "—", motivo: g.motivoAnulacion ?? "" } : null,
      cuenta: cuentas.get(g.id) ?? null,
    })),
  };
}

/** Resultado estimado de la OV (solo administración). Ver lib/comercializacion/resultado.ts. */
export async function resultadoOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<ResultadoEstimado> {
  const empresaId = requerirAdministracionComercial(usuario);
  const ov = await ordenDeEmpresa(empresaId, ordenVentaId);
  const [compras, gastos, partidas] = await Promise.all([
    // Compras: solo CONFIRMADAS (excluye borradores y anuladas), importe sin IVA.
    db.compraComercial.findMany({ where: { empresaId, ordenVentaId: ov.id, estatus: "CONFIRMADA" }, select: { subtotal: true } }),
    db.gastoComercial.findMany({ where: { empresaId, ordenVentaId: ov.id, estatus: "VIGENTE" }, select: { subtotal: true } }),
    cantidadesDeOrden(db, empresaId, ov.cotizacionId),
  ]);
  const r = calcularResultado({
    venta: ov.subtotal.toFixed(2),
    compras: compras.map((c) => c.subtotal.toFixed(2)),
    gastos: gastos.map((g) => g.subtotal.toFixed(2)),
    partidas: partidas.map((p) => ({ codigo: p.codigo, descripcion: p.descripcion, unidad: p.unidad, vendido: p.vendido, comprado: p.comprado })),
  });
  // B8B: una OV cancelada no muestra simulación de reparto.
  return ov.estatus === "CANCELADA" ? { ...r, simulacion: null, ordenCancelada: true } : r;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

const esquemaGasto = z.object({
  concepto: z.string({ error: "Indica el concepto del gasto." }).trim().min(1, "Indica el concepto del gasto.").max(200, "El concepto admite máximo 200 caracteres."),
  beneficiarioId: z.string({ error: "Elige el beneficiario o proveedor." }).trim().min(1, "Elige el beneficiario o proveedor."),
  fecha: z.unknown(),
  subtotal: z.unknown(),
  tratamientoImpuesto: z.unknown(),
  tasaIva: z.unknown().optional(),
  observaciones: z
    .string()
    .trim()
    .max(1000, "Las observaciones admiten máximo 1000 caracteres.")
    .nullish()
    .transform((v) => (v ? v : null)),
});

export type ArchivoComprobanteGasto = { nombre: string | null; bytes: Uint8Array } | null | undefined;

export async function registrarGastoComercial(
  usuario: UsuarioSesion,
  ordenVentaId: string,
  datosCrudos: unknown,
  archivo: ArchivoComprobanteGasto,
  claveCruda: unknown
): Promise<{ gastoId: string; numero: number; existente: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const clave = z.string({ error: "Clave de registro inválida. Recarga la página." }).trim().min(8).max(100).parse(claveCruda);
  const ov = await ordenDeEmpresa(empresaId, ordenVentaId);

  // Idempotencia: la misma clave devuelve el mismo gasto, sin subir archivos.
  const previa = async () => {
    const g = await db.gastoComercial.findFirst({ where: { empresaId, claveRegistro: clave }, select: { id: true, numero: true, ordenVentaId: true } });
    if (!g) return null;
    if (g.ordenVentaId !== ov.id) throw new ValidacionError("Clave de registro inválida. Recarga la página.");
    return { gastoId: g.id, numero: g.numero, existente: true };
  };
  const repetido = await previa();
  if (repetido) return repetido;

  const d = esquemaGasto.parse(datosCrudos ?? {});
  const fecha = normalizarFecha(d.fecha);
  if (!fecha) throw new ValidacionError("Indica la fecha del gasto (AAAA-MM-DD).");
  if (fecha > (await hoyDeEmpresa(db, empresaId))) throw new ValidacionError("La fecha del gasto no puede ser futura.");
  const subtotal = normalizarImporte(d.subtotal, { permitirCero: false });
  if (!subtotal) throw new ValidacionError("El importe sin IVA debe ser mayor que 0 con máximo 2 decimales.");
  // Impuesto explícito: nunca se asume 16 % ni se infiere del comprobante.
  if (!TRATAMIENTOS_IMPUESTO.includes(d.tratamientoImpuesto as TratamientoImpuesto)) {
    throw new ValidacionError("Selecciona el impuesto aplicable (gravado con tasa, tasa 0 % o exento).");
  }
  const tratamiento = d.tratamientoImpuesto as TratamientoImpuesto;
  let tasaIva: string | null = null;
  if (tratamiento === "GRAVADO") {
    tasaIva = normalizarTasa(d.tasaIva);
    if (!tasaIva || tasaIva === "0.00") throw new ValidacionError("Indica la tasa de IVA del gasto gravado (mayor que 0).");
  }
  const { iva, total } = calcularImpuesto(subtotal, tratamiento, tasaIva);

  const beneficiario = await db.beneficiario.findFirst({
    where: { id: d.beneficiarioId, empresaId, tipo: { in: ["PROVEEDOR", "CONTRATISTA"] }, activo: true, mismaPersonaQueId: null },
    select: { id: true, nombre: true },
  });
  if (!beneficiario) throw new RegistroNoEncontradoError("El beneficiario");

  // Comprobante opcional: mismos controles que los demás documentos del módulo.
  let comprobante: { ref: string; nombre: string; tipo: string; bytes: number } | null = null;
  if (archivo && archivo.bytes && archivo.bytes.length > 0) {
    if (archivo.bytes.length > MAX_BYTES_POR_CARGA) {
      throw new ValidacionError(`El comprobante pesa ${formatearTamano(archivo.bytes.length)}; el máximo es ${MB_POR_CARGA} MB. No se registró el gasto.`);
    }
    const tipo = tipoArchivoDetectado(archivo.bytes);
    if (!tipo) throw new ValidacionError("El comprobante debe ser PDF, JPG o PNG válido. No se registró el gasto.");
    const nombre = nombreSeguroDeArchivo(archivo.nombre, tipo, new Date());
    const ref = `comercializacion/${empresaId}/gastos/${ov.id}/${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "")}-${nombre}`;
    await subirBytes(ref, archivo.bytes, tipo);
    comprobante = { ref, nombre, tipo, bytes: archivo.bytes.length };
  }

  try {
    return await db.$transaction(async (tx) => {
      // Bloqueo de la OV: numeración consecutiva de sus gastos sin choques.
      await exigirOrdenVigenteTx(tx, empresaId, ov.id); // bloquea la OV (B8B: y exige que siga vigente)
      const ultimo = await tx.gastoComercial.aggregate({ where: { ordenVentaId: ov.id }, _max: { numero: true } });
      const numero = (ultimo._max.numero ?? 0) + 1;
      const gasto = await tx.gastoComercial.create({
        data: {
          empresaId,
          ordenVentaId: ov.id,
          numero,
          concepto: d.concepto,
          beneficiarioId: beneficiario.id,
          beneficiarioNombre: beneficiario.nombre,
          fecha: fechaADate(fecha),
          subtotal,
          tratamientoImpuesto: tratamiento,
          tasaIva,
          iva,
          total,
          observaciones: d.observaciones,
          comprobanteRef: comprobante?.ref ?? null,
          comprobanteNombre: comprobante?.nombre ?? null,
          comprobanteTipo: comprobante?.tipo ?? null,
          comprobanteBytes: comprobante?.bytes ?? null,
          claveRegistro: clave,
          registradoPorId: usuario.id,
        },
        select: { id: true },
      });
      // Su única cuenta por pagar, por el total con impuestos (B5).
      await crearCuentaTx(tx, { empresaId, usuarioId: usuario.id, total, gastoId: gasto.id });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_GASTO,
        entidadId: gasto.id,
        accion: "CREAR",
        valorNuevo: { ordenVenta: ov.folio, numero, concepto: d.concepto, beneficiario: beneficiario.nombre, fecha, subtotal, tratamiento, tasaIva, iva, total, comprobante: comprobante?.nombre ?? null },
      });
      return { gastoId: gasto.id, numero, existente: false };
    });
  } catch (error) {
    await eliminarSinFallar(comprobante?.ref ?? null);
    if (esUnica(error)) {
      const ganador = await previa().catch(() => null);
      if (ganador) return ganador;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Anular (sin historial de pagos)
// ---------------------------------------------------------------------------

/** Para la pantalla: motivo por el que un gasto no se anula con la acción simple. */
export function motivoQueImpideAnularGasto(g: { estatus: string; cuenta: { tuvoMovimientos: boolean } | null }): string | null {
  if (g.estatus !== "VIGENTE") return "El gasto ya está anulado.";
  if (g.cuenta?.tuvoMovimientos) return "Tiene historial de pagos (aunque estén anulados); no se anula con la acción simple.";
  return null;
}

export async function anularGastoComercial(usuario: UsuarioSesion, gastoId: unknown, motivoCrudo: unknown): Promise<{ existente: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof gastoId !== "string" || !gastoId) throw new RegistroNoEncontradoError("El gasto");
  const motivo = z
    .string({ error: "Indica el motivo de la anulación." })
    .trim()
    .min(3, "Indica el motivo de la anulación (mínimo 3 caracteres).")
    .max(500, "El motivo admite máximo 500 caracteres.")
    .parse(motivoCrudo);

  return db.$transaction(async (tx: Tx) => {
    // Orden de bloqueo: gasto → cuenta (igual que un pago del gasto, B5).
    const [g] = await tx.$queryRaw<{ estatus: string; numero: number; ordenVentaId: string }[]>`
      SELECT estatus::text AS estatus, numero, "ordenVentaId" FROM gastos_comerciales WHERE id = ${gastoId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    if (!g) throw new RegistroNoEncontradoError("El gasto");
    if (g.estatus === "ANULADO") return { existente: true }; // idempotente
    await tx.$queryRaw`SELECT id FROM cuentas_comerciales WHERE "gastoId" = ${gastoId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    // Atómico: la cuenta (sin pagos) se anula primero; la base solo admite
    // anular el gasto si su cuenta ya está anulada y nunca tuvo movimientos.
    await anularCuentaDeGastoTx(tx, empresaId, gastoId, usuario.id, motivo);
    await tx.gastoComercial.update({ where: { id: gastoId }, data: { estatus: "ANULADO", anuladoEn: new Date(), anuladoPorId: usuario.id, motivoAnulacion: motivo } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_GASTO,
      entidadId: gastoId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "VIGENTE" },
      valorNuevo: { estatus: "ANULADO", numero: g.numero, motivo },
    });
    return { existente: false };
  });
}

// ---------------------------------------------------------------------------
// Comprobante (descarga, solo administración)
// ---------------------------------------------------------------------------

export async function obtenerComprobanteGasto(usuario: UsuarioSesion, gastoId: string): Promise<{ bytes: Buffer; tipo: string; nombre: string }> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof gastoId !== "string" || !gastoId) throw new RegistroNoEncontradoError("El comprobante");
  const g = await db.gastoComercial.findFirst({ where: { id: gastoId, empresaId }, select: { comprobanteRef: true, comprobanteTipo: true, comprobanteNombre: true } });
  if (!g?.comprobanteRef) throw new RegistroNoEncontradoError("El comprobante");
  return { bytes: await obtenerArchivo(g.comprobanteRef), tipo: g.comprobanteTipo!, nombre: g.comprobanteNombre! };
}

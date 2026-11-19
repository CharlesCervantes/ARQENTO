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
import { ConflictoEdicionError } from "@/lib/server/comercializacion/cotizaciones";
import { aCentavos, deCentavos, formatearImporte, normalizarImporte } from "@/lib/comercializacion/importes";
import { esPlazoMensual, generarMensualidades, GeneracionMensualidadesError, type PlazoMensual } from "@/lib/comercializacion/mensualidades";
import { dateAFecha, fechaADate, normalizarFecha } from "@/lib/comercializacion/fechas";
import {
  calcularEstadoCuenta,
  hoyEnZona,
  METODOS_PAGO,
  ordenarCuotas,
  proponerAplicacion,
  type EstadoCuenta,
  type MetodoPago,
} from "@/lib/comercializacion/cuentas";
import { nombreSeguroDeArchivo, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";
import { MAX_BYTES_POR_CARGA, MB_POR_CARGA, formatearTamano } from "@/lib/comercializacion/cargas";

// Cuentas por cobrar (OV) y por pagar (compra) — B5 (noviembre 2026).
// docs/negocio/comercializacion.md §20 (B5). SOLO Administrador/Director.
// - Una cuenta por documento, creada en la transacción de aceptación de la
//   OV o de confirmación de la compra (crearCuentaTx). La base lo exige.
// - Condiciones: CONTADO (una cuota por el total) o CRÉDITO (una o varias
//   cuotas). Las cuotas suman exactamente el total. Guardar condiciones no
//   registra dinero. Se sustituyen (con historial) solo sin movimientos.
// - Cobros/pagos reales con aplicación explícita por cuota (propuesta: la
//   más antigua primero, incluidas futuras). Sin exceder el saldo, sin
//   repartir entre documentos y sin saldos a favor (alcance provisional P5).
// - Anulación de un movimiento con motivo: conserva el historial; sus
//   aplicaciones dejan de contar.
// - "Hoy" = fecha de calendario en la zona de la Empresa (America/Monterrey
//   si no está definida).

export const ENTIDAD_CUENTA = "CuentaComercial";
export const ENTIDAD_MOVIMIENTO = "MovimientoComercial";
const MAX_CUOTAS = 60;

type Tx = Prisma.TransactionClient;
type Cliente = Tx | typeof db;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

export async function hoyDeEmpresa(cliente: Cliente, empresaId: string, ahora: Date = new Date()): Promise<string> {
  const e = await cliente.empresa.findUnique({ where: { id: empresaId }, select: { zonaHoraria: true } });
  return hoyEnZona(e?.zonaHoraria ?? null, ahora);
}

// ---------------------------------------------------------------------------
// Creación (llamada desde la aceptación de la OV y la confirmación de la compra)
// ---------------------------------------------------------------------------

export async function crearCuentaTx(
  tx: Tx,
  datos: { empresaId: string; usuarioId: string; total: Prisma.Decimal | string } & ({ ordenVentaId: string } | { compraId: string } | { gastoId: string })
) {
  // Un solo documento origen por cuenta: OV (por cobrar), compra o gasto (por pagar).
  const esCobro = "ordenVentaId" in datos;
  const cuenta = await tx.cuentaComercial.create({
    data: {
      empresaId: datos.empresaId,
      tipo: esCobro ? "POR_COBRAR" : "POR_PAGAR",
      ordenVentaId: "ordenVentaId" in datos ? datos.ordenVentaId : null,
      compraId: "compraId" in datos ? datos.compraId : null,
      gastoId: "gastoId" in datos ? datos.gastoId : null,
      total: datos.total,
    },
    select: { id: true },
  });
  await registrarAuditoriaTx(tx, {
    empresaId: datos.empresaId,
    usuarioId: datos.usuarioId,
    entidad: ENTIDAD_CUENTA,
    entidadId: cuenta.id,
    accion: "CREAR",
    valorNuevo: { tipo: esCobro ? "POR_COBRAR" : "POR_PAGAR", total: typeof datos.total === "string" ? datos.total : datos.total.toFixed(2), condiciones: "por definir" },
  });
  return cuenta;
}

/** Anula la cuenta por pagar de una compra que se anula (B4) — solo si nunca tuvo pagos. */
export async function anularCuentaDeCompraTx(tx: Tx, empresaId: string, compraId: string, usuarioId: string, motivo: string) {
  await tx.$queryRaw`SELECT id FROM cuentas_comerciales WHERE "compraId" = ${compraId} AND "empresaId" = ${empresaId} FOR UPDATE`;
  const c = await tx.cuentaComercial.findFirst({ where: { compraId, empresaId }, select: { id: true, estatus: true, tuvoMovimientos: true } });
  if (!c || c.estatus === "ANULADA") return;
  if (c.tuvoMovimientos) throw new ValidacionError("La compra tiene historial de pagos (aunque estén anulados); no se puede anular con la acción simple.");
  await tx.cuentaComercial.update({ where: { id: c.id }, data: { estatus: "ANULADA", anuladaEn: new Date(), anuladaPorId: usuarioId, motivoAnulacion: motivo, version: { increment: 1 } } });
  await registrarAuditoriaTx(tx, {
    empresaId,
    usuarioId,
    entidad: ENTIDAD_CUENTA,
    entidadId: c.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: "VIGENTE" },
    valorNuevo: { estatus: "ANULADA", motivo, origen: "anulación de la compra" },
  });
}

/** Para B4: ¿la compra ya tuvo pagos (aunque se hayan anulado)? */
export async function compraTuvoPagosTx(tx: Tx, compraId: string): Promise<boolean> {
  const c = await tx.cuentaComercial.findFirst({ where: { compraId }, select: { tuvoMovimientos: true } });
  return Boolean(c?.tuvoMovimientos);
}

// ---------------------------------------------------------------------------
// Lectura y estado
// ---------------------------------------------------------------------------

export const INCLUIR_CUENTA = {
  ordenVenta: { select: { id: true, folio: true, cotizacionId: true } },
  compra: { select: { id: true, folio: true, estatus: true } },
  gasto: { select: { id: true, numero: true, concepto: true, estatus: true, ordenVenta: { select: { folio: true, cotizacionId: true } } } },
  cuotas: {
    orderBy: [{ fechaVencimiento: "asc" }, { numero: "asc" }],
    select: {
      id: true,
      numero: true,
      fechaVencimiento: true,
      importe: true,
      vigente: true,
      sustituidaEn: true,
      aplicaciones: { select: { importe: true, movimiento: { select: { estatus: true } } } },
      // B8B — historial de cambios de vencimiento de la cuota.
      cambiosVencimiento: {
        orderBy: { createdAt: "asc" },
        select: { id: true, fechaAnterior: true, fechaNueva: true, motivo: true, createdAt: true, registradoPor: { select: { nombre: true } } },
      },
    },
  },
  movimientos: {
    orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      importe: true,
      fecha: true,
      metodo: true,
      referencia: true,
      observaciones: true,
      comprobanteNombre: true,
      estatus: true,
      createdAt: true,
      anuladoEn: true,
      motivoAnulacion: true,
      registradoPor: { select: { nombre: true } },
      anuladoPor: { select: { nombre: true } },
      aplicaciones: { select: { importe: true, cuota: { select: { numero: true, fechaVencimiento: true, vigente: true } } } },
    },
  },
} as const satisfies Prisma.CuentaComercialInclude;

type CuentaCargada = Prisma.CuentaComercialGetPayload<{ include: typeof INCLUIR_CUENTA }>;

export function estadoDe(c: CuentaCargada, hoy: string): EstadoCuenta {
  const vigentes = c.cuotas.filter((q) => q.vigente);
  const cuotas = vigentes.map((q) => ({
    id: q.id,
    numero: q.numero,
    fechaVencimiento: dateAFecha(q.fechaVencimiento),
    importe: q.importe.toFixed(2),
    aplicado: deCentavos(q.aplicaciones.filter((a) => a.movimiento.estatus === "VIGENTE").reduce((s, a) => s + aCentavos(a.importe.toFixed(2)), BigInt(0))),
  }));
  const aplicado = c.movimientos.filter((m) => m.estatus === "VIGENTE").reduce((s, m) => s + aCentavos(m.importe.toFixed(2)), BigInt(0));
  return calcularEstadoCuenta(c.total.toFixed(2), deCentavos(aplicado), cuotas, hoy);
}

export type MovimientoDetalle = {
  id: string;
  importe: string;
  fecha: string;
  metodo: MetodoPago;
  referencia: string | null;
  observaciones: string | null;
  comprobanteNombre: string | null;
  estatus: "VIGENTE" | "ANULADO";
  registradoPorNombre: string;
  registradoEn: string;
  anulado: { en: string; porNombre: string; motivo: string } | null;
  aplicaciones: { cuotaNumero: number; fechaVencimiento: string; importe: string }[];
};

export type OrigenCuenta = "ORDEN" | "COMPRA" | "GASTO";

export type CambioVencimientoDetalle = { id: string; fechaAnterior: string; fechaNueva: string; motivo: string; porNombre: string; en: string };

export type DetalleCuenta = {
  id: string;
  tipo: "POR_COBRAR" | "POR_PAGAR";
  origen: OrigenCuenta;
  documento: { id: string; folio: string };
  estatus: "VIGENTE" | "ANULADA";
  modalidad: "CONTADO" | "CREDITO" | null;
  version: number;
  tuvoMovimientos: boolean;
  hoy: string;
  estado: EstadoCuenta;
  calendariosAnteriores: { numero: number; fechaVencimiento: string; importe: string; sustituidaEn: string }[];
  // B8B — por cuota vigente: fecha originalmente pactada y cambios de vencimiento.
  vencimientos: Record<string, { fechaPactada: string; cambios: CambioVencimientoDetalle[] }>;
  movimientos: MovimientoDetalle[];
  motivoAnulacion: string | null;
};

const origenDe = (c: { ordenVentaId: string | null; compraId: string | null }): OrigenCuenta => (c.ordenVentaId ? "ORDEN" : c.compraId ? "COMPRA" : "GASTO");

/** «OV-000012 · Gasto 1 (Flete)» — identifica el gasto y su OV. */
export const folioGasto = (g: { numero: number; concepto: string; ordenVenta: { folio: string } }) => `${g.ordenVenta.folio} · Gasto ${g.numero} (${g.concepto})`;

function aDetalle(c: CuentaCargada, hoy: string): DetalleCuenta {
  return {
    id: c.id,
    tipo: c.tipo,
    origen: origenDe(c),
    documento: c.ordenVenta
      ? { id: c.ordenVenta.id, folio: c.ordenVenta.folio }
      : c.compra
        ? { id: c.compra.id, folio: c.compra.folio }
        : { id: c.gasto!.id, folio: folioGasto(c.gasto!) },
    estatus: c.estatus,
    modalidad: c.modalidad,
    version: c.version,
    tuvoMovimientos: c.tuvoMovimientos,
    hoy,
    estado: estadoDe(c, hoy),
    calendariosAnteriores: c.cuotas
      .filter((q) => !q.vigente)
      .map((q) => ({ numero: q.numero, fechaVencimiento: dateAFecha(q.fechaVencimiento), importe: q.importe.toFixed(2), sustituidaEn: q.sustituidaEn!.toISOString() })),
    vencimientos: Object.fromEntries(
      c.cuotas
        .filter((q) => q.vigente)
        .map((q) => [
          q.id,
          {
            fechaPactada: dateAFecha(q.cambiosVencimiento[0]?.fechaAnterior ?? q.fechaVencimiento),
            cambios: q.cambiosVencimiento.map((h) => ({
              id: h.id,
              fechaAnterior: dateAFecha(h.fechaAnterior),
              fechaNueva: dateAFecha(h.fechaNueva),
              motivo: h.motivo,
              porNombre: h.registradoPor.nombre,
              en: h.createdAt.toISOString(),
            })),
          },
        ])
    ),
    movimientos: c.movimientos.map((m) => ({
      id: m.id,
      importe: m.importe.toFixed(2),
      fecha: dateAFecha(m.fecha),
      metodo: m.metodo,
      referencia: m.referencia,
      observaciones: m.observaciones,
      comprobanteNombre: m.comprobanteNombre,
      estatus: m.estatus,
      registradoPorNombre: m.registradoPor.nombre,
      registradoEn: m.createdAt.toISOString(),
      anulado: m.anuladoEn ? { en: m.anuladoEn.toISOString(), porNombre: m.anuladoPor?.nombre ?? "—", motivo: m.motivoAnulacion ?? "" } : null,
      aplicaciones: ordenarCuotas(
        m.aplicaciones.map((a) => ({ numero: a.cuota.numero, fechaVencimiento: dateAFecha(a.cuota.fechaVencimiento), importe: a.importe.toFixed(2) }))
      ).map((a) => ({ cuotaNumero: a.numero, fechaVencimiento: a.fechaVencimiento, importe: a.importe })),
    })),
    motivoAnulacion: c.motivoAnulacion,
  };
}

async function cargar(cliente: Cliente, empresaId: string, where: Prisma.CuentaComercialWhereInput): Promise<CuentaCargada | null> {
  return cliente.cuentaComercial.findFirst({ where: { ...where, empresaId }, include: INCLUIR_CUENTA });
}

export async function detalleCuentaDeOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<DetalleCuenta> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof ordenVentaId !== "string" || !ordenVentaId) throw new RegistroNoEncontradoError("La cuenta");
  const c = await cargar(db, empresaId, { ordenVentaId });
  if (!c) throw new RegistroNoEncontradoError("La cuenta por cobrar");
  return aDetalle(c, await hoyDeEmpresa(db, empresaId));
}

export async function detalleCuentaDeCompra(usuario: UsuarioSesion, compraId: string): Promise<DetalleCuenta | null> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof compraId !== "string" || !compraId) throw new RegistroNoEncontradoError("La cuenta");
  const c = await cargar(db, empresaId, { compraId });
  return c ? aDetalle(c, await hoyDeEmpresa(db, empresaId)) : null;
}

// ---------------------------------------------------------------------------
// Condiciones / calendario
// ---------------------------------------------------------------------------

const esquemaCondiciones = z.strictObject({
  modalidad: z.enum(["CONTADO", "CREDITO"], { error: "Elige contado o crédito." }),
  // Cuotas capturadas (contado o «Cuotas manuales»)…
  cuotas: z
    .array(z.strictObject({ fechaVencimiento: z.unknown(), importe: z.unknown() }))
    .min(1, "Indica al menos una fecha de pago.")
    .max(MAX_CUOTAS, `Máximo ${MAX_CUOTAS} cuotas.`)
    .optional(),
  // …o mensualidades automáticas (solo crédito de compras a proveedor): el
  // servidor genera el calendario desde el total de la cuenta; no recibe importes.
  mensualidades: z.strictObject({ plazo: z.unknown(), primerVencimiento: z.unknown() }).optional(),
});

async function bloquearCuenta(tx: Tx, empresaId: string, cuentaId: string) {
  if (typeof cuentaId !== "string" || !cuentaId) throw new RegistroNoEncontradoError("La cuenta");
  const previa = await tx.cuentaComercial.findFirst({ where: { id: cuentaId, empresaId }, select: { compraId: true, gastoId: true } });
  if (!previa) throw new RegistroNoEncontradoError("La cuenta");
  // B7: gasto → cuenta, el mismo orden que usa la anulación del gasto.
  if (previa.gastoId) await tx.$queryRaw`SELECT id FROM gastos_comerciales WHERE id = ${previa.gastoId} FOR UPDATE`;
  // Orden de bloqueo: compra → cuenta (igual que la anulación de la compra,
  // que bloquea OV → compra → cuenta). Así un pago y una anulación
  // simultáneos se serializan sin interbloqueos.
  if (previa.compraId) await tx.$queryRaw`SELECT id FROM compras_comerciales WHERE id = ${previa.compraId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM cuentas_comerciales WHERE id = ${cuentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
  return (await cargar(tx, empresaId, { id: cuentaId }))!;
}

export async function definirCondicionesCuenta(usuario: UsuarioSesion, cuentaId: string, versionLeida: unknown, datosCrudos: unknown): Promise<{ version: number }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const version = z.number({ error: "Versión inválida." }).int().min(1).parse(versionLeida);
  const d = esquemaCondiciones.parse(datosCrudos);
  const mensualidades = d.mensualidades ?? null;
  if (mensualidades ? d.cuotas !== undefined : d.cuotas === undefined) throw new ValidacionError("Indica las cuotas o el plazo de mensualidades (no ambos).");
  if (mensualidades && d.modalidad !== "CREDITO") throw new ValidacionError("Las mensualidades automáticas son de crédito.");
  if (mensualidades && !esPlazoMensual(mensualidades.plazo)) throw new ValidacionError("Elige un plazo de 3, 6, 12, 18 o 24 meses.");
  let cuotas: { fecha: string; importe: string }[] = [];
  if (d.cuotas) {
    cuotas = d.cuotas.map((q, i) => {
      const fecha = normalizarFecha(q.fechaVencimiento);
      if (!fecha) throw new ValidacionError(`Cuota ${i + 1}: indica una fecha válida (AAAA-MM-DD).`);
      const importe = normalizarImporte(q.importe, { permitirCero: false });
      if (!importe) throw new ValidacionError(`Cuota ${i + 1}: el importe debe ser mayor que 0 con máximo 2 decimales.`);
      return { fecha, importe };
    });
    if (d.modalidad === "CONTADO" && cuotas.length !== 1) throw new ValidacionError("De contado se paga en una sola fecha por el total.");
  }

  return db.$transaction(async (tx) => {
    const c = await bloquearCuenta(tx, empresaId, cuentaId);
    if (c.estatus !== "VIGENTE") throw new ValidacionError("La cuenta está anulada.");
    if (c.version !== version) throw new ConflictoEdicionError();
    if (c.tuvoMovimientos) {
      throw new ValidacionError("Las condiciones ya no se pueden cambiar: la cuenta tiene cobros o pagos registrados (reprogramar con pagos queda pendiente).");
    }
    if (mensualidades) {
      if (!c.compraId) throw new ValidacionError("Las mensualidades automáticas solo aplican al crédito de compras a proveedor.");
      try {
        cuotas = generarMensualidades(c.total.toFixed(2), mensualidades.plazo as PlazoMensual, String(mensualidades.primerVencimiento ?? "")).map((q) => ({
          fecha: q.fechaVencimiento,
          importe: q.importe,
        }));
      } catch (e) {
        if (e instanceof GeneracionMensualidadesError) throw new ValidacionError(e.message);
        throw e;
      }
    }
    const suma = cuotas.reduce((s, q) => s + aCentavos(q.importe), BigInt(0));
    if (suma !== aCentavos(c.total.toFixed(2))) {
      throw new ValidacionError(`Las cuotas suman ${formatearImporte(deCentavos(suma))} y el total es ${formatearImporte(c.total.toFixed(2))}; deben coincidir exactamente.`);
    }
    const ordenadas = [...cuotas].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
    const anteriores = c.cuotas.filter((q) => q.vigente);
    if (anteriores.length > 0) {
      await tx.cuotaCuentaComercial.updateMany({ where: { cuentaId: c.id, vigente: true }, data: { vigente: false, sustituidaEn: new Date() } });
    }
    await tx.cuotaCuentaComercial.createMany({
      data: ordenadas.map((q, i) => ({ empresaId, cuentaId: c.id, numero: i + 1, fechaVencimiento: fechaADate(q.fecha), importe: q.importe })),
    });
    const nuevaVersion = c.version + 1;
    await tx.cuentaComercial.update({ where: { id: c.id }, data: { modalidad: d.modalidad, version: nuevaVersion } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_CUENTA,
      entidadId: c.id,
      accion: "EDITAR",
      valorAnterior: {
        modalidad: c.modalidad,
        cuotas: anteriores.map((q) => ({ fecha: dateAFecha(q.fechaVencimiento), importe: q.importe.toFixed(2) })),
      },
      valorNuevo: {
        modalidad: d.modalidad,
        generacion: mensualidades ? { plazoMeses: mensualidades.plazo, primerVencimiento: ordenadas[0].fecha } : "MANUAL",
        cuotas: ordenadas.map((q) => ({ fecha: q.fecha, importe: q.importe })),
        version: nuevaVersion,
      },
    });
    return { version: nuevaVersion };
  });
}

// ---------------------------------------------------------------------------
// B8B — cambiar el vencimiento de UNA cuota
// ---------------------------------------------------------------------------
// - Cuotas con saldo de cuentas VIGENTES (OV, compras y gastos), aunque la
//   cuenta tenga movimientos. Solo administración.
// - Solo cambia la fecha: importes, número de cuotas, modalidad, pagos,
//   aplicaciones y las demás cuotas no se tocan; no regenera mensualidades.
// - Nueva fecha de hoy (zona de la Empresa, B5) en adelante y distinta de la
//   vigente; motivo obligatorio; historial con fecha anterior, nueva, autor y
//   fecha del registro (la pactada originalmente se conserva).
// - Concurrencia: bloquea la cuenta (como un pago) y exige la fecha que leyó
//   el usuario: si otro la cambió, se rechaza sin sobrescribir. Una cuota que
//   un pago simultáneo liquidó ya no cambia.
// - Reintento con la misma clave: devuelve el registro existente.

const esquemaCambioVencimiento = z.strictObject({
  fechaLeida: z.unknown(),
  nuevaFecha: z.unknown(),
  motivo: z.string({ error: "Indica el motivo del cambio." }).trim().min(3, "Indica el motivo del cambio.").max(500, "El motivo admite máximo 500 caracteres."),
});

export async function cambiarVencimientoCuota(
  usuario: UsuarioSesion,
  cuotaId: unknown,
  datosCrudos: unknown,
  claveCruda: unknown
): Promise<{ cambioId: string; reintento: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof cuotaId !== "string" || !cuotaId) throw new RegistroNoEncontradoError("La cuota");
  const clave = z.string({ error: "Clave de registro inválida. Recarga la página." }).trim().min(8).max(200).parse(claveCruda);
  const d = esquemaCambioVencimiento.parse(datosCrudos);
  const fechaLeida = normalizarFecha(d.fechaLeida);
  const nuevaFecha = normalizarFecha(d.nuevaFecha);
  if (!fechaLeida) throw new ValidacionError("Fecha vigente inválida. Recarga la página.");
  if (!nuevaFecha) throw new ValidacionError("Indica la nueva fecha de vencimiento (AAAA-MM-DD).");

  const previo = async () => {
    const h = await db.cambioVencimientoCuota.findFirst({ where: { empresaId, claveRegistro: clave }, select: { id: true, cuotaId: true } });
    if (!h) return null;
    if (h.cuotaId !== cuotaId) throw new ValidacionError("Clave de registro inválida. Recarga la página.");
    return { cambioId: h.id, reintento: true };
  };
  const repetido = await previo();
  if (repetido) return repetido;

  const cuota = await db.cuotaCuentaComercial.findFirst({ where: { id: cuotaId, empresaId }, select: { cuentaId: true } });
  if (!cuota) throw new RegistroNoEncontradoError("La cuota");

  try {
    return await db.$transaction(async (tx) => {
      const c = await bloquearCuenta(tx, empresaId, cuota.cuentaId);
      if (c.estatus !== "VIGENTE") throw new ValidacionError("La cuenta está anulada: no se cambian vencimientos.");
      const hoy = await hoyDeEmpresa(tx, empresaId);
      const q = estadoDe(c, hoy).cuotas.find((x) => x.id === cuotaId);
      if (!q) throw new ValidacionError("La cuota ya no forma parte del calendario vigente.");
      if (aCentavos(q.saldo) <= BigInt(0)) throw new ValidacionError("La cuota está liquidada: su vencimiento ya no cambia.");
      if (q.fechaVencimiento !== fechaLeida) throw new ConflictoEdicionError();
      if (nuevaFecha === q.fechaVencimiento) throw new ValidacionError("La nueva fecha es igual al vencimiento vigente.");
      if (nuevaFecha < hoy) throw new ValidacionError("La nueva fecha debe ser de hoy en adelante.");
      const h = await tx.cambioVencimientoCuota.create({
        data: {
          empresaId,
          cuentaId: c.id,
          cuotaId,
          fechaAnterior: fechaADate(q.fechaVencimiento),
          fechaNueva: fechaADate(nuevaFecha),
          motivo: d.motivo,
          registradoPorId: usuario.id,
          claveRegistro: clave,
        },
        select: { id: true },
      });
      await tx.cuotaCuentaComercial.update({ where: { id: cuotaId }, data: { fechaVencimiento: fechaADate(nuevaFecha) } });
      const nuevaVersion = c.version + 1;
      await tx.cuentaComercial.update({ where: { id: c.id }, data: { version: nuevaVersion } });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_CUENTA,
        entidadId: c.id,
        accion: "EDITAR",
        valorAnterior: { cuota: q.numero, fechaVencimiento: q.fechaVencimiento, version: c.version },
        valorNuevo: { cuota: q.numero, fechaVencimiento: nuevaFecha, motivo: d.motivo, saldo: q.saldo, version: nuevaVersion },
      });
      return { cambioId: h.id, reintento: false };
    });
  } catch (error) {
    if (esUnica(error)) {
      const ganador = await previo();
      if (ganador) return ganador;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cobros y pagos
// ---------------------------------------------------------------------------

const esquemaMovimiento = z.strictObject({
  importe: z.unknown(),
  fecha: z.unknown(),
  metodo: z.enum(METODOS_PAGO, { error: "Selecciona el método de pago." }),
  referencia: z.string().trim().max(100, "La referencia admite máximo 100 caracteres.").nullish().transform((v) => (v ? v : null)),
  observaciones: z.string().trim().max(1000, "Las observaciones admiten máximo 1000 caracteres.").nullish().transform((v) => (v ? v : null)),
  // Opcional: si no se envía se aplica la propuesta (cuotas más antiguas primero).
  aplicaciones: z.array(z.strictObject({ cuotaId: z.string().min(1), importe: z.unknown() })).max(MAX_CUOTAS).optional(),
});

export type ArchivoComprobante = { nombre: string | null; bytes: Uint8Array } | null | undefined;

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

async function eliminarSinFallar(ref: string | null) {
  if (!ref) return;
  try {
    await eliminarArchivo(ref);
  } catch {
    // Un comprobante huérfano no se refiere desde ninguna fila.
  }
}

export async function registrarMovimientoCuenta(
  usuario: UsuarioSesion,
  cuentaId: string,
  datosCrudos: unknown,
  archivo: ArchivoComprobante,
  claveCruda: unknown
): Promise<{ movimientoId: string; existente: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const clave = z.string({ error: "Clave de registro inválida." }).trim().min(8).max(100).parse(claveCruda);
  const d = esquemaMovimiento.parse(datosCrudos);
  const importe = normalizarImporte(d.importe, { permitirCero: false });
  if (!importe) throw new ValidacionError("El importe debe ser mayor que 0 con máximo 2 decimales.");
  const fecha = normalizarFecha(d.fecha);
  if (!fecha) throw new ValidacionError("Indica la fecha real del movimiento (AAAA-MM-DD).");
  if (fecha > (await hoyDeEmpresa(db, empresaId))) throw new ValidacionError("La fecha del movimiento no puede ser futura.");

  const previo = async () => {
    const m = await db.movimientoComercial.findFirst({ where: { empresaId, claveRegistro: clave }, select: { id: true, cuentaId: true } });
    if (!m) return null;
    if (m.cuentaId !== cuentaId) throw new ValidacionError("Clave de registro inválida. Recarga la página.");
    return { movimientoId: m.id, existente: true };
  };
  const repetido = await previo();
  if (repetido) return repetido;

  let ref: string | null = null;
  let tipo: string | null = null;
  let nombre: string | null = null;
  if (archivo && archivo.bytes && archivo.bytes.length > 0) {
    if (archivo.bytes.length > MAX_BYTES_POR_CARGA) throw new ValidacionError(`El comprobante pesa ${formatearTamano(archivo.bytes.length)}; el máximo es ${MB_POR_CARGA} MB. No se registró el movimiento.`);
    const t = tipoArchivoDetectado(archivo.bytes);
    if (!t) throw new ValidacionError("El comprobante debe ser un PDF, JPG o PNG.");
    tipo = t;
    nombre = nombreSeguroDeArchivo(archivo.nombre, t, new Date());
    ref = `comercializacion/${empresaId}/movimientos/${cuentaId}/${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "")}-${nombre}`;
    await subirBytes(ref, archivo.bytes, t);
  }

  try {
    const r = await db.$transaction(async (tx) => {
      const c = await bloquearCuenta(tx, empresaId, cuentaId);
      if (c.estatus !== "VIGENTE") throw new ValidacionError("La cuenta está anulada.");
      if (c.compra && c.compra.estatus !== "CONFIRMADA") throw new ValidacionError("Solo se paga una compra confirmada.");
      if (c.gasto && c.gasto.estatus !== "VIGENTE") throw new ValidacionError("El gasto está anulado.");
      const estado = estadoDe(c, await hoyDeEmpresa(tx, empresaId));
      if (estado.cuotas.length === 0) throw new ValidacionError("Define las condiciones de pago (contado o crédito) antes de registrar el primer movimiento.");
      if (aCentavos(importe) > aCentavos(estado.saldo)) {
        throw new ValidacionError(`El importe (${formatearImporte(importe)}) supera el saldo disponible (${formatearImporte(estado.saldo)}). No se registran saldos a favor.`);
      }
      let aplicaciones: { cuotaId: string; importe: string }[];
      if (d.aplicaciones && d.aplicaciones.length > 0) {
        const porId = new Map(estado.cuotas.map((q) => [q.id, q]));
        const vistas = new Set<string>();
        aplicaciones = d.aplicaciones
          .map((a, i) => {
            const q = porId.get(a.cuotaId);
            if (!q) throw new ValidacionError(`Aplicación ${i + 1}: la cuota no pertenece a esta cuenta.`);
            if (vistas.has(a.cuotaId)) throw new ValidacionError(`Aplicación ${i + 1}: la cuota está repetida.`);
            vistas.add(a.cuotaId);
            const imp = normalizarImporte(a.importe, { permitirCero: true });
            if (imp === null) throw new ValidacionError(`Aplicación ${i + 1}: importe inválido.`);
            if (aCentavos(imp) > aCentavos(q.saldo)) throw new ValidacionError(`La cuota ${q.numero} solo tiene ${formatearImporte(q.saldo)} de saldo.`);
            return { cuotaId: a.cuotaId, importe: imp };
          })
          .filter((a) => aCentavos(a.importe) > BigInt(0));
        const suma = aplicaciones.reduce((s, a) => s + aCentavos(a.importe), BigInt(0));
        if (suma !== aCentavos(importe)) {
          throw new ValidacionError(`La distribución suma ${formatearImporte(deCentavos(suma))} y el movimiento es de ${formatearImporte(importe)}; deben coincidir.`);
        }
      } else {
        const p = proponerAplicacion(estado.cuotas, importe);
        if (!p) throw new ValidacionError("El importe supera el saldo disponible.");
        aplicaciones = p;
      }

      const mov = await tx.movimientoComercial.create({
        data: {
          empresaId,
          cuentaId: c.id,
          importe,
          fecha: fechaADate(fecha),
          metodo: d.metodo,
          referencia: d.referencia,
          observaciones: d.observaciones,
          comprobanteRef: ref,
          comprobanteNombre: nombre,
          comprobanteTipo: tipo,
          comprobanteBytes: ref ? archivo!.bytes.length : null,
          registradoPorId: usuario.id,
          claveRegistro: clave,
        },
        select: { id: true },
      });
      await tx.aplicacionMovimientoComercial.createMany({
        data: aplicaciones.map((a) => ({ empresaId, movimientoId: mov.id, cuotaId: a.cuotaId, importe: a.importe })),
      });
      const numero = new Map(estado.cuotas.map((q) => [q.id, q.numero]));
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_MOVIMIENTO,
        entidadId: mov.id,
        accion: "CREAR",
        valorNuevo: {
          tipo: c.tipo === "POR_COBRAR" ? "cobro" : "pago",
          documento: c.ordenVenta?.folio ?? c.compra?.folio ?? (c.gasto ? folioGasto(c.gasto) : undefined),
          importe,
          fecha,
          metodo: d.metodo,
          referencia: d.referencia,
          aplicaciones: aplicaciones.map((a) => ({ cuota: numero.get(a.cuotaId), importe: a.importe })),
          comprobante: nombre,
        },
      });
      return { movimientoId: mov.id, existente: false };
    });
    return r;
  } catch (error) {
    await eliminarSinFallar(ref);
    if (esUnica(error)) {
      const ganador = await previo();
      if (ganador) return ganador;
    }
    throw error;
  }
}

export async function anularMovimientoCuenta(usuario: UsuarioSesion, movimientoId: string, motivoCrudo: unknown): Promise<{ yaAnulado: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const motivo = z.string({ error: "Indica el motivo de la anulación." }).trim().min(3, "Indica el motivo de la anulación.").max(500).parse(motivoCrudo);
  if (typeof movimientoId !== "string" || !movimientoId) throw new RegistroNoEncontradoError("El movimiento");
  const m = await db.movimientoComercial.findFirst({ where: { id: movimientoId, empresaId }, select: { cuentaId: true } });
  if (!m) throw new RegistroNoEncontradoError("El movimiento");
  return db.$transaction(async (tx) => {
    const c = await bloquearCuenta(tx, empresaId, m.cuentaId);
    const mov = await tx.movimientoComercial.findFirstOrThrow({ where: { id: movimientoId, empresaId }, select: { estatus: true, importe: true, fecha: true } });
    if (mov.estatus === "ANULADO") return { yaAnulado: true };
    await tx.movimientoComercial.update({ where: { id: movimientoId }, data: { estatus: "ANULADO", anuladoEn: new Date(), anuladoPorId: usuario.id, motivoAnulacion: motivo } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_MOVIMIENTO,
      entidadId: movimientoId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "VIGENTE" },
      valorNuevo: {
        estatus: "ANULADO",
        motivo,
        documento: c.ordenVenta?.folio ?? c.compra?.folio,
        importe: mov.importe.toFixed(2),
        nota: "Corrección de registro; no es una devolución bancaria.",
      },
    });
    return { yaAnulado: false };
  });
}

export async function obtenerComprobanteMovimiento(usuario: UsuarioSesion, movimientoId: string): Promise<{ bytes: Buffer; tipo: string; nombre: string }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const m = await db.movimientoComercial.findFirst({
    where: { id: typeof movimientoId === "string" ? movimientoId : "", empresaId },
    select: { comprobanteRef: true, comprobanteTipo: true, comprobanteNombre: true },
  });
  if (!m) throw new RegistroNoEncontradoError("El movimiento");
  if (!m.comprobanteRef) throw new RegistroNoEncontradoError("El comprobante");
  return { bytes: await obtenerArchivo(m.comprobanteRef), tipo: m.comprobanteTipo!, nombre: m.comprobanteNombre! };
}

// ---------------------------------------------------------------------------
// Indicadores (solo administración)
// ---------------------------------------------------------------------------

export type ResumenSaldos = { saldo: string; vencido: string; sinCondiciones: number };

function sumarEstados(estados: EstadoCuenta[]): ResumenSaldos {
  let saldo = BigInt(0);
  let vencido = BigInt(0);
  let sin = 0;
  for (const e of estados) {
    saldo += aCentavos(e.saldo);
    vencido += aCentavos(e.vencido);
    if (e.situacion === "SIN_CALENDARIO") sin++;
  }
  return { saldo: deCentavos(saldo), vencido: deCentavos(vencido), sinCondiciones: sin };
}

/** Por cobrar (cuenta de la OV) y por pagar (compras confirmadas vigentes de la OV). */
export async function resumenFinancieroOrden(
  usuario: UsuarioSesion,
  ordenVentaId: string
): Promise<{ porCobrar: ResumenSaldos; porPagar: ResumenSaldos; comprasConCuenta: number; gastosConCuenta: number }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const hoy = await hoyDeEmpresa(db, empresaId);
  const [cobro, pagos] = await Promise.all([
    db.cuentaComercial.findMany({ where: { empresaId, ordenVentaId, estatus: "VIGENTE" }, include: INCLUIR_CUENTA }),
    db.cuentaComercial.findMany({
      where: {
        empresaId,
        estatus: "VIGENTE",
        tipo: "POR_PAGAR",
        OR: [{ compra: { ordenVentaId, estatus: "CONFIRMADA" } }, { gasto: { ordenVentaId, estatus: "VIGENTE" } }],
      },
      include: INCLUIR_CUENTA,
    }),
  ]);
  return {
    porCobrar: sumarEstados(cobro.map((c) => estadoDe(c, hoy))),
    porPagar: sumarEstados(pagos.map((c) => estadoDe(c, hoy))),
    comprasConCuenta: pagos.filter((c) => c.compraId).length,
    gastosConCuenta: pagos.filter((c) => c.gastoId).length,
  };
}

/** Indicadores de la Empresa: por cobrar, por pagar y vencidos (solo cuentas vigentes). */
export async function indicadoresCuentasEmpresa(usuario: UsuarioSesion): Promise<{ porCobrar: ResumenSaldos; porPagar: ResumenSaldos }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const hoy = await hoyDeEmpresa(db, empresaId);
  const cuentas = await db.cuentaComercial.findMany({ where: { empresaId, estatus: "VIGENTE" }, include: INCLUIR_CUENTA });
  return {
    porCobrar: sumarEstados(cuentas.filter((c) => c.tipo === "POR_COBRAR").map((c) => estadoDe(c, hoy))),
    porPagar: sumarEstados(cuentas.filter((c) => c.tipo === "POR_PAGAR").map((c) => estadoDe(c, hoy))),
  };
}

/** Estado de cobro por OV (para la columna "Cobro" del listado de administración). */
export async function estadoCobroDeOrdenes(
  usuario: UsuarioSesion,
  ordenIds: string[]
): Promise<Map<string, Pick<EstadoCuenta, "liquidacion" | "situacion" | "saldo" | "vencido">>> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (ordenIds.length === 0) return new Map();
  const hoy = await hoyDeEmpresa(db, empresaId);
  const cuentas = await db.cuentaComercial.findMany({ where: { empresaId, ordenVentaId: { in: ordenIds } }, include: INCLUIR_CUENTA });
  return new Map(
    cuentas.map((c) => {
      const e = estadoDe(c, hoy);
      return [c.ordenVentaId!, { liquidacion: e.liquidacion, situacion: e.situacion, saldo: e.saldo, vencido: e.vencido }];
    })
  );
}

/** Cuentas por pagar de los gastos de una OV, por gastoId (solo administración). */
export async function detallesCuentasDeGastos(usuario: UsuarioSesion, ordenVentaId: string): Promise<Map<string, DetalleCuenta>> {
  const empresaId = requerirAdministracionComercial(usuario);
  const hoy = await hoyDeEmpresa(db, empresaId);
  const cuentas = await db.cuentaComercial.findMany({ where: { empresaId, gasto: { ordenVentaId, empresaId } }, include: INCLUIR_CUENTA });
  return new Map(cuentas.map((c) => [c.gastoId!, aDetalle(c, hoy)]));
}

/** Para B7: anula la cuenta por pagar de un gasto que se anula — solo si nunca tuvo pagos. Requiere el gasto y la cuenta ya bloqueados. */
export async function anularCuentaDeGastoTx(tx: Tx, empresaId: string, gastoId: string, usuarioId: string, motivo: string) {
  const c = await tx.cuentaComercial.findFirst({ where: { gastoId, empresaId }, select: { id: true, estatus: true, tuvoMovimientos: true } });
  if (!c || c.estatus === "ANULADA") return;
  if (c.tuvoMovimientos) throw new ValidacionError("El gasto tiene historial de pagos (aunque estén anulados); no se puede anular con la acción simple.");
  await tx.cuentaComercial.update({ where: { id: c.id }, data: { estatus: "ANULADA", anuladaEn: new Date(), anuladaPorId: usuarioId, motivoAnulacion: motivo, version: { increment: 1 } } });
  await registrarAuditoriaTx(tx, {
    empresaId,
    usuarioId,
    entidad: ENTIDAD_CUENTA,
    entidadId: c.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: "VIGENTE" },
    valorNuevo: { estatus: "ANULADA", motivo, origen: "anulación del gasto" },
  });
}

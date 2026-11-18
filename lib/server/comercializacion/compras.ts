import "server-only";
import { randomBytes } from "crypto";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { obtenerArchivo, subirBytes } from "@/lib/server/archivos";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { crearProveedor } from "@/lib/server/catalogos";
import { requerirAdministracionComercial } from "@/lib/server/comercializacion/acceso";
import { ConflictoEdicionError } from "@/lib/server/comercializacion/cotizaciones";
import { anularCuentaDeCompraTx, compraTuvoPagosTx, crearCuentaTx } from "@/lib/server/comercializacion/cuentas";
import { bloqueosSurtidoDeCompraTx } from "@/lib/server/comercializacion/surtido";
import {
  aMilesimas,
  calcularImportePartida,
  calcularTotalesCotizacion,
  normalizarCantidad,
  normalizarImporte,
  normalizarTasa,
  TRATAMIENTOS_IMPUESTO,
  type TotalesCotizacion,
  type TratamientoImpuesto,
} from "@/lib/comercializacion/importes";
import { dateAFecha, fechaADate, hoyNegocio, normalizarFecha } from "@/lib/comercializacion/fechas";
import { nombreSeguroDeArchivo, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";
import { MAX_BYTES_POR_CARGA, MB_POR_CARGA, formatearTamano } from "@/lib/comercializacion/cargas";

// Compras a proveedores de una orden de venta — B4 (noviembre 2026).
// docs/negocio/comercializacion.md §20 (B4). Reglas:
// - SOLO Administrador/Director (todas las funciones exigen administración):
//   el vendedor no recibe compras, proveedores, costos ni documentos.
// - Una OV admite varias compras; cada compra es de una OV y un proveedor
//   (catálogo existente: Beneficiario PROVEEDOR de la misma Empresa).
// - Partidas: vínculo con la partida VENDIDA de esa OV + copia de
//   descripción, unidad, cantidad, costo e impuesto DE COMPRA (independiente
//   del de venta). Se compra en la unidad de venta (sin conversiones).
// - Cálculo exacto con las reglas de B2 (importe por partida half-up; IVA
//   agrupado por tasa; tasa 0 y exento separados).
// - pendiente por comprar = vendido − Σ cantidades de compras CONFIRMADAS
//   (los borradores y las anuladas no consumen). No se permite exceder lo
//   vendido; la confirmación bloquea la OV para que dos confirmaciones
//   simultáneas no lo superen juntas (y la base lo vuelve a comprobar).
// - Confirmada = inmutable; se anula con motivo (libera cantidades, conserva
//   historial). Sin pagos, cuotas, recepciones ni efectos en construcción.
// - El costo de referencia del catálogo es solo orientativo: nunca se copia
//   como costo confirmado y un costo faltante nunca se toma como cero.

export const ENTIDAD_COMPRA = "CompraComercial";
const PREFIJO = "COC-";
const formatoFolio = (n: number) => `${PREFIJO}${String(n).padStart(6, "0")}`;
const MAX_PARTIDAS = 200;

const milesimasATexto = (m: bigint) => {
  const neg = m < BigInt(0);
  const a = neg ? -m : m;
  return `${neg ? "-" : ""}${a / BigInt(1000)}.${(a % BigInt(1000)).toString().padStart(3, "0")}`;
};
const dec3 = (d: Prisma.Decimal) => d.toFixed(3);

// ---------------------------------------------------------------------------
// Proveedores (catálogo existente)
// ---------------------------------------------------------------------------

export type OpcionProveedor = { id: string; nombre: string };

/** Proveedores activos de la Empresa (sin alias de "misma persona"). */
export async function listarProveedoresComerciales(usuario: UsuarioSesion): Promise<OpcionProveedor[]> {
  const empresaId = requerirAdministracionComercial(usuario);
  return db.beneficiario.findMany({
    where: { empresaId, tipo: "PROVEEDOR", activo: true, mismaPersonaQueId: null },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
}

/** Alta mínima de proveedor reutilizando el servicio de Catálogos (mismo registro y bitácora). */
export async function crearProveedorComercial(usuario: UsuarioSesion, datosCrudos: unknown): Promise<OpcionProveedor> {
  requerirAdministracionComercial(usuario);
  const d = z
    .object({
      nombre: z.string({ error: "El nombre del proveedor es obligatorio." }).trim().min(1, "El nombre del proveedor es obligatorio.").max(200),
      razonSocial: z.string().trim().max(200).optional(),
      rfc: z.string().trim().max(20).optional(),
    })
    .parse(datosCrudos);
  const p = await crearProveedor(usuario, { nombre: d.nombre, razonSocial: d.razonSocial || null, rfc: d.rfc || null });
  return { id: p.id, nombre: p.nombre };
}

// ---------------------------------------------------------------------------
// Cantidades por partida de la OV
// ---------------------------------------------------------------------------

type Cliente = Prisma.TransactionClient | typeof db;

async function ordenDeMiEmpresa(cliente: Cliente, empresaId: string, ordenVentaId: string) {
  if (typeof ordenVentaId !== "string" || !ordenVentaId) throw new RegistroNoEncontradoError("La orden de venta");
  const ov = await cliente.ordenVenta.findFirst({
    where: { id: ordenVentaId, empresaId },
    select: { id: true, folio: true, cotizacionId: true, cotizacion: { select: { folio: true, estatus: true } } },
  });
  if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
  return ov;
}

export type CantidadesPartidaVenta = {
  partidaVentaId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  vendido: string; // "100.000"
  comprado: string; // confirmado, no anulado
  enBorrador: string; // informativo: no consume
  pendiente: string;
  costoReferencia: string | null; // ORIENTATIVO (catálogo actual), solo administración
};

export async function cantidadesDeOrden(cliente: Cliente, empresaId: string, cotizacionId: string): Promise<CantidadesPartidaVenta[]> {
  const partidas = await cliente.partidaCotizacionVenta.findMany({
    where: { cotizacionId, empresaId },
    orderBy: { orden: "asc" },
    select: {
      id: true,
      codigo: true,
      descripcion: true,
      unidad: true,
      cantidad: true,
      producto: { select: { costoReferencia: true } },
      partidasCompra: { select: { cantidad: true, compra: { select: { estatus: true } } } },
    },
  });
  return partidas.map((p) => {
    let comprado = BigInt(0);
    let borrador = BigInt(0);
    for (const pc of p.partidasCompra) {
      const m = aMilesimas(dec3(pc.cantidad));
      if (pc.compra.estatus === "CONFIRMADA") comprado += m;
      else if (pc.compra.estatus === "BORRADOR") borrador += m;
    }
    const vendido = aMilesimas(dec3(p.cantidad));
    return {
      partidaVentaId: p.id,
      codigo: p.codigo,
      descripcion: p.descripcion,
      unidad: p.unidad,
      vendido: dec3(p.cantidad),
      comprado: milesimasATexto(comprado),
      enBorrador: milesimasATexto(borrador),
      pendiente: milesimasATexto(vendido - comprado),
      costoReferencia: p.producto.costoReferencia === null ? null : p.producto.costoReferencia.toFixed(2),
    };
  });
}

export type FilaCompraOrden = {
  id: string;
  folio: string;
  estatus: "BORRADOR" | "CONFIRMADA" | "ANULADA";
  proveedorNombre: string | null;
  fecha: string;
  total: string;
  completa: boolean;
};

export type ResumenComprasOrden = {
  ordenVentaId: string;
  ordenFolio: string;
  partidas: CantidadesPartidaVenta[];
  compras: FilaCompraOrden[];
};

/** Bloque "Compras a proveedores" del detalle de la OV — solo administración. */
export async function resumenComprasOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<ResumenComprasOrden> {
  const empresaId = requerirAdministracionComercial(usuario);
  const ov = await ordenDeMiEmpresa(db, empresaId, ordenVentaId);
  const [partidas, compras] = await Promise.all([
    cantidadesDeOrden(db, empresaId, ov.cotizacionId),
    db.compraComercial.findMany({
      where: { empresaId, ordenVentaId: ov.id },
      orderBy: { numeroFolio: "asc" },
      select: {
        id: true,
        folio: true,
        estatus: true,
        fecha: true,
        total: true,
        proveedorConfirmado: true,
        proveedor: { select: { nombre: true } },
        partidas: { select: { costoUnitario: true, tratamientoImpuesto: true } },
      },
    }),
  ]);
  return {
    ordenVentaId: ov.id,
    ordenFolio: ov.folio,
    partidas,
    compras: compras.map((c) => ({
      id: c.id,
      folio: c.folio,
      estatus: c.estatus,
      proveedorNombre: (c.proveedorConfirmado as { nombre?: string } | null)?.nombre ?? c.proveedor?.nombre ?? null,
      fecha: dateAFecha(c.fecha),
      total: c.total.toFixed(2),
      completa: c.partidas.length > 0 && c.partidas.every((p) => p.costoUnitario !== null && p.tratamientoImpuesto !== null),
    })),
  };
}

// ---------------------------------------------------------------------------
// Crear borrador
// ---------------------------------------------------------------------------

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

/** Crea un borrador VACÍO (folio COC asignado) para una OV. Idempotente por clave. */
export async function crearCompraComercial(
  usuario: UsuarioSesion,
  ordenVentaId: string,
  claveCreacionCruda?: unknown
): Promise<{ id: string; folio: string; reintento: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const claveCreacion = z.string().trim().min(8).max(100).nullish().parse(claveCreacionCruda) ?? null;
  const ov = await ordenDeMiEmpresa(db, empresaId, ordenVentaId);
  if (ov.cotizacion.estatus !== "ACEPTADA") throw new ValidacionError("Solo se compra para una orden de venta aceptada.");

  const previa = async () => {
    if (!claveCreacion) return null;
    const c = await db.compraComercial.findFirst({ where: { empresaId, claveCreacion }, select: { id: true, folio: true, ordenVentaId: true } });
    if (!c) return null;
    if (c.ordenVentaId !== ov.id) throw new ValidacionError("Clave de creación inválida. Recarga la página.");
    return { id: c.id, folio: c.folio, reintento: true };
  };
  const repetida = await previa();
  if (repetida) return repetida;

  try {
    return await db.$transaction(async (tx) => {
      const { ultimoFolioCompraComercial: numero } = await tx.empresa.update({
        where: { id: empresaId },
        data: { ultimoFolioCompraComercial: { increment: 1 } },
        select: { ultimoFolioCompraComercial: true },
      });
      const folio = formatoFolio(numero);
      const compra = await tx.compraComercial.create({
        data: {
          empresaId,
          folio,
          numeroFolio: numero,
          ordenVentaId: ov.id,
          fecha: fechaADate(hoyNegocio()),
          creadoPorId: usuario.id,
          claveCreacion,
        },
        select: { id: true },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_COMPRA,
        entidadId: compra.id,
        accion: "CREAR",
        valorNuevo: { folio, estatus: "BORRADOR", ordenVenta: ov.folio },
      });
      return { id: compra.id, folio, reintento: false };
    });
  } catch (error) {
    if (claveCreacion && esUnica(error)) {
      const ganadora = await previa();
      if (ganadora) return ganadora;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Guardar borrador
// ---------------------------------------------------------------------------

const vacio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

const esquemaPartida = z.strictObject(
  {
    partidaVentaId: z.string({ error: "Partida inválida." }).min(1, "Partida inválida."),
    cantidad: z.unknown(),
    costoUnitario: z.unknown().optional(),
    tratamientoImpuesto: z.unknown().optional(),
    tasaIva: z.unknown().optional(),
  },
  { error: (i) => (i.code === "unrecognized_keys" ? `Campo no permitido en una partida: ${i.keys.join(", ")}.` : undefined) }
);

const textoOpcional = (max: number, campo: string) =>
  z
    .string({ error: `${campo} inválido.` })
    .trim()
    .max(max, `${campo} admite máximo ${max} caracteres.`)
    .nullish()
    .transform((v) => (v ? v : null));

const esquemaCompra = z.strictObject(
  {
    proveedorId: z
      .string()
      .nullish()
      .transform((v) => (v ? v : null)),
    fecha: z.unknown(),
    referenciaProveedor: textoOpcional(100, "La referencia del proveedor"),
    notas: textoOpcional(2000, "Las notas"),
    partidas: z.array(esquemaPartida).max(MAX_PARTIDAS, `Máximo ${MAX_PARTIDAS} partidas por compra.`),
  },
  { error: (i) => (i.code === "unrecognized_keys" ? `Campo no permitido: ${i.keys.join(", ")}.` : undefined) }
);

type LineaCompra = {
  partidaVentaId: string;
  cantidad: string;
  costoUnitario: string | null;
  tratamientoImpuesto: TratamientoImpuesto | null;
  tasaIva: string | null;
};

export function validarDatosCompra(datosCrudos: unknown) {
  const d = esquemaCompra.parse(datosCrudos);
  const fecha = normalizarFecha(d.fecha);
  if (!fecha) throw new ValidacionError("La fecha de la compra es obligatoria (AAAA-MM-DD).");
  const vistas = new Set<string>();
  const partidas: LineaCompra[] = d.partidas.map((p, i) => {
    const n = i + 1;
    if (vistas.has(p.partidaVentaId)) throw new ValidacionError(`Partida ${n}: el material está repetido en la compra.`);
    vistas.add(p.partidaVentaId);
    const cantidad = normalizarCantidad(p.cantidad);
    if (!cantidad) throw new ValidacionError(`Partida ${n}: la cantidad debe ser mayor que 0 con máximo 3 decimales.`);
    let costoUnitario: string | null = null;
    if (!vacio(p.costoUnitario)) {
      costoUnitario = normalizarImporte(p.costoUnitario, { permitirCero: false });
      if (!costoUnitario) throw new ValidacionError(`Partida ${n}: el costo unitario debe ser mayor que 0 con máximo 2 decimales.`);
    }
    let tratamientoImpuesto: TratamientoImpuesto | null = null;
    let tasaIva: string | null = null;
    if (!vacio(p.tratamientoImpuesto)) {
      if (!TRATAMIENTOS_IMPUESTO.includes(p.tratamientoImpuesto as TratamientoImpuesto)) {
        throw new ValidacionError(`Partida ${n}: tratamiento de impuesto inválido.`);
      }
      tratamientoImpuesto = p.tratamientoImpuesto as TratamientoImpuesto;
      if (tratamientoImpuesto === "GRAVADO") {
        tasaIva = normalizarTasa(p.tasaIva);
        if (!tasaIva) throw new ValidacionError(`Partida ${n}: indica la tasa de IVA de la compra (mayor que 0 y hasta 100 %).`);
      } else if (!vacio(p.tasaIva) && normalizarTasa(p.tasaIva) !== null) {
        throw new ValidacionError(`Partida ${n}: la tasa de IVA solo aplica a compras gravadas.`);
      }
    } else if (!vacio(p.tasaIva)) {
      throw new ValidacionError(`Partida ${n}: selecciona el tratamiento de impuesto de la compra.`);
    }
    return { partidaVentaId: p.partidaVentaId, cantidad, costoUnitario, tratamientoImpuesto, tasaIva };
  });
  return {
    proveedorId: d.proveedorId,
    fecha,
    referenciaProveedor: d.referenciaProveedor,
    notas: d.notas,
    partidas,
  };
}

const lineaCompleta = (l: { costoUnitario: string | null; tratamientoImpuesto: TratamientoImpuesto | null }) =>
  l.costoUnitario !== null && l.tratamientoImpuesto !== null;

function importeDe(l: LineaCompra, n: number): string | null {
  if (!l.costoUnitario) return null;
  try {
    return calcularImportePartida(l.cantidad, l.costoUnitario);
  } catch {
    throw new ValidacionError(`Partida ${n}: el importe excede el máximo permitido.`);
  }
}

function totalesDe(lineas: { importe: string | null; tratamientoImpuesto: TratamientoImpuesto | null; tasaIva: string | null }[]): TotalesCotizacion {
  try {
    return calcularTotalesCotizacion(
      lineas
        .filter((l) => l.importe !== null && l.tratamientoImpuesto !== null)
        .map((l) => ({ importe: l.importe!, tratamientoImpuesto: l.tratamientoImpuesto!, tasaIva: l.tasaIva }))
    );
  } catch {
    throw new ValidacionError("El total de la compra excede el máximo permitido.");
  }
}

async function bloquearCompra(tx: Prisma.TransactionClient, empresaId: string, compraId: string) {
  if (typeof compraId !== "string" || !compraId) throw new RegistroNoEncontradoError("La compra");
  const fila = await tx.compraComercial.findFirst({ where: { id: compraId, empresaId }, select: { ordenVentaId: true } });
  if (!fila) throw new RegistroNoEncontradoError("La compra");
  // Orden de bloqueo fijo (OV → compra) en confirmar/anular/guardar: evita interbloqueos.
  await tx.$queryRaw`SELECT id FROM ordenes_venta WHERE id = ${fila.ordenVentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM compras_comerciales WHERE id = ${compraId} AND "empresaId" = ${empresaId} FOR UPDATE`;
  return tx.compraComercial.findFirstOrThrow({
    where: { id: compraId, empresaId },
    include: {
      ordenVenta: { select: { id: true, folio: true, cotizacionId: true } },
      partidas: { orderBy: { orden: "asc" } },
    },
  });
}

export async function guardarBorradorCompra(
  usuario: UsuarioSesion,
  compraId: string,
  versionLeida: unknown,
  datosCrudos: unknown
): Promise<{ version: number; sinCambios: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const version = z.number({ error: "Versión inválida." }).int().min(1).parse(versionLeida);
  const datos = validarDatosCompra(datosCrudos);

  return db.$transaction(async (tx) => {
    const actual = await bloquearCompra(tx, empresaId, compraId);
    if (actual.estatus !== "BORRADOR") throw new ValidacionError("Solo se edita una compra en borrador.");
    if (actual.version !== version) throw new ConflictoEdicionError();

    if (datos.proveedorId) {
      const prov = await tx.beneficiario.findFirst({ where: { id: datos.proveedorId, empresaId, tipo: "PROVEEDOR" }, select: { id: true } });
      if (!prov) throw new RegistroNoEncontradoError("El proveedor");
    }
    // Solo partidas de ESTA OV (la base también lo exige).
    const ventas = new Map(
      (
        await tx.partidaCotizacionVenta.findMany({
          where: { cotizacionId: actual.ordenVenta.cotizacionId, empresaId },
          select: { id: true, codigo: true, descripcion: true, unidad: true },
        })
      ).map((p) => [p.id, p])
    );
    const lineas = datos.partidas.map((l, i) => {
      const venta = ventas.get(l.partidaVentaId);
      if (!venta) throw new ValidacionError(`Partida ${i + 1}: el material no pertenece a la orden de venta ${actual.ordenVenta.folio}.`);
      return { ...l, venta, orden: i, importe: importeDe(l, i + 1) };
    });
    const totales = totalesDe(lineas);

    const antes = {
      proveedorId: actual.proveedorId,
      fecha: dateAFecha(actual.fecha),
      referenciaProveedor: actual.referenciaProveedor,
      notas: actual.notas,
      partidas: actual.partidas.map((p) => [p.partidaVentaId, dec3(p.cantidad), p.costoUnitario?.toFixed(2) ?? null, p.tratamientoImpuesto, p.tasaIva?.toFixed(2) ?? null]),
    };
    const despues = {
      proveedorId: datos.proveedorId,
      fecha: datos.fecha,
      referenciaProveedor: datos.referenciaProveedor,
      notas: datos.notas,
      partidas: lineas.map((l) => [l.partidaVentaId, l.cantidad, l.costoUnitario, l.tratamientoImpuesto, l.tasaIva]),
    };
    if (JSON.stringify(antes) === JSON.stringify(despues)) return { version: actual.version, sinCambios: true };

    await tx.partidaCompraComercial.deleteMany({ where: { compraId: actual.id, empresaId } });
    if (lineas.length > 0) {
      await tx.partidaCompraComercial.createMany({
        data: lineas.map((l) => ({
          empresaId,
          compraId: actual.id,
          orden: l.orden,
          partidaVentaId: l.partidaVentaId,
          codigo: l.venta.codigo,
          descripcion: l.venta.descripcion,
          unidad: l.venta.unidad,
          cantidad: l.cantidad,
          costoUnitario: l.costoUnitario,
          tratamientoImpuesto: l.tratamientoImpuesto,
          tasaIva: l.tasaIva,
          importe: l.importe,
        })),
      });
    }
    const nuevaVersion = actual.version + 1;
    await tx.compraComercial.update({
      where: { id: actual.id },
      data: {
        proveedorId: datos.proveedorId,
        fecha: fechaADate(datos.fecha),
        referenciaProveedor: datos.referenciaProveedor,
        notas: datos.notas,
        subtotal: totales.subtotal,
        iva: totales.iva,
        total: totales.total,
        version: nuevaVersion,
        actualizadoPorId: usuario.id,
      },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COMPRA,
      entidadId: actual.id,
      accion: "EDITAR",
      valorAnterior: { ...antes, version: actual.version },
      valorNuevo: { ...despues, version: nuevaVersion, total: totales.total },
    });
    return { version: nuevaVersion, sinCambios: false };
  });
}

// ---------------------------------------------------------------------------
// Confirmar
// ---------------------------------------------------------------------------

export async function confirmarCompraComercial(
  usuario: UsuarioSesion,
  compraId: string,
  versionLeida: unknown
): Promise<{ version: number; yaConfirmada: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const version = z.number({ error: "Versión inválida." }).int().min(1).parse(versionLeida);

  return db.$transaction(async (tx) => {
    const c = await bloquearCompra(tx, empresaId, compraId);
    // Idempotente: confirmar una compra ya confirmada devuelve éxito sin cambios.
    if (c.estatus === "CONFIRMADA") return { version: c.version, yaConfirmada: true };
    if (c.estatus !== "BORRADOR") throw new ValidacionError("Una compra anulada no se puede confirmar.");
    if (c.version !== version) throw new ConflictoEdicionError();

    const faltan: string[] = [];
    if (!c.proveedorId) faltan.push("proveedor");
    if (c.partidas.length === 0) faltan.push("al menos un material");
    const incompletas = c.partidas.filter((p) => !lineaCompleta({ costoUnitario: p.costoUnitario?.toFixed(2) ?? null, tratamientoImpuesto: p.tratamientoImpuesto }));
    if (incompletas.length > 0) faltan.push(`costo e impuesto de ${incompletas.map((p) => p.codigo).join(", ")}`);
    if (faltan.length > 0) throw new ValidacionError(`Para confirmar falta: ${faltan.join("; ")}.`);

    const proveedor = await tx.beneficiario.findFirst({
      where: { id: c.proveedorId!, empresaId, tipo: "PROVEEDOR", activo: true },
      select: { nombre: true, mismaPersonaQueId: true, proveedor: { select: { razonSocial: true, rfc: true } } },
    });
    if (!proveedor || proveedor.mismaPersonaQueId) throw new ValidacionError("El proveedor no está activo en el catálogo.");

    // Cantidades: lo confirmado (sin esta compra) + esta compra ≤ vendido.
    const cantidades = new Map((await cantidadesDeOrden(tx, empresaId, c.ordenVenta.cotizacionId)).map((p) => [p.partidaVentaId, p]));
    for (const p of c.partidas) {
      const q = cantidades.get(p.partidaVentaId)!;
      const disponible = aMilesimas(q.vendido) - aMilesimas(q.comprado);
      if (aMilesimas(dec3(p.cantidad)) > disponible) {
        throw new ValidacionError(
          `${p.codigo}: la compra (${Number(dec3(p.cantidad))} ${p.unidad}) supera lo pendiente por comprar (${Number(milesimasATexto(disponible))} ${p.unidad}).`
        );
      }
    }

    // Recalcular importes y totales exactos antes de congelar.
    const lineas = c.partidas.map((p) => ({
      cantidad: dec3(p.cantidad),
      costoUnitario: p.costoUnitario!.toFixed(2),
      tratamientoImpuesto: p.tratamientoImpuesto!,
      tasaIva: p.tasaIva?.toFixed(2) ?? null,
    }));
    const importes = lineas.map((l) => calcularImportePartida(l.cantidad, l.costoUnitario));
    const totales = totalesDe(lineas.map((l, i) => ({ ...l, importe: importes[i] })));
    for (let i = 0; i < c.partidas.length; i++) {
      if (c.partidas[i].importe?.toFixed(2) !== importes[i]) {
        throw new ValidacionError("Los importes guardados no coinciden con el cálculo. Guarda el borrador de nuevo antes de confirmar.");
      }
    }

    const nuevaVersion = c.version + 1;
    const proveedorConfirmado = { nombre: proveedor.nombre, razonSocial: proveedor.proveedor?.razonSocial ?? null, rfc: proveedor.proveedor?.rfc ?? null };
    await tx.compraComercial.update({
      where: { id: c.id },
      data: {
        estatus: "CONFIRMADA",
        proveedorConfirmado,
        confirmadaEn: new Date(),
        confirmadaPorId: usuario.id,
        subtotal: totales.subtotal,
        iva: totales.iva,
        total: totales.total,
        version: nuevaVersion,
        actualizadoPorId: usuario.id,
      },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COMPRA,
      entidadId: c.id,
      accion: "CONFIRMAR",
      valorAnterior: { estatus: "BORRADOR", version: c.version },
      valorNuevo: {
        estatus: "CONFIRMADA",
        version: nuevaVersion,
        proveedor: proveedorConfirmado.nombre,
        partidas: c.partidas.map((p, i) => ({ codigo: p.codigo, cantidad: lineas[i].cantidad, costoUnitario: lineas[i].costoUnitario })),
        total: totales.total,
      },
    });
    // B5: la cuenta por pagar nace con la confirmación, en la misma transacción.
    await crearCuentaTx(tx, { empresaId, usuarioId: usuario.id, compraId: c.id, total: totales.total });
    return { version: nuevaVersion, yaConfirmada: false };
  });
}

// ---------------------------------------------------------------------------
// Anular
// ---------------------------------------------------------------------------

/**
 * Motivos que impiden una anulación SIMPLE. Punto único de extensión:
 * - B5: cualquier pago registrado, AUNQUE se haya anulado después (la
 *   historia de pagos exige un reverso explícito, no esta acción).
 * - B8A: cantidades vinculadas a entregas vigentes, o entregas vigentes de
 *   sus materiales con cantidades sin vincular (se llama con la OV bloqueada).
 */
async function motivosQueImpidenAnular(tx: Prisma.TransactionClient, compraId: string): Promise<string[]> {
  const motivos: string[] = [];
  if (await compraTuvoPagosTx(tx, compraId)) motivos.push("la compra tiene historial de pagos al proveedor (aunque estén anulados)");
  for (const b of await bloqueosSurtidoDeCompraTx(tx, compraId)) {
    motivos.push(`${b.texto} (${b.entregas.map((e) => `Entrega ${e.numero}`).join(", ")})`);
  }
  return motivos;
}

export async function anularCompraComercial(
  usuario: UsuarioSesion,
  compraId: string,
  motivoCrudo: unknown
): Promise<{ yaAnulada: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const motivo = z
    .string({ error: "Indica el motivo de la anulación." })
    .trim()
    .min(3, "Indica el motivo de la anulación.")
    .max(500, "El motivo admite máximo 500 caracteres.")
    .parse(motivoCrudo);

  return db.$transaction(async (tx) => {
    const c = await bloquearCompra(tx, empresaId, compraId);
    if (c.estatus === "ANULADA") return { yaAnulada: true };
    // Bloquea también la cuenta (orden OV → compra → cuenta): un pago
    // simultáneo espera y, al continuar, encuentra la cuenta anulada.
    await tx.$queryRaw`SELECT id FROM cuentas_comerciales WHERE "compraId" = ${c.id} FOR UPDATE`;
    const bloqueos = await motivosQueImpidenAnular(tx, c.id);
    if (bloqueos.length > 0) throw new ValidacionError(`No se puede anular: ${bloqueos.join("; ")}.`);
    // La cuenta por pagar se anula junto con la compra (misma transacción).
    await anularCuentaDeCompraTx(tx, empresaId, c.id, usuario.id, motivo);
    await tx.compraComercial.update({
      where: { id: c.id },
      data: { estatus: "ANULADA", anuladaEn: new Date(), anuladaPorId: usuario.id, motivoAnulacion: motivo, version: c.version + 1, actualizadoPorId: usuario.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COMPRA,
      entidadId: c.id,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: c.estatus },
      valorNuevo: { estatus: "ANULADA", motivo, liberaCantidades: c.estatus === "CONFIRMADA" },
    });
    return { yaAnulada: false };
  });
}

// ---------------------------------------------------------------------------
// Documento del proveedor
// ---------------------------------------------------------------------------

export async function adjuntarDocumentoCompra(
  usuario: UsuarioSesion,
  compraId: string,
  archivo: { nombre: string | null; bytes: Uint8Array } | null | undefined
): Promise<void> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (!archivo || !archivo.bytes || archivo.bytes.length === 0) throw new ValidacionError("Selecciona el documento del proveedor (PDF, JPG o PNG).");
  if (archivo.bytes.length > MAX_BYTES_POR_CARGA) throw new ValidacionError(`El documento pesa ${formatearTamano(archivo.bytes.length)}; el máximo es ${MB_POR_CARGA} MB. No se guardó el documento.`);
  const tipo = tipoArchivoDetectado(archivo.bytes);
  if (!tipo) throw new ValidacionError("El documento debe ser un PDF, JPG o PNG.");
  const previa = await db.compraComercial.findFirst({ where: { id: compraId, empresaId }, select: { id: true, estatus: true } });
  if (!previa) throw new RegistroNoEncontradoError("La compra");
  if (previa.estatus === "ANULADA") throw new ValidacionError("Una compra anulada no admite documentos.");

  const nombre = nombreSeguroDeArchivo(archivo.nombre, tipo, new Date());
  const ref = `comercializacion/${empresaId}/compras/${compraId}/${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "")}-${nombre}`;
  await subirBytes(ref, archivo.bytes, tipo);
  // El archivo anterior (si lo hay) no se borra: queda en la bitácora.
  await db.$transaction(async (tx) => {
    const c = await bloquearCompra(tx, empresaId, compraId);
    if (c.estatus === "ANULADA") throw new ValidacionError("Una compra anulada no admite documentos.");
    await tx.compraComercial.update({
      where: { id: c.id },
      data: { documentoRef: ref, documentoNombre: nombre, documentoTipo: tipo, documentoBytes: archivo.bytes.length, actualizadoPorId: usuario.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COMPRA,
      entidadId: c.id,
      accion: "EDITAR",
      valorAnterior: { documento: c.documentoRef ? { ref: c.documentoRef, nombre: c.documentoNombre } : null },
      valorNuevo: { documento: { ref, nombre, tipo, bytes: archivo.bytes.length } },
    });
  });
}

/** Referencia del proveedor editable también en una compra confirmada (no afecta importes). */
export async function actualizarReferenciaProveedor(usuario: UsuarioSesion, compraId: string, referenciaCruda: unknown): Promise<void> {
  const empresaId = requerirAdministracionComercial(usuario);
  const referencia = textoOpcional(100, "La referencia del proveedor").parse(referenciaCruda ?? null);
  await db.$transaction(async (tx) => {
    const c = await bloquearCompra(tx, empresaId, compraId);
    if (c.estatus === "ANULADA") throw new ValidacionError("Una compra anulada no se modifica.");
    if (c.referenciaProveedor === referencia) return;
    await tx.compraComercial.update({ where: { id: c.id }, data: { referenciaProveedor: referencia, actualizadoPorId: usuario.id } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COMPRA,
      entidadId: c.id,
      accion: "EDITAR",
      valorAnterior: { referenciaProveedor: c.referenciaProveedor },
      valorNuevo: { referenciaProveedor: referencia },
    });
  });
}

export async function obtenerDocumentoCompra(usuario: UsuarioSesion, compraId: string): Promise<{ bytes: Buffer; tipo: string; nombre: string }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const c = await db.compraComercial.findFirst({
    where: { id: typeof compraId === "string" ? compraId : "", empresaId },
    select: { documentoRef: true, documentoTipo: true, documentoNombre: true },
  });
  if (!c) throw new RegistroNoEncontradoError("La compra");
  if (!c.documentoRef) throw new RegistroNoEncontradoError("El documento");
  return { bytes: await obtenerArchivo(c.documentoRef), tipo: c.documentoTipo!, nombre: c.documentoNombre! };
}

// ---------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------

export type PartidaCompraDetalle = {
  partidaVentaId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  cantidad: string;
  costoUnitario: string | null;
  tratamientoImpuesto: TratamientoImpuesto | null;
  tasaIva: string | null;
  importe: string | null;
};

export type CompraDetalle = {
  id: string;
  folio: string;
  estatus: "BORRADOR" | "CONFIRMADA" | "ANULADA";
  version: number;
  orden: { id: string; folio: string; cotizacionId: string; cotizacionFolio: string };
  proveedorId: string | null;
  proveedorNombre: string | null;
  proveedorConfirmado: { nombre: string; razonSocial: string | null; rfc: string | null } | null;
  fecha: string;
  referenciaProveedor: string | null;
  notas: string | null;
  documento: { nombre: string; tipo: string } | null;
  partidas: PartidaCompraDetalle[];
  totales: TotalesCotizacion;
  completa: boolean;
  confirmada: { en: string; porNombre: string } | null;
  anulada: { en: string; porNombre: string; motivo: string } | null;
  creadaPorNombre: string;
  // Cantidades de la OV (para capturar sin exceder) — vendidas, compradas y pendientes.
  cantidadesOrden: CantidadesPartidaVenta[];
};

export async function obtenerCompraComercial(usuario: UsuarioSesion, compraId: string): Promise<CompraDetalle> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof compraId !== "string" || !compraId) throw new RegistroNoEncontradoError("La compra");
  const c = await db.compraComercial.findFirst({
    where: { id: compraId, empresaId },
    include: {
      ordenVenta: { select: { id: true, folio: true, cotizacionId: true, cotizacion: { select: { folio: true } } } },
      proveedor: { select: { nombre: true } },
      partidas: { orderBy: { orden: "asc" } },
      creadoPor: { select: { nombre: true } },
      confirmadaPor: { select: { nombre: true } },
      anuladaPor: { select: { nombre: true } },
    },
  });
  if (!c) throw new RegistroNoEncontradoError("La compra");
  const partidas: PartidaCompraDetalle[] = c.partidas.map((p) => ({
    partidaVentaId: p.partidaVentaId,
    codigo: p.codigo,
    descripcion: p.descripcion,
    unidad: p.unidad,
    cantidad: dec3(p.cantidad),
    costoUnitario: p.costoUnitario?.toFixed(2) ?? null,
    tratamientoImpuesto: p.tratamientoImpuesto,
    tasaIva: p.tasaIva?.toFixed(2) ?? null,
    importe: p.importe?.toFixed(2) ?? null,
  }));
  return {
    id: c.id,
    folio: c.folio,
    estatus: c.estatus,
    version: c.version,
    orden: { id: c.ordenVenta.id, folio: c.ordenVenta.folio, cotizacionId: c.ordenVenta.cotizacionId, cotizacionFolio: c.ordenVenta.cotizacion.folio },
    proveedorId: c.proveedorId,
    proveedorNombre: c.proveedor?.nombre ?? null,
    proveedorConfirmado: c.proveedorConfirmado as CompraDetalle["proveedorConfirmado"],
    fecha: dateAFecha(c.fecha),
    referenciaProveedor: c.referenciaProveedor,
    notas: c.notas,
    documento: c.documentoRef ? { nombre: c.documentoNombre!, tipo: c.documentoTipo! } : null,
    partidas,
    totales: totalesDe(partidas),
    completa: partidas.length > 0 && partidas.every(lineaCompleta),
    confirmada: c.confirmadaEn ? { en: c.confirmadaEn.toISOString(), porNombre: c.confirmadaPor?.nombre ?? "—" } : null,
    anulada: c.anuladaEn ? { en: c.anuladaEn.toISOString(), porNombre: c.anuladaPor?.nombre ?? "—", motivo: c.motivoAnulacion ?? "" } : null,
    creadaPorNombre: c.creadoPor.nombre,
    cantidadesOrden: await cantidadesDeOrden(db, empresaId, c.ordenVenta.cotizacionId),
  };
}

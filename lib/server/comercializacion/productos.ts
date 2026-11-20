import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { requerirAdministracionComercial, requerirUsoComercial } from "@/lib/server/comercializacion/acceso";
import {
  TRATAMIENTOS_IMPUESTO,
  normalizarImporte,
  normalizarTasa,
  type TratamientoImpuesto,
  comoTratamientoVenta,
} from "@/lib/comercializacion/importes";

// Catálogo de productos de Comercialización — B1 (noviembre 2026).
// docs/negocio/comercializacion.md §6. Reglas:
// - Aislamiento: empresaId SIEMPRE de la sesión (acceso.ts); un producto de
//   otra Empresa "no existe" (RegistroNoEncontradoError, nunca 403).
// - Administración (Administrador/Director) da de alta, edita y desactiva.
//   Nunca se borra un producto.
// - El vendedor solo consulta productos ACTIVOS y solo recibe campos de
//   venta: el costo de referencia ni siquiera se selecciona de la base.
// - Cada alta/edición/(des)activación queda en la bitácora general
//   (RegistroAuditoria, entidad "ProductoComercial") con valor anterior y
//   nuevo — es el historial de precios/costos, visible solo a administración.

export const ENTIDAD_PRODUCTO = "ProductoComercial";

// ---------------------------------------------------------------------------
// DTOs — dos formas separadas a propósito: la del vendedor no tiene ningún
// campo privado en su tipo, así que no puede filtrarse por descuido.
// ---------------------------------------------------------------------------

export type ProductoParaVenta = {
  id: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  precioVenta: string; // canónico "1234.50", sin IVA
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null; // "16.00" solo si GRAVADO
};

export type ProductoAdministracion = ProductoParaVenta & {
  costoReferencia: string | null;
  activo: boolean;
  actualizadoEn: string;
};

const SELECT_VENTA = {
  id: true,
  codigo: true,
  descripcion: true,
  unidad: true,
  precioVenta: true,
  tratamientoImpuesto: true,
  tasaIva: true,
} as const satisfies Prisma.ProductoComercialSelect;

const SELECT_ADMINISTRACION = {
  ...SELECT_VENTA,
  costoReferencia: true,
  activo: true,
  updatedAt: true,
} as const satisfies Prisma.ProductoComercialSelect;

const dec = (v: Prisma.Decimal) => v.toFixed(2);
const decONulo = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed(2));

function aVenta(p: Prisma.ProductoComercialGetPayload<{ select: typeof SELECT_VENTA }>): ProductoParaVenta {
  return {
    id: p.id,
    codigo: p.codigo,
    descripcion: p.descripcion,
    unidad: p.unidad,
    precioVenta: dec(p.precioVenta),
    tratamientoImpuesto: comoTratamientoVenta(p.tratamientoImpuesto),
    tasaIva: decONulo(p.tasaIva),
  };
}

function aAdministracion(
  p: Prisma.ProductoComercialGetPayload<{ select: typeof SELECT_ADMINISTRACION }>
): ProductoAdministracion {
  return {
    ...aVenta(p),
    costoReferencia: decONulo(p.costoReferencia),
    activo: p.activo,
    actualizadoEn: p.updatedAt.toISOString(),
  };
}

/**
 * Consulta para vender (vendedor y administración): solo productos activos
 * y solo campos de venta.
 */
export async function listarProductosParaVenta(usuario: UsuarioSesion): Promise<ProductoParaVenta[]> {
  const empresaId = requerirUsoComercial(usuario);
  const filas = await db.productoComercial.findMany({
    where: { empresaId, activo: true },
    select: SELECT_VENTA,
    orderBy: { codigo: "asc" },
  });
  return filas.map(aVenta);
}

/** Catálogo completo con datos privados — solo administración. */
export async function listarProductosAdministracion(usuario: UsuarioSesion): Promise<ProductoAdministracion[]> {
  const empresaId = requerirAdministracionComercial(usuario);
  const filas = await db.productoComercial.findMany({
    where: { empresaId },
    select: SELECT_ADMINISTRACION,
    orderBy: [{ activo: "desc" }, { codigo: "asc" }],
  });
  return filas.map(aAdministracion);
}

// ---------------------------------------------------------------------------
// Validación de captura (servidor). Nunca se confía en el navegador: los
// importes llegan como texto y se normalizan aquí.
// ---------------------------------------------------------------------------

const textoObligatorio = (campo: string, max: number) =>
  z
    .string({ error: `${campo} es obligatorio.` })
    .trim()
    .min(1, `${campo} es obligatorio.`)
    .max(max, `${campo} admite máximo ${max} caracteres.`);

const esquemaCaptura = z.object({
  codigo: textoObligatorio("El código", 40).regex(/^\S+$/, "El código no puede contener espacios."),
  descripcion: textoObligatorio("La descripción", 300),
  unidad: textoObligatorio("La unidad", 20),
  precioVenta: z.unknown(),
  costoReferencia: z.unknown().optional(),
  tratamientoImpuesto: z.enum(TRATAMIENTOS_IMPUESTO as [TratamientoImpuesto, ...TratamientoImpuesto[]], {
    error: "Selecciona el tratamiento de impuesto.",
  }),
  tasaIva: z.unknown().optional(),
});

type DatosProducto = {
  codigo: string;
  descripcion: string;
  unidad: string;
  precioVenta: string;
  costoReferencia: string | null;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null;
};

const vacio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function validarDatosProducto(datosCrudos: unknown): DatosProducto {
  const d = esquemaCaptura.parse(datosCrudos);
  const precioVenta = normalizarImporte(d.precioVenta, { permitirCero: false });
  if (!precioVenta) {
    throw new ValidacionError("El precio de venta debe ser un importe mayor que 0 con máximo 2 decimales.");
  }
  let costoReferencia: string | null = null;
  if (!vacio(d.costoReferencia)) {
    costoReferencia = normalizarImporte(d.costoReferencia, { permitirCero: true });
    if (costoReferencia === null) {
      throw new ValidacionError("El costo de referencia debe ser un importe de 0 o más con máximo 2 decimales.");
    }
  }
  let tasaIva: string | null = null;
  if (d.tratamientoImpuesto === "GRAVADO") {
    tasaIva = normalizarTasa(d.tasaIva);
    if (!tasaIva) {
      throw new ValidacionError("La tasa de IVA debe ser mayor que 0 y hasta 100 %, con máximo 2 decimales. Para 0 % usa «Tasa 0 %».");
    }
  } else if (!vacio(d.tasaIva) && normalizarTasa(d.tasaIva) !== null) {
    // Una tasa positiva con un tratamiento que no la usa es una
    // contradicción: se rechaza en lugar de descartarla en silencio.
    throw new ValidacionError("La tasa de IVA solo aplica a productos gravados.");
  }
  return {
    codigo: d.codigo,
    descripcion: d.descripcion,
    unidad: d.unidad,
    precioVenta,
    costoReferencia,
    tratamientoImpuesto: d.tratamientoImpuesto,
    tasaIva,
  };
}

// Instantánea para bitácora — strings canónicos, nunca Decimal/float.
function instantanea(p: {
  codigo: string;
  descripcion: string;
  unidad: string;
  precioVenta: Prisma.Decimal | string;
  costoReferencia: Prisma.Decimal | string | null;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: Prisma.Decimal | string | null;
}): Record<string, string | null> {
  const t = (v: Prisma.Decimal | string | null) => (v === null ? null : typeof v === "string" ? v : v.toFixed(2));
  return {
    codigo: p.codigo,
    descripcion: p.descripcion,
    unidad: p.unidad,
    precioVenta: t(p.precioVenta),
    costoReferencia: t(p.costoReferencia),
    tratamientoImpuesto: p.tratamientoImpuesto,
    tasaIva: t(p.tasaIva),
  };
}

// La unicidad real la garantiza el índice único lower(codigo) por Empresa;
// esta consulta solo da un mensaje claro antes de intentar escribir. Usa la
// MISMA expresión que el índice: `mode: "insensitive"` de Prisma genera
// ILIKE sin escapar "_" ni "%", y daba falsos duplicados ("CEM_50" contra
// "CEMX50") — corregido en B2.
async function asegurarCodigoDisponible(
  tx: Prisma.TransactionClient,
  empresaId: string,
  codigo: string,
  excluirId?: string
) {
  const [existente] = await tx.$queryRaw<{ codigo: string; activo: boolean }[]>`
    SELECT codigo, activo FROM productos_comerciales
    WHERE "empresaId" = ${empresaId} AND lower(codigo) = lower(${codigo})
      AND (${excluirId ?? null}::text IS NULL OR id <> ${excluirId ?? null})
    LIMIT 1`;
  if (existente) {
    throw new ValidacionError(
      `Ya existe un producto con el código «${existente.codigo}»${existente.activo ? "" : " (inactivo — reactívalo en lugar de crear otro)"}.`
    );
  }
}

function esViolacionUnica(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return true;
  const texto = `${(error as { message?: string })?.message ?? ""} ${(error as { code?: string })?.code ?? ""}`;
  return /23505|unique constraint|productos_comerciales_empresa_codigo_unico/i.test(texto);
}

async function conCodigoUnico<T>(codigo: string, operacion: () => Promise<T>): Promise<T> {
  try {
    return await operacion();
  } catch (error) {
    if (esViolacionUnica(error)) throw new ValidacionError(`Ya existe un producto con el código «${codigo}».`);
    throw error;
  }
}

export async function crearProductoComercial(usuario: UsuarioSesion, datosCrudos: unknown): Promise<{ id: string }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const datos = validarDatosProducto(datosCrudos);

  return conCodigoUnico(datos.codigo, () =>
    db.$transaction(async (tx) => {
      await asegurarCodigoDisponible(tx, empresaId, datos.codigo);
      const creado = await tx.productoComercial.create({
        data: { ...datos, empresaId, creadoPorId: usuario.id },
        select: { id: true },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_PRODUCTO,
        entidadId: creado.id,
        accion: "CREAR",
        valorNuevo: { ...instantanea(datos), activo: true },
      });
      return creado;
    })
  );
}

// Bloquea la fila del producto (FOR UPDATE) dentro de la transacción y la
// devuelve solo si es de la Empresa del usuario.
async function productoDeMiEmpresaTx(tx: Prisma.TransactionClient, empresaId: string, productoId: string) {
  if (typeof productoId !== "string" || productoId.length === 0) throw new RegistroNoEncontradoError("El producto");
  await tx.$queryRaw`SELECT id FROM productos_comerciales WHERE id = ${productoId} AND "empresaId" = ${empresaId} FOR UPDATE`;
  const producto = await tx.productoComercial.findFirst({ where: { id: productoId, empresaId } });
  if (!producto) throw new RegistroNoEncontradoError("El producto");
  return producto;
}

export async function editarProductoComercial(
  usuario: UsuarioSesion,
  productoId: string,
  datosCrudos: unknown
): Promise<{ cambios: string[] }> {
  const empresaId = requerirAdministracionComercial(usuario);
  const datos = validarDatosProducto(datosCrudos);

  return conCodigoUnico(datos.codigo, () =>
    db.$transaction(async (tx) => {
      const actual = await productoDeMiEmpresaTx(tx, empresaId, productoId);
      const antes = instantanea({ ...actual, tratamientoImpuesto: comoTratamientoVenta(actual.tratamientoImpuesto) });
      const despues = instantanea(datos);
      const cambios = Object.keys(despues).filter((k) => antes[k] !== despues[k]);
      if (cambios.length === 0) return { cambios };

      if (antes.codigo!.toLowerCase() !== datos.codigo.toLowerCase()) {
        await asegurarCodigoDisponible(tx, empresaId, datos.codigo, productoId);
      }
      await tx.productoComercial.update({
        where: { id: productoId },
        data: { ...datos, actualizadoPorId: usuario.id },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_PRODUCTO,
        entidadId: productoId,
        accion: "EDITAR",
        valorAnterior: Object.fromEntries(cambios.map((k) => [k, antes[k]])),
        valorNuevo: Object.fromEntries(cambios.map((k) => [k, despues[k]])),
      });
      return { cambios };
    })
  );
}

const esquemaEstatus = z.object({
  activo: z.boolean({ error: "Estatus inválido." }),
  motivo: z.string().trim().max(300, "El motivo admite máximo 300 caracteres.").optional(),
});

/** Desactivar (nunca borrar) o reactivar un producto, con motivo opcional. */
export async function cambiarEstatusProductoComercial(
  usuario: UsuarioSesion,
  productoId: string,
  datosCrudos: unknown
): Promise<void> {
  const empresaId = requerirAdministracionComercial(usuario);
  const { activo, motivo } = esquemaEstatus.parse(datosCrudos);

  await db.$transaction(async (tx) => {
    const actual = await productoDeMiEmpresaTx(tx, empresaId, productoId);
    if (actual.activo === activo) return;
    await tx.productoComercial.update({
      where: { id: productoId },
      data: { activo, actualizadoPorId: usuario.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_PRODUCTO,
      entidadId: productoId,
      accion: activo ? "ACTIVAR" : "DESACTIVAR",
      valorAnterior: { activo: actual.activo },
      valorNuevo: { activo, ...(motivo ? { motivo } : {}) },
    });
  });
}

// ---------------------------------------------------------------------------
// Historial (bitácora) — solo administración: incluye costos.
// ---------------------------------------------------------------------------

export type CambioHistorial = { campo: string; anterior: string | null; nuevo: string | null };

export type EntradaHistorialProducto = {
  id: string;
  fecha: string;
  usuarioNombre: string | null;
  accion: "CREAR" | "EDITAR" | "ACTIVAR" | "DESACTIVAR";
  cambios: CambioHistorial[];
  motivo: string | null;
};

const comoTexto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function obtenerHistorialProductoComercial(
  usuario: UsuarioSesion,
  productoId: string
): Promise<EntradaHistorialProducto[]> {
  const empresaId = requerirAdministracionComercial(usuario);
  const producto = await db.productoComercial.findFirst({ where: { id: productoId, empresaId }, select: { id: true } });
  if (!producto) throw new RegistroNoEncontradoError("El producto");

  const registros = await db.registroAuditoria.findMany({
    where: { empresaId, entidad: ENTIDAD_PRODUCTO, entidadId: productoId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      createdAt: true,
      accion: true,
      valorAnterior: true,
      valorNuevo: true,
      usuario: { select: { nombre: true } },
    },
  });

  return registros
    .filter((r) => ["CREAR", "EDITAR", "ACTIVAR", "DESACTIVAR"].includes(r.accion))
    .map((r) => {
      const anterior = (r.valorAnterior ?? {}) as Record<string, unknown>;
      const nuevo = (r.valorNuevo ?? {}) as Record<string, unknown>;
      const campos = Object.keys(nuevo).filter((k) => k !== "motivo" && (r.accion !== "CREAR" || k !== "activo"));
      return {
        id: r.id,
        fecha: r.createdAt.toISOString(),
        usuarioNombre: r.usuario?.nombre ?? null,
        accion: r.accion as EntradaHistorialProducto["accion"],
        cambios: campos.map((campo) => ({ campo, anterior: comoTexto(anterior[campo]), nuevo: comoTexto(nuevo[campo]) })),
        motivo: comoTexto(nuevo.motivo),
      };
    });
}

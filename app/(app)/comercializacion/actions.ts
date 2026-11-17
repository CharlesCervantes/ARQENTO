"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireSession } from "@/lib/server/auth/dal";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import {
  cambiarEstatusProductoComercial,
  crearProductoComercial,
  editarProductoComercial,
  obtenerHistorialProductoComercial,
  type EntradaHistorialProducto,
} from "@/lib/server/comercializacion/productos";
import { cambiarMarcaVendedorComercial } from "@/lib/server/comercializacion/vendedores";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import {
  ConflictoEdicionError,
  actualizarCotizacionVenta,
  crearCotizacionVenta,
} from "@/lib/server/comercializacion/cotizaciones";

// Acciones de Comercialización — capa delgada: toda regla (permiso,
// Empresa, validación, bitácora) vive en lib/server/comercializacion/*. Los
// errores inesperados nunca exponen detalles internos.

function mensajeError(error: unknown): string {
  if (error instanceof ValidacionError || error instanceof SinPermisoError || error instanceof RegistroNoEncontradoError) {
    return error.message;
  }
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Datos inválidos.";
  return "No se pudo completar la operación. Inténtalo de nuevo.";
}

export type ProductoFormState = { error?: string; guardado?: boolean } | undefined;

function datosDeFormulario(formData: FormData) {
  const leer = (campo: string) => {
    const v = formData.get(campo);
    return typeof v === "string" ? v : undefined;
  };
  return {
    codigo: leer("codigo"),
    descripcion: leer("descripcion"),
    unidad: leer("unidad"),
    precioVenta: leer("precioVenta"),
    costoReferencia: leer("costoReferencia"),
    tratamientoImpuesto: leer("tratamientoImpuesto"),
    tasaIva: leer("tasaIva"),
  };
}

export async function crearProductoAction(_state: ProductoFormState, formData: FormData): Promise<ProductoFormState> {
  const usuario = await requireSession();
  try {
    await crearProductoComercial(usuario, datosDeFormulario(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion/productos");
  return { guardado: true };
}

export async function editarProductoAction(
  productoId: string,
  _state: ProductoFormState,
  formData: FormData
): Promise<ProductoFormState> {
  const usuario = await requireSession();
  try {
    await editarProductoComercial(usuario, productoId, datosDeFormulario(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion/productos");
  return { guardado: true };
}

export async function cambiarEstatusProductoAction(
  productoId: string,
  activo: boolean,
  motivo?: string
): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await cambiarEstatusProductoComercial(usuario, productoId, { activo, motivo: motivo || undefined });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion/productos");
  return {};
}

export async function historialProductoAction(
  productoId: string
): Promise<{ error?: string; historial?: EntradaHistorialProducto[] }> {
  const usuario = await requireSession();
  try {
    return { historial: await obtenerHistorialProductoComercial(usuario, productoId) };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export async function cambiarVendedorAction(usuarioId: string, vendedor: boolean): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await cambiarMarcaVendedorComercial(usuario, { usuarioId, vendedor });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion/vendedores");
  return {};
}

// ---------------------------------------------------------------------------
// B2 — clientes, obras y cotizaciones en borrador
// ---------------------------------------------------------------------------

export async function crearClienteAction(
  datos: unknown
): Promise<{ error?: string; cliente?: { id: string; nombre: string }; existente?: boolean }> {
  const usuario = await requireSession();
  try {
    const { existente, ...cliente } = await crearClienteComercial(usuario, datos);
    return { cliente, existente };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export async function crearObraAction(
  datos: unknown
): Promise<{ error?: string; obra?: { id: string; nombre: string; clienteId: string }; existente?: boolean }> {
  const usuario = await requireSession();
  try {
    const { existente, ...obra } = await crearObraComercial(usuario, datos);
    return { obra, existente };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type ResultadoGuardarCotizacion = {
  error?: string;
  conflicto?: boolean;
  id?: string;
  folio?: string;
  version?: number;
};

/** Crea (sin id) o actualiza (con id y versión leída) un borrador. */
export async function guardarCotizacionAction(entrada: {
  id?: string;
  version?: number;
  claveCreacion?: string;
  datos: unknown;
}): Promise<ResultadoGuardarCotizacion> {
  const usuario = await requireSession();
  try {
    if (entrada.id) {
      const r = await actualizarCotizacionVenta(usuario, entrada.id, entrada.version, entrada.datos);
      revalidatePath("/comercializacion");
      revalidatePath(`/comercializacion/cotizaciones/${r.id}`);
      return { id: r.id, version: r.version };
    }
    const r = await crearCotizacionVenta(usuario, entrada.datos, entrada.claveCreacion);
    revalidatePath("/comercializacion");
    return { id: r.id, folio: r.folio };
  } catch (error) {
    return { error: mensajeError(error), conflicto: error instanceof ConflictoEdicionError };
  }
}

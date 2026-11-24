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
import { duplicarCotizacionVenta, emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import {
  actualizarReferenciaProveedor,
  adjuntarDocumentoCompra,
  anularCompraComercial,
  confirmarCompraComercial,
  crearCompraComercial,
  crearProveedorComercial,
  guardarBorradorCompra,
} from "@/lib/server/comercializacion/compras";
import { anularMovimientoCuenta, cambiarVencimientoCuota, definirCondicionesCuenta, registrarMovimientoCuenta } from "@/lib/server/comercializacion/cuentas";
import { anularGastoComercial, registrarGastoComercial } from "@/lib/server/comercializacion/gastos";
import { anularVinculoSurtido, vincularSurtido } from "@/lib/server/comercializacion/surtido";
import { cancelarCotizacionVenta, cancelarOrdenVenta, rechazarCotizacionVenta } from "@/lib/server/comercializacion/cancelaciones";
import { agregarEvidenciasEntrega, anularEntregaComercial, registrarEntregaComercial } from "@/lib/server/comercializacion/entregas";

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

// ---------------------------------------------------------------------------
// B3 — emisión, duplicado y aceptación (orden de venta)
// ---------------------------------------------------------------------------

export async function emitirCotizacionAction(entrada: { id: string; version: number }): Promise<{ error?: string; conflicto?: boolean }> {
  const usuario = await requireSession();
  try {
    await emitirCotizacionVenta(usuario, entrada?.id, entrada?.version);
    revalidatePath(`/comercializacion/cotizaciones/${entrada.id}`);
  } catch (error) {
    return { error: mensajeError(error), conflicto: error instanceof ConflictoEdicionError };
  }
  revalidatePath("/comercializacion");
  revalidatePath(`/comercializacion/cotizaciones/${entrada.id}`);
  return {};
}

export async function duplicarCotizacionAction(entrada: {
  id: string;
  claveCreacion: string;
}): Promise<{ error?: string; id?: string; folio?: string; omitidos?: string[] }> {
  const usuario = await requireSession();
  try {
    const r = await duplicarCotizacionVenta(usuario, entrada?.id, entrada?.claveCreacion);
    revalidatePath("/comercializacion");
    return { id: r.id, folio: r.folio, omitidos: r.omitidos };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type AceptacionState = { error?: string; folio?: string } | undefined;

export async function registrarAceptacionAction(
  cotizacionId: string,
  _state: AceptacionState,
  formData: FormData
): Promise<AceptacionState> {
  const usuario = await requireSession();
  try {
    const evidencia = formData.get("evidencia");
    const archivo =
      evidencia instanceof File && evidencia.size > 0
        ? { nombre: evidencia.name, bytes: new Uint8Array(await evidencia.arrayBuffer()) }
        : null;
    const r = await registrarAceptacionCotizacion(
      usuario,
      cotizacionId,
      { fechaAceptacion: formData.get("fechaAceptacion"), referenciaOcCliente: formData.get("referenciaOcCliente") ?? "" },
      archivo
    );
    revalidatePath("/comercializacion");
    revalidatePath(`/comercializacion/cotizaciones/${cotizacionId}`);
    return { folio: r.folio };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

// ---------------------------------------------------------------------------
// B4 — compras a proveedores (solo administración; el servicio lo exige)
// ---------------------------------------------------------------------------

export async function crearCompraAction(entrada: { ordenVentaId: string; claveCreacion: string }): Promise<{ error?: string; id?: string }> {
  const usuario = await requireSession();
  try {
    const r = await crearCompraComercial(usuario, entrada?.ordenVentaId, entrada?.claveCreacion);
    return { id: r.id };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export async function guardarCompraAction(entrada: { id: string; version: number; datos: unknown }): Promise<{ error?: string; conflicto?: boolean; version?: number }> {
  const usuario = await requireSession();
  try {
    const r = await guardarBorradorCompra(usuario, entrada?.id, entrada?.version, entrada?.datos);
    revalidatePath(`/comercializacion/compras/${entrada.id}`);
    return { version: r.version };
  } catch (error) {
    return { error: mensajeError(error), conflicto: error instanceof ConflictoEdicionError };
  }
}

export async function confirmarCompraAction(entrada: { id: string; version: number }): Promise<{ error?: string; conflicto?: boolean }> {
  const usuario = await requireSession();
  try {
    await confirmarCompraComercial(usuario, entrada?.id, entrada?.version);
  } catch (error) {
    return { error: mensajeError(error), conflicto: error instanceof ConflictoEdicionError };
  }
  // B6B: la cuenta por pagar alimenta «Por atender» del listado.
  revalidatePath("/comercializacion", "layout");
  return {};
}

export async function anularCompraAction(entrada: { id: string; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await anularCompraComercial(usuario, entrada?.id, entrada?.motivo);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  // B6B: la cuenta por pagar alimenta «Por atender» del listado.
  revalidatePath("/comercializacion", "layout");
  return {};
}

export async function crearProveedorCompraAction(datos: unknown): Promise<{ error?: string; proveedor?: { id: string; nombre: string } }> {
  const usuario = await requireSession();
  try {
    return { proveedor: await crearProveedorComercial(usuario, datos) };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type DocumentoCompraState = { error?: string; ok?: boolean } | undefined;

export async function adjuntarDocumentoCompraAction(compraId: string, _state: DocumentoCompraState, formData: FormData): Promise<DocumentoCompraState> {
  const usuario = await requireSession();
  try {
    const referencia = formData.get("referenciaProveedor");
    if (typeof referencia === "string") await actualizarReferenciaProveedor(usuario, compraId, referencia);
    const doc = formData.get("documento");
    if (doc instanceof File && doc.size > 0) {
      await adjuntarDocumentoCompra(usuario, compraId, { nombre: doc.name, bytes: new Uint8Array(await doc.arrayBuffer()) });
    }
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/comercializacion/compras/${compraId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// B5 — cuentas por cobrar/pagar (solo administración; el servicio lo exige)
// ---------------------------------------------------------------------------

export async function definirCondicionesAction(entrada: { cuentaId: string; version: number; datos: unknown }): Promise<{ error?: string; conflicto?: boolean }> {
  const usuario = await requireSession();
  try {
    await definirCondicionesCuenta(usuario, entrada?.cuentaId, entrada?.version, entrada?.datos);
  } catch (error) {
    return { error: mensajeError(error), conflicto: error instanceof ConflictoEdicionError };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

export type MovimientoState = { error?: string; ok?: boolean } | undefined;

export async function registrarMovimientoAction(cuentaId: string, _state: MovimientoState, formData: FormData): Promise<MovimientoState> {
  const usuario = await requireSession();
  try {
    const leer = (k: string) => {
      const v = formData.get(k);
      return typeof v === "string" ? v : undefined;
    };
    let aplicaciones: unknown = undefined;
    const crudas = leer("aplicaciones");
    if (crudas) {
      try {
        aplicaciones = JSON.parse(crudas);
      } catch {
        return { error: "Distribución inválida. Recarga la página." };
      }
    }
    const archivo = formData.get("comprobante");
    await registrarMovimientoCuenta(
      usuario,
      cuentaId,
      { importe: leer("importe"), fecha: leer("fecha"), metodo: leer("metodo"), referencia: leer("referencia"), observaciones: leer("observaciones"), aplicaciones },
      archivo instanceof File && archivo.size > 0 ? { nombre: archivo.name, bytes: new Uint8Array(await archivo.arrayBuffer()) } : null,
      leer("clave")
    );
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return { ok: true };
}

export async function anularMovimientoAction(entrada: { movimientoId: string; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await anularMovimientoCuenta(usuario, entrada?.movimientoId, entrada?.motivo);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

// ---------------------------------------------------------------------------
// B6A — Entregas al cliente
// ---------------------------------------------------------------------------

export type EntregaState = { error?: string; ok?: boolean } | undefined;

export async function registrarEntregaAction(ordenVentaId: string, _state: EntregaState, formData: FormData): Promise<EntregaState> {
  const usuario = await requireSession();
  try {
    const leer = (k: string) => {
      const v = formData.get(k);
      return typeof v === "string" ? v : undefined;
    };
    let partidas: unknown = [];
    try {
      partidas = JSON.parse(leer("partidas") ?? "[]");
    } catch {
      return { error: "Cantidades inválidas. Recarga la página." };
    }
    const archivos = await Promise.all(
      formData
        .getAll("evidencias")
        .filter((a): a is File => a instanceof File && a.size > 0)
        .map(async (a) => ({ nombre: a.name, bytes: new Uint8Array(await a.arrayBuffer()) }))
    );
    await registrarEntregaComercial(
      usuario,
      ordenVentaId,
      { fechaEntrega: leer("fechaEntrega"), recibidoPor: leer("recibidoPor"), observaciones: leer("observaciones"), partidas },
      archivos,
      leer("clave")
    );
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return { ok: true };
}

export type GastoState = { error?: string; ok?: boolean } | undefined;

/** B7 — registra un gasto adicional de la OV con su cuenta por pagar (solo administración). */
export async function registrarGastoAction(ordenVentaId: string, _state: GastoState, formData: FormData): Promise<GastoState> {
  const usuario = await requireSession();
  try {
    const leer = (k: string) => {
      const v = formData.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const archivo = formData.get("comprobante");
    await registrarGastoComercial(
      usuario,
      ordenVentaId,
      {
        concepto: leer("concepto"),
        beneficiarioId: leer("beneficiarioId"),
        fecha: leer("fecha"),
        subtotal: leer("subtotal"),
        tratamientoImpuesto: leer("tratamientoImpuesto"),
        tasaIva: leer("tasaIva"),
        observaciones: leer("observaciones"),
      },
      archivo instanceof File && archivo.size > 0 ? { nombre: archivo.name, bytes: new Uint8Array(await archivo.arrayBuffer()) } : null,
      leer("clave")
    );
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return { ok: true };
}

/** B7 — anula un gasto sin historial de pagos, junto con su cuenta (solo administración). */
export async function anularGastoAction(entrada: { gastoId: string; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await anularGastoComercial(usuario, entrada?.gastoId, entrada?.motivo);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

/** B8A — vincula cantidades entregadas con las compras que las surtieron (solo administración). */
export async function vincularSurtidoAction(entrada: { entregaId: string; lineas: unknown; clave: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await vincularSurtido(usuario, entrada?.entregaId, entrada?.lineas, entrada?.clave);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

/** B8A — anula un vínculo capturado por error, con motivo (solo administración). */
export async function anularVinculoSurtidoAction(entrada: { vinculoId: string; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await anularVinculoSurtido(usuario, entrada?.vinculoId, entrada?.motivo);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

export type EvidenciasState = { error?: string; ok?: boolean; agregadas?: number } | undefined;

/** Agrega evidencias a una entrega vigente (no cambia cantidades ni estado). */
export async function agregarEvidenciasAction(entregaId: string, _state: EvidenciasState, formData: FormData): Promise<EvidenciasState> {
  const usuario = await requireSession();
  let agregadas = 0;
  try {
    const archivos = await Promise.all(
      formData
        .getAll("evidencias")
        .filter((a): a is File => a instanceof File && a.size > 0)
        .map(async (a) => ({ nombre: a.name, bytes: new Uint8Array(await a.arrayBuffer()) }))
    );
    const clave = formData.get("clave");
    agregadas = (await agregarEvidenciasEntrega(usuario, entregaId, archivos, typeof clave === "string" ? clave : undefined)).agregadas;
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return { ok: true, agregadas };
}

export async function anularEntregaAction(entrada: { entregaId: string; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await anularEntregaComercial(usuario, entrada?.entregaId, entrada?.motivo);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

// ---------------------------------------------------------------------------
// B8B — rechazo/cancelación de cotizaciones y cancelación básica de la OV.
// El servidor valida permisos (solo administración), estado y bloqueos.
// ---------------------------------------------------------------------------

export async function cerrarCotizacionAction(entrada: { id: string; accion: "RECHAZAR" | "CANCELAR"; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    if (entrada?.accion === "RECHAZAR") await rechazarCotizacionVenta(usuario, entrada?.id, entrada?.motivo);
    else if (entrada?.accion === "CANCELAR") await cancelarCotizacionVenta(usuario, entrada?.id, entrada?.motivo);
    else return { error: "Acción inválida." };
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/comercializacion", "layout");
  return {};
}

export async function cancelarOrdenVentaAction(entrada: { ordenId: string; motivo: string }): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await cancelarOrdenVenta(usuario, entrada?.ordenId, entrada?.motivo);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  // Indicadores, «Por atender» y entregas pendientes dejan de contarla.
  revalidatePath("/comercializacion", "layout");
  return {};
}

/** B8B — cambiar el vencimiento de una cuota (solo administración; el servidor valida todo). */
export async function cambiarVencimientoAction(entrada: { cuotaId: string; fechaLeida: string; nuevaFecha: string; motivo: string; clave: string }): Promise<{ error?: string; conflicto?: boolean }> {
  const usuario = await requireSession();
  try {
    await cambiarVencimientoCuota(usuario, entrada?.cuotaId, { fechaLeida: entrada?.fechaLeida, nuevaFecha: entrada?.nuevaFecha, motivo: entrada?.motivo }, entrada?.clave);
  } catch (error) {
    if (error instanceof ConflictoEdicionError) return { error: "Otra persona cambió este vencimiento mientras lo editabas. Recarga para ver la fecha vigente.", conflicto: true };
    return { error: mensajeError(error) };
  }
  // «Por atender» y los saldos vencidos se recalculan con la fecha nueva.
  revalidatePath("/comercializacion", "layout");
  return {};
}

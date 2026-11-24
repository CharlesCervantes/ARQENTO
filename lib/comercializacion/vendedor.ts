// Vendedor opcional (noviembre 2026): una venta puede no tener vendedor
// asignado (vendedorId NULL) — la operan Administración y Dirección.
// Compartido por servidor e interfaz.

/** Texto que se muestra cuando la venta no tiene vendedor asignado. */
export const ETIQUETA_SIN_VENDEDOR = "Sin vendedor";

/** Valor del filtro del listado para «ventas sin vendedor» (solo administración). */
export const FILTRO_SIN_VENDEDOR = "sin";

export const nombreVendedor = (vendedor: { nombre: string } | null | undefined): string =>
  vendedor?.nombre ?? ETIQUETA_SIN_VENDEDOR;

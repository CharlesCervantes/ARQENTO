import { db } from "@/lib/server/db";
import { calcularTotalesCotizacion } from "@/lib/comercializacion/importes";

// Simula datos previos a la opción de IVA por cotización (migración
// 20261201090000): impuesto copiado por partida desde el producto e
// impuestoVenta NULL. Solo para borradores (una emitida es inmutable). Las
// pruebas lo usan para verificar que lo histórico se conserva.

export type ImpuestoAnterior = { tratamientoImpuesto: "GRAVADO" | "TASA_CERO" | "EXENTO"; tasaIva: string | null };

export const G16: ImpuestoAnterior = { tratamientoImpuesto: "GRAVADO", tasaIva: "16.00" };
export const G8: ImpuestoAnterior = { tratamientoImpuesto: "GRAVADO", tasaIva: "8.00" };
export const TASA_CERO: ImpuestoAnterior = { tratamientoImpuesto: "TASA_CERO", tasaIva: null };
export const EXENTO: ImpuestoAnterior = { tratamientoImpuesto: "EXENTO", tasaIva: null };

export async function convertirEnAnterior(cotizacionId: string, impuestos: ImpuestoAnterior[]) {
  const partidas = await db.partidaCotizacionVenta.findMany({ where: { cotizacionId }, orderBy: { orden: "asc" } });
  if (partidas.length !== impuestos.length) throw new Error("Un impuesto por partida.");
  for (const [i, p] of partidas.entries()) {
    await db.partidaCotizacionVenta.update({ where: { id: p.id }, data: impuestos[i] });
  }
  const t = calcularTotalesCotizacion(partidas.map((p, i) => ({ importe: p.importe.toFixed(2), ...impuestos[i] })));
  await db.cotizacionVenta.update({
    where: { id: cotizacionId },
    data: { impuestoVenta: null, subtotal: t.subtotal, iva: t.iva, total: t.total },
  });
  return t;
}

/** Producto dado de alta antes de nov-2026, con su impuesto capturado. */
export async function marcarProductoAnterior(productoId: string, impuesto: ImpuestoAnterior) {
  await db.productoComercial.update({ where: { id: productoId }, data: impuesto });
}

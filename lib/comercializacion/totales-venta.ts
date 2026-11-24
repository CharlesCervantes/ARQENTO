import { formatearImporte, TASA_IVA_VENTA, type ImpuestoVenta, type TotalesCotizacion } from "@/lib/comercializacion/importes";

// Filas de impuesto entre «Subtotal» y «Total» de una venta — las mismas en
// el formulario, la vista de la cotización/OV y el PDF.
// - Con IVA: una sola fila «IVA 16 %».
// - Sin IVA: fila «IVA» en $0.00 marcada «Sin IVA» (no es tasa 0 % ni exención).
// - Esquema anterior (null): desglose por tasa, tasa 0 % y exento, como se
//   emitió originalmente.

export type FilaImpuesto = { etiqueta: string; valor: string; tenue?: boolean };

export function filasImpuestoVenta(t: TotalesCotizacion, impuestoVenta: ImpuestoVenta | null): FilaImpuesto[] {
  if (impuestoVenta === "SIN_IVA") return [{ etiqueta: "IVA (Sin IVA)", valor: t.iva }];
  if (impuestoVenta === "CON_IVA") return [{ etiqueta: `IVA ${Number(TASA_IVA_VENTA)} %`, valor: t.iva }];
  const filas: FilaImpuesto[] = t.gravado.map((g) => ({ etiqueta: `IVA ${Number(g.tasa)} % sobre ${formatearImporte(g.base)}`, valor: g.iva }));
  if (t.baseTasaCero !== "0.00") filas.push({ etiqueta: "Base tasa 0 % (IVA $0.00)", valor: t.baseTasaCero, tenue: true });
  if (t.baseExenta !== "0.00") filas.push({ etiqueta: "Base exenta (sin IVA)", valor: t.baseExenta, tenue: true });
  if (t.baseSinIva && t.baseSinIva !== "0.00") filas.push({ etiqueta: "Base «Sin IVA»", valor: t.baseSinIva, tenue: true });
  return filas;
}

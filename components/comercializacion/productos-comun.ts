import { ETIQUETA_TRATAMIENTO, type TratamientoImpuesto } from "@/lib/comercializacion/importes";

// Utilidades de presentación compartidas por las vistas de Productos.

export function etiquetaImpuesto(p: { tratamientoImpuesto: TratamientoImpuesto; tasaIva: string | null }): string {
  if (p.tratamientoImpuesto === "GRAVADO" && p.tasaIva) return `IVA ${Number(p.tasaIva)} %`;
  return ETIQUETA_TRATAMIENTO[p.tratamientoImpuesto];
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function coincideBusqueda(p: { codigo: string; descripcion: string }, busqueda: string): boolean {
  const b = normalizar(busqueda.trim());
  if (!b) return true;
  return normalizar(p.codigo).includes(b) || normalizar(p.descripcion).includes(b);
}

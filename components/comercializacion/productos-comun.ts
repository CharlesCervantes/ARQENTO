// Utilidades de presentación compartidas por las vistas de Productos.

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function coincideBusqueda(p: { codigo: string; descripcion: string }, busqueda: string): boolean {
  const b = normalizar(busqueda.trim());
  if (!b) return true;
  return normalizar(p.codigo).includes(b) || normalizar(p.descripcion).includes(b);
}

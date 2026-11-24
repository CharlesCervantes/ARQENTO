// Mapea la clave de Modulo (catálogo en base de datos, ver prisma/schema.prisma)
// a su ruta dentro de la app. Si una clave no tiene entrada aquí, o su `href`
// es null, el módulo existe en el plan pero su pantalla aún no está construida.
export const RUTA_MODULO: Record<string, { href: string | null; label: string }> = {
  inicio: { href: "/dashboard", label: "Inicio" },
  reporte_general: { href: "/reporte-general", label: "Reporte General" },
  control_de_obra: { href: "/control-de-obra", label: "Proyectos" },
  control_prestamos: { href: null, label: "Control de Préstamos" },
  catalogos: { href: "/catalogos", label: "Catálogos" },
  gastos: { href: "/gastos", label: "Gastos" },
  contabilidad: { href: "/contabilidad", label: "Contabilidad" },
  compras: { href: "/compras", label: "Compras" },
  comercializacion: { href: "/comercializacion", label: "Comercialización" },
};

/**
 * Pantalla de entrada de un usuario de Empresa: la del primer módulo VISIBLE
 * (ya filtrado por Empresa y rol, en el orden del menú) que tenga pantalla.
 * Con Inicio habilitado es /dashboard; sin Inicio, p. ej. solo
 * Comercialización → /comercializacion (Operaciones). null = ningún módulo
 * con pantalla: quien llama muestra un aviso, nunca redirige (sin ciclos).
 */
export function rutaInicial(clavesVisiblesEnOrden: string[]): string | null {
  for (const clave of clavesVisiblesEnOrden) {
    const href = RUTA_MODULO[clave]?.href;
    if (href) return href;
  }
  return null;
}

// Clases compartidas del rediseño de Comercialización (plan §8): acciones
// principales sólidas en carbón de 44 px, secundarias con borde y foco
// visible. Los colores salen de los tokens acotados a .comercial.

const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-[filter,background-color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

export const BOTON_PRIMARIO = `${base} bg-[var(--brand)] text-[var(--brand-foreground)] shadow-sm hover:brightness-125`;
export const BOTON_SECUNDARIO = `${base} border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-black/[0.04]`;
export const BOTON_PELIGRO = `${base} border border-red-200 bg-[var(--surface)] text-red-700 hover:bg-red-50`;
/** Acción en línea dentro de tablas o tarjetas: texto legible y subrayado al pasar. */
export const ACCION_EN_LINEA =
  "inline-flex items-center gap-1 rounded text-sm font-medium text-[var(--foreground)] underline decoration-[var(--border)] underline-offset-4 hover:decoration-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";

export const ESTILO_ESTADO = {
  neutro: "bg-black/[0.06] text-[var(--foreground)]",
  info: "bg-sky-50 text-sky-800",
  ok: "bg-emerald-50 text-emerald-800",
  aviso: "bg-amber-50 text-amber-900",
  alerta: "bg-red-50 text-red-700",
} as const;
export type TonoEstado = keyof typeof ESTILO_ESTADO;

export function claseEstado(tono: TonoEstado) {
  return `inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${ESTILO_ESTADO[tono]}`;
}

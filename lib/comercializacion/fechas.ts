// Fechas de calendario de Comercialización (fecha y vigencia de una
// cotización). Se manejan como texto "AAAA-MM-DD" y se guardan en columnas
// DATE: nunca se convierten con la zona horaria del servidor (que en
// Vercel es UTC), así que una fecha no se recorre un día.

// Zona horaria de negocio inicial (docs/negocio/comercializacion.md §10).
export const ZONA_HORARIA_NEGOCIO = "America/Monterrey";

/** Hoy en la zona horaria del negocio, como "AAAA-MM-DD". */
export function hoyNegocio(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_HORARIA_NEGOCIO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
}

/** Valida "AAAA-MM-DD" como fecha real del calendario; null si no lo es. */
export function normalizarFecha(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim());
  if (!m) return null;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fecha = new Date(Date.UTC(a, mes - 1, d));
  if (fecha.getUTCFullYear() !== a || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== d) return null;
  if (a < 2000 || a > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** "AAAA-MM-DD" → Date a medianoche UTC (lo que Prisma escribe en DATE). */
export function fechaADate(fecha: string): Date {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

/** Date leída de una columna DATE → "AAAA-MM-DD". */
export function dateAFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

const formato = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "AAAA-MM-DD" → "16 nov 2026", sin desplazamiento por zona horaria. */
export function formatearFechaCalendario(fecha: string | null): string {
  return fecha ? formato.format(fechaADate(fecha)) : "—";
}

import "server-only";
import { db } from "@/lib/server/db";

// Número de semana ISO-8601 (lunes = inicio de semana, la semana que
// contiene el primer jueves del año es la semana 1).
function numeroSemanaISO(fecha: Date): { numero: number; anio: number } {
  const d = new Date(
    Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate())
  );
  const diaISO = d.getUTCDay() || 7; // lunes=1 … domingo=7
  d.setUTCDate(d.getUTCDate() + 4 - diaISO);
  const inicioAnio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const numero = Math.ceil(
    ((d.getTime() - inicioAnio.getTime()) / 86400000 + 1) / 7
  );
  return { numero, anio: d.getUTCFullYear() };
}

function lunesDeLaSemana(fecha: Date): Date {
  const d = new Date(fecha);
  const dia = d.getDay() || 7;
  if (dia !== 1) d.setDate(d.getDate() - (dia - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

// El ciclo operativo de Conkuali es lunes a sábado
// (02-control-de-obra.md — "Ciclo operativo semanal (lunes a sábado)").
function rangoSemana(fecha: Date): {
  numero: number;
  anio: number;
  fechaInicio: Date;
  fechaFin: Date;
} {
  const { numero, anio } = numeroSemanaISO(fecha);
  const fechaInicio = lunesDeLaSemana(fecha);
  const fechaFin = new Date(fechaInicio);
  fechaFin.setDate(fechaFin.getDate() + 5);
  return { numero, anio, fechaInicio, fechaFin };
}

// Los renglones semanales se generan automáticamente (01-administracion-pagos-semanales.md)
// — aquí solo se garantiza que exista el registro de Semana, no los movimientos
// (esos dependen de que exista una participación beneficiario-proyecto, Etapa 3+).
// Recibe cualquier fecha de referencia (no solo "hoy") para poder navegar a
// semanas anteriores o siguientes reutilizando el mismo cálculo de rango.
export async function obtenerOCrearSemana(empresaId: string, fechaReferencia: Date) {
  const { numero, anio, fechaInicio, fechaFin } = rangoSemana(fechaReferencia);

  return db.semana.upsert({
    where: { empresaId_numero_anio: { empresaId, numero, anio } },
    update: {},
    create: { empresaId, numero, anio, fechaInicio, fechaFin },
  });
}

export async function obtenerOCrearSemanaActual(empresaId: string) {
  return obtenerOCrearSemana(empresaId, new Date());
}

// Semanas válidas para registrar un gasto desde otra pantalla (p. ej. un
// documento de Captura Inteligente): la semana actual — creada si aún no
// existe, igual que hace Gastos al abrirse — y las semanas ya existentes de
// la Empresa, de la más reciente a la más antigua. Mismo criterio que el
// módulo de Gastos: cualquier Semana de la Empresa es válida para un gasto
// (el cierre semanal solo bloquea el Avance). La fecha de un comprobante
// nunca decide la semana por sí sola.
export async function listarSemanasParaRegistro(empresaId: string, cantidad = 12) {
  const actual = await obtenerOCrearSemanaActual(empresaId);
  const semanas = await db.semana.findMany({
    where: { empresaId },
    orderBy: { fechaInicio: "desc" },
    take: cantidad,
    select: { id: true, numero: true, anio: true, fechaInicio: true, fechaFin: true },
  });
  if (!semanas.some((s) => s.id === actual.id)) semanas.unshift(actual);
  return {
    semanaActualId: actual.id,
    semanas: semanas.map((s) => ({ ...s, fechaInicio: s.fechaInicio.toISOString(), fechaFin: s.fechaFin.toISOString() })),
  };
}

// Para llevar la fecha de referencia en la URL (?fecha=YYYY-MM-DD) sin sufrir
// el corrimiento de un día que da `new Date("YYYY-MM-DD")` en zonas UTC-.
export function fechaAParametro(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parametroAFecha(parametro: string | undefined): Date {
  const partes = parametro?.split("-").map(Number);
  if (!partes || partes.length !== 3 || partes.some(Number.isNaN)) {
    return new Date();
  }
  const [y, m, d] = partes;
  return new Date(y, m - 1, d);
}

const MESES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

export function formatearRangoSemana(semana: {
  numero: number;
  anio: number;
  fechaInicio: Date;
  fechaFin: Date;
}): string {
  const inicio = semana.fechaInicio;
  const fin = semana.fechaFin;
  const mismoMes = inicio.getMonth() === fin.getMonth();
  const rango = mismoMes
    ? `${inicio.getDate()}–${fin.getDate()} ${MESES[fin.getMonth()]}`
    : `${inicio.getDate()} ${MESES[inicio.getMonth()]} – ${fin.getDate()} ${MESES[fin.getMonth()]}`;
  return `Semana ${semana.numero} · ${rango} ${semana.anio}`;
}

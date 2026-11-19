// Mensualidades automáticas del crédito de un proveedor (ajuste de nov-2026)
// — funciones PURAS, usadas por el navegador (vista previa) y por el
// servidor (que vuelve a calcular: nunca confía en importes enviados).
//
// Reglas:
// - Plazos: 3, 6, 12, 18 o 24 meses = ese número de cuotas mensuales.
// - Importe: total (con el impuesto aplicable) ÷ cuotas, en centavos; cada
//   cuota lleva el cociente y la ÚLTIMA absorbe la diferencia para que la
//   suma sea exactamente el total. Sin intereses ni comisiones. Si el total no
//   alcanza para un centavo por cuota no se genera nada (nunca cuotas en cero).
// - Vencimientos: el primero es la fecha elegida; la cuota k vence k meses
//   después en el MISMO día del mes. Si ese mes no tiene ese día se usa su
//   último día, y el día original se recupera en los meses que sí lo tienen
//   (31 ene → 28/29 feb → 31 mar), porque siempre se calcula desde el primero.

import { aCentavos, deCentavos } from "@/lib/comercializacion/importes";
import { normalizarFecha } from "@/lib/comercializacion/fechas";

export const PLAZOS_MENSUALES = [3, 6, 12, 18, 24] as const;
export type PlazoMensual = (typeof PLAZOS_MENSUALES)[number];

export const esPlazoMensual = (v: unknown): v is PlazoMensual => typeof v === "number" && (PLAZOS_MENSUALES as readonly number[]).includes(v);

const diasDelMes = (anio: number, mes1a12: number) => new Date(Date.UTC(anio, mes1a12, 0)).getUTCDate();

/** Fecha "AAAA-MM-DD" que corresponde `meses` meses después de `primera`, conservando su día cuando existe. */
export function sumarMeses(primera: string, meses: number): string {
  const [a, m, d] = primera.split("-").map(Number);
  const indice = m - 1 + meses;
  const anio = a + Math.floor(indice / 12);
  const mes = (indice % 12) + 1;
  const dia = Math.min(d, diasDelMes(anio, mes));
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export type CuotaGenerada = { numero: number; fechaVencimiento: string; importe: string };

export class GeneracionMensualidadesError extends Error {}

/**
 * Calendario de `plazo` mensualidades por `total` (canónico "1234.56") desde
 * `primerVencimiento` ("AAAA-MM-DD"). Lanza GeneracionMensualidadesError con
 * un mensaje para el usuario si los datos no permiten generarlo.
 */
export function generarMensualidades(total: string, plazo: number, primerVencimiento: string): CuotaGenerada[] {
  if (!esPlazoMensual(plazo)) throw new GeneracionMensualidadesError("Elige un plazo de 3, 6, 12, 18 o 24 meses.");
  const primera = normalizarFecha(primerVencimiento);
  if (!primera) throw new GeneracionMensualidadesError("Indica la fecha del primer vencimiento (AAAA-MM-DD).");
  const totalC = aCentavos(total);
  const n = BigInt(plazo);
  const base = totalC / n;
  if (base <= BigInt(0)) {
    throw new GeneracionMensualidadesError(`El total no alcanza para ${plazo} mensualidades de al menos $0.01; elige un plazo menor o cuotas manuales.`);
  }
  const ultima = totalC - base * (n - BigInt(1));
  const cuotas: CuotaGenerada[] = [];
  for (let k = 0; k < plazo; k++) {
    const fecha = sumarMeses(primera, k);
    if (!normalizarFecha(fecha)) throw new GeneracionMensualidadesError("El calendario sale del rango de fechas permitido (2000–2100).");
    cuotas.push({ numero: k + 1, fechaVencimiento: fecha, importe: deCentavos(k === plazo - 1 ? ultima : base) });
  }
  return cuotas;
}

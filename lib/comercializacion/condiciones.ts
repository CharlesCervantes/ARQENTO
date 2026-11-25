// Formas rápidas de definir condiciones de cobro o pago — funciones PURAS.
// Solo proponen fechas e importes: el usuario los ve antes de guardar y el
// servidor vuelve a validar que sumen exactamente el total. La fecha base de
// un plazo la elige el usuario (no se asume compra, factura ni recepción).

import { aCentavos, deCentavos } from "@/lib/comercializacion/importes";
import { fechaADate, dateAFecha, normalizarFecha } from "@/lib/comercializacion/fechas";
import { sumarMeses } from "@/lib/comercializacion/mensualidades";

export type CuotaPropuesta = { fecha: string; importe: string };
export type Frecuencia = "SEMANAL" | "QUINCENAL" | "MENSUAL";
export const ETIQUETA_FRECUENCIA: Record<Frecuencia, string> = { SEMANAL: "Cada semana", QUINCENAL: "Cada 15 días", MENSUAL: "Cada mes" };
export const MAX_CUOTAS_IGUALES = 60;
export const MAX_DIAS_PLAZO = 730;

export class CondicionesError extends Error {}

function fechaValida(fecha: string, que: string): string {
  const f = normalizarFecha(fecha);
  if (!f) throw new CondicionesError(`Indica ${que}.`);
  return f;
}

export function sumarDias(fecha: string, dias: number): string {
  const d = fechaADate(fecha);
  d.setUTCDate(d.getUTCDate() + dias);
  return dateAFecha(d);
}

/** Un solo pago por el total, `dias` después de `desde`. */
export function pagoAPlazo(total: string, desde: string, dias: number): CuotaPropuesta[] {
  const base = fechaValida(desde, "desde qué fecha se cuenta el plazo");
  if (!Number.isInteger(dias) || dias < 0 || dias > MAX_DIAS_PLAZO) throw new CondicionesError(`Indica de 0 a ${MAX_DIAS_PLAZO} días.`);
  return [{ fecha: fechaValida(sumarDias(base, dias), "una fecha dentro del rango permitido"), importe: total }];
}

/** Anticipo en porcentaje (redondeado al centavo) y el resto en otra fecha. */
export function anticipoYSaldo(total: string, porcentaje: number, fechaAnticipo: string, fechaSaldo: string): CuotaPropuesta[] {
  const f1 = fechaValida(fechaAnticipo, "la fecha del anticipo");
  const f2 = fechaValida(fechaSaldo, "la fecha del saldo");
  if (f2 < f1) throw new CondicionesError("El saldo no puede vencer antes que el anticipo.");
  const puntos = Math.round(porcentaje * 100);
  if (!Number.isFinite(puntos) || puntos <= 0 || puntos >= 10000) throw new CondicionesError("El anticipo debe ser mayor que 0 % y menor que 100 %.");
  const t = aCentavos(total);
  const anticipo = (t * BigInt(puntos) + BigInt(5000)) / BigInt(10000);
  if (anticipo <= BigInt(0) || anticipo >= t) throw new CondicionesError("El total no alcanza para dividirlo en anticipo y saldo.");
  return [
    { fecha: f1, importe: deCentavos(anticipo) },
    { fecha: f2, importe: deCentavos(t - anticipo) },
  ];
}

/** `numero` cuotas iguales; la última ajusta los centavos (misma regla que las mensualidades). */
export function cuotasIguales(total: string, numero: number, primera: string, frecuencia: Frecuencia): CuotaPropuesta[] {
  const f = fechaValida(primera, "la fecha de la primera cuota");
  if (!Number.isInteger(numero) || numero < 2 || numero > MAX_CUOTAS_IGUALES) throw new CondicionesError(`Indica de 2 a ${MAX_CUOTAS_IGUALES} cuotas.`);
  const t = aCentavos(total);
  const base = t / BigInt(numero);
  if (base <= BigInt(0)) throw new CondicionesError("El total no alcanza para tantas cuotas.");
  return Array.from({ length: numero }, (_, k) => ({
    fecha: fechaValida(frecuencia === "MENSUAL" ? sumarMeses(f, k) : sumarDias(f, k * (frecuencia === "SEMANAL" ? 7 : 15)), "fechas dentro del rango permitido"),
    importe: deCentavos(k === numero - 1 ? t - base * BigInt(numero - 1) : base),
  }));
}

/** Parámetro de la URL que pide abrir «Definir condiciones» de un documento. */
export const PARAM_DEFINIR = "definir";

/** Agrega la petición a un enlace interno, respetando su ancla. */
export function enlaceDefinir(enlace: string, id: string): string {
  const [ruta, hash] = enlace.split("#");
  return `${ruta}${ruta.includes("?") ? "&" : "?"}${PARAM_DEFINIR}=${encodeURIComponent(id)}${hash ? `#${hash}` : ""}`;
}

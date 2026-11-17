import { aMilesimas } from "@/lib/comercializacion/importes";

// Entregas al cliente (B6A) — cálculo puro de cantidades y estado, en
// milésimas exactas (BigInt). Nunca suma cantidades de unidades distintas:
// el avance es por partida y el estado general solo cuenta partidas.

/** Límites explícitos de evidencias por entrega. El total por registro se
 * mantiene bajo el límite actual de 10 MB que el proxy de la aplicación
 * aplica a cada solicitud (ver docs/negocio/comercializacion.md §20 B6A). */
export const MAX_EVIDENCIAS_POR_ENTREGA = 10;
export const MAX_BYTES_EVIDENCIAS_POR_ENTREGA = 9 * 1024 * 1024; // 9 MB en total (y por archivo)

export type EstadoEntrega = "PENDIENTE" | "PARCIAL" | "COMPLETA";

export const ETIQUETA_ESTADO_ENTREGA: Record<EstadoEntrega, string> = {
  PENDIENTE: "Pendiente",
  PARCIAL: "Parcial",
  COMPLETA: "Completa",
};

export function milesimasATexto(m: bigint): string {
  const neg = m < BigInt(0);
  const a = neg ? -m : m;
  return `${neg ? "-" : ""}${a / BigInt(1000)}.${(a % BigInt(1000)).toString().padStart(3, "0")}`;
}

export type AvancePartida = { vendido: string; entregado: string; pendiente: string; completa: boolean };

/** Avance de una partida: vendido − entregado (entregas vigentes). */
export function avancePartida(vendido: string, entregas: string[]): AvancePartida {
  const v = aMilesimas(vendido);
  const e = entregas.reduce((s, c) => s + aMilesimas(c), BigInt(0));
  const pendiente = v - e;
  return { vendido, entregado: milesimasATexto(e), pendiente: milesimasATexto(pendiente), completa: pendiente <= BigInt(0) };
}

/** Estado general de la OV a partir del avance de cada partida. */
export function estadoEntrega(partidas: { entregado: string; pendiente: string }[]): {
  estado: EstadoEntrega;
  completas: number;
  total: number;
} {
  const total = partidas.length;
  const completas = partidas.filter((p) => p.pendiente.startsWith("-") || aMilesimas(p.pendiente) === BigInt(0)).length;
  const algoEntregado = partidas.some((p) => aMilesimas(p.entregado) > BigInt(0));
  const estado: EstadoEntrega = total > 0 && completas === total ? "COMPLETA" : algoEntregado ? "PARCIAL" : "PENDIENTE";
  return { estado, completas, total };
}

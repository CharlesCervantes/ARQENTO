// Partida «ADITIVAS» (noviembre 2026): toda obra nace con ella y siempre va al
// final del Contrato General, de la estimación y de cualquier lista de
// partidas. «Al final» se guarda en `Partida.orden` con un valor reservado,
// así todas las consultas que ya ordenan por `orden` la dejan abajo sin
// tratamiento especial. Las obras que ya tenían una partida «Aditiva» o
// «Aditivas» (incluye «ADITIVA 01») conservan la suya y no reciben otra.

export const NOMBRE_PARTIDA_ADITIVAS = "ADITIVAS";

// Reservado para las partidas de aditivas; ninguna otra partida puede
// alcanzarlo (ver ordenDePartida).
export const ORDEN_PARTIDA_ADITIVAS = 1_000_000;

export function esPartidaAditivas(nombre: string): boolean {
  const normalizado = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase();
  return /^ADITIVAS?(?![A-Z])/.test(normalizado);
}

// Orden con que se guarda una partida: las de aditivas siempre al final; las
// demás nunca por debajo de ellas.
export function ordenDePartida(nombre: string, ordenSolicitado: number): number {
  if (esPartidaAditivas(nombre)) return ORDEN_PARTIDA_ADITIVAS;
  return Math.min(ordenSolicitado, ORDEN_PARTIDA_ADITIVAS - 1);
}

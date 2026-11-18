// Resultado estimado por OV y simulación de reparto 50/50 (B7) — funciones
// PURAS, en centavos exactos (BigInt). docs/negocio/comercializacion.md §20 B7.
//
// Resultado estimado = venta sin IVA − compras confirmadas vigentes sin IVA −
// gastos adicionales vigentes sin IVA.
// - Nunca se calcula con cobros ni pagos: pagar un costo no lo vuelve a restar
//   y cobrar no vuelve a sumar la venta.
// - Nunca usa el costo de referencia del catálogo.
// - Si alguna partida vendida no está cubierta por compras confirmadas, el
//   resultado es INCOMPLETO: se muestran venta y costos conocidos y los
//   faltantes, pero no una cifra final ni una simulación (lo faltante no es
//   costo cero).
// - Es un resultado operativo estimado con lo capturado: no es utilidad
//   fiscal ni dinero disponible.

import { aCentavos, aMilesimas, deCentavos } from "@/lib/comercializacion/importes";
import { milesimasATexto } from "@/lib/comercializacion/entregas";

export type CoberturaPartida = { codigo: string; descripcion: string; unidad: string; vendido: string; comprado: string };
export type FaltanteCompra = { codigo: string; descripcion: string; unidad: string; vendido: string; comprado: string; falta: string };

export type EstadoResultado = "INCOMPLETO" | "POSITIVO" | "CERO" | "PERDIDA";

export type ResultadoEstimado = {
  venta: string; // sin IVA
  compras: string; // confirmadas vigentes, sin IVA
  gastos: string; // vigentes, sin IVA
  costosConocidos: string; // compras + gastos
  estado: EstadoResultado;
  /** null cuando faltan compras: no se presenta una cifra final. */
  resultado: string | null;
  faltantes: FaltanteCompra[];
  /** Solo con costos de materiales completos y resultado positivo. */
  simulacion: { socio1: string; socio2: string } | null;
};

const cero = BigInt(0);
const suma = (importes: string[]) => importes.reduce((s, i) => s + aCentavos(i), cero);

/**
 * Reparto 50/50 en centavos. Si el resultado tiene un centavo indivisible,
 * el remanente va a la SEGUNDA participación; ambas suman exactamente el
 * resultado.
 */
export function simular5050(resultado: string): { socio1: string; socio2: string } {
  const c = aCentavos(resultado);
  const s1 = c / BigInt(2); // división entera (trunca)
  return { socio1: deCentavos(s1), socio2: deCentavos(c - s1) };
}

export function calcularResultado(entrada: {
  venta: string;
  compras: string[];
  gastos: string[];
  partidas: CoberturaPartida[];
}): ResultadoEstimado {
  const venta = aCentavos(entrada.venta);
  const compras = suma(entrada.compras);
  const gastos = suma(entrada.gastos);
  const faltantes: FaltanteCompra[] = [];
  for (const p of entrada.partidas) {
    const falta = aMilesimas(p.vendido) - aMilesimas(p.comprado);
    if (falta > cero) faltantes.push({ ...p, falta: milesimasATexto(falta) });
  }
  const base = {
    venta: deCentavos(venta),
    compras: deCentavos(compras),
    gastos: deCentavos(gastos),
    costosConocidos: deCentavos(compras + gastos),
    faltantes,
  };
  if (faltantes.length > 0 || entrada.partidas.length === 0) {
    return { ...base, estado: "INCOMPLETO", resultado: null, simulacion: null };
  }
  const r = venta - compras - gastos;
  const resultado = deCentavos(r);
  return {
    ...base,
    resultado,
    estado: r > cero ? "POSITIVO" : r === cero ? "CERO" : "PERDIDA",
    simulacion: r > cero ? simular5050(resultado) : null,
  };
}

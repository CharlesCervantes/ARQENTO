import { Prisma } from "@/lib/generated/prisma/browser";

// Captura de avance por cantidad o por monto: el otro campo se calcula solo.

type ConceptoCaptura = {
  estaSemana: number;
  montoEstaSemana: number | null;
  precioUnitarioContratista: number | null;
  precioUnitarioContratistaContratado: number | null;
};

/** P.U. de captura: el contratado o, sin contratista, el del concepto (el mismo que hereda la asignación). */
export function precioDeCaptura(c: ConceptoCaptura): number | null {
  return (c.precioUnitarioContratistaContratado ?? c.precioUnitarioContratista) || null;
}

/** Texto para el input numérico: sin separador de miles. */
export function cantidadInicial(c: ConceptoCaptura): string {
  return c.estaSemana > 0 ? new Prisma.Decimal(c.estaSemana).toDecimalPlaces(3).toString() : "";
}

export function montoDesdeCantidad(cantidad: string, precio: number | null): string {
  if (!precio || cantidad === "") return "";
  return new Prisma.Decimal(cantidad).times(precio).toDecimalPlaces(2).toString();
}

export function cantidadDesdeMonto(monto: string, precio: number): string {
  return new Prisma.Decimal(monto).div(precio).toDecimalPlaces(3).toString();
}

/** El monto exacto guardado; si no hay, el derivado de la cantidad. */
export function montoInicial(c: ConceptoCaptura): string {
  if (c.montoEstaSemana !== null) return String(c.montoEstaSemana);
  return montoDesdeCantidad(cantidadInicial(c), precioDeCaptura(c));
}

/**
 * Monto que se envía al guardar. Vacío cuando no se tecleó: si la fila no
 * cambió (reenviarla no debe regresarla a pendiente) o si, sin contratista,
 * el monto solo es cantidad × P.U. de referencia.
 */
export function montoAEnviar(c: ConceptoCaptura, cantidad: string, monto: string): string {
  if (c.montoEstaSemana !== null) return monto;
  if (cantidad === cantidadInicial(c) && monto === montoInicial(c)) return "";
  const sinContratista = c.precioUnitarioContratistaContratado === null;
  return sinContratista && monto === montoDesdeCantidad(cantidad, precioDeCaptura(c)) ? "" : monto;
}

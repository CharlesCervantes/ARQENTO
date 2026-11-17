// Cuentas por cobrar/pagar de Comercialización (B5) — funciones PURAS (sin
// base de datos), usables en servidor y navegador. Importes exactos en
// centavos (BigInt) con las reglas de importes.ts.
//
// - Saldo de cuota = importe programado − aplicaciones de movimientos VIGENTES.
// - Saldo de cuenta = total − aplicaciones vigentes.
// - Liquidación: PENDIENTE (nada aplicado), PARCIAL, LIQUIDADA (saldo 0).
// - Vencimiento (por cuota con saldo): fecha < hoy → VENCIDA; fecha = hoy →
//   VENCE_HOY; si no → AL_CORRIENTE. Sin calendario → SIN_CALENDARIO.
//   "hoy" es la fecha de calendario en la zona de la Empresa.
// - Importe vencido = Σ saldos de cuotas con fecha ANTERIOR a hoy (no todo el
//   saldo de la cuenta).

import { aCentavos, deCentavos } from "@/lib/comercializacion/importes";

export const ZONA_HORARIA_PREDETERMINADA = "America/Monterrey";

/** Zona válida de la Empresa o la predeterminada. */
export function zonaEfectiva(zona: string | null | undefined): string {
  if (!zona) return ZONA_HORARIA_PREDETERMINADA;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zona });
    return zona;
  } catch {
    return ZONA_HORARIA_PREDETERMINADA;
  }
}

/** Fecha de calendario "AAAA-MM-DD" de `ahora` en la zona dada. */
export function hoyEnZona(zona: string | null | undefined, ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zonaEfectiva(zona), year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}

export type Liquidacion = "PENDIENTE" | "PARCIAL" | "LIQUIDADA";
export type SituacionVencimiento = "SIN_CALENDARIO" | "AL_CORRIENTE" | "VENCE_HOY" | "VENCIDA";

export type CuotaParaSaldo = { id: string; numero: number; fechaVencimiento: string; importe: string; aplicado: string };

export type CuotaConSaldo = CuotaParaSaldo & { saldo: string; situacion: "LIQUIDADA" | "AL_CORRIENTE" | "VENCE_HOY" | "VENCIDA" };

export type EstadoCuenta = {
  total: string;
  aplicado: string; // cobrado / pagado (movimientos vigentes)
  saldo: string;
  vencido: string;
  liquidacion: Liquidacion;
  situacion: SituacionVencimiento;
  cuotas: CuotaConSaldo[];
};

const cero = BigInt(0);

export function ordenarCuotas<T extends { fechaVencimiento: string; numero: number }>(cuotas: T[]): T[] {
  return [...cuotas].sort((a, b) => (a.fechaVencimiento < b.fechaVencimiento ? -1 : a.fechaVencimiento > b.fechaVencimiento ? 1 : a.numero - b.numero));
}

export function calcularEstadoCuenta(total: string, aplicadoTotal: string, cuotas: CuotaParaSaldo[], hoy: string): EstadoCuenta {
  const totalC = aCentavos(total);
  const aplicadoC = aCentavos(aplicadoTotal);
  const saldoC = totalC - aplicadoC;
  let vencido = cero;
  let hayHoy = false;
  const conSaldo: CuotaConSaldo[] = ordenarCuotas(cuotas).map((q) => {
    const s = aCentavos(q.importe) - aCentavos(q.aplicado);
    let situacion: CuotaConSaldo["situacion"] = "AL_CORRIENTE";
    if (s <= cero) situacion = "LIQUIDADA";
    else if (q.fechaVencimiento < hoy) {
      situacion = "VENCIDA";
      vencido += s;
    } else if (q.fechaVencimiento === hoy) {
      situacion = "VENCE_HOY";
      hayHoy = true;
    }
    return { ...q, saldo: deCentavos(s), situacion };
  });
  const liquidacion: Liquidacion = saldoC <= cero ? "LIQUIDADA" : aplicadoC > cero ? "PARCIAL" : "PENDIENTE";
  const situacion: SituacionVencimiento =
    cuotas.length === 0 ? "SIN_CALENDARIO" : vencido > cero ? "VENCIDA" : hayHoy ? "VENCE_HOY" : "AL_CORRIENTE";
  return { total, aplicado: aplicadoTotal, saldo: deCentavos(saldoC), vencido: deCentavos(vencido), liquidacion, situacion, cuotas: conSaldo };
}

/**
 * Propuesta de aplicación: cubre las cuotas con saldo de la más antigua a la
 * más reciente (incluye cuotas futuras: pagos anticipados). Si el importe
 * excede el saldo total, devuelve null (no se crean saldos a favor).
 */
export function proponerAplicacion(cuotas: { id: string; numero: number; fechaVencimiento: string; saldo: string }[], importe: string): { cuotaId: string; importe: string }[] | null {
  let resto = aCentavos(importe);
  if (resto <= cero) return null;
  const res: { cuotaId: string; importe: string }[] = [];
  for (const q of ordenarCuotas(cuotas)) {
    if (resto === cero) break;
    const s = aCentavos(q.saldo);
    if (s <= cero) continue;
    const a = s < resto ? s : resto;
    res.push({ cuotaId: q.id, importe: deCentavos(a) });
    resto -= a;
  }
  return resto === cero ? res : null;
}

export const ETIQUETA_LIQUIDACION: Record<Liquidacion, string> = { PENDIENTE: "Pendiente", PARCIAL: "Parcial", LIQUIDADA: "Liquidada" };
export const ETIQUETA_SITUACION: Record<SituacionVencimiento, string> = {
  SIN_CALENDARIO: "Condiciones por definir",
  AL_CORRIENTE: "Al corriente",
  VENCE_HOY: "Vence hoy",
  VENCIDA: "Vencida",
};
export const METODOS_PAGO = ["TRANSFERENCIA", "DEPOSITO", "EFECTIVO", "CHEQUE", "TARJETA", "OTRO"] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];
export const ETIQUETA_METODO: Record<MetodoPago, string> = {
  TRANSFERENCIA: "Transferencia",
  DEPOSITO: "Depósito",
  EFECTIVO: "Efectivo",
  CHEQUE: "Cheque",
  TARJETA: "Tarjeta",
  OTRO: "Otro",
};

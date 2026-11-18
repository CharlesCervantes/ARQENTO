// Recordatorios internos de cobros y pagos de Comercialización (B6B) —
// funciones PURAS (sin base de datos). docs/negocio/comercializacion.md §10 y
// §20 (B6B).
//
// Se calculan al consultar, a partir de los saldos reales de B5 (cuotas y
// aplicaciones vigentes); no existe otra fuente de saldos ni una tabla de
// avisos. Fechas como texto "AAAA-MM-DD" en la zona de la Empresa (mismas
// reglas que B5), sin conversiones UTC.
//
// - VENCIDO: cuota con saldo y vencimiento anterior a hoy.
// - HOY: cuota con saldo que vence hoy.
// - PROXIMO: cuota con saldo que vence entre mañana y hoy + DIAS_AVISO_PROXIMO.
// - SIN_CONDICIONES: cuenta vigente con saldo y sin calendario (una entrada
//   por cuenta, sin fecha).
// Una cuota pertenece a una sola categoría; las liquidadas no generan aviso.

import { aCentavos, deCentavos } from "@/lib/comercializacion/importes";

/**
 * Anticipación de los avisos "próximos" en días naturales. VALOR PROVISIONAL
 * de P6 (pendiente de confirmar por el negocio); cambiarlo aquí basta.
 */
export const DIAS_AVISO_PROXIMO = 3;

export const CATEGORIAS_AVISO = ["VENCIDO", "HOY", "PROXIMO", "SIN_CONDICIONES"] as const;
export type CategoriaAviso = (typeof CATEGORIAS_AVISO)[number];

export const ETIQUETA_CATEGORIA_AVISO: Record<CategoriaAviso, string> = {
  VENCIDO: "Vencidos",
  HOY: "Vencen hoy",
  PROXIMO: `Próximos ${DIAS_AVISO_PROXIMO} días`,
  SIN_CONDICIONES: "Condiciones por definir",
};

export type TipoAviso = "COBRO" | "PAGO";

/** Suma n días naturales a "AAAA-MM-DD" (aritmética de calendario, sin zona). */
export function sumarDias(fecha: string, n: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  f.setUTCDate(f.getUTCDate() + n);
  return f.toISOString().slice(0, 10);
}

/** Categoría de una cuota según su vencimiento y saldo; null si no genera aviso. */
export function categoriaDeCuota(fechaVencimiento: string, saldo: string, hoy: string, dias: number = DIAS_AVISO_PROXIMO): Exclude<CategoriaAviso, "SIN_CONDICIONES"> | null {
  if (aCentavos(saldo) <= BigInt(0)) return null;
  if (fechaVencimiento < hoy) return "VENCIDO";
  if (fechaVencimiento === hoy) return "HOY";
  if (fechaVencimiento <= sumarDias(hoy, dias)) return "PROXIMO";
  return null;
}

/** Cuenta vigente con su documento y sus cuotas vigentes con saldo (de B5). */
export type CuentaParaAvisos = {
  cuentaId: string;
  tipo: TipoAviso;
  contraparte: string; // cliente o proveedor
  folio: string; // OV o COC
  enlace: string; // documento y su bloque financiero
  saldo: string; // saldo de la cuenta
  cuotas: { numero: number; fechaVencimiento: string; saldo: string }[];
};

export type Aviso = {
  clave: string; // única: cuenta + cuota (o cuenta, sin condiciones)
  categoria: CategoriaAviso;
  tipo: TipoAviso;
  contraparte: string;
  folio: string;
  enlace: string;
  cuotaNumero: number | null;
  fechaVencimiento: string | null;
  saldo: string; // saldo pendiente de la cuota (o de la cuenta sin condiciones)
};

/** Construye los avisos de un conjunto de cuentas vigentes. Sin duplicados: uno por cuota (o por cuenta). */
export function construirAvisos(cuentas: CuentaParaAvisos[], hoy: string, dias: number = DIAS_AVISO_PROXIMO): Aviso[] {
  const avisos: Aviso[] = [];
  for (const c of cuentas) {
    const base = { tipo: c.tipo, contraparte: c.contraparte, folio: c.folio, enlace: c.enlace };
    if (c.cuotas.length === 0) {
      if (aCentavos(c.saldo) > BigInt(0)) {
        avisos.push({ ...base, clave: c.cuentaId, categoria: "SIN_CONDICIONES", cuotaNumero: null, fechaVencimiento: null, saldo: c.saldo });
      }
      continue;
    }
    for (const q of c.cuotas) {
      const categoria = categoriaDeCuota(q.fechaVencimiento, q.saldo, hoy, dias);
      if (categoria) avisos.push({ ...base, clave: `${c.cuentaId}:${q.numero}`, categoria, cuotaNumero: q.numero, fechaVencimiento: q.fechaVencimiento, saldo: q.saldo });
    }
  }
  return ordenarAvisos(avisos);
}

/** Vencidos desde el más antiguo; hoy/próximos desde el más cercano (orden ascendente por fecha en todos). */
export function ordenarAvisos(avisos: Aviso[]): Aviso[] {
  return [...avisos].sort(
    (a, b) =>
      CATEGORIAS_AVISO.indexOf(a.categoria) - CATEGORIAS_AVISO.indexOf(b.categoria) ||
      (a.fechaVencimiento ?? "").localeCompare(b.fechaVencimiento ?? "") ||
      a.folio.localeCompare(b.folio) ||
      (a.cuotaNumero ?? 0) - (b.cuotaNumero ?? 0) ||
      a.clave.localeCompare(b.clave)
  );
}

export type TotalesAviso = { cuotas: number; cuentas: number; importe: string };
export type ResumenCategoria = { cobro: TotalesAviso; pago: TotalesAviso };

/** Conteos e importes del conjunto COMPLETO de una categoría, por cobrar y por pagar por separado (nunca se compensan). */
export function resumirAvisos(avisos: Aviso[]): Record<CategoriaAviso, ResumenCategoria> {
  const vacio = (): TotalesAviso => ({ cuotas: 0, cuentas: 0, importe: "0.00" });
  const res = Object.fromEntries(CATEGORIAS_AVISO.map((k) => [k, { cobro: vacio(), pago: vacio() }])) as Record<CategoriaAviso, ResumenCategoria>;
  const cuentas = new Map<string, Set<string>>();
  const importes = new Map<string, bigint>();
  for (const a of avisos) {
    const k = `${a.categoria}|${a.tipo}`;
    const t = res[a.categoria][a.tipo === "COBRO" ? "cobro" : "pago"];
    if (a.cuotaNumero !== null) t.cuotas++;
    const cuenta = a.clave.split(":")[0];
    if (!cuentas.has(k)) cuentas.set(k, new Set());
    cuentas.get(k)!.add(cuenta);
    t.cuentas = cuentas.get(k)!.size;
    importes.set(k, (importes.get(k) ?? BigInt(0)) + aCentavos(a.saldo));
    t.importe = deCentavos(importes.get(k)!);
  }
  return res;
}

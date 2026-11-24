import type { EsquemaContractual } from "@/lib/generated/prisma/enums";

// Presentación de la estimación privada (Cliente Priv. y su PDF). Solo
// reordena cifras ya calculadas o congeladas; nunca recalcula totales.

export function etiquetaCargo(esquema: EsquemaContractual | null): "Administración" | "Utilidad" {
  return esquema === "ADMINISTRACION" ? "Administración" : "Utilidad";
}

// "18" → " (18%)"; sin tasa → "".
export function sufijoTasa(porcentaje: number | null): string {
  return porcentaje === null ? "" : ` (${porcentaje.toLocaleString("es-MX", { maximumFractionDigits: 2 })}%)`;
}

export type TasaTrabajos = { porcentaje: number; base: number; monto: number };

// Trabajos de la semana agrupados por la tasa que se les aplicó. Un solo
// elemento = tasa única; varios = se muestra el desglose, nunca una tasa.
export function tasasDeTrabajos(
  filas: {
    precioUnitarioBase: number;
    cantidadEstaSemana: number;
    porcentajeAplicado: number | null;
    // Importe base de la capa; puede estar fijado y no ser P.U. × cantidad.
    importeEstaSemanaBase?: number;
  }[]
): TasaTrabajos[] {
  const porTasa = new Map<number, number>();
  for (const f of filas) {
    const tasa = f.porcentajeAplicado ?? 0;
    porTasa.set(tasa, (porTasa.get(tasa) ?? 0) + (f.importeEstaSemanaBase ?? f.precioUnitarioBase * f.cantidadEstaSemana));
  }
  return [...porTasa.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([porcentaje, base]) => ({ porcentaje, base, monto: base * (porcentaje / 100) }));
}

// Importes de una fila congelada llevados a la base (sin administración, sin
// IVA): P.U. base × cantidad, la misma fórmula con la que se emitió el
// subtotal de trabajos.
export function importesBase(f: {
  precioUnitarioBase: number;
  cantidadContratada: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  cantidadPorEjercer: number;
}) {
  return {
    importeContratado: f.precioUnitarioBase * f.cantidadContratada,
    importeEstaSemana: f.precioUnitarioBase * f.cantidadEstaSemana,
    importeAcumulado: f.precioUnitarioBase * f.cantidadAcumulada,
    importePorEjercer: f.precioUnitarioBase * f.cantidadPorEjercer,
  };
}

// Importe base de una fila EMITIDA: P.U. base × cantidad salvo que el importe
// congelado venga de un importe fijado (cantidad estimada por capa).
export function baseDeImporteCongelado(p: {
  calculado: number;
  importe: number;
  precioUnitarioBase: number;
  precioUnitario: number;
  porcentajeAplicado: number | null;
}): number {
  const base =
    p.porcentajeAplicado !== null
      ? p.importe / (1 + p.porcentajeAplicado / 100)
      : p.precioUnitario > 0
        ? (p.importe * p.precioUnitarioBase) / p.precioUnitario
        : p.importe;
  return Math.abs(base - p.calculado) < 0.05 ? p.calculado : base;
}

const centavos = (n: number) => Math.round(n * 100) / 100;

export type LineaResumen = { etiqueta: string; monto: number };

// Renglones del resumen del PDF privado. "Trabajos con administración" ya
// incluye su cargo, para conciliar con la columna de trabajos. El subtotal
// antes de IVA sale del total emitido, que nunca se recalcula.
export function resumenPdfPrivado(e: {
  esquemaContractual: EsquemaContractual | null;
  subtotalTrabajos: number;
  administracionTrabajos: number;
  gastosCobrables: number;
  administracionGastos: number;
  porcentajeAdministracionGastos: number | null;
  aplicaIVA: boolean;
  porcentajeIVA: number | null;
  montoIVA: number;
  total: number;
}): LineaResumen[] {
  const cargo = etiquetaCargo(e.esquemaContractual);
  const lineas: LineaResumen[] = [
    {
      etiqueta: e.administracionTrabajos !== 0 ? `Trabajos con ${cargo.toLowerCase()}` : "Trabajos",
      monto: centavos(e.subtotalTrabajos + e.administracionTrabajos),
    },
    { etiqueta: "Gastos cobrables", monto: e.gastosCobrables },
  ];
  if (e.administracionGastos !== 0) {
    lineas.push({
      etiqueta: `${cargo} sobre gastos${sufijoTasa(e.porcentajeAdministracionGastos)}`,
      monto: e.administracionGastos,
    });
  }
  if (e.aplicaIVA) {
    lineas.push({ etiqueta: "Subtotal antes de IVA", monto: centavos(e.total - e.montoIVA) });
    lineas.push({ etiqueta: `IVA${sufijoTasa(e.porcentajeIVA)}`, monto: e.montoIVA });
  }
  return lineas;
}

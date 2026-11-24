import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { importesBase, resumenPdfPrivado, tasasDeTrabajos, baseDeImporteCongelado } from "@/lib/control-de-obra/presentacion-estimacion-privada";

const CASO = {
  esquemaContractual: "ADMINISTRACION" as const,
  subtotalTrabajos: 10800,
  administracionTrabajos: 1944,
  gastosCobrables: 6691,
  administracionGastos: 1204.38,
  porcentajeAdministracionGastos: 18,
  aplicaIVA: true,
  porcentajeIVA: 16,
  montoIVA: 3302.3,
  total: 23941.68,
};

describe("Presentación de la estimación privada", () => {
  test("el resumen del PDF concilia con la columna de trabajos y el total", () => {
    const lineas = resumenPdfPrivado(CASO);
    assert.deepEqual(lineas, [
      { etiqueta: "Trabajos con administración", monto: 12744 },
      { etiqueta: "Gastos cobrables", monto: 6691 },
      { etiqueta: "Administración sobre gastos (18%)", monto: 1204.38 },
      { etiqueta: "Subtotal antes de IVA", monto: 20639.38 },
      { etiqueta: "IVA (16%)", monto: 3302.3 },
    ]);
    assert.equal(4484 + 5900 + 2360, lineas[0].monto);
  });

  test("Precio Alzado rotula Utilidad; sin IVA ni gastos no agrega renglones", () => {
    const lineas = resumenPdfPrivado({
      ...CASO, esquemaContractual: "PRECIO_ALZADO" as never, gastosCobrables: 0, administracionGastos: 0, aplicaIVA: false, montoIVA: 0, total: 12744,
    });
    assert.deepEqual(lineas.map((l) => l.etiqueta), ["Trabajos con utilidad", "Gastos cobrables"]);
  });

  test("importes en base: P.U. sin administración × cantidad, con acumulado histórico", () => {
    assert.deepEqual(
      importesBase({ precioUnitarioBase: 950, cantidadContratada: 8, cantidadEstaSemana: 4, cantidadAcumulada: 8, cantidadPorEjercer: 0 }),
      { importeContratado: 7600, importeEstaSemana: 3800, importeAcumulado: 7600, importePorEjercer: 0 }
    );
  });

  test("tasa única o desglose por tasa", () => {
    const fila = (precioUnitarioBase: number, porcentajeAplicado: number | null) => ({ precioUnitarioBase, cantidadEstaSemana: 1, porcentajeAplicado });
    assert.deepEqual(tasasDeTrabajos([fila(5000, 18), fila(2000, 18)]), [{ porcentaje: 18, base: 7000, monto: 1260 }]);
    assert.deepEqual(tasasDeTrabajos([fila(950, 15), fila(5000, 18)]).map((t) => [t.porcentaje, t.base, t.monto]), [[18, 5000, 900], [15, 950, 142.5]]);
  });
});

describe("importes fijados por capa (cantidad estimada por capa)", () => {
  const emitida = { precioUnitarioBase: 381.15, precioUnitario: 426.89, porcentajeAplicado: 12 };
  test("una fila emitida normal conserva P.U. base × cantidad exacto", () => {
    const calculado = 381.15 * 1000;
    const importe = Math.round(calculado * 1.12 * 100) / 100;
    assert.equal(baseDeImporteCongelado({ ...emitida, calculado, importe }), calculado);
  });
  test("un importe fijado no se recalcula como P.U. × cantidad", () => {
    const base = baseDeImporteCongelado({ calculado: 5500 * 1.090909, importe: 6720, precioUnitarioBase: 5500, precioUnitario: 6160, porcentajeAplicado: 12 });
    assert.equal(Math.round(base * 100) / 100, 6000);
  });
  test("sin administración, el importe congelado ya es la base", () => {
    assert.equal(baseDeImporteCongelado({ calculado: 100, importe: 150, precioUnitarioBase: 100, precioUnitario: 100, porcentajeAplicado: null }), 150);
  });
  test("las tasas de trabajos usan el importe base de la capa si está fijado", () => {
    const [t] = tasasDeTrabajos([{ precioUnitarioBase: 5500, cantidadEstaSemana: 1, porcentajeAplicado: 12, importeEstaSemanaBase: 6000 }]);
    assert.equal(t.base, 6000);
    assert.equal(Math.round(t.monto), 720);
  });
});

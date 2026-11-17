import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  aCentavos,
  calcularImpuesto,
  deCentavos,
  formatearImporte,
  normalizarImporte,
  normalizarTasa,
} from "@/lib/comercializacion/importes";

// Importes de Comercialización: aritmética exacta en centavos, half-up.

describe("normalizarImporte", () => {
  const validos: [string, string][] = [
    ["1234.5", "1234.50"],
    ["$1,234.56", "1234.56"],
    [" 80 ", "80.00"],
    ["0007.1", "7.10"],
    ["999999999999.99", "999999999999.99"],
  ];
  for (const [entrada, esperado] of validos) {
    test(`acepta ${JSON.stringify(entrada)} → ${esperado}`, () => {
      assert.equal(normalizarImporte(entrada, { permitirCero: false }), esperado);
    });
  }

  const invalidos = ["", "  ", "-5", "1.234", "1e3", "abc", "12.3.4", "1000000000000.00", "NaN", "Infinity"];
  for (const entrada of invalidos) {
    test(`rechaza ${JSON.stringify(entrada)}`, () => {
      assert.equal(normalizarImporte(entrada, { permitirCero: true }), null);
    });
  }

  test("cero: rechazado para precio, aceptado para costo", () => {
    assert.equal(normalizarImporte("0", { permitirCero: false }), null);
    assert.equal(normalizarImporte("0.00", { permitirCero: false }), null);
    assert.equal(normalizarImporte("0", { permitirCero: true }), "0.00");
  });

  test("no acepta tipos distintos de texto o número", () => {
    assert.equal(normalizarImporte({ valueOf: () => 5 }, { permitirCero: true }), null);
    assert.equal(normalizarImporte(undefined, { permitirCero: true }), null);
  });
});

describe("normalizarTasa", () => {
  test("acepta tasas entre 0 (excluido) y 100", () => {
    assert.equal(normalizarTasa("16"), "16.00");
    assert.equal(normalizarTasa("16 %"), "16.00");
    assert.equal(normalizarTasa("8.5"), "8.50");
    assert.equal(normalizarTasa("100"), "100.00");
  });
  test("rechaza 0 (eso es el tratamiento Tasa 0 %), negativos, >100 y >2 decimales", () => {
    for (const t of ["0", "0.00", "-16", "100.01", "16.123", "", "x"]) assert.equal(normalizarTasa(t), null, t);
  });
});

describe("calcularImpuesto", () => {
  test("16 % de $100.00", () => {
    assert.deepEqual(calcularImpuesto("100.00", "GRAVADO", "16.00"), { iva: "16.00", total: "116.00" });
  });
  test("redondeo half-up al centavo", () => {
    assert.deepEqual(calcularImpuesto("0.05", "GRAVADO", "10.00"), { iva: "0.01", total: "0.06" }); // 0.005 → 0.01
    assert.deepEqual(calcularImpuesto("0.03", "GRAVADO", "16.00"), { iva: "0.00", total: "0.03" }); // 0.0048 → 0.00
    assert.deepEqual(calcularImpuesto("1.15", "GRAVADO", "16.00"), { iva: "0.18", total: "1.33" }); // 0.184
  });
  test("sin errores de punto flotante en importes grandes", () => {
    assert.deepEqual(calcularImpuesto("999999999999.99", "GRAVADO", "16.00"), {
      iva: "160000000000.00",
      total: "1159999999999.99",
    });
    // 0.1 + 0.2 en float da 0.30000000000000004; aquí es exacto.
    assert.equal(deCentavos(aCentavos("0.10") + aCentavos("0.20")), "0.30");
  });
  test("Tasa 0 % y Exento: IVA cero, pero tratamientos distintos", () => {
    assert.deepEqual(calcularImpuesto("250.00", "TASA_CERO", null), { iva: "0.00", total: "250.00" });
    assert.deepEqual(calcularImpuesto("250.00", "EXENTO", null), { iva: "0.00", total: "250.00" });
  });
  test("gravado sin tasa es un error", () => {
    assert.throws(() => calcularImpuesto("10.00", "GRAVADO", null));
  });
  test("tasa no estándar editable (8 %)", () => {
    assert.deepEqual(calcularImpuesto("1250.00", "GRAVADO", "8.00"), { iva: "100.00", total: "1350.00" });
  });
});

describe("formato", () => {
  test("formatearImporte", () => {
    assert.equal(formatearImporte("1234567.50"), "$1,234,567.50");
    assert.equal(formatearImporte("0.00"), "$0.00");
    assert.equal(formatearImporte(null), "—");
  });
});

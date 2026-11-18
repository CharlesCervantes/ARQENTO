import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { calcularResultado, simular5050 } from "@/lib/comercializacion/resultado";

// B7 — resultado estimado y simulación 50/50 en centavos exactos.

const completa = [{ codigo: "P", descripcion: "Pieza", unidad: "pieza", vendido: "100.000", comprado: "100.000" }];

describe("Simulación 50/50", () => {
  test("partes iguales y centavo indivisible a la segunda participación", () => {
    assert.deepEqual(simular5050("3000.00"), { socio1: "1500.00", socio2: "1500.00" });
    assert.deepEqual(simular5050("3000.01"), { socio1: "1500.00", socio2: "1500.01" });
    assert.deepEqual(simular5050("0.01"), { socio1: "0.00", socio2: "0.01" });
  });
});

describe("Resultado estimado", () => {
  test("caso principal: $10,000 − $6,000 − $1,000 = $3,000", () => {
    const r = calcularResultado({ venta: "10000.00", compras: ["6000.00"], gastos: ["1000.00"], partidas: completa });
    assert.deepEqual(r, {
      venta: "10000.00",
      compras: "6000.00",
      gastos: "1000.00",
      costosConocidos: "7000.00",
      faltantes: [],
      estado: "POSITIVO",
      resultado: "3000.00",
      simulacion: { socio1: "1500.00", socio2: "1500.00" },
    });
  });
  test("cero y pérdida: sin simulación", () => {
    assert.deepEqual(
      [calcularResultado({ venta: "100.00", compras: ["100.00"], gastos: [], partidas: completa })].map((r) => [r.estado, r.resultado, r.simulacion]),
      [["CERO", "0.00", null]]
    );
    const p = calcularResultado({ venta: "100.00", compras: ["90.00"], gastos: ["10.01"], partidas: completa });
    assert.deepEqual([p.estado, p.resultado, p.simulacion], ["PERDIDA", "-0.01", null]);
  });
  test("incompleto: sin cifra final ni simulación, con faltantes por partida (sin mezclar unidades)", () => {
    const r = calcularResultado({
      venta: "500.00",
      compras: ["100.00"],
      gastos: ["5.00"],
      partidas: [
        { codigo: "P", descripcion: "Pieza", unidad: "pieza", vendido: "100.000", comprado: "100.000" },
        { codigo: "T", descripcion: "Tubo", unidad: "m", vendido: "2.375", comprado: "1.250" },
      ],
    });
    assert.deepEqual([r.estado, r.resultado, r.simulacion, r.costosConocidos], ["INCOMPLETO", null, null, "105.00"]);
    assert.deepEqual(r.faltantes.map((f) => [f.codigo, f.unidad, f.falta]), [["T", "m", "1.125"]]);
  });
  test("una OV sin partidas no se presenta como completa", () => {
    assert.equal(calcularResultado({ venta: "0.00", compras: [], gastos: [], partidas: [] }).estado, "INCOMPLETO");
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { avancePartida, estadoEntrega } from "@/lib/comercializacion/entregas";

// B6A — avance por partida y estado general de entrega (milésimas exactas).

describe("Avance por partida", () => {
  test("100 postes y 2.375 m: entrega de 60 y 1.250 deja 40 y 1.125", () => {
    assert.deepEqual(avancePartida("100.000", ["60.000"]), { vendido: "100.000", entregado: "60.000", pendiente: "40.000", completa: false });
    assert.deepEqual(avancePartida("2.375", ["1.250"]), { vendido: "2.375", entregado: "1.250", pendiente: "1.125", completa: false });
  });
  test("fracciones exactas sin errores de punto flotante", () => {
    assert.deepEqual(avancePartida("0.300", ["0.100", "0.200"]), { vendido: "0.300", entregado: "0.300", pendiente: "0.000", completa: true });
    assert.equal(avancePartida("2.375", ["0.001", "2.373"]).pendiente, "0.001");
  });
  test("sin entregas: todo pendiente", () => {
    assert.deepEqual(avancePartida("5.000", []), { vendido: "5.000", entregado: "0.000", pendiente: "5.000", completa: false });
  });
});

describe("Estado general", () => {
  const p = (v: string, e: string[]) => avancePartida(v, e);
  test("Pendiente: ninguna cantidad entregada", () => {
    assert.deepEqual(estadoEntrega([p("100.000", []), p("2.375", [])]), { estado: "PENDIENTE", completas: 0, total: 2 });
  });
  test("Parcial: algo entregado y aún hay pendientes", () => {
    assert.deepEqual(estadoEntrega([p("100.000", ["60.000"]), p("2.375", ["1.250"])]), { estado: "PARCIAL", completas: 0, total: 2 });
  });
  test("Unidades distintas: 100 piezas completas y 0 m de tubo NO es completa (ni un porcentaje)", () => {
    assert.deepEqual(estadoEntrega([p("100.000", ["100.000"]), p("2.375", [])]), { estado: "PARCIAL", completas: 1, total: 2 });
  });
  test("Completa: todas las partidas entregadas", () => {
    assert.deepEqual(estadoEntrega([p("100.000", ["60.000", "40.000"]), p("2.375", ["1.250", "1.125"])]), { estado: "COMPLETA", completas: 2, total: 2 });
  });
});

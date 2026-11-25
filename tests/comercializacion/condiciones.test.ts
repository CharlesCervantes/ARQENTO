import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { anticipoYSaldo, cuotasIguales, enlaceDefinir, pagoAPlazo, sumarDias } from "@/lib/comercializacion/condiciones";
import { aCentavos } from "@/lib/comercializacion/importes";

describe("Formas rápidas de condiciones", () => {
  test("plazo en días desde la fecha elegida, con cambio de mes y año bisiesto", () => {
    assert.deepEqual(pagoAPlazo("100.00", "2026-12-15", 30), [{ fecha: "2027-01-14", importe: "100.00" }]);
    assert.equal(sumarDias("2028-02-28", 1), "2028-02-29");
    for (const dias of [-1, 1.5, NaN, 731]) assert.throws(() => pagoAPlazo("100.00", "2026-12-15", dias));
    assert.throws(() => pagoAPlazo("100.00", "", 30));
  });
  test("anticipo y saldo suman exactamente el total", () => {
    assert.deepEqual(anticipoYSaldo("100.01", 50, "2026-11-25", "2026-12-25").map((q) => q.importe), ["50.01", "50.00"]);
    assert.deepEqual(anticipoYSaldo("12000.00", 33.33, "2026-11-25", "2026-11-25").map((q) => q.importe), ["3999.60", "8000.40"]);
    for (const x of [0, 100, -5, NaN]) assert.throws(() => anticipoYSaldo("100.00", x, "2026-11-25", "2026-12-25"));
    assert.throws(() => anticipoYSaldo("100.00", 50, "2026-12-25", "2026-11-25"));
    assert.throws(() => anticipoYSaldo("0.01", 50, "2026-11-25", "2026-12-25"));
  });
  test("cuotas iguales: la última ajusta centavos; mensual conserva el día", () => {
    const m = cuotasIguales("100.00", 3, "2027-01-31", "MENSUAL");
    assert.deepEqual(m.map((q) => q.fecha), ["2027-01-31", "2027-02-28", "2027-03-31"]);
    assert.deepEqual(m.map((q) => q.importe), ["33.33", "33.33", "33.34"]);
    assert.deepEqual(cuotasIguales("10.00", 2, "2026-11-25", "SEMANAL").map((q) => q.fecha), ["2026-11-25", "2026-12-02"]);
    assert.deepEqual(cuotasIguales("10.00", 2, "2026-11-25", "QUINCENAL").map((q) => q.fecha), ["2026-11-25", "2026-12-10"]);
    for (let n = 2; n <= 60; n++) assert.equal(cuotasIguales("11600.07", n, "2026-11-25", "MENSUAL").reduce((s, q) => s + aCentavos(q.importe), BigInt(0)), BigInt(1160007));
    for (const n of [1, 61, 2.5, NaN]) assert.throws(() => cuotasIguales("100.00", n, "2026-11-25", "MENSUAL"));
    assert.throws(() => cuotasIguales("0.02", 3, "2026-11-25", "MENSUAL"));
  });
  test("el enlace conserva consulta y ancla", () => {
    assert.equal(enlaceDefinir("/a/b?vista=x#cobros", "c1"), "/a/b?vista=x&definir=c1#cobros");
    assert.equal(enlaceDefinir("/a/b", "c1"), "/a/b?definir=c1");
  });
});

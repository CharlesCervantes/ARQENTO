import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { calcularEstadoCuenta, hoyEnZona, proponerAplicacion, zonaEfectiva } from "@/lib/comercializacion/cuentas";

// B5 — saldos, estados de liquidación/vencimiento y aplicación de abonos.

const cuotas = (a1: string, a2: string) => [
  { id: "q1", numero: 1, fechaVencimiento: "2026-11-10", importe: "4000.00", aplicado: a1 },
  { id: "q2", numero: 2, fechaVencimiento: "2026-12-10", importe: "8000.00", aplicado: a2 },
];

describe("Caso de referencia $12,000 en dos cuotas", () => {
  test("sin abonos: todo pendiente; vencido solo la cuota 1 si ya pasó su fecha", () => {
    const e = calcularEstadoCuenta("12000.00", "0.00", cuotas("0.00", "0.00"), "2026-11-20");
    assert.equal(e.saldo, "12000.00");
    assert.equal(e.vencido, "4000.00");
    assert.equal(e.liquidacion, "PENDIENTE");
    assert.equal(e.situacion, "VENCIDA");
  });
  test("abono de $5,000: cuota 1 liquidada, cuota 2 con $7,000; vencido $0", () => {
    const p = proponerAplicacion(
      cuotas("0.00", "0.00").map((q) => ({ ...q, saldo: q.importe })),
      "5000.00"
    );
    assert.deepEqual(p, [
      { cuotaId: "q1", importe: "4000.00" },
      { cuotaId: "q2", importe: "1000.00" },
    ]);
    const e = calcularEstadoCuenta("12000.00", "5000.00", cuotas("4000.00", "1000.00"), "2026-11-20");
    assert.deepEqual(e.cuotas.map((q) => [q.saldo, q.situacion]), [
      ["0.00", "LIQUIDADA"],
      ["7000.00", "AL_CORRIENTE"],
    ]);
    assert.equal(e.saldo, "7000.00");
    assert.equal(e.vencido, "0.00");
    assert.equal(e.liquidacion, "PARCIAL");
    assert.equal(e.situacion, "AL_CORRIENTE");
  });
  test("parcial y vencida a la vez: el vencido es solo el saldo de cuotas vencidas", () => {
    const e = calcularEstadoCuenta("12000.00", "1000.00", cuotas("1000.00", "0.00"), "2026-11-20");
    assert.equal(e.liquidacion, "PARCIAL");
    assert.equal(e.situacion, "VENCIDA");
    assert.equal(e.vencido, "3000.00");
    assert.equal(e.saldo, "11000.00");
  });
});

describe("Estados", () => {
  test("sin calendario: no liquidada ni vencida", () => {
    const e = calcularEstadoCuenta("500.00", "0.00", [], "2026-11-20");
    assert.equal(e.situacion, "SIN_CALENDARIO");
    assert.equal(e.liquidacion, "PENDIENTE");
    assert.equal(e.vencido, "0.00");
  });
  test("vence hoy durante el día; vencida al día siguiente", () => {
    const q = [{ id: "q", numero: 1, fechaVencimiento: "2026-11-20", importe: "100.00", aplicado: "0.00" }];
    assert.equal(calcularEstadoCuenta("100.00", "0.00", q, "2026-11-20").situacion, "VENCE_HOY");
    assert.equal(calcularEstadoCuenta("100.00", "0.00", q, "2026-11-20").vencido, "0.00");
    assert.equal(calcularEstadoCuenta("100.00", "0.00", q, "2026-11-21").situacion, "VENCIDA");
    assert.equal(calcularEstadoCuenta("100.00", "0.00", q, "2026-11-21").vencido, "100.00");
  });
  test("liquidada no está vencida aunque su fecha haya pasado", () => {
    const q = [{ id: "q", numero: 1, fechaVencimiento: "2026-01-01", importe: "100.00", aplicado: "100.00" }];
    const e = calcularEstadoCuenta("100.00", "100.00", q, "2026-11-20");
    assert.equal(e.liquidacion, "LIQUIDADA");
    assert.equal(e.vencido, "0.00");
  });
});

describe("Propuesta de aplicación", () => {
  test("la más antigua primero, incluyendo cuotas futuras (pago anticipado)", () => {
    const qs = [
      { id: "b", numero: 2, fechaVencimiento: "2027-01-01", saldo: "50.00" },
      { id: "a", numero: 1, fechaVencimiento: "2026-01-01", saldo: "0.00" },
      { id: "c", numero: 3, fechaVencimiento: "2027-02-01", saldo: "50.00" },
    ];
    assert.deepEqual(proponerAplicacion(qs, "75.00"), [
      { cuotaId: "b", importe: "50.00" },
      { cuotaId: "c", importe: "25.00" },
    ]);
  });
  test("si excede el saldo no hay propuesta (sin saldo a favor)", () => {
    assert.equal(proponerAplicacion([{ id: "a", numero: 1, fechaVencimiento: "2026-01-01", saldo: "10.00" }], "10.01"), null);
    assert.equal(proponerAplicacion([{ id: "a", numero: 1, fechaVencimiento: "2026-01-01", saldo: "10.00" }], "0.00"), null);
  });
  test("centavos exactos", () => {
    const qs = [1, 2, 3].map((n) => ({ id: `q${n}`, numero: n, fechaVencimiento: `2026-0${n}-01`, saldo: "33.33" }));
    assert.deepEqual(proponerAplicacion(qs, "66.67"), [
      { cuotaId: "q1", importe: "33.33" },
      { cuotaId: "q2", importe: "33.33" },
      { cuotaId: "q3", importe: "0.01" },
    ]);
  });
});

describe("Zona horaria y medianoche", () => {
  test("America/Monterrey (UTC−6): el día cambia a las 06:00 UTC", () => {
    assert.equal(hoyEnZona(null, new Date(Date.UTC(2026, 10, 21, 5, 59, 59))), "2026-11-20");
    assert.equal(hoyEnZona(null, new Date(Date.UTC(2026, 10, 21, 6, 0, 0))), "2026-11-21");
  });
  test("una cuota que vence el 20: «Vence hoy» a las 23:59 locales y vencida a las 00:00", () => {
    const q = [{ id: "q", numero: 1, fechaVencimiento: "2026-11-20", importe: "100.00", aplicado: "0.00" }];
    const antes = hoyEnZona(null, new Date(Date.UTC(2026, 10, 21, 5, 59, 0)));
    const despues = hoyEnZona(null, new Date(Date.UTC(2026, 10, 21, 6, 0, 0)));
    assert.equal(calcularEstadoCuenta("100.00", "0.00", q, antes).situacion, "VENCE_HOY");
    assert.equal(calcularEstadoCuenta("100.00", "0.00", q, despues).situacion, "VENCIDA");
  });
  test("se usa la zona de la Empresa; una zona inválida cae en America/Monterrey", () => {
    const instante = new Date(Date.UTC(2026, 10, 20, 20, 0, 0)); // 14:00 Monterrey, 05:00 del 21 en Tokio
    assert.equal(hoyEnZona("Asia/Tokyo", instante), "2026-11-21");
    assert.equal(hoyEnZona(null, instante), "2026-11-20");
    assert.equal(zonaEfectiva("No/Existe"), "America/Monterrey");
    assert.equal(hoyEnZona("No/Existe", instante), "2026-11-20");
  });
});

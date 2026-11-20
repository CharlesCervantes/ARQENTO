import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hoyEnZona } from "@/lib/comercializacion/cuentas";
import { DIAS_AVISO_PROXIMO, categoriaDeCuota, construirAvisos, resumirAvisos, sumarDias, type CuentaParaAvisos } from "@/lib/comercializacion/recordatorios";

// B6B — clasificación de recordatorios con fecha controlada (sin reloj real).

const HOY = "2026-03-10";

describe("Clasificación por cuota", () => {
  test("umbral provisional centralizado: 3 días naturales", () => {
    assert.equal(DIAS_AVISO_PROXIMO, 3);
  });
  test("vencida, hoy, mañana, a 3 días y a 4 días", () => {
    assert.equal(categoriaDeCuota("2026-03-09", "100.00", HOY), "VENCIDO");
    assert.equal(categoriaDeCuota("2026-03-10", "100.00", HOY), "HOY");
    assert.equal(categoriaDeCuota("2026-03-11", "100.00", HOY), "PROXIMO");
    assert.equal(categoriaDeCuota("2026-03-13", "100.00", HOY), "PROXIMO");
    assert.equal(categoriaDeCuota("2026-03-14", "100.00", HOY), null);
  });
  test("cuota liquidada: sin aviso aunque esté vencida", () => {
    assert.equal(categoriaDeCuota("2026-01-01", "0.00", HOY), null);
  });
  test("aritmética de calendario: fin de mes y año bisiesto", () => {
    assert.equal(sumarDias("2028-02-27", 3), "2028-03-01");
    assert.equal(sumarDias("2026-12-30", 3), "2027-01-02");
    assert.equal(categoriaDeCuota("2027-01-02", "1.00", "2026-12-30"), "PROXIMO");
  });
  test("medianoche en la zona de la Empresa (America/Monterrey, UTC−6)", () => {
    const antes = hoyEnZona("America/Monterrey", new Date("2026-03-10T05:59:59Z"));
    const despues = hoyEnZona("America/Monterrey", new Date("2026-03-10T06:00:00Z"));
    assert.deepEqual([antes, despues], ["2026-03-09", "2026-03-10"]);
    assert.equal(categoriaDeCuota("2026-03-09", "1.00", antes), "HOY");
    assert.equal(categoriaDeCuota("2026-03-09", "1.00", despues), "VENCIDO");
  });
});

const cuenta = (id: string, tipo: "COBRO" | "PAGO", saldo: string, cuotas: [number, string, string][]): CuentaParaAvisos => ({
  cuentaId: id,
  tipo,
  contraparte: `Contraparte ${id}`,
  folio: id.toUpperCase(),
  enlace: `/x/${id}`,
  saldo,
  cuotas: cuotas.map(([numero, fechaVencimiento, s]) => ({ numero, fechaVencimiento, saldo: s })),
});

describe("Construcción y totales", () => {
  test("una entrada por cuota (sin duplicados) y una por cuenta sin calendario", () => {
    const avisos = construirAvisos(
      [
        cuenta("ov-1", "COBRO", "5000.00", [
          [1, "2026-03-01", "1000.00"],
          [2, "2026-03-10", "1000.00"],
          [3, "2026-03-12", "1000.00"],
          [4, "2026-03-20", "2000.00"],
        ]),
        cuenta("ov-2", "COBRO", "800.00", []),
        cuenta("ov-3", "COBRO", "0.00", []),
        cuenta("coc-1", "PAGO", "700.00", [[1, "2026-02-01", "700.00"]]),
      ],
      HOY
    );
    assert.deepEqual(
      avisos.map((a) => [a.categoria, a.folio, a.cuotaNumero, a.saldo]),
      [
        ["VENCIDO", "COC-1", 1, "700.00"],
        ["VENCIDO", "OV-1", 1, "1000.00"],
        ["HOY", "OV-1", 2, "1000.00"],
        ["PROXIMO", "OV-1", 3, "1000.00"],
        ["SIN_CONDICIONES", "OV-2", null, "800.00"],
      ]
    );
    assert.equal(new Set(avisos.map((a) => a.clave)).size, avisos.length);
    const r = resumirAvisos(avisos);
    // Por cobrar y por pagar nunca se compensan.
    assert.deepEqual(r.VENCIDO, { cobro: { cuotas: 1, cuentas: 1, importe: "1000.00" }, pago: { cuotas: 1, cuentas: 1, importe: "700.00" } });
    assert.deepEqual(r.SIN_CONDICIONES.cobro, { cuotas: 0, cuentas: 1, importe: "800.00" });
    assert.deepEqual(r.PROXIMO.pago, { cuotas: 0, cuentas: 0, importe: "0.00" });
  });
  test("varias cuotas vencidas de la misma cuenta: N cuotas, 1 cuenta, orden desde la más antigua", () => {
    const avisos = construirAvisos(
      [
        cuenta("ov-1", "COBRO", "3.00", [
          [3, "2026-03-05", "1.00"],
          [1, "2026-03-01", "1.00"],
          [2, "2026-03-03", "1.00"],
        ]),
      ],
      HOY
    );
    assert.deepEqual(avisos.map((a) => a.cuotaNumero), [1, 2, 3]);
    assert.deepEqual(resumirAvisos(avisos).VENCIDO.cobro, { cuotas: 3, cuentas: 1, importe: "3.00" });
  });
});

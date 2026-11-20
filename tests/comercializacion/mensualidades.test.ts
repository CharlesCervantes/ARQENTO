import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generarMensualidades, GeneracionMensualidadesError, PLAZOS_MENSUALES, sumarMeses } from "@/lib/comercializacion/mensualidades";
import { aCentavos, calcularTotalesCotizacion, esImpuestoCompraVigente, etiquetaImpuestoCompra } from "@/lib/comercializacion/importes";

// Mensualidades automáticas del crédito de proveedor e impuesto de compras
// (ajuste de nov-2026) — funciones puras.

const suma = (cuotas: { importe: string }[]) => cuotas.reduce((s, q) => s + aCentavos(q.importe), BigInt(0));
const fechas = (total: string, plazo: number, primera: string) => generarMensualidades(total, plazo, primera).map((q) => q.fechaVencimiento);

describe("Mensualidades: plazos e importes", () => {
  test("los cinco plazos generan ese número de cuotas que suman exactamente el total", () => {
    assert.deepEqual([...PLAZOS_MENSUALES], [3, 6, 12, 18, 24]);
    for (const plazo of PLAZOS_MENSUALES) {
      const cuotas = generarMensualidades("11600.00", plazo, "2027-01-15");
      assert.equal(cuotas.length, plazo);
      assert.equal(suma(cuotas), BigInt(1160000));
      assert.deepEqual(
        cuotas.map((q) => q.numero),
        Array.from({ length: plazo }, (_, i) => i + 1)
      );
      assert.ok(cuotas.every((q) => aCentavos(q.importe) > BigInt(0)));
    }
  });

  test("la diferencia de centavos va en la última cuota", () => {
    assert.deepEqual(
      generarMensualidades("1000.00", 3, "2027-01-10").map((q) => q.importe),
      ["333.33", "333.33", "333.34"]
    );
    // 100.00 / 6 = 16.66 × 5 + 16.70
    assert.deepEqual(
      generarMensualidades("100.00", 6, "2027-01-10").map((q) => q.importe),
      ["16.66", "16.66", "16.66", "16.66", "16.66", "16.70"]
    );
    // 11,600 / 18 = 644.44 × 17 + 644.52
    const c18 = generarMensualidades("11600.00", 18, "2027-01-10");
    assert.deepEqual([c18[0].importe, c18[16].importe, c18[17].importe], ["644.44", "644.44", "644.52"]);
    // División exacta: todas iguales.
    assert.ok(generarMensualidades("2400.00", 24, "2027-01-10").every((q) => q.importe === "100.00"));
    // Mínimo posible: un centavo por cuota.
    assert.ok(generarMensualidades("0.24", 24, "2027-01-10").every((q) => q.importe === "0.01"));
  });

  test("no genera importes cero, plazos no permitidos ni fechas inválidas", () => {
    assert.throws(() => generarMensualidades("0.05", 6, "2027-01-10"), GeneracionMensualidadesError);
    assert.throws(() => generarMensualidades("0.23", 24, "2027-01-10"), /no alcanza para 24 mensualidades/);
    assert.throws(() => generarMensualidades("1000.00", 4, "2027-01-10"), /3, 6, 12, 18 o 24/);
    assert.throws(() => generarMensualidades("1000.00", 3, ""), /primer vencimiento/);
    assert.throws(() => generarMensualidades("1000.00", 3, "2027-02-30"), /primer vencimiento/);
    assert.throws(() => generarMensualidades("1000.00", 24, "2099-06-15"), /rango de fechas/);
  });
});

describe("Mensualidades: vencimientos", () => {
  test("mismo día cada mes y cambio de año", () => {
    assert.deepEqual(fechas("300.00", 3, "2026-11-15"), ["2026-11-15", "2026-12-15", "2027-01-15"]);
    const f24 = fechas("2400.00", 24, "2027-03-05");
    assert.deepEqual([f24[0], f24[11], f24[23]], ["2027-03-05", "2028-02-05", "2029-02-05"]);
  });

  test("día 31: usa el último día del mes corto y recupera el 31", () => {
    assert.deepEqual(fechas("600.00", 6, "2027-01-31"), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31", "2027-06-30"]);
    // Año bisiesto: 29 de febrero.
    assert.deepEqual(fechas("300.00", 3, "2028-01-31"), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  });

  test("día 30 y día 29: febrero usa su último día y después se recupera el día original", () => {
    assert.deepEqual(fechas("300.00", 3, "2027-01-30"), ["2027-01-30", "2027-02-28", "2027-03-30"]);
    assert.deepEqual(fechas("300.00", 3, "2027-01-29"), ["2027-01-29", "2027-02-28", "2027-03-29"]);
    assert.deepEqual(fechas("300.00", 3, "2028-01-29"), ["2028-01-29", "2028-02-29", "2028-03-29"]);
    // Primer vencimiento el 29 de febrero bisiesto: el 29 se conserva en los meses siguientes.
    assert.deepEqual(fechas("1200.00", 12, "2028-02-29").slice(0, 3), ["2028-02-29", "2028-03-29", "2028-04-29"]);
    assert.equal(fechas("1200.00", 12, "2028-02-29")[11], "2029-01-29");
    assert.equal(sumarMeses("2028-02-29", 12), "2029-02-28");
  });
});

describe("Impuesto de compras: «Sin IVA» / «IVA 16 %»", () => {
  test("«Sin IVA» no agrega impuesto y se reporta aparte de tasa 0 % y exento", () => {
    const t = calcularTotalesCotizacion([
      { importe: "1000.00", tratamientoImpuesto: "SIN_IVA", tasaIva: null },
      { importe: "500.00", tratamientoImpuesto: "GRAVADO", tasaIva: "16.00" },
    ]);
    assert.deepEqual([t.subtotal, t.iva, t.total, t.baseSinIva, t.baseTasaCero, t.baseExenta], ["1500.00", "80.00", "1580.00", "1000.00", "0.00", "0.00"]);
  });

  test("opciones vigentes y etiquetas de históricos", () => {
    assert.equal(esImpuestoCompraVigente("SIN_IVA", null), true);
    assert.equal(esImpuestoCompraVigente("GRAVADO", "16.00"), true);
    assert.equal(esImpuestoCompraVigente("GRAVADO", "8.00"), false);
    assert.equal(esImpuestoCompraVigente("TASA_CERO", null), false);
    assert.equal(esImpuestoCompraVigente("EXENTO", null), false);
    assert.deepEqual(
      [etiquetaImpuestoCompra("SIN_IVA", null), etiquetaImpuestoCompra("GRAVADO", "16.00"), etiquetaImpuestoCompra("GRAVADO", "8.00"), etiquetaImpuestoCompra("TASA_CERO", null), etiquetaImpuestoCompra("EXENTO", null)],
      ["Sin IVA", "IVA 16 %", "IVA 8 %", "Tasa 0 %", "Exento"]
    );
  });
});

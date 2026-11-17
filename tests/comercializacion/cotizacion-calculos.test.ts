import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  aMilesimas,
  calcularImportePartida,
  calcularTotalesCotizacion,
  formatearCantidad,
  normalizarCantidad,
} from "@/lib/comercializacion/importes";
import { dateAFecha, fechaADate, hoyNegocio, normalizarFecha } from "@/lib/comercializacion/fechas";
import { validarDatosCotizacion } from "@/lib/server/comercializacion/cotizaciones";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";

// B2 — cálculos de cotización: cantidades fraccionarias exactas, redondeo
// por partida, IVA agrupado por tasa y diferencia Tasa 0 % / Exento.

describe("normalizarCantidad", () => {
  const validas: [string, string][] = [
    ["2.5", "2.500"],
    ["0.125", "0.125"],
    ["12.75", "12.750"],
    ["1,500.25", "1500.250"],
    ["3", "3.000"],
    ["99999999999.999", "99999999999.999"],
  ];
  for (const [e, s] of validas) test(`${e} → ${s} (sin redondear a entero)`, () => assert.equal(normalizarCantidad(e), s));

  for (const e of ["0", "0.000", "-1", "1.2345", "abc", "", "1e2", "100000000000.000"]) {
    test(`rechaza ${JSON.stringify(e)}`, () => assert.equal(normalizarCantidad(e), null));
  }
  test("formato de pantalla sin ceros sobrantes", () => {
    assert.equal(formatearCantidad("2.500"), "2.5");
    assert.equal(formatearCantidad("1500.000"), "1,500");
    assert.equal(formatearCantidad("0.125"), "0.125");
  });
});

describe("calcularImportePartida (exacto, half-up una sola vez)", () => {
  const casos: [string, string, string, string][] = [
    ["2.375", "123.45", "293.19", "2.375 m × $123.45 = 293.19375"],
    ["0.125", "2840.00", "355.00", "0.125 ton × $2,840.00 = 355"],
    ["1.005", "1.00", "1.01", "1.005 → half-up"],
    ["3.333", "0.15", "0.50", "0.49995 → 0.50"],
    ["3.333", "0.10", "0.33", "0.3333 → 0.33"],
    ["7.000", "245.50", "1718.50", "entero"],
    ["0.001", "0.01", "0.00", "mínimo representable"],
  ];
  for (const [cant, precio, esperado, nombre] of casos) {
    test(nombre, () => assert.equal(calcularImportePartida(cant, precio), esperado));
  }
  test("no pierde precisión donde float sí la pierde", () => {
    // En float: 1.15 * 3 = 3.4499999999999997 → redondeo ingenuo da 3.45 o 3.44 según el método.
    assert.equal(calcularImportePartida("3.000", "1.15"), "3.45");
    assert.equal(aMilesimas("0.001") * BigInt(1), BigInt(1));
  });
  test("excede la capacidad de la columna → error", () => {
    assert.throws(() => calcularImportePartida("99999999999.999", "999999999999.99"), RangeError);
  });
});

describe("calcularTotalesCotizacion — impuestos mixtos", () => {
  test("gravado 16 %, gravado 8 %, tasa 0 y exento", () => {
    const t = calcularTotalesCotizacion([
      { importe: "1000.00", tratamientoImpuesto: "GRAVADO", tasaIva: "16.00" },
      { importe: "293.19", tratamientoImpuesto: "GRAVADO", tasaIva: "16.00" },
      { importe: "500.00", tratamientoImpuesto: "GRAVADO", tasaIva: "8.00" },
      { importe: "250.00", tratamientoImpuesto: "TASA_CERO", tasaIva: null },
      { importe: "120.00", tratamientoImpuesto: "EXENTO", tasaIva: null },
    ]);
    assert.equal(t.subtotal, "2163.19");
    assert.deepEqual(t.gravado, [
      { tasa: "16.00", base: "1293.19", iva: "206.91" }, // 206.9104
      { tasa: "8.00", base: "500.00", iva: "40.00" },
    ]);
    assert.equal(t.baseTasaCero, "250.00");
    assert.equal(t.baseExenta, "120.00");
    assert.equal(t.iva, "246.91");
    assert.equal(t.total, "2410.10");
  });

  test("IVA por tasa se redondea sobre la base agrupada, no por partida", () => {
    // Tres partidas de $0.03 al 16 %: por partida daría 3 × 0.00 = 0.00;
    // agrupado: 0.09 × 16 % = 0.0144 → 0.01.
    const t = calcularTotalesCotizacion(
      Array.from({ length: 3 }, () => ({ importe: "0.03", tratamientoImpuesto: "GRAVADO" as const, tasaIva: "16.00" }))
    );
    assert.equal(t.iva, "0.01");
    assert.equal(t.total, "0.10");
  });

  test("Tasa 0 % y Exento no se mezclan aunque ambos den IVA $0", () => {
    const t = calcularTotalesCotizacion([
      { importe: "100.00", tratamientoImpuesto: "TASA_CERO", tasaIva: null },
      { importe: "40.00", tratamientoImpuesto: "EXENTO", tasaIva: null },
    ]);
    assert.equal(t.baseTasaCero, "100.00");
    assert.equal(t.baseExenta, "40.00");
    assert.equal(t.iva, "0.00");
    assert.deepEqual(t.gravado, []);
  });

  test("sin partidas: todo en cero", () => {
    assert.deepEqual(calcularTotalesCotizacion([]), {
      subtotal: "0.00",
      gravado: [],
      baseTasaCero: "0.00",
      baseExenta: "0.00",
      iva: "0.00",
      total: "0.00",
    });
  });
});

describe("Fechas de calendario", () => {
  test("hoy en Monterrey no se recorre por UTC", () => {
    // 2026-11-17 03:00 UTC = 2026-11-16 21:00 en Monterrey (UTC-6).
    assert.equal(hoyNegocio(new Date(Date.UTC(2026, 10, 17, 3, 0))), "2026-11-16");
    assert.equal(hoyNegocio(new Date(Date.UTC(2026, 10, 17, 7, 0))), "2026-11-17");
  });
  test("ida y vuelta a DATE sin desplazamiento", () => {
    assert.equal(dateAFecha(fechaADate("2026-12-31")), "2026-12-31");
  });
  test("rechaza fechas imposibles o con hora", () => {
    for (const f of ["2026-02-30", "2026-13-01", "16/11/2026", "2026-11-16T00:00:00Z", ""]) assert.equal(normalizarFecha(f), null, f);
    assert.equal(normalizarFecha("2028-02-29"), "2028-02-29");
  });
});

describe("validarDatosCotizacion", () => {
  const base = {
    clienteId: "c1",
    obraId: null,
    descripcion: "Material para losa",
    fecha: "2026-11-16",
    vigenciaHasta: "2026-11-30",
    condiciones: "",
    observaciones: "",
    partidas: [{ id: null, productoId: "p1", cantidad: "2.5" }],
  };

  test("normaliza y conserva cantidades fraccionarias", () => {
    const d = validarDatosCotizacion(base);
    assert.equal(d.partidas[0].cantidad, "2.500");
    assert.equal(d.partidas[0].precioUnitario, null);
    assert.equal(d.condiciones, null);
  });

  const rechazadas: [string, Record<string, unknown>][] = [
    ["importe enviado en partida", { partidas: [{ productoId: "p1", cantidad: "1", importe: "1.00" }] }],
    ["tasa enviada en partida", { partidas: [{ productoId: "p1", cantidad: "1", tasaIva: "0" }] }],
    ["tratamiento enviado en partida", { partidas: [{ productoId: "p1", cantidad: "1", tratamientoImpuesto: "EXENTO" }] }],
    ["descuento enviado en partida", { partidas: [{ productoId: "p1", cantidad: "1", descuento: "10" }] }],
    ["total enviado en el encabezado", { total: "1.00" }],
    ["creador enviado en el encabezado", { creadoPorId: "otro" }],
    ["empresa enviada en el encabezado", { empresaId: "otra" }],
    ["cantidad 0", { partidas: [{ productoId: "p1", cantidad: "0" }] }],
    ["cantidad con 4 decimales", { partidas: [{ productoId: "p1", cantidad: "1.2345" }] }],
    ["precio con 3 decimales", { partidas: [{ productoId: "p1", cantidad: "1", precioUnitario: "1.005" }] }],
    ["vigencia anterior a la fecha", { vigenciaHasta: "2026-11-01" }],
    ["fecha inválida", { fecha: "2026-02-30" }],
    ["obra sin cliente", { clienteId: null, obraId: "o1" }],
    ["partida repetida", { partidas: [{ id: "x", productoId: "p1", cantidad: "1" }, { id: "x", productoId: "p1", cantidad: "2" }] }],
  ];
  for (const [nombre, cambio] of rechazadas) {
    test(`rechaza: ${nombre}`, () => assert.throws(() => validarDatosCotizacion({ ...base, ...cambio })));
  }

  test("mínimos del borrador: cliente, descripción o una partida", () => {
    assert.throws(
      () => validarDatosCotizacion({ ...base, clienteId: null, descripcion: "", partidas: [] }),
      ValidacionError
    );
    assert.doesNotThrow(() => validarDatosCotizacion({ ...base, clienteId: null, descripcion: "", vigenciaHasta: null }));
    assert.doesNotThrow(() => validarDatosCotizacion({ ...base, descripcion: "", partidas: [] }));
  });
});

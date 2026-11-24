import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  calcularImportePartida,
  calcularTotalesCotizacion,
  impuestoDePartidaVenta,
  impuestoVentaEquivalente,
  type ImpuestoVenta,
} from "@/lib/comercializacion/importes";
import { filasImpuestoVenta } from "@/lib/comercializacion/totales-venta";
import { leerDocumentoEmitido } from "@/lib/comercializacion/documento";

// IVA por cotización (nov-2026): una opción para toda la venta.

function totales(opcion: ImpuestoVenta, lineas: [cantidad: string, precio: string][]) {
  const imp = impuestoDePartidaVenta(opcion);
  return calcularTotalesCotizacion(lineas.map(([c, p]) => ({ importe: calcularImportePartida(c, p), ...imp })));
}

describe("IVA por cotización — importes", () => {
  test("2 piezas de $120.00 con IVA: 240.00 + 38.40 = 278.40", () => {
    const t = totales("CON_IVA", [["2.000", "120.00"]]);
    assert.equal(t.subtotal, "240.00");
    assert.equal(t.iva, "38.40");
    assert.equal(t.total, "278.40");
  });
  test("las mismas piezas sin IVA: total = subtotal = 240.00", () => {
    const t = totales("SIN_IVA", [["2.000", "120.00"]]);
    assert.equal(t.subtotal, "240.00");
    assert.equal(t.iva, "0.00");
    assert.equal(t.total, "240.00");
    // «Sin IVA» no se reporta como tasa 0 % ni como exento.
    assert.equal(t.baseTasaCero, "0.00");
    assert.equal(t.baseExenta, "0.00");
    assert.equal(t.baseSinIva, "240.00");
  });
  test("precio ajustado a $110.00: subtotal 220.00, con IVA 255.20", () => {
    const t = totales("CON_IVA", [["2.000", "110.00"]]);
    assert.equal(t.subtotal, "220.00");
    assert.equal(t.iva, "35.20");
    assert.equal(t.total, "255.20");
  });
  test("el IVA se redondea una vez sobre el subtotal, half-up al centavo", () => {
    // Tres partidas de $0.03: por partida el IVA sería 0.0048 → 0.00 cada
    // una; sobre el subtotal ($0.09 × 16 % = 0.0144) da $0.01.
    const t = totales("CON_IVA", [["1.000", "0.03"], ["1.000", "0.03"], ["1.000", "0.03"]]);
    assert.equal(t.subtotal, "0.09");
    assert.equal(t.iva, "0.01");
    assert.equal(t.total, "0.10");
    // 10.03 × 16 % = 1.6048 → 1.60 ; 10.05 × 16 % = 1.608 → 1.61
    assert.equal(totales("CON_IVA", [["1.000", "10.03"]]).iva, "1.60");
    assert.equal(totales("CON_IVA", [["1.000", "10.05"]]).iva, "1.61");
    // Cantidad con decimales: 2.375 × 123.45 = 293.19375 → 293.19 ; IVA 46.9104 → 46.91
    const d = totales("CON_IVA", [["2.375", "123.45"]]);
    assert.equal(d.subtotal, "293.19");
    assert.equal(d.iva, "46.91");
    assert.equal(d.total, "340.10");
  });
  test("varias partidas: al alternar la opción solo cambian IVA y total", () => {
    const lineas: [string, string][] = [["2.000", "120.00"], ["3.500", "45.10"], ["1.000", "999.99"]];
    const con = totales("CON_IVA", lineas);
    const sin = totales("SIN_IVA", lineas);
    assert.equal(con.subtotal, sin.subtotal);
    assert.equal(con.subtotal, "1397.84"); // 240 + 157.85 + 999.99
    assert.equal(con.iva, "223.65"); // 1397.84 × 16 % = 223.6544
    assert.equal(con.total, "1621.49");
    assert.equal(sin.total, "1397.84");
  });
});

describe("IVA por cotización — opción equivalente de un documento anterior", () => {
  const g16 = { tratamientoImpuesto: "GRAVADO" as const, tasaIva: "16.00" };
  test("todo gravado al 16 % → Con IVA", () => {
    assert.equal(impuestoVentaEquivalente([g16, g16]), "CON_IVA");
  });
  test("tasa 0 %, exento, otra tasa o mezclas no se representan", () => {
    assert.equal(impuestoVentaEquivalente([{ tratamientoImpuesto: "TASA_CERO", tasaIva: null }]), null);
    assert.equal(impuestoVentaEquivalente([{ tratamientoImpuesto: "EXENTO", tasaIva: null }]), null);
    assert.equal(impuestoVentaEquivalente([{ tratamientoImpuesto: "GRAVADO", tasaIva: "8.00" }]), null);
    assert.equal(impuestoVentaEquivalente([g16, { tratamientoImpuesto: "EXENTO", tasaIva: null }]), null);
  });
  test("todo «Sin IVA» → Sin IVA", () => {
    assert.equal(impuestoVentaEquivalente([{ tratamientoImpuesto: "SIN_IVA", tasaIva: null }]), "SIN_IVA");
  });
});

describe("IVA por cotización — presentación y documento", () => {
  test("filas del resumen por opción", () => {
    const con = totales("CON_IVA", [["2.000", "120.00"]]);
    assert.deepEqual(filasImpuestoVenta(con, "CON_IVA"), [{ etiqueta: "IVA 16 %", valor: "38.40" }]);
    const sin = totales("SIN_IVA", [["2.000", "120.00"]]);
    assert.deepEqual(filasImpuestoVenta(sin, "SIN_IVA"), [{ etiqueta: "IVA (Sin IVA)", valor: "0.00" }]);
  });
  test("documento anterior: conserva el desglose por tasa, tasa 0 % y exento", () => {
    const t = calcularTotalesCotizacion([
      { importe: "100.00", tratamientoImpuesto: "GRAVADO", tasaIva: "16.00" },
      { importe: "50.00", tratamientoImpuesto: "TASA_CERO", tasaIva: null },
      { importe: "20.00", tratamientoImpuesto: "EXENTO", tasaIva: null },
    ]);
    const filas = filasImpuestoVenta(t, null).map((f) => f.etiqueta);
    assert.deepEqual(filas, ["IVA 16 % sobre $100.00", "Base tasa 0 % (IVA $0.00)", "Base exenta (sin IVA)"]);
  });
  test("una copia emitida antes de la opción de IVA se sigue leyendo igual", () => {
    const anterior = {
      version: 1,
      folio: "COT-000001",
      fecha: "2026-11-20",
      vigenciaHasta: "2026-11-30",
      descripcion: "Material",
      condiciones: null,
      observaciones: null,
      empresa: { nombre: "E", razonSocial: null, logoRef: null },
      cliente: { nombre: "C", contacto: null, telefono: null },
      obra: { nombre: "O", ubicacion: null },
      vendedor: { nombre: "V" },
      partidas: [
        { codigo: "A", descripcion: "a", unidad: "pza", cantidad: "1.000", precioUnitario: "100.00", importe: "100.00", tratamientoImpuesto: "EXENTO", tasaIva: null },
      ],
      totales: { subtotal: "100.00", gravado: [], baseTasaCero: "0.00", baseExenta: "100.00", iva: "0.00", total: "100.00" },
    };
    const d = leerDocumentoEmitido(anterior);
    assert.equal(d.impuestoVenta, null);
    assert.equal(d.totales.baseSinIva, "0.00");
    assert.equal(d.totales.total, "100.00");
    assert.equal(d.partidas[0].tratamientoImpuesto, "EXENTO");
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cantidadDesdeMonto, cantidadInicial, montoAEnviar, montoInicial, precioDeCaptura } from "@/lib/control-de-obra/captura-avance";

const c = (x: Record<string, number | null> = {}) => ({ estaSemana: 0, montoEstaSemana: null, precioUnitarioContratista: 280, precioUnitarioContratistaContratado: null, ...x });

describe("Captura de avance por monto", () => {
  test("precio: contratado; sin contratista, el del concepto; sin precio o en cero, ninguno", () => {
    assert.equal(precioDeCaptura(c({ precioUnitarioContratistaContratado: 300 })), 300);
    assert.equal(precioDeCaptura(c()), 280);
    assert.equal(precioDeCaptura(c({ precioUnitarioContratista: null })), null);
    assert.equal(precioDeCaptura(c({ precioUnitarioContratista: 0 })), null);
  });
  test("el monto calcula la cantidad a 3 decimales", () => {
    assert.equal(cantidadDesdeMonto("10000", 280), "35.714");
    assert.equal(cantidadDesdeMonto("476280", 280), "1701");
  });
  test("cantidades de mil o más se recargan sin coma", () => {
    assert.equal(cantidadInicial(c({ estaSemana: 1701.5 })), "1701.5");
    assert.equal(montoInicial(c({ estaSemana: 1701.5 })), "476420");
  });
  test("monto a enviar: el tecleado exacto; nada si solo es derivado o la fila no cambió", () => {
    assert.equal(montoAEnviar(c(), "35.714", "10000"), "10000");
    assert.equal(montoAEnviar(c(), "2", "560"), "");
    assert.equal(montoAEnviar(c({ estaSemana: 2, precioUnitarioContratistaContratado: 280 }), "2", "560"), "");
    assert.equal(montoAEnviar(c({ precioUnitarioContratistaContratado: 280 }), "2", "560"), "560");
    assert.equal(montoAEnviar(c({ estaSemana: 2, montoEstaSemana: 560 }), "2", "560"), "560");
  });
});

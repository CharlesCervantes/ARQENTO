import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BYTES_POR_CARGA, MB_POR_CARGA, formatearTamano, revisarCarga } from "@/lib/comercializacion/cargas";

// Límite por carga de Comercialización (una solicitud): 4 MB de archivos,
// por debajo de los 4.5 MB por solicitud de Vercel Functions.

const MB = 1024 * 1024;

describe("Límite por carga", () => {
  test("4 MB, con margen bajo los 4.5 MB por solicitud de la plataforma", () => {
    assert.equal(MB_POR_CARGA, 4);
    assert.ok(MAX_BYTES_POR_CARGA + 256 * 1024 < 4.5 * 1000 * 1000, "queda margen para campos y envoltura multipart");
  });
  test("individual y suma", () => {
    assert.equal(revisarCarga([4 * MB]), null);
    assert.match(revisarCarga([4 * MB + 1])!, /Un archivo pesa 4\.0 MB; el máximo por carga es 4 MB/);
    assert.equal(revisarCarga([2 * MB, 2 * MB]), null);
    assert.match(revisarCarga([2 * MB, 2 * MB + 1])!, /Los archivos suman 4\.0 MB; el máximo por carga es 4 MB/);
    assert.equal(revisarCarga([]), null);
  });
  test("cantidad de archivos", () => {
    assert.match(revisarCarga([1, 1, 1], { maxArchivos: 2 })!, /máximo 2 archivos por carga \(elegiste 3\)/);
    assert.equal(revisarCarga([1, 1], { maxArchivos: 2 }), null);
  });
  test("formato legible", () => {
    assert.equal(formatearTamano(850 * 1024), "850 KB");
    assert.equal(formatearTamano(3.25 * MB), "3.3 MB");
    assert.equal(formatearTamano(10), "1 KB");
  });
});

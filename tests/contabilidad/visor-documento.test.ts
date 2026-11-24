import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  NIVELES_ZOOM,
  ajustarAlContenedor,
  desplazamientoAnclado,
  vistaDeDocumento,
  zoomAnterior,
  zoomSiguiente,
} from "@/lib/documentos/visor";

describe("visor de documentos: tipo de vista", () => {
  test("fotografías JPG/PNG se muestran como imagen y el PDF en su visor", () => {
    assert.equal(vistaDeDocumento("image/jpeg"), "IMAGEN");
    assert.equal(vistaDeDocumento("image/jpg"), "IMAGEN");
    assert.equal(vistaDeDocumento(" IMAGE/PNG "), "IMAGEN");
    assert.equal(vistaDeDocumento("application/pdf"), "PDF");
  });

  test("cualquier otro tipo no se incrusta (solo abrir en otra pestaña)", () => {
    for (const tipo of ["image/svg+xml", "text/html", "image/webp", "application/octet-stream", ""]) {
      assert.equal(vistaDeDocumento(tipo), "OTRO", tipo);
    }
  });
});

describe("visor de documentos: ajuste a la pantalla", () => {
  test("una foto vertical grande cabe completa conservando su proporción", () => {
    const r = ajustarAlContenedor({ ancho: 3000, alto: 4000 }, { ancho: 900, alto: 600 });
    assert.deepEqual(r, { ancho: 450, alto: 600 });
  });

  test("una imagen panorámica se limita por el ancho", () => {
    const r = ajustarAlContenedor({ ancho: 4000, alto: 1000 }, { ancho: 800, alto: 600 });
    assert.deepEqual(r, { ancho: 800, alto: 200 });
  });

  test("una imagen pequeña no se agranda al abrirla", () => {
    assert.deepEqual(ajustarAlContenedor({ ancho: 300, alto: 200 }, { ancho: 900, alto: 600 }), { ancho: 300, alto: 200 });
  });

  test("medidas inválidas o contenedor sin espacio no producen tamaños negativos", () => {
    assert.deepEqual(ajustarAlContenedor({ ancho: 0, alto: 100 }, { ancho: 900, alto: 600 }), { ancho: 0, alto: 0 });
    assert.deepEqual(ajustarAlContenedor({ ancho: 100, alto: 100 }, { ancho: -32, alto: 600 }), { ancho: 0, alto: 0 });
  });
});

describe("visor de documentos: ampliación", () => {
  test("los niveles avanzan y retroceden sin salirse de los límites", () => {
    assert.equal(zoomSiguiente(1), 1.5);
    assert.equal(zoomSiguiente(3), 4);
    assert.equal(zoomSiguiente(4), 4);
    assert.equal(zoomAnterior(4), 3);
    assert.equal(zoomAnterior(1.5), 1);
    assert.equal(zoomAnterior(1), 1);
    assert.equal(NIVELES_ZOOM[0], 1, "el nivel mínimo es la imagen completa");
  });

  test("al ampliar, el punto bajo el cursor se queda en su lugar", () => {
    // Imagen de 400 px, sin desplazar, cursor a 100 px del borde de la imagen
    // (desfase 16 px del relleno): fracción 0.25. Al doble (800 px) el mismo
    // punto queda en 216 px de contenido; para verlo en 116 px se desplaza 100.
    const fraccion = (0 + 116 - 16) / 400;
    assert.equal(fraccion, 0.25);
    assert.equal(desplazamientoAnclado({ fraccion, tamanoNuevo: 800, desfaseNuevo: 16, puntoEnPantalla: 116 }), 100);
  });

  test("nunca propone un desplazamiento negativo", () => {
    assert.equal(desplazamientoAnclado({ fraccion: 0, tamanoNuevo: 800, desfaseNuevo: 16, puntoEnPantalla: 300 }), 0);
  });
});

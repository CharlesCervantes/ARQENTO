import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { extraerMensajesEntrantes } from "@/lib/whatsapp/payload";
import { MAX_BYTES_POR_DOCUMENTO, contextoDePieDeFoto, nombreSeguroDeArchivo, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";
import { ArchivoRechazadoError, validarArchivoRecibido } from "@/lib/server/contabilidad/documentos/recepcion";
import { DescargaMediaError, descargarMediaDeMeta, urlDeMetaValida } from "@/lib/server/whatsapp/cliente";
import { diagnosticoDeError } from "@/lib/server/whatsapp/proceso";
import { RESPUESTAS_WHATSAPP } from "@/lib/whatsapp/respuestas";
import { jpgFicticio, pdfFicticio, pngFicticio, simularMeta } from "../helpers/archivos-ficticios";

// Fase 2A WhatsApp — piezas de la recepción de comprobantes que no necesitan
// base de datos: lectura del webhook, tipo real del archivo, nombre y pie de
// foto seguros, validación y descarga desde Meta (simulado, sin red). El
// flujo completo con PostgreSQL y almacenamiento está en
// tests/integracion/whatsapp-archivos.test.ts. Archivos y token ficticios.

const TOKEN = "token-ficticio-de-prueba-NO-REAL";

function webhook(mensaje: Record<string, unknown>) {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn-1" }, messages: [mensaje] } }] }] };
}
const base = { id: "wamid.a", from: "5213312345678", timestamp: "1760000000" };

describe("Webhook — fotografías y documentos", () => {
  test("Fotografía: identificador del archivo y pie de foto; nunca la URL ni la huella de Meta", () => {
    const [m] = extraerMensajesEntrantes(
      webhook({ ...base, type: "image", image: { id: "1234567890", mime_type: "image/jpeg", sha256: "huella-de-meta", caption: "Obra Villas, lo pague yo", url: "https://ejemplo.invalid/x" } }),
      "pn-1"
    );
    assert.equal(m.tipo, "image");
    assert.deepEqual(m.archivo, { mediaId: "1234567890", nombre: null });
    assert.equal(m.texto, "Obra Villas, lo pague yo");
    assert.ok(!JSON.stringify(m).includes("ejemplo.invalid") && !JSON.stringify(m).includes("huella-de-meta"));
  });

  test("Documento: conserva el nombre original (se sanea después) y acota el pie de foto", () => {
    const [m] = extraerMensajesEntrantes(
      webhook({ ...base, type: "document", document: { id: "media.9", mime_type: "application/pdf", filename: "Factura 2026.pdf", caption: "x".repeat(500) } }),
      "pn-1"
    );
    assert.deepEqual(m.archivo, { mediaId: "media.9", nombre: "Factura 2026.pdf" });
    assert.equal(m.texto?.length, 200);
  });

  test("Sin identificador válido, o en audio, video o sticker, no hay archivo que recibir", () => {
    const sinArchivo = [
      { ...base, type: "image", image: {} },
      { ...base, type: "image", image: { id: "../../etc/passwd" } },
      { ...base, type: "document", document: { id: 42 } },
      { ...base, type: "audio", audio: { id: "111" } },
      { ...base, type: "video", video: { id: "111" } },
      { ...base, type: "sticker", sticker: { id: "111" } },
      { ...base, type: "text", text: { body: "hola" }, image: { id: "111" } },
    ];
    for (const mensaje of sinArchivo) assert.equal(extraerMensajesEntrantes(webhook(mensaje), "pn-1")[0].archivo, null, JSON.stringify(mensaje));
  });
});

describe("Tipo real, nombre y pie de foto", () => {
  test("El tipo se decide por el contenido: PDF, JPG y PNG; lo demás no se reconoce", () => {
    assert.equal(tipoArchivoDetectado(pdfFicticio()), "application/pdf");
    assert.equal(tipoArchivoDetectado(jpgFicticio("a")), "image/jpeg");
    assert.equal(tipoArchivoDetectado(pngFicticio("a")), "image/png");
    for (const otro of [Buffer.from("MZ ejecutable ficticio"), Buffer.from("PK zip ficticio"), Buffer.from("<html>"), Buffer.from("GIF89a"), Buffer.from("RIFFxxxxWEBP"), Buffer.alloc(0), Buffer.from("%PDF")]) {
      assert.equal(tipoArchivoDetectado(otro), null);
    }
  });

  test("Nombre seguro: sin rutas, espacios ni acentos; extensión del tipo REAL; genérico si no hay nombre", () => {
    const fecha = new Date(Date.UTC(2026, 10, 10, 15, 4, 5));
    assert.equal(nombreSeguroDeArchivo("Factura Ñandú 2026.pdf", "application/pdf", fecha), "Factura-Nandu-2026.pdf");
    assert.equal(nombreSeguroDeArchivo("../../etc/passwd", "application/pdf", fecha), "etc-passwd.pdf");
    assert.equal(nombreSeguroDeArchivo("C:\\Users\\x\\ticket.exe", "image/jpeg", fecha), "C-Users-x-ticket.jpg");
    assert.equal(nombreSeguroDeArchivo("foto.png", "image/jpeg", fecha), "foto.jpg", "la extensión es la del contenido, no la declarada");
    assert.equal(nombreSeguroDeArchivo(null, "image/jpeg", fecha), "comprobante-20261110-150405.jpg");
    assert.equal(nombreSeguroDeArchivo("///", "image/png", fecha), "comprobante-20261110-150405.png");
    const largo = nombreSeguroDeArchivo("a".repeat(300), "application/pdf", fecha);
    assert.equal(largo.length, 64);
    for (const n of [largo, nombreSeguroDeArchivo("x/../y", "application/pdf", fecha)]) assert.match(n, /^[A-Za-z0-9_-]+\.(pdf|jpg|png)$/);
  });

  test("Pie de foto: una línea, sin caracteres de control, máximo 200 caracteres; vacío es nulo", () => {
    const control = String.fromCharCode(0, 7, 27, 127, 8203, 8232);
    assert.equal(contextoDePieDeFoto(`  Obra Villas${control}\n\tlo pagué   yo  `), "Obra Villas lo pagué yo");
    assert.equal(contextoDePieDeFoto("x".repeat(500))?.length, 200);
    for (const vacio of [null, undefined, "", "   ", "\n\t", control]) assert.equal(contextoDePieDeFoto(vacio), null);
  });
});

describe("Validación del archivo recibido", () => {
  const rechazo = async (bytes: Buffer, declarado: string | null) => {
    try {
      await validarArchivoRecibido(bytes, declarado);
    } catch (error) {
      assert.ok(error instanceof ArchivoRechazadoError, String(error));
      return error.motivo;
    }
    assert.fail("debió rechazarse");
  };

  test("Acepta fotografía y PDF válidos cuando el tipo declarado coincide con el real", async () => {
    assert.equal(await validarArchivoRecibido(jpgFicticio("a"), "image/jpeg"), "image/jpeg");
    assert.equal(await validarArchivoRecibido(pngFicticio("a"), "IMAGE/PNG; charset=binary"), "image/png");
    assert.equal(await validarArchivoRecibido(pdfFicticio("Ticket ficticio", 3), "application/pdf"), "application/pdf");
    assert.equal(await validarArchivoRecibido(pdfFicticio(), null), "application/pdf", "sin tipo declarado decide el contenido");
  });

  test("Tipo falsificado: lo declarado no coincide con el contenido", async () => {
    assert.equal(await rechazo(pdfFicticio(), "image/jpeg"), "CONTENIDO");
    assert.equal(await rechazo(jpgFicticio("a"), "application/pdf"), "CONTENIDO");
    assert.equal(await rechazo(pngFicticio("a"), "image/jpeg"), "CONTENIDO");
  });

  test("Contenido que no es fotografía ni PDF, aunque se declare como tal", async () => {
    assert.equal(await rechazo(Buffer.from("MZ ejecutable ficticio"), "application/pdf"), "TIPO");
    assert.equal(await rechazo(Buffer.from("<script>alert(1)</script>"), "image/jpeg"), "TIPO");
    assert.equal(await rechazo(Buffer.from("RIFFxxxxWEBPVP8 "), "image/webp"), "TIPO");
    assert.equal(await rechazo(Buffer.alloc(0), "image/jpeg"), "CONTENIDO");
  });

  test("Demasiado grande, PDF ilegible o con más de 20 páginas", async () => {
    assert.equal(await rechazo(Buffer.concat([jpgFicticio("a"), Buffer.alloc(MAX_BYTES_POR_DOCUMENTO)]), "image/jpeg"), "TAMANO");
    assert.equal(await rechazo(Buffer.from("%PDF-1.4 esto no es un PDF de verdad"), "application/pdf"), "CONTENIDO");
    assert.equal(await rechazo(pdfFicticio("Ticket", 21), "application/pdf"), "PAGINAS");
    assert.equal(await validarArchivoRecibido(pdfFicticio("Ticket", 20), "application/pdf"), "application/pdf");
  });

  test("El motivo del rechazo nunca incluye datos del archivo", async () => {
    try {
      await validarArchivoRecibido(Buffer.from("contenido secreto ficticio"), "image/jpeg");
      assert.fail("debió rechazarse");
    } catch (error) {
      assert.equal(diagnosticoDeError(error), "ArchivoRechazado:TIPO");
      assert.ok(!String((error as Error).message).includes("secreto"));
    }
  });
});

describe("Descarga desde Meta (simulada)", () => {
  let meta: ReturnType<typeof simularMeta>;
  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
    meta = simularMeta();
  });
  afterEach(() => {
    meta.restaurar();
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });
  const falla = async (mediaId = "m1", limite = 1000) => {
    try {
      await descargarMediaDeMeta(mediaId, limite);
    } catch (error) {
      assert.ok(error instanceof DescargaMediaError, String(error));
      return error;
    }
    assert.fail("la descarga debió fallar");
  };

  test("Descarga correcta: bytes exactos, tipo declarado y token solo en la cabecera", async () => {
    const bytes = jpgFicticio("descarga");
    meta.archivos.set("m1", { bytes, tipo: "image/jpeg" });
    const r = await descargarMediaDeMeta("m1", 1000);
    assert.deepEqual(r.bytes, bytes);
    assert.equal(r.tipoDeclarado, "image/jpeg");
    assert.equal(meta.consultas, 1);
    assert.equal(meta.descargas, 1);
    assert.ok(meta.urls.every((u) => !u.includes(TOKEN)), "el token nunca va en la URL");
    assert.deepEqual(meta.autorizaciones, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  test("Archivo que ya no existe en Meta (identificador caducado): definitivo, no se reintenta", async () => {
    const e = await falla("caducado");
    assert.equal(e.definitivo, true);
    assert.equal(e.motivo, "NO_DISPONIBLE");
    assert.equal(meta.descargas, 0);
    meta.archivos.set("m1", { bytes: jpgFicticio("a"), tipo: "image/jpeg" });
    meta.fallaDescarga = 404;
    assert.equal((await falla()).motivo, "NO_DISPONIBLE");
  });

  test("Token vencido, permisos, límite de Meta o caída: temporales (se reintenta)", async () => {
    meta.archivos.set("m1", { bytes: jpgFicticio("a"), tipo: "image/jpeg" });
    for (const [status, esperado] of [[401, "DescargaMedia:media401.190"], [403, "DescargaMedia:media403.1"], [429, "DescargaMedia:media429.1"], [500, "DescargaMedia:media500.1"]] as const) {
      meta.fallaConsulta = status;
      const e = await falla();
      assert.equal(e.definitivo, false, String(status));
      assert.equal(diagnosticoDeError(e), esperado);
    }
    meta.fallaConsulta = null;
    meta.fallaDescarga = 503;
    assert.equal((await falla()).definitivo, false);
  });

  test("Tamaño: se rechaza por lo que declara Meta SIN descargar, y también si la descarga excede el límite", async () => {
    meta.archivos.set("grande", { bytes: jpgFicticio("a"), tipo: "image/jpeg", tamanoDeclarado: 5000 });
    const declarado = await falla("grande", 1000);
    assert.equal(declarado.motivo, "TAMANO");
    assert.equal(declarado.definitivo, true);
    assert.equal(meta.descargas, 0, "no se descarga un archivo que ya se sabe demasiado grande");

    meta.archivos.set("mentiroso", { bytes: Buffer.concat([jpgFicticio("a"), Buffer.alloc(5000)]), tipo: "image/jpeg", tamanoDeclarado: 10 });
    assert.equal((await falla("mentiroso", 1000)).motivo, "TAMANO");
  });

  test("Lista estricta de destinos: solo HTTPS, sin puerto ni credenciales, hacia dominios de archivos de Meta", () => {
    for (const url of [
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&ext=2&hash=abc",
      "https://scontent.xx.fbcdn.net/v/archivo",
      "https://mmg.whatsapp.net/d/f/archivo",
      "https://LOOKASIDE.FBSBX.COM/x",
    ]) {
      assert.ok(urlDeMetaValida(url), url);
    }
    for (const url of [
      "http://lookaside.fbsbx.com/x",
      "https://lookaside.fbsbx.com:8443/x",
      "https://usuario:clave@lookaside.fbsbx.com/x",
      "https://lookaside.fbsbx.com@atacante.invalid/x",
      "https://fbsbx.com.atacante.invalid/x",
      "https://atacantefbsbx.com/x",
      "https://fbsbx.com/x",
      "https://graph.facebook.com/v21.0/me",
      "https://www.facebook.com/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://localhost/x",
      "https://lookaside.fbsbx.com.localhost/x",
      "ftp://lookaside.fbsbx.com/x",
      "file:///etc/passwd",
      "//lookaside.fbsbx.com/x",
      "no es una url",
      `https://lookaside.fbsbx.com/${"a".repeat(3000)}`,
      null,
      42,
    ]) {
      assert.equal(urlDeMetaValida(url), null, String(url));
    }
  });

  test("Redirecciones: solo se siguen hacia dominios de Meta, validando cada salto; nunca hacia otro destino", async () => {
    const bytes = jpgFicticio("redirigido");
    meta.archivos.set("m1", { bytes, tipo: "image/jpeg" });
    meta.redirecciones.push("https://scontent.xx.fbcdn.net/v/archivo?mid=m1");
    assert.deepEqual((await descargarMediaDeMeta("m1", 1000)).bytes, bytes);
    assert.equal(meta.descargas, 2);

    for (const destino of ["https://atacante.invalid/robo", "http://169.254.169.254/latest/meta-data", "https://127.0.0.1/interno", "/ruta-relativa"]) {
      meta.urls.length = 0;
      meta.redirecciones.length = 0;
      meta.redirecciones.push(destino);
      assert.equal(diagnosticoDeError(await falla()), "DescargaMedia:media-redireccion", destino);
      assert.ok(meta.urls.every((u) => /^https:\/\/(graph\.facebook\.com|lookaside\.fbsbx\.com)\//.test(u)), `nunca se pide ${destino}`);
    }

    // Demasiados saltos, aunque todos sean de Meta.
    meta.redirecciones.length = 0;
    for (let i = 0; i < 6; i++) meta.redirecciones.push("https://lookaside.fbsbx.com/otra?mid=m1");
    const e = await falla();
    assert.equal(diagnosticoDeError(e), "DescargaMedia:media-redireccion");
    assert.equal(e.definitivo, false);
  });

  test("La URL de descarga debe ser HTTPS de un dominio de Meta; el token no se envía a otro lugar", async () => {
    for (const url of ["https://atacante.invalid/archivo", "http://lookaside.fbsbx.com/archivo", "https://fbsbx.com.atacante.invalid/x", "https://lookaside.fbsbx.com:8443/x", "https://graph.facebook.com/x", "file:///etc/passwd", "no es una url"]) {
      meta.archivos.set("m1", { bytes: jpgFicticio("a"), tipo: "image/jpeg", url });
      const e = await falla();
      assert.equal(diagnosticoDeError(e), "DescargaMedia:media-url", url);
    }
    assert.equal(meta.descargas, 0);
  });

  test("Tiempo agotado y fallas de red se propagan como errores temporales", async () => {
    meta.archivos.set("m1", { bytes: jpgFicticio("a"), tipo: "image/jpeg" });
    meta.fallaConsulta = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    await assert.rejects(descargarMediaDeMeta("m1", 1000), { name: "TimeoutError" });
    meta.fallaConsulta = null;
    meta.fallaDescarga = new TypeError("fetch failed");
    await assert.rejects(descargarMediaDeMeta("m1", 1000), { name: "TypeError" });
  });

  test("Sin token de acceso no se intenta nada; un identificador extraño tampoco llega a Meta", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    assert.equal(diagnosticoDeError(await falla()), "DescargaMedia:sin-token");
    process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
    assert.equal((await falla("../../v21.0/otro")).definitivo, true);
    assert.equal(meta.consultas, 0);
  });

  test("Los diagnósticos nunca contienen el token, la URL ni el identificador del archivo", async () => {
    meta.archivos.set("identificador-privado-1", { bytes: jpgFicticio("a"), tipo: "image/jpeg" });
    meta.fallaConsulta = 401;
    const e = await falla("identificador-privado-1");
    for (const dato of [TOKEN, "identificador-privado-1", "graph.facebook.com", "lookaside"]) {
      assert.ok(!`${e.message} ${diagnosticoDeError(e)} ${JSON.stringify(e)}`.includes(dato), dato);
    }
  });
});

describe("Tipo declarado por WhatsApp frente al tipo real", () => {
  test("Las fotografías habituales de WhatsApp (JPEG) y sus variantes de tipo declarado se aceptan", async () => {
    // WhatsApp convierte las fotografías a JPEG; los archivos enviados "como
    // documento" pueden llegar con un tipo genérico.
    for (const declarado of ["image/jpeg", "image/jpg", "IMAGE/JPEG", "image/jpeg; charset=binary", "application/octet-stream", "", null]) {
      assert.equal(await validarArchivoRecibido(jpgFicticio("habitual"), declarado), "image/jpeg", String(declarado));
    }
    assert.equal(await validarArchivoRecibido(pdfFicticio(), "application/octet-stream"), "application/pdf");
    assert.equal(await validarArchivoRecibido(pngFicticio("captura"), "image/png"), "image/png");
    // JPEG con cabecera EXIF (cámara del teléfono), no solo JFIF.
    const exif = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from("Exif-ficticio")]);
    assert.equal(await validarArchivoRecibido(exif, "image/jpeg"), "image/jpeg");
  });

  test("Un tipo declarado que contradice al real, o un formato no admitido (HEIC, WebP), se rechaza con motivo", async () => {
    const motivo = async (bytes: Buffer, declarado: string | null) => {
      try {
        await validarArchivoRecibido(bytes, declarado);
      } catch (error) {
        assert.ok(error instanceof ArchivoRechazadoError);
        return error.motivo;
      }
      return "ACEPTADO";
    };
    assert.equal(await motivo(jpgFicticio("a"), "application/pdf"), "CONTENIDO");
    assert.equal(await motivo(pdfFicticio(), "image/jpeg"), "CONTENIDO");
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic-ficticio")]);
    const webp = Buffer.from("RIFF0000WEBPVP8 ficticio");
    assert.equal(await motivo(heic, "image/heic"), "TIPO");
    assert.equal(await motivo(webp, "image/webp"), "TIPO");
    assert.equal(await motivo(heic, "application/octet-stream"), "TIPO", "un tipo genérico no abre la puerta a otros formatos");
  });
});

describe("Respuestas de recepción", () => {
  test("Son genéricas: sin importes, proveedores, obras ni datos del archivo", () => {
    const textos = [RESPUESTAS_WHATSAPP.archivoRecibido, RESPUESTAS_WHATSAPP.archivoNoPermitido, RESPUESTAS_WHATSAPP.archivoNoDisponible, RESPUESTAS_WHATSAPP.archivoDetenido, RESPUESTAS_WHATSAPP.archivoLimitado, RESPUESTAS_WHATSAPP.eligeEmpresaYReenvia];
    for (const t of textos) assert.ok(!/\$|importe|total|proveedor|duplicad|ya exist|repetid/i.test(t), t);
  });
});

import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { MAX_ARCHIVOS_POR_VENTANA, procesarMensajesPendientes, recibirWebhookWhatsapp } from "@/lib/server/whatsapp/mensajes";
import { buscarDocumentoPorHash, calcularHashArchivo } from "@/lib/server/inteligencia/trabajos";
import { depurarRegistrosWhatsapp } from "@/lib/server/whatsapp/retencion";
import { obtenerEstadoMensajesMaster, reprocesarMensajesPendientesMaster } from "@/lib/server/master/whatsapp";
import {
  MENSAJE_BANDEJA_NO_DISPONIBLE,
  descartarDocumentoRecibido,
  obtenerBandejaRecibidos,
  obtenerRefDocumentoRecibido,
  reanudarRecepcionesRecibidas,
} from "@/lib/server/contabilidad/documentos/recibidos-whatsapp";
import { obtenerDocumentosDelLote, subirDocumentosEgreso } from "@/lib/server/contabilidad/documentos/documento-egreso";
import { RESPUESTAS_WHATSAPP } from "@/lib/whatsapp/respuestas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { jpgFicticio, pdfFicticio, pngFicticio, simularMeta } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin, adminAjeno, baseLimpiaConDatos, conFallaSimulada, repetir, sinInterbloqueos, supervisor } from "./apoyo/base";

// Fase 2A WhatsApp — recepción de comprobantes contra PostgreSQL REAL (base
// local dedicada y protegida), almacenamiento R2 SIMULADO en memoria y Meta
// SIMULADO (sin red). ARQENTO IA permanece APAGADA en todas las pruebas.
// Archivos, teléfonos y token completamente ficticios.

const APP_SECRET = "secreto-webhook-de-prueba";
const WA = "5213312345678";
const TEL = "+523312345678";
const OTRO_WA = "5215598765432";
const OTRO_TEL = "+525598765432";
const DESTINO = "523312345678";

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const master: UsuarioSesion = { ...usuarioDePrueba({ rol: "MASTER" }), id: "usuario-master-arch" };
const supervisorAjeno: UsuarioSesion = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA_AJENA }), id: "usuario-supervisor-ajeno" };

let meta: ReturnType<typeof simularMeta>;
let secuencia = 0;

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  process.env.WHATSAPP_ACCESS_TOKEN = "token-ficticio-de-prueba-NO-REAL";
  meta = simularMeta();
  await db.usuario.createMany({
    data: [
      { id: master.id, nombre: "Master Prueba", email: "master-arch@prueba.invalid", passwordHash: "sin-acceso", rol: "MASTER", empresaId: null },
      { id: supervisorAjeno.id, nombre: "Supervisor Ajeno", email: "sup-arch@ajena.invalid", passwordHash: "sin-acceso", rol: "SUPERVISOR", empresaId: EMPRESA_AJENA },
    ],
  });
  // WhatsApp habilitado; ARQENTO IA se queda en su valor por omisión: APAGADA.
  await db.empresa.updateMany({ where: { id: { in: [EMPRESA, EMPRESA_AJENA] } }, data: { whatsappHabilitado: true } });
  await db.usuario.updateMany({ where: { id: { in: [admin.id, supervisor.id, supervisorAjeno.id, adminAjeno.id] } }, data: { whatsappAutorizado: true } });
});
afterEach(() => {
  meta.restaurar();
  delete process.env.WHATSAPP_ACCESS_TOKEN;
});

const vincular = (u: UsuarioSesion, wa = WA, telefono = TEL) =>
  db.vinculoWhatsapp.create({ data: { empresaId: u.empresaId!, usuarioId: u.id, telefonoE164: telefono, waId: wa, estado: "VERIFICADO", verificadoEn: new Date() } });

type Mensaje = Record<string, unknown> & { id: string };
const foto = (mediaId: string, pie?: string, from = WA): Mensaje => ({
  id: `wamid.arch.${++secuencia}`,
  from,
  timestamp: "1760000000",
  type: "image",
  image: { id: mediaId, mime_type: "image/jpeg", ...(pie ? { caption: pie } : {}) },
});
const pdf = (mediaId: string, nombre: string, pie?: string, from = WA): Mensaje => ({
  id: `wamid.arch.${++secuencia}`,
  from,
  timestamp: "1760000000",
  type: "document",
  document: { id: mediaId, mime_type: "application/pdf", filename: nombre, ...(pie ? { caption: pie } : {}) },
});
function enviar(...mensajes: Record<string, unknown>[]) {
  const cuerpo = Buffer.from(
    JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-number-id-simulado" }, messages: mensajes } }] }] })
  );
  return recibirWebhookWhatsapp(cuerpo, `sha256=${createHmac("sha256", APP_SECRET).update(cuerpo).digest("hex")}`);
}
const mensajeDe = (m: Mensaje) => db.mensajeWhatsapp.findUniqueOrThrow({ where: { wamid: m.id } });
const documentos = (empresaId = EMPRESA) => db.documentoEgreso.findMany({ where: { empresaId }, orderBy: { createdAt: "asc" } });
const textosEnviados = () => meta.enviados.map((e) => e.texto);

// Recibe una fotografía ficticia válida y devuelve su documento.
async function recibirFoto(semilla: string, pie?: string) {
  const bytes = jpgFicticio(semilla);
  meta.archivos.set(`media-${semilla}`, { bytes, tipo: "image/jpeg" });
  const mensaje = foto(`media-${semilla}`, pie);
  assert.equal((await enviar(mensaje)).status, 200);
  const registro = await mensajeDe(mensaje);
  assert.equal(registro.resultado, "DOCUMENTO_RECIBIDO");
  return { bytes, mensaje, documento: await db.documentoEgreso.findUniqueOrThrow({ where: { id: registro.documentoEgresoId! } }) };
}

describe("Recepción — fotografía y PDF válidos", () => {
  test("Fotografía de un Supervisor: documento PENDIENTE de su Empresa, archivo guardado, confirmación genérica y nada de IA", async () => {
    await vincular(supervisor);
    const { bytes, mensaje, documento } = await recibirFoto("ticket-1", "  Obra Prueba,\n lo pagué yo  ");

    assert.equal(documento.empresaId, EMPRESA);
    assert.equal(documento.origen, "WHATSAPP");
    assert.equal(documento.estatus, "PENDIENTE");
    assert.equal(documento.subidoPorId, supervisor.id, "el remitente queda como origen del documento");
    assert.equal(documento.tipoMime, "image/jpeg");
    assert.equal(documento.contextoUsuario, "Obra Prueba, lo pagué yo", "pie de foto saneado como contexto");
    assert.equal(documento.egresoId, null);
    assert.equal(documento.trabajoProcesamientoId, null);
    // La clave del objeto depende solo del mensaje (sin nombre de archivo).
    assert.equal(documento.archivoRef, `contabilidad/${EMPRESA}/documentos-egreso/whatsapp/${(await mensajeDe(mensaje)).id}`);
    assert.match(documento.archivoNombre, /^comprobante-\d{8}-\d{6}\.jpg$/);
    assert.equal((await mensajeDe(mensaje)).intentos, 1);
    assert.deepEqual(almacenamiento.get(documento.archivoRef), bytes, "el archivo guardado es exactamente el recibido");
    assert.equal(almacenamiento.size, 1);

    const registro = await mensajeDe(mensaje);
    assert.equal(registro.estadoProceso, "PROCESADO");
    assert.equal(registro.etapaArchivo, "GUARDADO");
    assert.equal(registro.respondido, true);
    assert.equal(registro.remitentePendiente, null);
    assert.equal(registro.textoPendiente, null);
    assert.equal(registro.archivoPendiente, null, "no se conserva el identificador del archivo en Meta");
    assert.deepEqual(meta.enviados, [{ to: DESTINO, tipo: "text", texto: RESPUESTAS_WHATSAPP.archivoRecibido }]);

    // ARQENTO IA apagada: ni trabajos, ni consumo, ni gastos, ni egresos.
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).inteligenciaHabilitada, false);
    assert.equal(await db.trabajoProcesamientoDocumento.count(), 0);
    assert.equal(await db.registroConsumoInteligencia.count(), 0);
    assert.equal(await db.gastoObra.count(), 0);
    assert.equal(await db.egreso.count(), 0);

    // Auditoría mínima, sin nombre de archivo, pie de foto ni teléfono.
    const auditoria = await db.registroAuditoria.findMany({ where: { entidad: "DocumentoEgreso", entidadId: documento.id } });
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].usuarioId, supervisor.id);
    assert.deepEqual(auditoria[0].valorNuevo, { origen: "WHATSAPP", tipoMime: "image/jpeg", estatus: "PENDIENTE" });
  });

  test("PDF con nombre peligroso: se guarda con nombre saneado y nunca fuera de la carpeta de la Empresa", async () => {
    await vincular(admin);
    const bytes = pdfFicticio("Factura ficticia", 2);
    meta.archivos.set("media-pdf", { bytes, tipo: "application/pdf" });
    const mensaje = pdf("media-pdf", "../../Factura Ñandú 2026.PDF", "Material de la obra");
    assert.equal((await enviar(mensaje)).status, 200);
    const [documento] = await documentos();
    assert.equal(documento.tipoMime, "application/pdf");
    assert.equal(documento.archivoNombre, "Factura-Nandu-2026.pdf");
    assert.ok(documento.archivoRef.startsWith(`contabilidad/${EMPRESA}/documentos-egreso/whatsapp/`));
    assert.ok(!documento.archivoRef.includes(".."));
    assert.deepEqual(almacenamiento.get(documento.archivoRef), bytes);
    assert.equal(documento.subidoPorId, admin.id);
  });

  test("PNG enviado como fotografía y declarado correctamente también se recibe", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-png", { bytes: pngFicticio("a"), tipo: "image/png" });
    await enviar(foto("media-png"));
    assert.equal((await documentos())[0].tipoMime, "image/png");
  });
});

describe("Recepción — archivos que no se aceptan", () => {
  test("Tipo falsificado, contenido inválido o demasiado grande: error controlado, sin documento ni archivo", async () => {
    await vincular(supervisor);
    const casos: [string, { bytes: Buffer; tipo: string; tamanoDeclarado?: number }, string][] = [
      ["PDF declarado como fotografía", { bytes: pdfFicticio(), tipo: "image/jpeg" }, "ARCHIVO_RECHAZADO_CONTENIDO"],
      ["ejecutable declarado como fotografía", { bytes: Buffer.from("MZ ejecutable ficticio"), tipo: "image/jpeg" }, "ARCHIVO_RECHAZADO_TIPO"],
      ["PDF ilegible", { bytes: Buffer.from("%PDF-1.4 esto no es un PDF de verdad"), tipo: "application/pdf" }, "ARCHIVO_RECHAZADO_CONTENIDO"],
      ["PDF de 21 páginas", { bytes: pdfFicticio("Largo", 21), tipo: "application/pdf" }, "ARCHIVO_RECHAZADO_PAGINAS"],
      ["tamaño declarado mayor a 10 MB", { bytes: jpgFicticio("g"), tipo: "image/jpeg", tamanoDeclarado: 11 * 1024 * 1024 }, "ARCHIVO_RECHAZADO_TAMANO"],
      ["tamaño real mayor a 10 MB con declaración falsa", { bytes: Buffer.concat([jpgFicticio("g"), Buffer.alloc(10 * 1024 * 1024)]), tipo: "image/jpeg", tamanoDeclarado: 100 }, "ARCHIVO_RECHAZADO_TAMANO"],
    ];
    for (const [nombre, archivo, esperado] of casos) {
      meta.enviados.length = 0;
      meta.archivos.set("media-malo", archivo);
      const mensaje = foto("media-malo");
      assert.equal((await enviar(mensaje)).status, 200, `${nombre}: no se pide reentrega de un archivo inaceptable`);
      const registro = await mensajeDe(mensaje);
      assert.equal(registro.resultado, esperado, nombre);
      assert.equal(registro.estadoProceso, "PROCESADO", nombre);
      assert.equal(registro.etapaArchivo, "RECHAZADO", nombre);
      assert.equal(registro.archivoPendiente, null, nombre);
      assert.equal(registro.remitentePendiente, null, nombre);
      assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoNoPermitido], nombre);
    }
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.equal(almacenamiento.size, 0, "nada inválido llega al almacenamiento");
  });

  test("Archivo que ya no existe en Meta (identificador caducado): se pide reenviarlo", async () => {
    await vincular(supervisor);
    const mensaje = foto("media-caducado");
    assert.equal((await enviar(mensaje)).status, 200);
    assert.equal((await mensajeDe(mensaje)).resultado, "ARCHIVO_RECHAZADO_NO_DISPONIBLE");
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoNoDisponible]);
    assert.equal(await db.documentoEgreso.count(), 0);
  });
});

describe("Recepción — quién puede enviar", () => {
  test("Número sin vínculo, usuario desactivado, sin autorización o Empresa con WhatsApp apagado: no se descarga ni se guarda", async () => {
    meta.archivos.set("media-x", { bytes: jpgFicticio("x"), tipo: "image/jpeg" });
    const intentar = async (motivo: string) => {
      const mensaje = foto("media-x");
      assert.equal((await enviar(mensaje)).status, 200, motivo);
      const registro = await mensajeDe(mensaje);
      assert.equal(registro.resultado, "NO_VINCULADO", motivo);
      assert.equal(registro.etapaArchivo, null, motivo);
      assert.equal(registro.archivoPendiente, null, motivo);
    };
    await intentar("sin vínculo");
    await vincular(supervisor);
    await db.usuario.update({ where: { id: supervisor.id }, data: { activo: false } });
    await intentar("usuario desactivado");
    await db.usuario.update({ where: { id: supervisor.id }, data: { activo: true, whatsappAutorizado: false } });
    await intentar("usuario sin autorización");
    await db.usuario.update({ where: { id: supervisor.id }, data: { whatsappAutorizado: true } });
    await db.empresa.update({ where: { id: EMPRESA }, data: { whatsappHabilitado: false } });
    await intentar("WhatsApp apagado para la Empresa");
    await db.empresa.update({ where: { id: EMPRESA }, data: { whatsappHabilitado: true } });
    await db.vinculoWhatsapp.updateMany({ where: { usuarioId: supervisor.id }, data: { estado: "REVOCADO" } });
    await intentar("vínculo revocado");

    assert.equal(meta.consultas, 0, "nunca se consultó a Meta por el archivo");
    assert.equal(meta.descargas, 0);
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.equal(almacenamiento.size, 0);
  });

  test("Autorización retirada MIENTRAS se recibía: no se guarda el documento y el archivo se elimina", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-r", { bytes: jpgFicticio("r"), tipo: "image/jpeg" });
    const mensaje = foto("media-r");
    // Falla al guardar el documento: la recepción queda en ALMACENADO.
    assert.equal((await conFallaSimulada("documentos_egreso", "NEW.origen = 'WHATSAPP'", () => enviar(mensaje))).status, 500);
    assert.equal((await mensajeDe(mensaje)).etapaArchivo, "ALMACENADO");
    assert.equal(almacenamiento.size, 1);

    await db.usuario.update({ where: { id: supervisor.id }, data: { whatsappAutorizado: false } });
    assert.equal((await enviar(mensaje)).status, 200);
    const registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "ARCHIVO_NO_AUTORIZADO");
    assert.equal(registro.etapaArchivo, "RECHAZADO");
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.equal(almacenamiento.size, 0, "el archivo de quien ya no está autorizado no se conserva");
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.numeroNoVinculado]);
  });
});

describe("Recepción — Empresa correcta", () => {
  test("Número vinculado a dos Empresas sin selección: pide elegir y reenviar; nunca asigna por omisión", async () => {
    await vincular(supervisor);
    const vinculoAjeno = await vincular(supervisorAjeno);
    meta.archivos.set("media-m", { bytes: jpgFicticio("m"), tipo: "image/jpeg" });

    const primero = foto("media-m");
    assert.equal((await enviar(primero)).status, 200);
    const registro = await mensajeDe(primero);
    assert.equal(registro.resultado, "EMPRESA_REQUERIDA");
    assert.equal(registro.empresaId, null);
    assert.equal(registro.archivoPendiente, null);
    assert.equal(meta.consultas, 0, "no se descarga un archivo sin Empresa");
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.equal(meta.enviados.at(-1)!.tipo, "interactive");
    assert.equal(meta.enviados.at(-1)!.texto, RESPUESTAS_WHATSAPP.eligeEmpresaYReenvia);

    // Elige la Empresa ajena y reenvía: queda SOLO en la elegida.
    await enviar({ id: `wamid.arch.${++secuencia}`, from: WA, timestamp: "1760000000", type: "interactive", interactive: { type: "list_reply", list_reply: { id: vinculoAjeno.id } } });
    assert.equal((await enviar(foto("media-m"))).status, 200);
    assert.equal((await documentos(EMPRESA)).length, 0);
    const [documento] = await documentos(EMPRESA_AJENA);
    assert.equal(documento.subidoPorId, supervisorAjeno.id);
    assert.ok(documento.archivoRef.startsWith(`contabilidad/${EMPRESA_AJENA}/`));
    assert.equal(meta.enviados.at(-1)!.texto, RESPUESTAS_WHATSAPP.archivoRecibido);
  });

  test("El mismo archivo en dos Empresas son documentos y objetos independientes", async () => {
    await vincular(supervisor);
    await vincular(supervisorAjeno, OTRO_WA, OTRO_TEL);
    meta.archivos.set("media-c", { bytes: jpgFicticio("compartido"), tipo: "image/jpeg" });
    await enviar(foto("media-c"));
    await enviar(foto("media-c", undefined, OTRO_WA));
    const [propio] = await documentos(EMPRESA);
    const [ajeno] = await documentos(EMPRESA_AJENA);
    assert.notEqual(propio.id, ajeno.id);
    assert.equal(propio.hashArchivo, ajeno.hashArchivo);
    assert.notEqual(propio.archivoRef, ajeno.archivoRef);
    assert.equal(almacenamiento.size, 2);
  });
});

describe("Recepción — duplicados y concurrencia", () => {
  test("El mismo archivo enviado dos veces: un solo documento y la MISMA confirmación genérica", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("repetido", "Primera nota");
    const segundo = foto("media-repetido", "Segunda nota");
    // El repetido se detecta por su huella ANTES de subirlo: no hay segunda copia.
    let subidas = 0;
    const guardarOriginal = almacenamiento.set;
    almacenamiento.set = function (...args) {
      subidas++;
      return guardarOriginal.apply(this, args);
    };
    try {
      assert.equal((await enviar(segundo)).status, 200);
    } finally {
      almacenamiento.set = guardarOriginal;
    }
    assert.equal(subidas, 0, "un archivo repetido no se vuelve a subir");

    assert.equal(await db.documentoEgreso.count(), 1);
    assert.equal((await mensajeDe(segundo)).documentoEgresoId, documento.id);
    assert.equal((await mensajeDe(segundo)).resultado, "DOCUMENTO_REPETIDO", "la recepción repetida queda identificada internamente");
    assert.equal((await mensajeDe(segundo)).etapaArchivo, "GUARDADO");
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoRecibido, RESPUESTAS_WHATSAPP.archivoRecibido], "no se revela que ya existía");
    assert.equal(almacenamiento.size, 1, "la copia repetida no se conserva");
    assert.ok(almacenamiento.has(documento.archivoRef));
    const actual = await db.documentoEgreso.findUniqueOrThrow({ where: { id: documento.id } });
    assert.equal(actual.contextoUsuario, "Primera nota", "el contexto original no se pisa");
    assert.equal((actual.contextosAdicionales as { texto: string }[]).at(-1)?.texto, "Segunda nota");
    const auditoria = await db.registroAuditoria.findMany({ where: { entidad: "DocumentoEgreso", entidadId: documento.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(auditoria.map((a) => a.accion), ["CREAR", "EDITAR"]);
    assert.deepEqual(auditoria[1].valorNuevo, { recepcionRepetida: "WHATSAPP" });
    assert.equal(auditoria[1].usuarioId, supervisor.id);
  });

  test("Documento ya subido por la web que llega por WhatsApp: no se duplica, la recepción queda identificada y no se analiza nada", async () => {
    await vincular(supervisor);
    const bytes = jpgFicticio("web-primero");
    const web = await db.documentoEgreso.create({
      data: { empresaId: EMPRESA, archivoRef: "pruebas/web-primero.jpg", archivoNombre: "web-primero.jpg", tipoMime: "image/jpeg", hashArchivo: calcularHashArchivo(bytes), loteId: "lote-web", subidoPorId: admin.id },
    });
    meta.archivos.set("media-web", { bytes, tipo: "image/jpeg" });
    const mensaje = foto("media-web");
    assert.equal((await enviar(mensaje)).status, 200);

    assert.equal(await db.documentoEgreso.count(), 1, "sin documento financiero duplicado");
    const registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "DOCUMENTO_REPETIDO");
    assert.equal(registro.documentoEgresoId, web.id);
    assert.equal(registro.usuarioId, supervisor.id);
    assert.equal(registro.empresaId, EMPRESA);
    const actual = await db.documentoEgreso.findUniqueOrThrow({ where: { id: web.id } });
    assert.equal(actual.origen, "WEB");
    assert.equal(actual.loteId, "lote-web");
    assert.equal(actual.archivoRef, "pruebas/web-primero.jpg");
    assert.equal(almacenamiento.size, 0, "no queda ninguna copia en el almacenamiento");
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "DocumentoEgreso", entidadId: web.id, accion: "EDITAR", usuarioId: supervisor.id } }), 1);
    assert.equal(await db.trabajoProcesamientoDocumento.count(), 0, "recibir un repetido tampoco crea análisis");
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoRecibido]);
  });

  test("Un documento DESCARTADO en la web que llega por WhatsApp no se reutiliza: es un documento nuevo y visible", async () => {
    await vincular(supervisor);
    const bytes = jpgFicticio("web-descartado");
    await db.documentoEgreso.create({
      data: { empresaId: EMPRESA, archivoRef: "pruebas/web-descartado.jpg", archivoNombre: "x.jpg", tipoMime: "image/jpeg", hashArchivo: calcularHashArchivo(bytes), loteId: "lote-web", subidoPorId: admin.id, estatus: "DESCARTADO" },
    });
    meta.archivos.set("media-wd", { bytes, tipo: "image/jpeg" });
    const mensaje = foto("media-wd");
    assert.equal((await enviar(mensaje)).status, 200);
    assert.equal((await mensajeDe(mensaje)).resultado, "DOCUMENTO_RECIBIDO");
    const bandeja = await obtenerBandejaRecibidos(admin);
    assert.equal(bandeja!.documentos.length, 1);
    assert.equal(almacenamiento.size, 1);
  });

  test("Dos mensajes simultáneos con el mismo archivo crean UN documento", async () => {
    await vincular(supervisor);
    await repetir(5, async (vuelta) => {
      almacenamiento.clear();
      meta.archivos.set(`media-sim-${vuelta}`, { bytes: jpgFicticio(`simultaneo-${vuelta}`), tipo: "image/jpeg" });
      const a = foto(`media-sim-${vuelta}`);
      const b = foto(`media-sim-${vuelta}`);
      const r = await Promise.allSettled([enviar(a), enviar(b)]);
      sinInterbloqueos(r);
      assert.deepEqual(r.map((x) => (x.status === "fulfilled" ? x.value.status : x.status)), [200, 200]);
      const ids = [(await mensajeDe(a)).documentoEgresoId, (await mensajeDe(b)).documentoEgresoId];
      assert.ok(ids[0] && ids[0] === ids[1], "los dos mensajes apuntan al mismo documento");
      const documento = await db.documentoEgreso.findUniqueOrThrow({ where: { id: ids[0]! } });
      assert.equal(await db.documentoEgreso.count({ where: { empresaId: EMPRESA, hashArchivo: documento.hashArchivo } }), 1);
      assert.deepEqual([...almacenamiento.keys()], [documento.archivoRef], "solo queda el objeto del documento");
    });
  });

  test("El MISMO mensaje entregado dos veces a la vez: un documento, un objeto y una sola confirmación", async () => {
    await vincular(supervisor);
    await repetir(5, async (vuelta) => {
      almacenamiento.clear();
      meta.enviados.length = 0;
      meta.archivos.set(`media-re-${vuelta}`, { bytes: jpgFicticio(`reentrega-${vuelta}`), tipo: "image/jpeg" });
      const mensaje = foto(`media-re-${vuelta}`);
      const r = await Promise.allSettled([enviar(mensaje), enviar(mensaje)]);
      sinInterbloqueos(r);
      assert.ok(r.every((x) => x.status === "fulfilled"), JSON.stringify(r));
      const registro = await mensajeDe(mensaje);
      assert.equal(registro.resultado, "DOCUMENTO_RECIBIDO");
      assert.equal(await db.documentoEgreso.count({ where: { id: registro.documentoEgresoId! } }), 1);
      assert.equal(almacenamiento.size, 1);
      assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoRecibido]);
      // Una reentrega posterior no hace nada.
      assert.equal((await enviar(mensaje)).status, 200);
      assert.equal(meta.enviados.length, 1);
    });
    assert.equal(await db.documentoEgreso.count(), 5);
  });
});

describe("Recepción — interrupciones y recuperación", () => {
  test("Falla la descarga de Meta: nada se confirma, se pide la reentrega y esta completa la recepción una sola vez", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-d", { bytes: jpgFicticio("descarga"), tipo: "image/jpeg" });
    const mensaje = foto("media-d");
    meta.fallaDescarga = 503;
    assert.equal((await enviar(mensaje)).status, 500);
    let registro = await mensajeDe(mensaje);
    assert.equal(registro.estadoProceso, "ERROR");
    assert.equal(registro.etapaArchivo, "ASIGNADO");
    assert.equal(registro.intentos, 1);
    assert.equal(registro.error, "proceso:DescargaMedia:archivo503");
    assert.equal(registro.empresaId, EMPRESA);
    assert.equal(meta.enviados.length, 0, "no se confirma un archivo que no se guardó");
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.equal(almacenamiento.size, 0);
    assert.deepEqual(await obtenerEstadoMensajesMaster(master), { pendientes: 0, reintentables: 1, detenidos: 0, definitivos: 0 });

    meta.fallaDescarga = null;
    assert.equal((await enviar(mensaje)).status, 200);
    registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "DOCUMENTO_RECIBIDO");
    assert.equal(registro.error, null);
    assert.equal(await db.documentoEgreso.count(), 1);
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoRecibido]);
  });

  test("Falla la subida al almacenamiento: se reintenta sin dejar documento a medias", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-s", { bytes: jpgFicticio("subida"), tipo: "image/jpeg" });
    const mensaje = foto("media-s");
    const guardarOriginal = almacenamiento.set;
    almacenamiento.set = () => {
      throw new Error("Almacenamiento no disponible (simulado)");
    };
    try {
      assert.equal((await enviar(mensaje)).status, 500);
    } finally {
      almacenamiento.set = guardarOriginal;
    }
    assert.equal((await mensajeDe(mensaje)).etapaArchivo, "ASIGNADO");
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.equal(meta.enviados.length, 0);

    assert.equal((await enviar(mensaje)).status, 200);
    assert.equal(await db.documentoEgreso.count(), 1);
    assert.equal(almacenamiento.size, 1);
  });

  test("Falla al guardar el documento: la etapa ALMACENADO queda persistida y la reanudación ya no depende de Meta", async () => {
    await vincular(supervisor);
    const bytes = jpgFicticio("guardado");
    meta.archivos.set("media-g", { bytes, tipo: "image/jpeg" });
    const mensaje = foto("media-g", "Nota ficticia");
    assert.equal((await conFallaSimulada("documentos_egreso", "NEW.origen = 'WHATSAPP'", () => enviar(mensaje))).status, 500);

    const registro = await mensajeDe(mensaje);
    assert.equal(registro.etapaArchivo, "ALMACENADO");
    assert.equal(registro.estadoProceso, "ERROR");
    const pendiente = registro.archivoPendiente as { ref: string; hash: string; tipoMime: string };
    assert.deepEqual(almacenamiento.get(pendiente.ref), bytes, "el archivo ya está a salvo en el almacenamiento");
    assert.equal(await db.documentoEgreso.count(), 0, "la transacción se revirtió completa");
    assert.equal(meta.enviados.length, 0);

    // El identificador de Meta caduca: la reanudación no lo necesita.
    meta.archivos.clear();
    const consultasAntes = meta.consultas;
    assert.equal((await enviar(mensaje)).status, 200);
    assert.equal(meta.consultas, consultasAntes, "no se volvió a pedir el archivo a Meta");
    const [documento] = await documentos();
    assert.equal(documento.archivoRef, pendiente.ref);
    assert.equal(documento.hashArchivo, pendiente.hash);
    assert.equal(documento.contextoUsuario, "Nota ficticia");
    assert.equal(almacenamiento.size, 1, "sin objetos huérfanos");
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoRecibido]);
  });

  test("Si el objeto almacenado desapareció, la reanudación lo vuelve a descargar en la MISMA clave", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-h", { bytes: jpgFicticio("huerfano"), tipo: "image/jpeg" });
    const mensaje = foto("media-h");
    await conFallaSimulada("documentos_egreso", "NEW.origen = 'WHATSAPP'", () => enviar(mensaje));
    const { ref } = (await mensajeDe(mensaje)).archivoPendiente as { ref: string };
    almacenamiento.clear();
    assert.equal((await enviar(mensaje)).status, 200);
    assert.deepEqual([...almacenamiento.keys()], [ref]);
    assert.equal((await documentos())[0].archivoRef, ref);
  });

  test("Tres intentos fallidos con el archivo ya almacenado: queda DETENIDO, nada se pierde y un reintento explícito lo guarda", async () => {
    await vincular(supervisor);
    const bytes = jpgFicticio("fallido");
    meta.archivos.set("media-f", { bytes, tipo: "image/jpeg" });
    const mensaje = foto("media-f", "Nota ficticia");
    await conFallaSimulada("documentos_egreso", "NEW.origen = 'WHATSAPP'", async () => {
      assert.equal((await enviar(mensaje)).status, 500);
      assert.equal((await enviar(mensaje)).status, 500);
      assert.equal((await enviar(mensaje)).status, 200, "al tercer intento Meta deja de reentregar");
      // Ni la reentrega tardía ni la recuperación automática lo vuelven a intentar.
      assert.equal((await enviar(mensaje)).status, 200);
      assert.equal((await procesarMensajesPendientes()).revisados, 0);
    });
    let registro = await mensajeDe(mensaje);
    assert.equal(registro.estadoProceso, "ERROR");
    assert.equal(registro.resultado, "ARCHIVO_DETENIDO");
    assert.equal(registro.etapaArchivo, "ALMACENADO", "no se marca como rechazado: sigue siendo recuperable");
    assert.equal(registro.intentos, 3);
    assert.match(registro.error ?? "", /^proceso:/, "se conserva el diagnóstico de la falla");
    assert.ok(registro.remitentePendiente, "se conserva lo necesario para avisar al remitente al guardarlo");
    const pendiente = registro.archivoPendiente as { ref: string; mediaId: string };
    assert.equal(pendiente.mediaId, "media-f");
    assert.deepEqual(almacenamiento.get(pendiente.ref), bytes, "el archivo almacenado NO se elimina");
    assert.equal(await db.documentoEgreso.count(), 0);
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoDetenido], "se avisa una sola vez, sin decir que se guardó");
    assert.deepEqual(await obtenerEstadoMensajesMaster(master), { pendientes: 0, reintentables: 0, detenidos: 1, definitivos: 0 });

    // Identificable en la bandeja de SU Empresa (y solo en ella); abrirla no procesa nada.
    const consultas = meta.consultas;
    const bandeja = await obtenerBandejaRecibidos(admin);
    assert.deepEqual(bandeja!.recepciones.map((r) => ({ ...r, recibidoEn: "x" })), [
      { id: registro.id, recibidoEn: "x", enviadoPor: "Supervisor Prueba", estado: "DETENIDA", almacenado: true },
    ]);
    assert.deepEqual((await obtenerBandejaRecibidos(adminAjeno))!.recepciones, []);
    assert.equal((await mensajeDe(mensaje)).intentos, 3, "abrir la bandeja no reintenta nada");
    assert.equal(meta.consultas, consultas);

    // Otra Empresa y el Supervisor no pueden reintentarla.
    assert.deepEqual(await reanudarRecepcionesRecibidas(adminAjeno), { revisadas: 0, guardadas: 0, pendientes: 0 });
    await assert.rejects(reanudarRecepcionesRecibidas(supervisor), /permiso/i);
    assert.equal(await db.documentoEgreso.count(), 0);

    // Reintento explícito: ya no necesita a Meta (el identificador pudo caducar).
    meta.archivos.clear();
    assert.deepEqual(await reanudarRecepcionesRecibidas(admin), { revisadas: 1, guardadas: 1, pendientes: 0 });
    registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "DOCUMENTO_RECIBIDO");
    assert.equal(registro.etapaArchivo, "GUARDADO");
    assert.equal(registro.remitentePendiente, null);
    assert.equal(registro.archivoPendiente, null);
    const [documento] = await documentos();
    assert.equal(documento.archivoRef, pendiente.ref);
    assert.equal(documento.contextoUsuario, "Nota ficticia");
    assert.equal(almacenamiento.size, 1);
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoDetenido, RESPUESTAS_WHATSAPP.archivoRecibido]);
    assert.deepEqual(await obtenerEstadoMensajesMaster(master), { pendientes: 0, reintentables: 0, detenidos: 0, definitivos: 0 });
  });

  test("Token de Meta vencido: tres descargas fallidas dejan el comprobante DETENIDO (con su identificador) y Master lo recupera", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-t", { bytes: jpgFicticio("token"), tipo: "image/jpeg" });
    const mensaje = foto("media-t");
    meta.fallaConsulta = 401;
    meta.fallaEnvio = 401;
    assert.equal((await enviar(mensaje)).status, 500);
    assert.equal((await enviar(mensaje)).status, 500);
    assert.equal((await enviar(mensaje)).status, 200);
    let registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "ARCHIVO_DETENIDO");
    assert.equal(registro.etapaArchivo, "ASIGNADO");
    assert.equal(registro.error, "proceso:DescargaMedia:media401.190", "el aviso fallido no borra el diagnóstico");
    assert.equal((registro.archivoPendiente as { mediaId: string }).mediaId, "media-t");
    assert.equal(registro.respondido, false);

    // Con el token renovado, Master lo reprocesa (incluye los detenidos).
    meta.fallaConsulta = null;
    meta.fallaEnvio = null;
    const resumen = await reprocesarMensajesPendientesMaster(master);
    assert.deepEqual(resumen, { revisados: 1, procesados: 1, reintentables: 0, definitivos: 0, detenidos: 0, omitidos: 0 });
    registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "DOCUMENTO_RECIBIDO");
    assert.equal(await db.documentoEgreso.count(), 1);
  });

  test("Ejecución cortada por la plataforma: el intento se cuenta al empezar y, al agotarse, deja de consumir cada webhook", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-k", { bytes: jpgFicticio("cortada"), tipo: "image/jpeg" });
    const mensaje = foto("media-k");
    // Primer intento fallido: el intento queda contado desde que empieza.
    meta.fallaConsulta = 500;
    await enviar(mensaje);
    assert.equal((await mensajeDe(mensaje)).intentos, 1);
    meta.fallaConsulta = null;
    // Una ejecución cortada no alcanza a registrar su error: tras tres, el
    // mensaje queda PENDIENTE (sin error) con los tres intentos ya contados.
    await db.mensajeWhatsapp.update({ where: { wamid: mensaje.id }, data: { estadoProceso: "PENDIENTE", error: null, intentos: 3, createdAt: new Date(Date.now() - 120_000) } });

    const consultas = meta.consultas;
    assert.equal((await enviar(mensaje)).status, 200, "la reentrega ya no lo procesa");
    assert.equal((await procesarMensajesPendientes()).revisados, 0, "la recuperación automática tampoco");
    assert.equal(meta.consultas, consultas);
    assert.deepEqual(await obtenerEstadoMensajesMaster(master), { pendientes: 0, reintentables: 0, detenidos: 1, definitivos: 0 });
    assert.equal((await obtenerBandejaRecibidos(admin))!.recepciones[0].estado, "DETENIDA");

    assert.deepEqual(await reanudarRecepcionesRecibidas(admin), { revisadas: 1, guardadas: 1, pendientes: 0 });
    assert.equal(await db.documentoEgreso.count(), 1);
  });

  test("Sin reentrega de Meta: la bandeja MUESTRA la recepción sin procesarla y «Reintentar recepción» la completa, solo en su Empresa", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-b", { bytes: jpgFicticio("bandeja"), tipo: "image/jpeg" });
    meta.fallaDescarga = 503;
    const mensaje = foto("media-b");
    await enviar(mensaje);
    meta.fallaDescarga = null;

    assert.deepEqual(await obtenerBandejaRecibidos(adminAjeno), { documentos: [], recepciones: [], limitados: 0 });
    const descargas = meta.descargas;
    const bandeja = await obtenerBandejaRecibidos(admin);
    assert.equal(bandeja!.documentos.length, 0);
    assert.deepEqual(bandeja!.recepciones.map((r) => [r.estado, r.almacenado, r.enviadoPor]), [["EN_CURSO", false, "Supervisor Prueba"]]);
    assert.equal(meta.descargas, descargas, "cargar la bandeja no descarga ni guarda nada");
    assert.equal((await mensajeDe(mensaje)).etapaArchivo, "ASIGNADO");

    assert.deepEqual(await reanudarRecepcionesRecibidas(adminAjeno), { revisadas: 0, guardadas: 0, pendientes: 0 });
    assert.equal((await mensajeDe(mensaje)).etapaArchivo, "ASIGNADO");

    assert.deepEqual(await reanudarRecepcionesRecibidas(admin), { revisadas: 1, guardadas: 1, pendientes: 0 });
    assert.equal((await mensajeDe(mensaje)).resultado, "DOCUMENTO_RECIBIDO");
    assert.equal((await obtenerBandejaRecibidos(admin))!.documentos.length, 1);
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoRecibido], "la confirmación sale al completarse");
  });

  test("El archivo se subió pero no quedó registrado y después caducó en Meta: se rechaza con aviso y sin objeto huérfano", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-o", { bytes: jpgFicticio("huerfano-2"), tipo: "image/jpeg" });
    const mensaje = foto("media-o");
    // La subida ocurre, pero falla el registro de la etapa ALMACENADO.
    assert.equal((await conFallaSimulada("mensajes_whatsapp", "NEW.\"etapaArchivo\" = 'ALMACENADO'", () => enviar(mensaje))).status, 500);
    assert.equal(almacenamiento.size, 1, "el objeto existe aunque su etapa no se registró");
    assert.equal((await mensajeDe(mensaje)).etapaArchivo, "ASIGNADO");

    meta.archivos.clear();
    assert.equal((await enviar(mensaje)).status, 200);
    const registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "ARCHIVO_RECHAZADO_NO_DISPONIBLE");
    assert.equal(registro.etapaArchivo, "RECHAZADO");
    assert.equal(almacenamiento.size, 0, "la clave depende solo del mensaje: el objeto se localiza y se elimina");
    assert.deepEqual(textosEnviados(), [RESPUESTAS_WHATSAPP.archivoNoDisponible]);
  });

  test("Master puede reprocesar; el siguiente webhook también recupera lo pendiente", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-1", { bytes: jpgFicticio("uno"), tipo: "image/jpeg" });
    meta.archivos.set("media-2", { bytes: jpgFicticio("dos"), tipo: "image/jpeg" });
    meta.fallaConsulta = 500;
    const uno = foto("media-1");
    const dos = foto("media-2");
    await enviar(uno);
    await enviar(dos);
    meta.fallaConsulta = null;

    // Ningún mensaje se reintenta dentro de la misma entrega que lo trae.
    const resumen = await reprocesarMensajesPendientesMaster(master);
    assert.equal(resumen.procesados, 2);
    assert.equal(await db.documentoEgreso.count(), 2);

    meta.archivos.set("media-3", { bytes: jpgFicticio("tres"), tipo: "image/jpeg" });
    meta.fallaDescarga = 503;
    const tres = foto("media-3");
    await enviar(tres);
    meta.fallaDescarga = null;
    assert.equal((await enviar({ id: `wamid.arch.${++secuencia}`, from: WA, timestamp: "1760000000", type: "text", text: { body: "AYUDA" } })).status, 200);
    assert.equal((await mensajeDe(tres)).resultado, "DOCUMENTO_RECIBIDO", "recuperación oportunista en el siguiente webhook");
    assert.equal(await db.documentoEgreso.count(), 3);
  });

  test("Una entrega con más mensajes que el límite: TODOS se registran y ninguno se pierde", async () => {
    const mensajes = Array.from({ length: 25 }, (_, i) => ({ id: `wamid.lote.${i}`, from: `52155000000${String(i).padStart(2, "0")}`, timestamp: "1760000000", type: "text", text: { body: "hola" } }));
    assert.equal((await enviar(...mensajes)).status, 500, "queda trabajo pendiente: se pide la reentrega");
    assert.equal(await db.mensajeWhatsapp.count(), 25, "los 25 quedaron registrados");
    assert.equal(await db.mensajeWhatsapp.count({ where: { estadoProceso: "PROCESADO" } }), 20);
    assert.equal(await db.mensajeWhatsapp.count({ where: { estadoProceso: "PENDIENTE", remitentePendiente: { not: null } } }), 5);

    assert.equal((await enviar(...mensajes)).status, 200);
    assert.equal(await db.mensajeWhatsapp.count(), 25);
    assert.equal(await db.mensajeWhatsapp.count({ where: { estadoProceso: "PROCESADO" } }), 25);
  });

  test("Falla el envío de la confirmación: el documento queda guardado y no se reenvía ni se duplica", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-e", { bytes: jpgFicticio("envio"), tipo: "image/jpeg" });
    meta.fallaEnvio = 400;
    const mensaje = foto("media-e");
    assert.equal((await enviar(mensaje)).status, 200);
    const registro = await mensajeDe(mensaje);
    assert.equal(registro.resultado, "DOCUMENTO_RECIBIDO");
    assert.equal(registro.respondido, false);
    assert.equal(registro.error, "envio:http400:meta131030");
    assert.equal(await db.documentoEgreso.count(), 1);
    assert.equal((await enviar(mensaje)).status, 200);
    assert.equal(await db.documentoEgreso.count(), 1);
  });
});

describe("Límites por número — nunca se descarta un comprobante en silencio", () => {
  test("Ráfaga de comprobantes en una sola entrega: se guardan los primeros 50; cada uno de los demás queda ARCHIVO_LIMITADO con aviso", async () => {
    await vincular(supervisor);
    const total = MAX_ARCHIVOS_POR_VENTANA + 5;
    const mensajes = Array.from({ length: total }, (_, i) => {
      meta.archivos.set(`media-r${i}`, { bytes: jpgFicticio(`rafaga-${i}`), tipo: "image/jpeg" });
      return foto(`media-r${i}`);
    });
    // Una entrega procesa 20 mensajes: los demás quedan registrados y Meta reentrega.
    assert.equal((await enviar(...mensajes)).status, 500);
    assert.equal(await db.mensajeWhatsapp.count(), total, "todos quedaron registrados");
    assert.equal((await enviar(...mensajes)).status, 500);
    assert.equal((await enviar(...mensajes)).status, 200);

    // El límite se cuenta por orden de llegada, no por orden de proceso: los
    // primeros 50 se guardan aunque al procesarlos ya hubieran llegado los 55.
    const registros = await Promise.all(mensajes.map(mensajeDe));
    assert.deepEqual(registros.slice(0, MAX_ARCHIVOS_POR_VENTANA).map((r) => r.resultado), Array(MAX_ARCHIVOS_POR_VENTANA).fill("DOCUMENTO_RECIBIDO"));
    assert.equal(await db.documentoEgreso.count(), MAX_ARCHIVOS_POR_VENTANA);
    for (const r of registros.slice(MAX_ARCHIVOS_POR_VENTANA)) {
      assert.equal(r.estadoProceso, "PROCESADO");
      assert.equal(r.resultado, "ARCHIVO_LIMITADO", "estado explícito");
      assert.equal(r.etapaArchivo, "RECHAZADO");
      assert.equal(r.empresaId, EMPRESA, "ligado a su Empresa");
      assert.equal(r.usuarioId, supervisor.id);
      assert.equal(r.respondido, true, "el remitente fue avisado");
      assert.equal(r.remitentePendiente, null);
      assert.equal(r.archivoPendiente, null);
    }
    assert.equal(textosEnviados().filter((t) => t === RESPUESTAS_WHATSAPP.archivoLimitado).length, 5);
    assert.equal(textosEnviados().filter((t) => t === RESPUESTAS_WHATSAPP.archivoRecibido).length, MAX_ARCHIVOS_POR_VENTANA);
    assert.equal(meta.descargas, MAX_ARCHIVOS_POR_VENTANA, "lo limitado no se descarga");
    assert.equal(almacenamiento.size, MAX_ARCHIVOS_POR_VENTANA);

    // Visible para su Empresa, y solo para ella.
    assert.equal((await obtenerBandejaRecibidos(admin))!.limitados, 5);
    assert.equal((await obtenerBandejaRecibidos(adminAjeno))!.limitados, 0);

    // Los archivos no consumen el límite de los demás mensajes.
    await enviar({ id: `wamid.arch.${++secuencia}`, from: WA, timestamp: "1760000000", type: "text", text: { body: "AYUDA" } });
    assert.equal(meta.enviados.at(-1)!.texto, RESPUESTAS_WHATSAPP.ayuda);

    // Pasada la ventana, el mismo número vuelve a ser atendido.
    await db.mensajeWhatsapp.updateMany({ data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    meta.archivos.set("media-despues", { bytes: jpgFicticio("despues"), tipo: "image/jpeg" });
    const despues = foto("media-despues");
    await enviar(despues);
    assert.equal((await mensajeDe(despues)).resultado, "DOCUMENTO_RECIBIDO");
  });

  test("El límite de un número no afecta a otro número ni a otra Empresa", async () => {
    await vincular(supervisor);
    await vincular(supervisorAjeno, OTRO_WA, OTRO_TEL);
    // 50 archivos previos del primer número, ya registrados en su ventana.
    await db.mensajeWhatsapp.createMany({
      data: Array.from({ length: MAX_ARCHIVOS_POR_VENTANA }, (_, i) => ({
        wamid: `wamid.previo.${i}`,
        remitenteHash: "pendiente",
        tipo: "image",
        estadoProceso: "PROCESADO" as const,
        recibidoEn: new Date(),
      })),
    });
    meta.archivos.set("media-x", { bytes: jpgFicticio("x"), tipo: "image/jpeg" });
    const propio = foto("media-x");
    await enviar(propio);
    const hash = (await mensajeDe(propio)).remitenteHash;
    assert.equal((await mensajeDe(propio)).resultado, "DOCUMENTO_RECIBIDO");
    await db.mensajeWhatsapp.updateMany({ where: { remitenteHash: "pendiente" }, data: { remitenteHash: hash } });

    const limitado = foto("media-x");
    await enviar(limitado);
    assert.equal((await mensajeDe(limitado)).resultado, "ARCHIVO_LIMITADO");
    const ajeno = foto("media-x", undefined, OTRO_WA);
    await enviar(ajeno);
    assert.equal((await mensajeDe(ajeno)).resultado, "DOCUMENTO_RECIBIDO");
    assert.equal((await documentos(EMPRESA_AJENA)).length, 1);
  });

  test("Archivos de un número SIN vínculo: nunca se descargan y, sobre el límite general, no reciben respuesta", async () => {
    for (let i = 0; i < 22; i++) await enviar(foto("media-nadie", undefined, OTRO_WA));
    assert.equal(await db.mensajeWhatsapp.count({ where: { resultado: "NO_VINCULADO" } }), 20);
    assert.equal(await db.mensajeWhatsapp.count({ where: { resultado: "LIMITADO" } }), 2);
    assert.equal(meta.consultas, 0);
    assert.equal(meta.enviados.length, 1, "una sola respuesta genérica cada 24 horas");
    assert.equal(await db.mensajeWhatsapp.count({ where: { archivoPendiente: { not: Prisma.DbNull } } }), 0);
  });
});

describe("Bandeja «Recibidos por WhatsApp» — con ARQENTO IA apagada", () => {
  test("Administrador ve los comprobantes de SU Empresa; la Captura Inteligente sigue cerrada", async () => {
    await vincular(supervisor);
    await vincular(supervisorAjeno, OTRO_WA, OTRO_TEL);
    const { documento } = await recibirFoto("propio", "Nota ficticia");
    meta.archivos.set("media-ajeno", { bytes: jpgFicticio("ajeno"), tipo: "image/jpeg" });
    await enviar(foto("media-ajeno", undefined, OTRO_WA));

    const bandeja = await obtenerBandejaRecibidos(admin);
    assert.deepEqual(bandeja!.recepciones, []);
    assert.equal(bandeja!.limitados, 0);
    assert.deepEqual(bandeja!.documentos.map((d) => ({ ...d, recibidoEn: "x" })), [
      { id: documento.id, nombre: documento.archivoNombre, tipoMime: "image/jpeg", recibidoEn: "x", enviadoPor: "Supervisor Prueba", contexto: "Nota ficticia", eliminacionPendiente: false },
    ]);
    assert.equal(await obtenerRefDocumentoRecibido(admin, documento.id), documento.archivoRef);
    assert.equal((await obtenerBandejaRecibidos(adminAjeno))!.documentos.length, 1);

    // ARQENTO IA sigue apagada y su módulo, cerrado en el servidor.
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).inteligenciaHabilitada, false);
    await assert.rejects(obtenerDocumentosDelLote(admin, documento.loteId), /no está habilitada/);
    await assert.rejects(subirDocumentosEgreso(admin, [{ nombre: "x.png", tipoMime: "image/png", bytes: pngFicticio("web") }]), /no está habilitada/);
  });

  test("El Supervisor que envió el comprobante NO tiene acceso a la bandeja, al archivo ni al descarte", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("privado");
    await assert.rejects(obtenerBandejaRecibidos(supervisor), /permiso/i);
    await assert.rejects(obtenerRefDocumentoRecibido(supervisor, documento.id), /permiso/i);
    await assert.rejects(descartarDocumentoRecibido(supervisor, documento.id), /permiso/i);
    await assert.rejects(obtenerBandejaRecibidos(master), /permiso/i);
    assert.equal((await db.documentoEgreso.findUniqueOrThrow({ where: { id: documento.id } })).estatus, "PENDIENTE");
  });

  test("Otra Empresa no puede ver, abrir ni descartar un documento ajeno", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("aislado");
    assert.deepEqual((await obtenerBandejaRecibidos(adminAjeno))!.documentos, []);
    await assert.rejects(obtenerRefDocumentoRecibido(adminAjeno, documento.id), /no existe|no encontrad/i);
    await assert.rejects(descartarDocumentoRecibido(adminAjeno, documento.id), /no existe|no encontrad/i);
    assert.equal((await db.documentoEgreso.findUniqueOrThrow({ where: { id: documento.id } })).estatus, "PENDIENTE");
    assert.equal(almacenamiento.size, 1);
  });

  test("Con WhatsApp apagado para la Empresa la bandeja no aplica y sus acciones se rechazan", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("apagado");
    await db.empresa.update({ where: { id: EMPRESA }, data: { whatsappHabilitado: false } });
    assert.equal(await obtenerBandejaRecibidos(admin), null);
    await assert.rejects(obtenerRefDocumentoRecibido(admin, documento.id), new RegExp(MENSAJE_BANDEJA_NO_DISPONIBLE));
    await assert.rejects(descartarDocumentoRecibido(admin, documento.id), new RegExp(MENSAJE_BANDEJA_NO_DISPONIBLE));
  });
});

describe("Descartar un comprobante recibido por error", () => {
  test("Elimina el archivo privado y deja solo la auditoría mínima; es idempotente", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("error", "Foto personal enviada por error");
    assert.deepEqual(await descartarDocumentoRecibido(admin, documento.id), { archivoEliminado: true });

    assert.equal(almacenamiento.size, 0, "el objeto se eliminó del almacenamiento");
    const actual = await db.documentoEgreso.findUniqueOrThrow({ where: { id: documento.id } });
    assert.equal(actual.estatus, "DESCARTADO");
    assert.ok(actual.archivoEliminadoEn);
    assert.equal(actual.archivoNombre, "(archivo eliminado)");
    assert.equal(actual.contextoUsuario, null);
    assert.equal(actual.contextosAdicionales, null);
    assert.deepEqual((await obtenerBandejaRecibidos(admin))!.documentos, []);
    await assert.rejects(obtenerRefDocumentoRecibido(admin, documento.id), /no existe|no encontrad/i);

    const auditoria = await db.registroAuditoria.findMany({ where: { entidad: "DocumentoEgreso", entidadId: documento.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(auditoria.map((a) => a.accion), ["CREAR", "CAMBIAR_ESTATUS", "ELIMINAR"]);
    const texto = JSON.stringify(auditoria);
    for (const sensible of ["Foto personal", documento.archivoNombre, documento.archivoRef, WA, DESTINO]) assert.ok(!texto.includes(sensible), sensible);

    assert.deepEqual(await descartarDocumentoRecibido(admin, documento.id), { archivoEliminado: true });
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "DocumentoEgreso", entidadId: documento.id } }), 3, "repetirlo no hace nada");
  });

  test("Si el mismo archivo vuelve a llegar después de descartarlo, es un documento NUEVO", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("vuelve");
    await descartarDocumentoRecibido(admin, documento.id);
    assert.equal((await enviar(foto("media-vuelve"))).status, 200);
    const todos = await documentos();
    assert.equal(todos.length, 2);
    assert.equal(todos[1].estatus, "PENDIENTE");
    assert.equal(todos[1].hashArchivo, documento.hashArchivo);
    assert.ok(almacenamiento.has(todos[1].archivoRef), "el documento nuevo tiene su propio archivo");
    assert.equal((await obtenerBandejaRecibidos(admin))!.documentos.length, 1);
  });

  test("Nunca elimina un objeto que otro registro utiliza", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("compartido");
    await db.documentoEgreso.create({
      data: { empresaId: EMPRESA_AJENA, archivoRef: documento.archivoRef, archivoNombre: "otro.jpg", tipoMime: "image/jpeg", hashArchivo: "huella-ficticia", loteId: "lote-ficticio", subidoPorId: adminAjeno.id },
    });
    assert.deepEqual(await descartarDocumentoRecibido(admin, documento.id), { archivoEliminado: false });
    assert.equal(almacenamiento.size, 1, "el objeto compartido se conserva");
    const actual = await db.documentoEgreso.findUniqueOrThrow({ where: { id: documento.id } });
    assert.equal(actual.estatus, "DESCARTADO");
    assert.equal(actual.archivoEliminadoEn, null);
  });

  test("Si el almacenamiento falla al eliminar: queda descartado con eliminación pendiente y se puede reintentar", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("pendiente");
    const borrarOriginal = almacenamiento.delete;
    almacenamiento.delete = () => {
      throw new Error("Almacenamiento no disponible (simulado)");
    };
    try {
      await assert.rejects(descartarDocumentoRecibido(admin, documento.id), /todavía no se pudo eliminar/);
    } finally {
      almacenamiento.delete = borrarOriginal;
    }
    const bandeja = await obtenerBandejaRecibidos(admin);
    assert.equal(bandeja!.documentos[0].eliminacionPendiente, true);
    // Mientras su archivo espera la eliminación, tampoco la subida web lo reutiliza.
    assert.equal(await buscarDocumentoPorHash(EMPRESA, documento.hashArchivo), null);
    await assert.rejects(obtenerRefDocumentoRecibido(admin, documento.id), /no existe|no encontrad/i, "un descartado ya no se puede abrir");

    assert.deepEqual(await descartarDocumentoRecibido(admin, documento.id), { archivoEliminado: true });
    assert.equal(almacenamiento.size, 0);
    assert.deepEqual((await obtenerBandejaRecibidos(admin))!.documentos, []);
  });

  test("No descarta un documento ya registrado ni uno que no llegó por WhatsApp", async () => {
    await vincular(supervisor);
    const { documento } = await recibirFoto("registrado");
    await db.documentoEgreso.update({ where: { id: documento.id }, data: { estatus: "CONVERTIDO" } });
    await assert.rejects(descartarDocumentoRecibido(admin, documento.id), /ya fue registrado/);
    assert.equal(almacenamiento.size, 1);

    const web = await db.documentoEgreso.create({
      data: { empresaId: EMPRESA, archivoRef: "pruebas/web.pdf", archivoNombre: "web.pdf", tipoMime: "application/pdf", hashArchivo: "huella-web", loteId: "lote-web", subidoPorId: admin.id },
    });
    assert.equal(web.origen, "WEB", "los documentos existentes y los de la web conservan origen WEB");
    await assert.rejects(descartarDocumentoRecibido(admin, web.id), /no existe|no encontrad/i);
  });
});

describe("Privacidad de las respuestas y retención", () => {
  test("Todo lo que se envía al remitente es un texto fijo y genérico, dirigido a su número", async () => {
    await vincular(supervisor);
    await recibirFoto("p1", "Pagué $1,250.00 a Proveedor Ficticio SA");
    meta.archivos.set("media-malo", { bytes: Buffer.from("no es una imagen"), tipo: "image/jpeg" });
    await enviar(foto("media-malo"));
    await enviar(foto("media-inexistente"));
    const fijos = new Set<string>(Object.values(RESPUESTAS_WHATSAPP).filter((v) => typeof v === "string") as string[]);
    assert.equal(meta.enviados.length, 3);
    for (const e of meta.enviados) {
      assert.ok(fijos.has(e.texto), e.texto);
      assert.equal(e.to, DESTINO);
      assert.ok(!/1,250|Proveedor Ficticio/.test(e.texto));
    }
    // El registro operativo del mensaje no conserva teléfono, pie de foto ni identificadores.
    const registros = JSON.stringify(await db.mensajeWhatsapp.findMany());
    for (const sensible of [WA, DESTINO, "1,250", "Proveedor Ficticio", "media-p1"]) assert.ok(!registros.includes(sensible), sensible);
  });

  test("La depuración de 90 días conserva el mensaje que dio origen a un documento", async () => {
    await vincular(supervisor);
    const { mensaje } = await recibirFoto("retencion");
    await enviar({ id: "wamid.arch.texto", from: OTRO_WA, timestamp: "1760000000", type: "text", text: { body: "hola" } });
    const r = await depurarRegistrosWhatsapp({ ahora: new Date(Date.now() + 100 * 86_400_000), ejecutar: true, usuarioId: master.id });
    assert.equal(r.mensajes, 1, "solo se depura el mensaje sin documento");
    assert.equal((await mensajeDe(mensaje)).resultado, "DOCUMENTO_RECIBIDO");
  });

  test("procesarMensajesPendientes acotado a una Empresa no toca mensajes de texto ni de otra Empresa", async () => {
    await vincular(supervisor);
    meta.archivos.set("media-z", { bytes: jpgFicticio("z"), tipo: "image/jpeg" });
    meta.fallaDescarga = 503;
    await enviar(foto("media-z"));
    meta.fallaDescarga = null;
    assert.deepEqual(await procesarMensajesPendientes(10, [], { empresaId: EMPRESA_AJENA }), { revisados: 0, procesados: 0, reintentables: 0, definitivos: 0, detenidos: 0, omitidos: 0 });
    assert.equal((await procesarMensajesPendientes(10, [], { empresaId: EMPRESA })).procesados, 1);
  });
});

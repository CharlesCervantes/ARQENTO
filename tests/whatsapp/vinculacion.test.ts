import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  autorizarWhatsappUsuario,
  iniciarVinculacionWhatsapp,
  listarWhatsappDeMiEmpresa,
  obtenerMiWhatsapp,
  revocarMiWhatsapp,
  revocarWhatsappDeUsuario,
} from "@/lib/server/whatsapp/vinculos";
import { diagnosticoDeError, procesarMensajesPendientes, recibirWebhookWhatsapp, registrarMensajesEntrantes } from "@/lib/server/whatsapp/mensajes";
import { extraerMensajesEntrantes } from "@/lib/whatsapp/payload";
import { empresaActivaDelRemitenteTx } from "@/lib/server/whatsapp/seleccion-empresa";
import { depurarRegistrosWhatsapp } from "@/lib/server/whatsapp/retencion";
import { hashRemitente } from "@/lib/server/whatsapp/config";
import { salidaSimulada } from "@/lib/server/whatsapp/cliente";
import {
  cambiarWhatsappEmpresa,
  obtenerEstadoMensajesMaster,
  obtenerWhatsappEmpresaMaster,
  reprocesarMensajesPendientesMaster,
  revocarVinculoWhatsappMaster,
} from "@/lib/server/master/whatsapp";
import { cambiarEstatusUsuarioEmpresa } from "@/lib/server/master/empresas";
import { RESPUESTAS_WHATSAPP } from "@/lib/whatsapp/respuestas";
import { db } from "@/lib/server/db";
import type { UsuarioSesion } from "@/lib/server/session";
import { crearBdWhatsapp, type Empresa, type Usuario } from "../helpers/bd-whatsapp";
import { usuarioDePrueba } from "../helpers/usuarios";

// Fase 1 WhatsApp + ARQENTO IA — vinculación de punta a punta sobre una base
// SIMULADA en memoria (sin BD real, sin Meta: sin token de acceso las
// respuestas quedan en `salidaSimulada`). Los secretos son los ficticios de
// tests/setup/unitarias.mjs. Teléfonos ficticios.

const TEL = "+52 33 1234 5678"; // WhatsApp lo reporta como 5213312345678
const WA = "5213312345678";
const OTRO_WA = "5215598765432";
const APP_SECRET = "secreto-webhook-de-prueba";

const empresa = (id: string, extra: Partial<Empresa> = {}): Empresa => ({ id, nombre: `Constructora ${id}`, activa: true, whatsappHabilitado: true, inteligenciaHabilitada: false, ...extra });
const usuario = (id: string, rol: string, empresaId: string | null, extra: Partial<Usuario> = {}): Usuario => ({ id, nombre: `Nombre ${id}`, rol, activo: true, empresaId, whatsappAutorizado: true, ...extra });
const sesion = (u: Usuario): UsuarioSesion => {
  const base = usuarioDePrueba({ rol: u.rol as UsuarioSesion["rol"], empresaId: u.empresaId ?? undefined });
  return { ...base, id: u.id, empresaId: u.empresaId, empresa: base.empresa ? { ...base.empresa, id: u.empresaId! } : null } as UsuarioSesion;
};

let bd: ReturnType<typeof crearBdWhatsapp>;
let wamid = 0;
const MASTER = usuario("master", "MASTER", null);
const ADMIN_A = usuario("admin-a", "ADMINISTRADOR", "A");
const DIRECTOR_A = usuario("director-a", "DIRECTOR", "A");
const SUP_A = usuario("sup-a", "SUPERVISOR", "A");
const SUP2_A = usuario("sup2-a", "SUPERVISOR", "A");
const SUP_B = usuario("sup-b", "SUPERVISOR", "B");
const ADMIN_B = usuario("admin-b", "ADMINISTRADOR", "B");

beforeEach(() => {
  wamid = 0;
  salidaSimulada.length = 0;
  bd = crearBdWhatsapp({
    empresas: [empresa("A"), empresa("B")],
    usuarios: [MASTER, ADMIN_A, DIRECTOR_A, SUP_A, SUP2_A, SUP_B, ADMIN_B].map((u) => ({ ...u })),
  });
});
afterEach(() => bd.restaurar());

function cuerpoWebhook(mensajes: Record<string, unknown>[], phoneNumberId = "phone-number-id-simulado") {
  return Buffer.from(
    JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages: mensajes } }] }] })
  );
}
const firmar = (cuerpo: Buffer, secreto = APP_SECRET) => `sha256=${createHmac("sha256", secreto).update(cuerpo).digest("hex")}`;
const textoDe = (from: string, body: string, id = `wamid.${++wamid}`) => ({ id, from, timestamp: "1760000000", type: "text", text: { body } });
async function enviar(...mensajes: Record<string, unknown>[]) {
  const cuerpo = cuerpoWebhook(mensajes);
  return recibirWebhookWhatsapp(cuerpo, firmar(cuerpo));
}
const ultimaRespuesta = () => salidaSimulada.at(-1);
const vinculoDe = (usuarioId: string) => bd.t.vinculos.filter((v) => v.usuarioId === usuarioId && v.estado !== "REVOCADO")[0];

async function vincular(u: Usuario, telefono = TEL, wa = WA) {
  const { codigo } = await iniciarVinculacionWhatsapp(sesion(u), telefono);
  await enviar(textoDe(wa, codigo));
  assert.equal(vinculoDe(u.id)?.estado, "VERIFICADO", `no se vinculó ${u.id}`);
}

describe("Inicio de la vinculación", () => {
  test("Genera ARQ-XXXXXX de 15 minutos; solo guarda su HMAC y la auditoría nunca incluye el código", async () => {
    const r = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    assert.match(r.codigo, /^ARQ-[A-Z2-9]{6}$/);
    assert.equal(r.telefono, "+523312345678");
    const minutos = (new Date(r.expiraEn).getTime() - Date.now()) / 60_000;
    assert.ok(minutos > 14.9 && minutos <= 15, String(minutos));
    assert.equal(bd.t.codigos.length, 1);
    const todo = JSON.stringify(bd.t);
    assert.ok(!todo.includes(r.codigo) && !todo.includes(r.codigo.slice(4)), "el código quedó en claro");
    assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE");
    assert.ok(bd.bloqueos.some((b) => b.includes("FROM usuarios") && b.includes(SUP_A.id)), "debe bloquear al usuario");
  });

  test("Sin autorización, usuario desactivado, Empresa con WhatsApp apagado o Master: no se genera código", async () => {
    bd.t.usuarios.find((u) => u.id === SUP_A.id)!.whatsappAutorizado = false;
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP_A), TEL), /no está disponible/);
    bd.t.usuarios.find((u) => u.id === SUP2_A.id)!.activo = false;
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP2_A), TEL), /no está disponible/);
    bd.t.empresas.find((e) => e.id === "B")!.whatsappHabilitado = false;
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP_B), TEL), /no está disponible/);
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(MASTER), TEL), /permiso/i);
    assert.equal(bd.t.codigos.length, 0);
    assert.equal(bd.t.vinculos.length, 0);
  });

  test("La autorización se relee de la base, no de la sesión", async () => {
    const s = sesion(SUP_A);
    bd.t.usuarios.find((u) => u.id === SUP_A.id)!.whatsappAutorizado = false;
    await assert.rejects(iniciarVinculacionWhatsapp(s, TEL), /no está disponible/);
  });

  test("Teléfono sin código de país se rechaza", async () => {
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP_A), "33 1234 5678"), /formato internacional/);
  });

  test("Máximo 5 códigos por hora por usuario; cada código nuevo invalida el anterior", async () => {
    for (let i = 0; i < 5; i++) await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP_A), TEL), /demasiados códigos/);
    assert.equal(bd.t.codigos.filter((c) => !c.invalidadoEn).length, 1);
    assert.equal(bd.t.vinculos.length, 1, "mismo número: reutiliza el vínculo pendiente");
  });

  test("Cambiar de número estando pendiente revoca el vínculo anterior (historial) y crea otro", async () => {
    await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await iniciarVinculacionWhatsapp(sesion(SUP_A), "+52 55 9876 5432");
    assert.equal(bd.t.vinculos.length, 2);
    assert.equal(bd.t.vinculos[0].estado, "REVOCADO");
    assert.match(String(bd.t.vinculos[0].motivoRevocacion), /Reemplazado/);
  });

  test("Con un WhatsApp ya verificado hay que revocarlo antes de vincular otro", async () => {
    await vincular(SUP_A);
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP_A), "+52 55 9876 5432"), /Ya tienes un WhatsApp vinculado/);
  });

  test("El mismo número no puede estar vigente para dos usuarios de la MISMA Empresa (mensaje genérico)", async () => {
    await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await assert.rejects(iniciarVinculacionWhatsapp(sesion(SUP2_A), TEL), (e: Error) => {
      assert.match(e.message, /No se pudo registrar ese número/);
      assert.ok(!e.message.includes(SUP_A.nombre));
      return true;
    });
    assert.equal(bd.t.vinculos.length, 1, "la transacción fallida no deja rastro");
  });
});

describe("Verificación del código por WhatsApp", () => {
  test("Código correcto desde el mismo número: VERIFICADO, respuesta de éxito y sin guardar texto ni número", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    assert.deepEqual(await enviar(textoDe(WA, `Hola, mi código es ${codigo.toLowerCase()}`)), { status: 200 });
    const v = vinculoDe(SUP_A.id);
    assert.equal(v.estado, "VERIFICADO");
    assert.equal(v.waId, WA);
    assert.deepEqual(ultimaRespuesta(), { tipo: "texto", waId: WA, texto: RESPUESTAS_WHATSAPP.vinculado });
    const [m] = bd.t.mensajes;
    assert.equal(m.estadoProceso, "PROCESADO");
    assert.equal(m.resultado, "VINCULADO");
    assert.equal(m.remitentePendiente, null);
    assert.equal(m.textoPendiente, null);
    assert.equal(m.respondido, true);
    assert.ok(!JSON.stringify(bd.t.mensajes).includes(WA) && !JSON.stringify(bd.t.mensajes).includes("3312345678"));
    assert.ok(bd.t.codigos[0].usadoEn);
  });

  test("Todas las fallas reciben la MISMA respuesta (sin enumeración)", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await enviar(textoDe(WA, "ARQ-ZZZZZZ")); // incorrecto
    const incorrecto = ultimaRespuesta();
    await enviar(textoDe(OTRO_WA, codigo)); // otro teléfono
    const otroTelefono = ultimaRespuesta();
    await enviar(textoDe(WA, codigo)); // ahora sí
    await enviar(textoDe(WA, codigo)); // reutilizado
    const reutilizado = ultimaRespuesta();
    for (const r of [incorrecto, otroTelefono, reutilizado]) assert.equal(r && "texto" in r && r.texto, RESPUESTAS_WHATSAPP.vinculacionFallida);
  });

  test("Desde otro teléfono no vincula y cuenta como intento fallido", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await enviar(textoDe(OTRO_WA, codigo));
    assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE");
    assert.equal(bd.t.codigos[0].intentosFallidos, 1);
  });

  test("Código vencido no vincula", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    bd.t.codigos[0].expiraEn = new Date(Date.now() - 1000);
    await enviar(textoDe(WA, codigo));
    assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE");
    assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.vinculacionFallida);
  });

  test("Un código invalidado por uno nuevo ya no sirve", async () => {
    const primero = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await enviar(textoDe(WA, primero.codigo));
    assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE");
  });

  test("5 intentos incorrectos desde el número invalidan el código vigente", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    for (let i = 0; i < 5; i++) await enviar(textoDe(WA, "ARQ-ZZZZZZ"));
    assert.equal(bd.t.codigos[0].intentosFallidos, 5);
    assert.ok(bd.t.codigos[0].invalidadoEn);
    await enviar(textoDe(WA, codigo));
    assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE");
  });

  test("Si entre la generación y el envío se retira la autorización, se desactiva el usuario o se apaga WhatsApp, no vincula", async () => {
    for (const romper of [
      () => (bd.t.usuarios.find((u) => u.id === SUP_A.id)!.whatsappAutorizado = false),
      () => (bd.t.usuarios.find((u) => u.id === SUP_A.id)!.activo = false),
      () => (bd.t.empresas.find((e) => e.id === "A")!.whatsappHabilitado = false),
      () => (bd.t.empresas.find((e) => e.id === "A")!.activa = false),
    ]) {
      bd.restaurar();
      bd = crearBdWhatsapp({ empresas: [empresa("A")], usuarios: [{ ...SUP_A }] });
      const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
      romper();
      await enviar(textoDe(WA, codigo));
      assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE");
      assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.vinculacionFallida);
    }
  });
});

describe("Webhook: autenticidad, idempotencia y recuperación", () => {
  test("Firma inválida o ausente: 401 y no se registra nada", async () => {
    const cuerpo = cuerpoWebhook([textoDe(WA, "hola")]);
    assert.equal((await recibirWebhookWhatsapp(cuerpo, null)).status, 401);
    assert.equal((await recibirWebhookWhatsapp(cuerpo, firmar(cuerpo, "secreto-falso"))).status, 401);
    const alterado = Buffer.from(cuerpo.toString().replace("hola", "HOLA"));
    assert.equal((await recibirWebhookWhatsapp(alterado, firmar(cuerpo))).status, 401);
    assert.equal(bd.t.mensajes.length, 0);
    assert.equal(salidaSimulada.length, 0);
  });

  test("JSON inválido con firma válida: 400; cuerpo demasiado grande: 413", async () => {
    const malo = Buffer.from("{no-json");
    assert.equal((await recibirWebhookWhatsapp(malo, firmar(malo))).status, 400);
    const grande = Buffer.alloc(300 * 1024, 32);
    assert.equal((await recibirWebhookWhatsapp(grande, firmar(grande))).status, 413);
  });

  test("Sin configuración el webhook responde 503 sin procesar", async () => {
    const anterior = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    try {
      assert.equal((await enviar(textoDe(WA, "hola"))).status, 503);
    } finally {
      process.env.WHATSAPP_APP_SECRET = anterior;
    }
    assert.equal(bd.t.mensajes.length, 0);
  });

  test("Mensajes de otro phone_number_id se ignoran", async () => {
    const cuerpo = cuerpoWebhook([textoDe(WA, "hola")], "otro-numero");
    assert.equal((await recibirWebhookWhatsapp(cuerpo, firmar(cuerpo))).status, 200);
    assert.equal(bd.t.mensajes.length, 0);
  });

  test("Webhook duplicado (mismo wamid): se procesa y se responde UNA vez", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.repetido");
    await enviar(m);
    await enviar(m);
    await enviar(m);
    assert.equal(bd.t.mensajes.length, 1);
    assert.equal(salidaSimulada.length, 1);
  });

  test("Concurrencia: el mismo webhook entregado dos veces en paralelo se procesa una sola vez", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.paralelo");
    const r = await Promise.all([enviar(m), enviar(m)]);
    assert.deepEqual(r.map((x) => x.status), [200, 200]);
    assert.equal(bd.t.mensajes.length, 1);
    assert.equal(salidaSimulada.length, 1);
    assert.equal(bd.t.vinculos.filter((v) => v.estado === "VERIFICADO").length, 1);
  });

  test("Falla al procesar: 500 para que Meta reentregue; la reentrega del MISMO wamid lo procesa y responde una vez", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.reentrega");
    bd.fallarEn("auditoria");
    assert.equal((await enviar(m)).status, 500);
    const [registro] = bd.t.mensajes;
    assert.equal(registro.estadoProceso, "ERROR");
    assert.equal(registro.intentos, 1, "un intento por entrega (no se reintenta en la misma llamada)");
    assert.equal(registro.remitentePendiente, WA);
    assert.equal(vinculoDe(SUP_A.id).estado, "PENDIENTE", "la transacción se revirtió");
    assert.equal(registro.error, "proceso:Error");
    assert.equal(salidaSimulada.length, 0);
    bd.fallarEn(null);
    assert.equal((await enviar(m)).status, 200);
    assert.equal(bd.t.mensajes.length, 1, "idempotente por wamid");
    assert.equal(bd.t.mensajes[0].estadoProceso, "PROCESADO");
    assert.equal(vinculoDe(SUP_A.id).estado, "VERIFICADO");
    assert.equal(salidaSimulada.length, 1);
    assert.equal((await enviar(m)).status, 200, "una entrega más se omite");
    assert.equal(salidaSimulada.length, 1, "nunca una segunda respuesta");
  });

  test("Tres entregas fallidas: 500, 500 y 200 con ERROR definitivo; sin datos personales y con diagnóstico", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.tres");
    bd.fallarEn("auditoria");
    const estados = [];
    for (let i = 0; i < 3; i++) estados.push((await enviar(m)).status);
    assert.deepEqual(estados, [500, 500, 200]);
    const [r] = bd.t.mensajes;
    assert.deepEqual([r.estadoProceso, r.resultado, r.intentos], ["ERROR", "ERROR_DEFINITIVO", 3]);
    assert.equal(r.remitentePendiente, null);
    assert.equal(r.textoPendiente, null);
    // Diagnóstico conservado: tipo de error, tipo de mensaje, intentos, fechas y HMAC del remitente.
    assert.equal(r.error, "proceso:Error");
    assert.equal(r.tipo, "text");
    assert.equal(r.remitenteHash, hashRemitente("+523312345678"));
    assert.ok(r.procesadoEn);
    assert.ok(!JSON.stringify(bd.t.mensajes).includes(WA) && !JSON.stringify(bd.t.mensajes).includes(codigo.slice(4)));
    bd.fallarEn(null);
    assert.equal((await enviar(m)).status, 200, "Meta deja de reentregar");
    assert.equal((await procesarMensajesPendientes()).revisados, 0);
    assert.equal(salidaSimulada.length, 0);
  });

  test("Corte a medio proceso (registrado, nunca procesado): la reentrega lo procesa", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.cortado");
    // Simula una función que murió justo después de registrar.
    await registrarMensajesEntrantes(extraerMensajesEntrantes(JSON.parse(cuerpoWebhook([m]).toString()), "phone-number-id-simulado"));
    assert.equal(bd.t.mensajes[0].estadoProceso, "PENDIENTE");
    assert.equal((await enviar(m)).status, 200);
    assert.equal(bd.t.mensajes[0].estadoProceso, "PROCESADO");
    assert.equal(salidaSimulada.length, 1);
  });

  test("Falla la escritura inicial: la excepción llega a la ruta (500) y nada queda a medias; la reentrega funciona", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.registro");
    bd.fallarEn("mensajes.create");
    await assert.rejects(enviar(m), /Falla simulada/);
    assert.equal(bd.t.mensajes.length, 0);
    bd.fallarEn(null);
    assert.equal((await enviar(m)).status, 200);
    assert.equal(vinculoDe(SUP_A.id).estado, "VERIFICADO");
  });

  test("Si tampoco se puede marcar el error, sigue PENDIENTE y se pide reentrega (500)", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.sin-marca");
    bd.fallarEn("mensajes.update");
    assert.equal((await enviar(m)).status, 500);
    assert.equal(bd.t.mensajes[0].estadoProceso, "PENDIENTE");
    bd.fallarEn(null);
    assert.equal((await enviar(m)).status, 200);
    assert.equal(bd.t.mensajes[0].estadoProceso, "PROCESADO");
  });

  test("Lote mixto: el bueno se procesa y responde una vez; el fallido pide reentrega y luego se completa", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const lote = [textoDe(WA, codigo, "wamid.lote-codigo"), textoDe(OTRO_WA, "hola", "wamid.lote-desconocido")];
    bd.fallarEn("auditoria"); // solo la verificación del código audita
    assert.equal((await enviar(...lote)).status, 500);
    assert.deepEqual(bd.t.mensajes.map((x) => x.estadoProceso), ["ERROR", "PROCESADO"]);
    assert.equal(salidaSimulada.length, 1);
    bd.fallarEn(null);
    assert.equal((await enviar(...lote)).status, 200);
    assert.deepEqual(bd.t.mensajes.map((x) => x.estadoProceso), ["PROCESADO", "PROCESADO"]);
    assert.equal(salidaSimulada.length, 2, "el desconocido no recibe una segunda respuesta");
  });

  test("Reentregas simultáneas de un mensaje pendiente: se procesa y responde una sola vez", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    const m = textoDe(WA, codigo, "wamid.simultaneo");
    bd.fallarEn("auditoria");
    await enviar(m);
    bd.fallarEn(null);
    const r = await Promise.all([enviar(m), enviar(m), enviar(m)]);
    assert.deepEqual(r.map((x) => x.status), [200, 200, 200]);
    assert.equal(salidaSimulada.length, 1);
    assert.equal(bd.t.auditorias.filter((a) => a.accion === "CONFIRMAR").length, 1);
  });

  test("Sin WHATSAPP_CODIGO_PEPPER el webhook responde 503 (configuración incompleta), no 500", async () => {
    const anterior = process.env.WHATSAPP_CODIGO_PEPPER;
    delete process.env.WHATSAPP_CODIGO_PEPPER;
    try {
      assert.equal((await enviar(textoDe(WA, "hola"))).status, 503);
    } finally {
      process.env.WHATSAPP_CODIGO_PEPPER = anterior;
    }
    assert.equal(bd.t.mensajes.length, 0);
  });

  test("El diagnóstico nunca incluye el mensaje del error (podría tener datos personales)", () => {
    const e = Object.assign(new Error(`falló con ${WA} y el texto ARQ-ZZZZZZ`), { code: "P2034" });
    assert.equal(diagnosticoDeError(e), "Error:P2034");
    assert.equal(diagnosticoDeError({ code: "x y z" }), "object");
    assert.equal(diagnosticoDeError(null), "object");
  });

  test("Master: ve solo conteos y puede reprocesar pendientes (auditado); nadie más puede", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesion(SUP_A), TEL);
    await registrarMensajesEntrantes(extraerMensajesEntrantes(JSON.parse(cuerpoWebhook([textoDe(WA, codigo)]).toString()), "phone-number-id-simulado"));
    bd.t.mensajes[0].createdAt = new Date(Date.now() - 60_000);
    assert.deepEqual(await obtenerEstadoMensajesMaster(sesion(MASTER)), { pendientes: 1, reintentables: 0, detenidos: 0, definitivos: 0 });
    assert.deepEqual((await obtenerWhatsappEmpresaMaster(sesion(MASTER), "A")).canal, { pendientes: 1, reintentables: 0, detenidos: 0, definitivos: 0 });
    for (const u of [ADMIN_A, DIRECTOR_A, SUP_A]) await assert.rejects(reprocesarMensajesPendientesMaster(sesion(u)), /permiso/i);
    const r = await reprocesarMensajesPendientesMaster(sesion(MASTER));
    assert.deepEqual([r.revisados, r.procesados], [1, 1]);
    assert.equal(vinculoDe(SUP_A.id).estado, "VERIFICADO");
    assert.ok(bd.t.auditorias.some((a) => a.entidad === "MensajesWhatsapp" && a.usuarioId === MASTER.id));
    assert.equal(salidaSimulada.length, 1);
  });
});

describe("Números desconocidos, límites y archivos", () => {
  test("Número no vinculado: respuesta genérica una vez cada 24 h y solo un HMAC del remitente", async () => {
    await enviar(textoDe(OTRO_WA, "hola"));
    await enviar(textoDe(OTRO_WA, "¿quién eres?"));
    assert.equal(salidaSimulada.length, 1);
    assert.equal(salidaSimulada[0].texto, RESPUESTAS_WHATSAPP.numeroNoVinculado);
    for (const m of bd.t.mensajes) {
      assert.equal(m.resultado, "NO_VINCULADO");
      assert.equal(m.remitentePendiente, null);
      assert.equal(m.textoPendiente, null);
      assert.equal(m.remitenteHash, hashRemitente("+525598765432"));
    }
  });

  test("Más de 20 mensajes en 10 minutos desde un número: LIMITADO, sin respuesta", async () => {
    await vincular(SUP_A);
    salidaSimulada.length = 0;
    for (let i = 0; i < 21; i++) await enviar(textoDe(WA, "ayuda"));
    // El del código + 19 de ayuda llegan a 20 en la ventana; del 21º en adelante, sin respuesta.
    assert.equal(bd.t.mensajes.filter((m) => m.resultado === "LIMITADO").length, 2);
    assert.equal(salidaSimulada.length, 19);
  });

  test("Audio, video y stickers: nunca se descargan, solo se responde qué se recibe", async () => {
    await vincular(SUP_A);
    const fetchOriginal = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = (async () => {
      llamadas++;
      throw new Error("sin red");
    }) as typeof fetch;
    try {
      await enviar({ id: "wamid.audio", from: WA, timestamp: "1760000000", type: "audio", audio: { id: "media-1", mime_type: "audio/ogg" } });
    } finally {
      globalThis.fetch = fetchOriginal;
    }
    assert.equal(llamadas, 0);
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "ARCHIVO_IGNORADO");
    assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.soloVinculacion);
  });

  test("Comprobante sin almacenamiento configurado: falla de forma segura, sin descargar nada, y al agotar los intentos avisa al remitente", async () => {
    await vincular(SUP_A);
    salidaSimulada.length = 0;
    const fetchOriginal = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = (async () => {
      llamadas++;
      throw new Error("sin red");
    }) as typeof fetch;
    const documento = { id: "wamid.doc", from: WA, timestamp: "1760000000", type: "document", document: { id: "media-1", mime_type: "application/pdf", filename: "factura-ficticia.pdf" } };
    const mensaje = () => bd.t.mensajes.find((m) => m.wamid === "wamid.doc")!;
    try {
      assert.equal((await enviar(documento)).status, 500, "sin guardar: se pide la reentrega");
      assert.equal(mensaje().etapaArchivo, "ASIGNADO", "la etapa queda persistida para reanudar");
      assert.equal(mensaje().estadoProceso, "ERROR");
      assert.equal(mensaje().error, "proceso:RecepcionInterrumpida:almacenamiento");
      assert.equal(mensaje().empresaId, "A");
      assert.equal(mensaje().usuarioId, SUP_A.id);
      assert.equal(salidaSimulada.length, 0, "nunca se confirma lo que no se guardó");
      assert.equal((await enviar(documento)).status, 500);
      assert.equal((await enviar(documento)).status, 200, "agotados los intentos, Meta deja de reentregar");
    } finally {
      globalThis.fetch = fetchOriginal;
    }
    assert.equal(llamadas, 0, "sin almacenamiento no se descarga nada de Meta");
    // No se descarta: queda DETENIDO, con lo necesario para recuperarlo
    // cuando el almacenamiento esté configurado.
    assert.equal(mensaje().resultado, "ARCHIVO_DETENIDO");
    assert.equal(mensaje().etapaArchivo, "ASIGNADO");
    assert.equal(mensaje().intentos, 3);
    assert.equal(mensaje().remitentePendiente, WA);
    assert.deepEqual(mensaje().archivoPendiente, { mediaId: "media-1", nombre: "factura-ficticia.pdf" });
    assert.equal(mensaje().error, "proceso:RecepcionInterrumpida:almacenamiento");
    assert.equal((await enviar(documento)).status, 200, "una reentrega tardía ya no lo intenta");
    assert.equal(mensaje().intentos, 3);
    assert.equal(salidaSimulada.length, 1);
    assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.archivoDetenido);
  });

  test("Comprobante de un número sin vínculo o con varias Empresas sin elegir: no se recibe ni se descarga", async () => {
    const imagen = (id: string) => ({ id, from: WA, timestamp: "1760000000", type: "image", image: { id: "media-2", mime_type: "image/jpeg" } });
    await enviar(imagen("wamid.img.1"));
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "NO_VINCULADO");
    assert.equal(bd.t.mensajes.at(-1)!.etapaArchivo, null);

    await vincular(SUP_A);
    await vincular(SUP_B);
    salidaSimulada.length = 0;
    assert.equal((await enviar(imagen("wamid.img.2"))).status, 200);
    const m = bd.t.mensajes.at(-1)!;
    assert.equal(m.resultado, "EMPRESA_REQUERIDA");
    assert.equal(m.estadoProceso, "PROCESADO");
    assert.equal(m.empresaId, null, "nunca se asigna a una Empresa por omisión");
    assert.equal(m.etapaArchivo, null);
    assert.equal(ultimaRespuesta()!.tipo, "lista");
    assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.eligeEmpresaYReenvia);
  });

  test("Una pregunta financiera nunca recibe datos: solo la ayuda genérica", async () => {
    await vincular(SUP_A);
    await enviar(textoDe(WA, "¿cuál es el saldo de la obra?"));
    assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.ayuda);
  });
});

describe("Revocación, desactivación y WhatsApp apagado (D2)", () => {
  test("El usuario revoca su WhatsApp: queda REVOCADO (historial) y el número deja de funcionar", async () => {
    await vincular(SUP_A);
    assert.equal(await revocarMiWhatsapp(sesion(SUP_A)), 1);
    assert.equal(bd.t.vinculos.length, 1);
    assert.equal(bd.t.vinculos[0].estado, "REVOCADO");
    assert.equal(bd.t.vinculos[0].revocadoPorId, SUP_A.id);
    await enviar(textoDe(WA, "ayuda"));
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "NO_VINCULADO");
    const mio = await obtenerMiWhatsapp(sesion(SUP_A));
    assert.equal(mio!.vinculo, null);
    assert.match(String(mio!.ultimaRevocacion!.motivo), /usuario/);
  });

  test("Desactivar al usuario (Master) revoca sus vínculos en la misma transacción; al reactivarse debe vincular de nuevo", async () => {
    await vincular(SUP_A);
    await cambiarEstatusUsuarioEmpresa(sesion(MASTER), "A", SUP_A.id, false);
    assert.equal(bd.t.vinculos[0].estado, "REVOCADO");
    assert.match(String(bd.t.vinculos[0].motivoRevocacion), /desactivado/);
    await cambiarEstatusUsuarioEmpresa(sesion(MASTER), "A", SUP_A.id, true);
    assert.equal(vinculoDe(SUP_A.id), undefined);
    await enviar(textoDe(WA, "ayuda"));
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "NO_VINCULADO");
  });

  test("Si la revocación falla, la desactivación tampoco se aplica", async () => {
    await vincular(SUP_A);
    bd.fallarEn("vinculos.update");
    await assert.rejects(cambiarEstatusUsuarioEmpresa(sesion(MASTER), "A", SUP_A.id, false));
    assert.equal(bd.t.usuarios.find((u) => u.id === SUP_A.id)!.activo, true);
    assert.equal(vinculoDe(SUP_A.id).estado, "VERIFICADO");
  });

  test("Apagar WhatsApp en la Empresa conserva los vínculos pero impide usarlos; al encenderlo vuelven a funcionar", async () => {
    await vincular(SUP_A);
    await cambiarWhatsappEmpresa(sesion(MASTER), "A", false);
    assert.equal(vinculoDe(SUP_A.id).estado, "VERIFICADO");
    await enviar(textoDe(WA, "ayuda"));
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "NO_VINCULADO");
    await cambiarWhatsappEmpresa(sesion(MASTER), "A", true);
    await enviar(textoDe(WA, "ayuda"));
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "AYUDA");
  });

  test("WhatsApp e inteligencia son independientes", async () => {
    await cambiarWhatsappEmpresa(sesion(MASTER), "A", false);
    assert.equal(bd.t.empresas.find((e) => e.id === "A")!.inteligenciaHabilitada, false);
    bd.t.empresas.find((e) => e.id === "A")!.inteligenciaHabilitada = true;
    await cambiarWhatsappEmpresa(sesion(MASTER), "A", true);
    assert.equal(bd.t.empresas.find((e) => e.id === "A")!.inteligenciaHabilitada, true);
  });
});

describe("Permisos e aislamiento multiempresa (D1, D3)", () => {
  test("Administrador y Director autorizan y retiran a usuarios de SU Empresa; retirar revoca vínculos", async () => {
    await autorizarWhatsappUsuario(sesion(ADMIN_A), SUP_A.id, false);
    assert.equal(bd.t.usuarios.find((u) => u.id === SUP_A.id)!.whatsappAutorizado, false);
    await autorizarWhatsappUsuario(sesion(DIRECTOR_A), SUP_A.id, true);
    await vincular(SUP_A);
    await autorizarWhatsappUsuario(sesion(DIRECTOR_A), SUP_A.id, false);
    assert.equal(bd.t.vinculos[0].estado, "REVOCADO");
    assert.match(String(bd.t.vinculos[0].motivoRevocacion), /retirado/);
    assert.ok(bd.t.auditorias.some((a) => a.entidad === "Usuario" && a.accion === "DESACTIVAR"));
  });

  test("Supervisor y Master no administran usuarios de una Empresa", async () => {
    await assert.rejects(autorizarWhatsappUsuario(sesion(SUP_A), SUP2_A.id, false), /permiso/i);
    await assert.rejects(revocarWhatsappDeUsuario(sesion(SUP_A), SUP2_A.id), /permiso/i);
    await assert.rejects(autorizarWhatsappUsuario(sesion(MASTER), SUP_A.id, false), /permiso/i);
    await assert.rejects(listarWhatsappDeMiEmpresa(sesion(SUP_A)), /permiso/i);
  });

  test("Una Empresa nunca administra usuarios de otra (el usuario ajeno 'no existe')", async () => {
    await vincular(SUP_B, "+52 55 9876 5432", OTRO_WA);
    await assert.rejects(autorizarWhatsappUsuario(sesion(ADMIN_A), SUP_B.id, false), /no (existe|encontr)/i);
    await assert.rejects(revocarWhatsappDeUsuario(sesion(ADMIN_A), SUP_B.id), /no (existe|encontr)/i);
    assert.equal(bd.t.usuarios.find((u) => u.id === SUP_B.id)!.whatsappAutorizado, true);
    assert.equal(vinculoDe(SUP_B.id).estado, "VERIFICADO");
    const lista = await listarWhatsappDeMiEmpresa(sesion(ADMIN_A));
    assert.ok(lista.usuarios.every((u) => u.usuarioId !== SUP_B.id && u.usuarioId !== ADMIN_B.id));
  });

  test("Un usuario desactivado no puede ser autorizado", async () => {
    bd.t.usuarios.find((u) => u.id === SUP_A.id)!.activo = false;
    bd.t.usuarios.find((u) => u.id === SUP_A.id)!.whatsappAutorizado = false;
    await assert.rejects(autorizarWhatsappUsuario(sesion(ADMIN_A), SUP_A.id, true), /desactivado/);
  });

  test("Teléfonos ajenos salen enmascarados del servidor (administrador y Master); el propio, completo", async () => {
    await vincular(SUP_A);
    await vincular(ADMIN_A, "+52 55 9876 5432", OTRO_WA);
    const lista = await listarWhatsappDeMiEmpresa(sesion(ADMIN_A));
    const sup = lista.usuarios.find((u) => u.usuarioId === SUP_A.id)!;
    const propio = lista.usuarios.find((u) => u.usuarioId === ADMIN_A.id)!;
    assert.equal(sup.vinculo!.telefono, "+52 •••• 5678");
    assert.equal(propio.vinculo!.telefono, "+525598765432");
    const master = await obtenerWhatsappEmpresaMaster(sesion(MASTER), "A");
    assert.ok(master.vinculos.every((v) => v.telefono.includes("••••")));
    const serializado = JSON.stringify([lista, master]);
    assert.ok(!serializado.includes("3312345678"));
    assert.ok(!/codigo|hash/i.test(serializado));
  });

  test("Master revoca un vínculo solo dentro de la Empresa indicada", async () => {
    await vincular(SUP_A);
    const id = vinculoDe(SUP_A.id).id as string;
    await assert.rejects(revocarVinculoWhatsappMaster(sesion(MASTER), "B", id), /no (existe|encontr)/i);
    await revocarVinculoWhatsappMaster(sesion(MASTER), "A", id);
    assert.equal(bd.t.vinculos[0].estado, "REVOCADO");
    await assert.rejects(revocarVinculoWhatsappMaster(sesion(ADMIN_A), "A", id), /permiso/i);
  });
});

describe("Mismo teléfono en varias Empresas (D5)", () => {
  test("Lista SOLO los nombres de las Empresas vinculadas; la selección vale 30 min y se revalida", async () => {
    await vincular(SUP_A);
    await vincular(SUP_B); // misma persona/número en otra Empresa
    bd.t.empresas.push(empresa("C")); // Empresa sin vínculo: nunca aparece
    await enviar(textoDe(WA, "empresa"));
    const lista = ultimaRespuesta()!;
    assert.equal(lista.tipo, "lista");
    assert.deepEqual(lista.tipo === "lista" && lista.opciones.map((o) => o.titulo).sort(), ["Constructora A", "Constructora B"]);
    const opcionB = lista.tipo === "lista" ? lista.opciones.find((o) => o.titulo === "Constructora B")! : null;

    const remitenteHash = hashRemitente("+523312345678");
    await enviar({ id: "wamid.sel", from: WA, timestamp: "1760000000", type: "interactive", interactive: { list_reply: { id: opcionB!.id } } });
    assert.equal(ultimaRespuesta()!.texto, RESPUESTAS_WHATSAPP.empresaElegida("Constructora B"));
    const sesionWa = bd.t.sesiones[0];
    const minutos = ((sesionWa.expiraEn as Date).getTime() - Date.now()) / 60_000;
    assert.ok(minutos > 29.9 && minutos <= 30);

    const activa = () => empresaActivaDelRemitenteTx(db as never, { remitenteHash, telefonoE164: "+523312345678", ahora: new Date() });
    assert.equal((await activa())!.empresaId, "B");
    // Revalidación: si se apaga WhatsApp en B, la selección deja de valer.
    bd.t.empresas.find((e) => e.id === "B")!.whatsappHabilitado = false;
    assert.equal((await activa())!.empresaId, "A", "queda una sola Empresa utilizable");
    bd.t.empresas.find((e) => e.id === "B")!.whatsappHabilitado = true;
    // Caducidad.
    sesionWa.expiraEn = new Date(Date.now() - 1000);
    assert.equal(await activa(), null);
  });

  test("No se puede seleccionar un vínculo ajeno (de otro número o revocado)", async () => {
    await vincular(SUP_A);
    await vincular(SUP_B);
    await vincular(SUP2_A, "+52 55 9876 5432", OTRO_WA);
    const ajeno = vinculoDe(SUP2_A.id).id as string;
    await enviar({ id: "wamid.sel", from: WA, timestamp: "1760000000", type: "interactive", interactive: { list_reply: { id: ajeno } } });
    assert.equal(bd.t.mensajes.at(-1)!.resultado, "SELECCION_INVALIDA");
    assert.equal(bd.t.sesiones.length, 0);
    assert.equal(ultimaRespuesta()!.tipo, "lista");
  });

  test("Revocar un vínculo borra su selección vigente", async () => {
    await vincular(SUP_A);
    await vincular(SUP_B);
    const idB = vinculoDe(SUP_B.id).id as string;
    await enviar({ id: "wamid.sel", from: WA, timestamp: "1760000000", type: "interactive", interactive: { list_reply: { id: idB } } });
    assert.equal(bd.t.sesiones.length, 1);
    await revocarMiWhatsapp(sesion(SUP_B));
    assert.equal(bd.t.sesiones.length, 0);
  });
});

describe("Retención de 90 días (D4)", () => {
  test("Simulación por defecto; al ejecutar solo borra operativos terminados y deja auditoría", async () => {
    await vincular(SUP_A);
    await enviar(textoDe(OTRO_WA, "hola"));
    const viejo = new Date(Date.now() - 91 * 86_400_000);
    for (const m of bd.t.mensajes) m.createdAt = viejo;
    for (const c of bd.t.codigos) c.createdAt = viejo;
    bd.t.mensajes.push({ id: "pendiente-viejo", wamid: "w-p", estadoProceso: "PENDIENTE", remitentePendiente: "x", createdAt: viejo });
    bd.t.mensajes.push({ id: "error-reintentable", wamid: "w-e", estadoProceso: "ERROR", remitentePendiente: "x", createdAt: viejo });

    const simulacion = await depurarRegistrosWhatsapp();
    assert.equal(simulacion.ejecutado, false);
    assert.equal(simulacion.mensajes, 2);
    assert.equal(simulacion.codigos, 1);
    assert.equal(bd.t.mensajes.length, 4, "la simulación no borra");

    const r = await depurarRegistrosWhatsapp({ ejecutar: true, usuarioId: MASTER.id });
    assert.deepEqual([r.mensajes, r.codigos, r.ejecutado], [2, 1, true]);
    assert.deepEqual(bd.t.mensajes.map((m) => m.id).sort(), ["error-reintentable", "pendiente-viejo"]);
    assert.equal(bd.t.vinculos.length, 1, "los vínculos (historial) nunca se borran");
    assert.ok(bd.t.auditorias.some((a) => a.entidad === "RetencionWhatsapp" && a.accion === "ELIMINAR"));
  });

  test("Registros recientes no se tocan", async () => {
    await vincular(SUP_A);
    const r = await depurarRegistrosWhatsapp({ ejecutar: true });
    assert.equal(r.mensajes + r.codigos, 0);
  });
});

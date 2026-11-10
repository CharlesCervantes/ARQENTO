import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { db } from "@/lib/server/db";
import {
  autorizarWhatsappUsuario,
  iniciarVinculacionWhatsapp,
  listarWhatsappDeMiEmpresa,
  revocarWhatsappDeUsuario,
} from "@/lib/server/whatsapp/vinculos";
import { procesarMensajesPendientes, recibirWebhookWhatsapp, registrarMensajesEntrantes } from "@/lib/server/whatsapp/mensajes";
import { extraerMensajesEntrantes } from "@/lib/whatsapp/payload";
import { depurarRegistrosWhatsapp } from "@/lib/server/whatsapp/retencion";
import { salidaSimulada } from "@/lib/server/whatsapp/cliente";
import { cambiarWhatsappEmpresa, obtenerEstadoMensajesMaster, obtenerWhatsappEmpresaMaster, reprocesarMensajesPendientesMaster } from "@/lib/server/master/whatsapp";
import { cambiarEstatusUsuarioEmpresa } from "@/lib/server/master/empresas";
import { RESPUESTAS_WHATSAPP } from "@/lib/whatsapp/respuestas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, EMPRESA_AJENA, admin, adminAjeno, baseLimpiaConDatos, conFallaSimulada, sinInterbloqueos, supervisor } from "./apoyo/base";

// Fase 1 WhatsApp + ARQENTO IA contra PostgreSQL REAL (base local dedicada,
// verificada por tests/setup/integracion.mjs): índices únicos PARCIALES de
// la migración, bloqueos reales (FOR UPDATE) ante webhooks y vinculaciones
// concurrentes, rollback real y aislamiento multiempresa. Meta está
// simulado: secretos ficticios del setup, sin token de acceso (las
// respuestas quedan en `salidaSimulada`). Teléfonos ficticios.

const APP_SECRET = "secreto-webhook-de-prueba";
const TEL = "+52 33 1234 5678";
const WA = "5213312345678";
const OTRO_WA = "5215598765432";

const master: UsuarioSesion = { ...usuarioDePrueba({ rol: "MASTER" }), id: "usuario-master-wa" };
const supervisor2: UsuarioSesion = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: "usuario-supervisor-2" };
const supervisorAjeno: UsuarioSesion = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA_AJENA }), id: "usuario-supervisor-ajeno" };

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  salidaSimulada.length = 0;
  await db.usuario.createMany({
    data: [
      { id: master.id, nombre: "Master Prueba", email: "master-wa@prueba.invalid", passwordHash: "sin-acceso", rol: "MASTER", empresaId: null },
      { id: supervisor2.id, nombre: "Supervisor Dos", email: "sup2@prueba.invalid", passwordHash: "sin-acceso", rol: "SUPERVISOR", empresaId: EMPRESA },
      { id: supervisorAjeno.id, nombre: "Supervisor Ajeno", email: "sup@ajena.invalid", passwordHash: "sin-acceso", rol: "SUPERVISOR", empresaId: EMPRESA_AJENA },
    ],
  });
  // Siempre explícito: por omisión todo nace APAGADO (false).
  await db.empresa.updateMany({ where: { id: { in: [EMPRESA, EMPRESA_AJENA] } }, data: { whatsappHabilitado: true } });
  await db.usuario.updateMany({ where: { id: { in: [admin.id, supervisor.id, supervisor2.id, supervisorAjeno.id, adminAjeno.id] } }, data: { whatsappAutorizado: true } });
});

let secuencia = 0;
const textoDe = (from: string, body: string, id = `wamid.int.${++secuencia}`) => ({ id, from, timestamp: "1760000000", type: "text", text: { body } });
function cuerpo(mensajes: Record<string, unknown>[]) {
  return Buffer.from(
    JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-number-id-simulado" }, messages: mensajes } }] }] })
  );
}
const firmar = (c: Buffer) => `sha256=${createHmac("sha256", APP_SECRET).update(c).digest("hex")}`;
const enviar = (...mensajes: Record<string, unknown>[]) => {
  const c = cuerpo(mensajes);
  return recibirWebhookWhatsapp(c, firmar(c));
};
const vigente = (usuarioId: string) => db.vinculoWhatsapp.findFirst({ where: { usuarioId, estado: { not: "REVOCADO" } } });

async function vincular(u: UsuarioSesion, telefono = TEL, wa = WA) {
  const { codigo } = await iniciarVinculacionWhatsapp(u, telefono);
  await enviar(textoDe(wa, codigo));
  assert.equal((await vigente(u.id))?.estado, "VERIFICADO");
}

describe("WhatsApp en PostgreSQL — esquema", () => {
  test("Las Empresas y usuarios nuevos nacen con WhatsApp apagado y sin autorización", async () => {
    const e = await db.empresa.create({ data: { id: "empresa-nueva-wa", nombre: "Nueva (ficticia)" } });
    assert.equal(e.whatsappHabilitado, false);
    assert.equal(e.inteligenciaHabilitada, false);
    const u = await db.usuario.create({ data: { nombre: "Nuevo", email: "nuevo-wa@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: e.id } });
    assert.equal(u.whatsappAutorizado, false);
  });

  test("Índice parcial: un vínculo vigente por usuario; los REVOCADOS no cuentan (historial)", async () => {
    const base = { empresaId: EMPRESA, usuarioId: supervisor.id };
    await db.vinculoWhatsapp.create({ data: { ...base, telefonoE164: "+523312345678", estado: "REVOCADO" } });
    await db.vinculoWhatsapp.create({ data: { ...base, telefonoE164: "+523312345678", estado: "REVOCADO" } });
    await db.vinculoWhatsapp.create({ data: { ...base, telefonoE164: "+523312345678" } });
    await assert.rejects(db.vinculoWhatsapp.create({ data: { ...base, telefonoE164: "+525598765432" } }), /Unique constraint|P2002/);
  });

  test("Índice parcial: un número vigente por Empresa, pero sí en Empresas distintas", async () => {
    await db.vinculoWhatsapp.create({ data: { empresaId: EMPRESA, usuarioId: supervisor.id, telefonoE164: "+523312345678" } });
    await assert.rejects(
      db.vinculoWhatsapp.create({ data: { empresaId: EMPRESA, usuarioId: supervisor2.id, telefonoE164: "+523312345678" } }),
      /Unique constraint|P2002/
    );
    await db.vinculoWhatsapp.create({ data: { empresaId: EMPRESA_AJENA, usuarioId: supervisorAjeno.id, telefonoE164: "+523312345678" } });
  });

  test("wamid es único (idempotencia del webhook)", async () => {
    const m = { remitenteHash: "h", tipo: "text", recibidoEn: new Date() };
    await db.mensajeWhatsapp.create({ data: { ...m, wamid: "w-unico" } });
    await assert.rejects(db.mensajeWhatsapp.create({ data: { ...m, wamid: "w-unico" } }), /Unique constraint|P2002/);
  });
});

describe("WhatsApp en PostgreSQL — vinculación y concurrencia", () => {
  test("Vinculación completa: código solo como HMAC; mensaje procesado sin número ni texto", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    await enviar(textoDe(WA, codigo));
    const v = await vigente(supervisor.id);
    assert.equal(v?.estado, "VERIFICADO");
    assert.equal(v?.telefonoE164, "+523312345678");
    const filas = await db.$queryRawUnsafe<{ t: string }[]>(
      `SELECT row_to_json(c)::text AS t FROM codigos_vinculacion_whatsapp c UNION ALL SELECT row_to_json(m)::text FROM mensajes_whatsapp m UNION ALL SELECT row_to_json(a)::text FROM registros_auditoria a`
    );
    const todo = filas.map((f) => f.t).join("\n");
    assert.ok(!todo.includes(codigo.slice(4)), "el código quedó en claro");
    assert.ok(!todo.includes(WA) && !todo.includes("3312345678"), "el número quedó en claro fuera del vínculo");
  });

  test("Dos generaciones simultáneas del mismo usuario: un solo vínculo y un solo código vigente", async () => {
    const r = await Promise.allSettled(Array.from({ length: 4 }, () => iniciarVinculacionWhatsapp(supervisor, TEL)));
    sinInterbloqueos(r);
    assert.ok(r.every((x) => x.status === "fulfilled"));
    assert.equal(await db.vinculoWhatsapp.count({ where: { usuarioId: supervisor.id } }), 1);
    assert.equal(await db.codigoVinculacionWhatsapp.count({ where: { usadoEn: null, invalidadoEn: null } }), 1);
  });

  test("Dos usuarios de la MISMA Empresa registrando el mismo número a la vez: solo uno, mensaje genérico al otro", async () => {
    const r = await Promise.allSettled([iniciarVinculacionWhatsapp(supervisor, TEL), iniciarVinculacionWhatsapp(supervisor2, TEL)]);
    sinInterbloqueos(r);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const rechazo = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    assert.match(rechazo.reason.message, /No se pudo registrar ese número/);
    assert.equal(await db.vinculoWhatsapp.count(), 1);
  });

  test("El mismo webhook entregado en paralelo: se registra, procesa y responde UNA vez", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const m = textoDe(WA, codigo, "wamid.paralelo");
    const r = await Promise.allSettled([enviar(m), enviar(m), enviar(m)]);
    sinInterbloqueos(r);
    assert.ok(r.every((x) => x.status === "fulfilled" && x.value.status === 200));
    assert.equal(await db.mensajeWhatsapp.count(), 1);
    assert.equal(salidaSimulada.length, 1);
    assert.equal(salidaSimulada[0].texto, RESPUESTAS_WHATSAPP.vinculado);
  });

  test("El mismo código enviado en dos mensajes simultáneos: un VINCULADO y un CODIGO_INVALIDO", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const r = await Promise.allSettled([enviar(textoDe(WA, codigo)), enviar(textoDe(WA, codigo))]);
    sinInterbloqueos(r);
    const resultados = (await db.mensajeWhatsapp.findMany({ select: { resultado: true } })).map((m) => m.resultado).sort();
    assert.deepEqual(resultados, ["CODIGO_INVALIDO", "VINCULADO"]);
  });

  test("Revocar mientras llega el código: nunca queda VERIFICADO un vínculo revocado", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const r = await Promise.allSettled([enviar(textoDe(WA, codigo)), revocarWhatsappDeUsuario(admin, supervisor.id)]);
    sinInterbloqueos(r);
    const v = await db.vinculoWhatsapp.findFirstOrThrow({ where: { usuarioId: supervisor.id } });
    // Cualquiera de los dos órdenes es válido; lo que nunca puede pasar es que la revocación se pierda.
    assert.equal(v.estado, "REVOCADO");
  });

  test("Falla real en la auditoría: la verificación se revierte, se pide reentrega (500) y el reproceso lo recupera", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const r = await conFallaSimulada("registros_auditoria", `NEW."accion" = 'CONFIRMAR'`, () => enviar(textoDe(WA, codigo)));
    assert.equal(r.status, 500);
    assert.equal((await vigente(supervisor.id))?.estado, "PENDIENTE");
    const [m] = await db.mensajeWhatsapp.findMany();
    assert.equal(m.estadoProceso, "ERROR");
    assert.equal((await procesarMensajesPendientes()).procesados, 1);
    assert.equal((await vigente(supervisor.id))?.estado, "VERIFICADO");
  });
});

describe("WhatsApp en PostgreSQL — recuperación de mensajes (reentregas de Meta)", () => {
  const FALLA_CONFIRMAR = `NEW."accion" = 'CONFIRMAR'`;

  test("Error reintentable → 500; la reentrega del mismo wamid lo procesa una vez y responde una vez", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const m = textoDe(WA, codigo, "wamid.int.reentrega");
    assert.equal((await conFallaSimulada("registros_auditoria", FALLA_CONFIRMAR, () => enviar(m))).status, 500);
    const fallido = await db.mensajeWhatsapp.findUniqueOrThrow({ where: { wamid: m.id } });
    assert.deepEqual([fallido.estadoProceso, fallido.intentos], ["ERROR", 1]);
    assert.ok(fallido.error?.startsWith("proceso:"));
    assert.equal((await enviar(m)).status, 200);
    assert.equal((await enviar(m)).status, 200);
    assert.equal(await db.mensajeWhatsapp.count(), 1);
    assert.equal((await db.mensajeWhatsapp.findUniqueOrThrow({ where: { wamid: m.id } })).estadoProceso, "PROCESADO");
    assert.equal(salidaSimulada.length, 1);
  });

  test("Falla real de la escritura inicial: ningún registro y la ruta debe responder 500; la reentrega funciona", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const m = textoDe(WA, codigo, "wamid.int.registro");
    await assert.rejects(conFallaSimulada("mensajes_whatsapp", "TG_OP = 'INSERT'", () => enviar(m)), /Falla simulada/);
    assert.equal(await db.mensajeWhatsapp.count(), 0);
    assert.equal((await enviar(m)).status, 200);
    assert.equal((await vigente(supervisor.id))?.estado, "VERIFICADO");
  });

  test("Tres entregas fallidas: 500, 500, 200 con ERROR definitivo, diagnóstico técnico y sin datos personales", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const m = textoDe(WA, codigo, "wamid.int.tres");
    const estados = await conFallaSimulada("registros_auditoria", FALLA_CONFIRMAR, async () => {
      const s = [];
      for (let i = 0; i < 3; i++) s.push((await enviar(m)).status);
      return s;
    });
    assert.deepEqual(estados, [500, 500, 200]);
    const r = await db.mensajeWhatsapp.findUniqueOrThrow({ where: { wamid: m.id } });
    assert.deepEqual([r.estadoProceso, r.resultado, r.intentos, r.remitentePendiente, r.textoPendiente], ["ERROR", "ERROR_DEFINITIVO", 3, null, null]);
    assert.match(r.error ?? "", /^proceso:[A-Za-z0-9_.:-]+$/);
    const [fila] = await db.$queryRawUnsafe<{ t: string }[]>(`SELECT row_to_json(m)::text AS t FROM mensajes_whatsapp m`);
    assert.ok(!fila.t.includes(WA) && !fila.t.includes("3312345678") && !fila.t.includes(codigo.slice(4)));
    assert.equal((await enviar(m)).status, 200);
    assert.equal(salidaSimulada.length, 0);
  });

  test("Reentregas simultáneas de un mensaje con error: un solo PROCESADO, una sola respuesta, sin interbloqueos", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const m = textoDe(WA, codigo, "wamid.int.simultaneo");
    await conFallaSimulada("registros_auditoria", FALLA_CONFIRMAR, () => enviar(m));
    const r = await Promise.allSettled([enviar(m), enviar(m), enviar(m)]);
    sinInterbloqueos(r);
    assert.ok(r.every((x) => x.status === "fulfilled" && x.value.status === 200));
    assert.equal(salidaSimulada.length, 1);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "VinculoWhatsapp", accion: "CONFIRMAR" } }), 1);
  });

  test("Master reprocesa un mensaje que quedó PENDIENTE sin nueva entrega; queda auditado", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(supervisor, TEL);
    const m = textoDe(WA, codigo, "wamid.int.huerfano");
    await registrarMensajesEntrantes(extraerMensajesEntrantes(JSON.parse(cuerpo([m]).toString()), "phone-number-id-simulado"));
    await db.$executeRawUnsafe(`UPDATE mensajes_whatsapp SET "createdAt" = now() - interval '5 minutes'`);
    assert.deepEqual(await obtenerEstadoMensajesMaster(master), { pendientes: 1, reintentables: 0, definitivos: 0 });
    await assert.rejects(reprocesarMensajesPendientesMaster(admin), /permiso/i);
    const r = await reprocesarMensajesPendientesMaster(master);
    assert.deepEqual([r.revisados, r.procesados], [1, 1]);
    assert.equal((await vigente(supervisor.id))?.estado, "VERIFICADO");
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "MensajesWhatsapp", usuarioId: master.id } }), 1);
  });
});

describe("WhatsApp en PostgreSQL — permisos, D2 y multiempresa", () => {
  test("Desactivar al usuario revoca su vínculo (historial) y el número deja de funcionar", async () => {
    await vincular(supervisor);
    await cambiarEstatusUsuarioEmpresa(master, EMPRESA, supervisor.id, false);
    const v = await db.vinculoWhatsapp.findFirstOrThrow({ where: { usuarioId: supervisor.id } });
    assert.equal(v.estado, "REVOCADO");
    assert.equal(v.revocadoPorId, master.id);
    await cambiarEstatusUsuarioEmpresa(master, EMPRESA, supervisor.id, true);
    assert.equal(await vigente(supervisor.id), null, "al reactivarse debe vincular de nuevo");
    await enviar(textoDe(WA, "ayuda"));
    assert.equal((await db.mensajeWhatsapp.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).resultado, "NO_VINCULADO");
  });

  test("Apagar WhatsApp en la Empresa conserva el vínculo pero bloquea su uso", async () => {
    await vincular(supervisor);
    await cambiarWhatsappEmpresa(master, EMPRESA, false);
    assert.equal((await vigente(supervisor.id))?.estado, "VERIFICADO");
    await enviar(textoDe(WA, "ayuda"));
    assert.equal((await db.mensajeWhatsapp.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).resultado, "NO_VINCULADO");
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).inteligenciaHabilitada, false);
  });

  test("Un administrador no autoriza ni revoca usuarios de otra Empresa", async () => {
    await vincular(supervisorAjeno);
    await assert.rejects(autorizarWhatsappUsuario(admin, supervisorAjeno.id, false));
    await assert.rejects(revocarWhatsappDeUsuario(admin, supervisorAjeno.id));
    assert.equal((await vigente(supervisorAjeno.id))?.estado, "VERIFICADO");
    const lista = await listarWhatsappDeMiEmpresa(admin);
    assert.ok(lista.usuarios.every((u) => u.usuarioId !== supervisorAjeno.id));
  });

  test("Mismo número en dos Empresas: solo se ofrecen esas dos y la selección se guarda 30 minutos", async () => {
    await vincular(supervisor);
    await vincular(supervisorAjeno);
    await enviar(textoDe(WA, "empresa"));
    const lista = salidaSimulada.at(-1)!;
    assert.equal(lista.tipo, "lista");
    const opciones = lista.tipo === "lista" ? lista.opciones : [];
    assert.deepEqual(opciones.map((o) => o.titulo).sort(), ["Constructora Ajena (ficticia)", "Constructora Prueba (ficticia)"]);
    await enviar({ id: "wamid.sel", from: WA, timestamp: "1760000000", type: "interactive", interactive: { list_reply: { id: opciones[0].id } } });
    const s = await db.sesionWhatsapp.findFirstOrThrow();
    const minutos = (s.expiraEn.getTime() - Date.now()) / 60_000;
    assert.ok(minutos > 29 && minutos <= 30);
  });

  test("Master ve los teléfonos enmascarados", async () => {
    await vincular(supervisor);
    const r = await obtenerWhatsappEmpresaMaster(master, EMPRESA);
    assert.deepEqual(r.vinculos.map((v) => v.telefono), ["+52 •••• 5678"]);
  });

  test("Retención: la simulación no borra; la ejecución solo borra lo vencido y deja auditoría", async () => {
    await vincular(supervisor);
    await enviar(textoDe(OTRO_WA, "hola"));
    await db.$executeRawUnsafe(`UPDATE mensajes_whatsapp SET "createdAt" = now() - interval '91 days'`);
    await db.$executeRawUnsafe(`UPDATE codigos_vinculacion_whatsapp SET "createdAt" = now() - interval '91 days'`);
    const simulacion = await depurarRegistrosWhatsapp();
    assert.deepEqual([simulacion.mensajes, simulacion.codigos, simulacion.ejecutado], [2, 1, false]);
    assert.equal(await db.mensajeWhatsapp.count(), 2);
    const r = await depurarRegistrosWhatsapp({ ejecutar: true, usuarioId: master.id });
    assert.deepEqual([r.mensajes, r.codigos], [2, 1]);
    assert.equal(await db.mensajeWhatsapp.count(), 0);
    assert.equal(await db.vinculoWhatsapp.count(), 1);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "RetencionWhatsapp" } }), 1);
  });
});

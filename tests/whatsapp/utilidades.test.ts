import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { enmascararTelefono, normalizarTelefono, normalizarWaId } from "@/lib/whatsapp/telefono";
import { ALFABETO_CODIGO, extraerCodigoVinculacion, generarCodigoVinculacion, hashCodigoVinculacion } from "@/lib/whatsapp/codigo";
import { extraerMensajesEntrantes } from "@/lib/whatsapp/payload";
import { comandoDeTexto } from "@/lib/whatsapp/respuestas";
import { verificarFirmaMeta, verificarTokenSuscripcion } from "@/lib/server/whatsapp/firma";
import { puedeAdministrarWhatsappEmpresa, puedeConfigurarWhatsappEmpresa, rolPuedeVincularWhatsapp } from "@/lib/server/permisos";
import { usuarioDePrueba } from "../helpers/usuarios";

// Fase 1 WhatsApp + ARQENTO IA — piezas puras: teléfonos, códigos, firma de
// Meta, lectura del payload y permisos. Sin red ni base de datos.

describe("Normalización de teléfonos", () => {
  test("México: 10 dígitos nacionales; el prefijo móvil antiguo 1 (+52 1) se retira", () => {
    assert.deepEqual(normalizarTelefono("+52 33 1234 5678"), { ok: true, e164: "+523312345678" });
    assert.deepEqual(normalizarTelefono("+52 1 33 1234 5678"), { ok: true, e164: "+523312345678" });
    assert.deepEqual(normalizarTelefono("0052 (55) 1234-5678"), { ok: true, e164: "+525512345678" });
    assert.deepEqual(normalizarWaId("5213312345678"), { ok: true, e164: "+523312345678" });
  });

  test("México: rechaza números que no tienen 10 dígitos nacionales válidos", () => {
    assert.equal(normalizarTelefono("+52 33 1234 567").ok, false);
    assert.equal(normalizarTelefono("+52 0312345678").ok, false);
    assert.equal(normalizarTelefono("+52 1312345678").ok, false);
  });

  test("Extranjeros se conservan tal cual (EE. UU., España, Argentina con 9)", () => {
    assert.deepEqual(normalizarTelefono("+1 (415) 555-0100"), { ok: true, e164: "+14155550100" });
    assert.deepEqual(normalizarTelefono("+34 612 34 56 78"), { ok: true, e164: "+34612345678" });
    assert.deepEqual(normalizarTelefono("+54 9 11 1234 5678"), { ok: true, e164: "+5491112345678" });
  });

  test("Sin código de país, con letras o fuera de 8–15 dígitos se rechaza (nunca asume México)", () => {
    for (const malo of ["3312345678", "33 1234 5678", "+52abc", "+1234567", "+1234567890123456", "+0123456789", "", "+"]) {
      assert.equal(normalizarTelefono(malo).ok, false, malo);
    }
    assert.equal(normalizarWaId("+5213312345678").ok, false);
  });

  test("Enmascarado: solo código de país y últimos 4 dígitos", () => {
    assert.equal(enmascararTelefono("+523312345678"), "+52 •••• 5678");
    assert.equal(enmascararTelefono("+14155550100"), "+1 •••• 0100");
    assert.ok(!enmascararTelefono("+523312345678").includes("3312"));
  });
});

describe("Códigos de vinculación", () => {
  test("Formato ARQ-XXXXXX con alfabeto sin caracteres ambiguos", () => {
    for (let i = 0; i < 200; i++) {
      const c = generarCodigoVinculacion();
      assert.match(c, /^ARQ-[A-Z2-9]{6}$/);
      assert.ok([...c.slice(4)].every((x) => ALFABETO_CODIGO.includes(x)), c);
    }
  });

  test("Se reconoce dentro del texto, sin importar mayúsculas ni guion", () => {
    assert.equal(extraerCodigoVinculacion("ARQ-7K2M9Q"), "ARQ-7K2M9Q");
    assert.equal(extraerCodigoVinculacion("mi código es arq 7k2m9q gracias"), "ARQ-7K2M9Q");
    assert.equal(extraerCodigoVinculacion("ARQ7K2M9Q"), "ARQ-7K2M9Q");
    assert.equal(extraerCodigoVinculacion("ARQ-7K2M0Q"), null); // 0 no está en el alfabeto
    assert.equal(extraerCodigoVinculacion("ARQ-7K2M9QX"), null);
    assert.equal(extraerCodigoVinculacion("hola"), null);
  });

  test("Solo se guarda un HMAC: depende del secreto y no contiene el código", () => {
    const a = hashCodigoVinculacion("ARQ-7K2M9Q", "secreto-a-0123456789");
    assert.equal(a, hashCodigoVinculacion("arq-7k2m9q", "secreto-a-0123456789"));
    assert.notEqual(a, hashCodigoVinculacion("ARQ-7K2M9Q", "secreto-b-0123456789"));
    assert.ok(!a.includes("7K2M9Q"));
  });
});

describe("Firma del webhook de Meta", () => {
  const secreto = "secreto-webhook-de-prueba";
  const cuerpo = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  const firmar = (b: Buffer, s = secreto) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

  test("Acepta la firma correcta del cuerpo ORIGINAL", () => {
    assert.equal(verificarFirmaMeta(cuerpo, firmar(cuerpo), secreto), true);
  });

  test("Rechaza: sin cabecera, otro secreto, cuerpo alterado o re-serializado, formato inválido", () => {
    assert.equal(verificarFirmaMeta(cuerpo, null, secreto), false);
    assert.equal(verificarFirmaMeta(cuerpo, firmar(cuerpo, "otro-secreto"), secreto), false);
    assert.equal(verificarFirmaMeta(Buffer.from(cuerpo.toString().replace("[]", "[ ]")), firmar(cuerpo), secreto), false);
    const reserializado = Buffer.from(JSON.stringify(JSON.parse('{ "object": "whatsapp_business_account", "entry": [] }')));
    assert.equal(verificarFirmaMeta(Buffer.from('{ "object": "whatsapp_business_account", "entry": [] }'), firmar(reserializado), secreto), false);
    assert.equal(verificarFirmaMeta(cuerpo, "sha1=abc", secreto), false);
    assert.equal(verificarFirmaMeta(cuerpo, "sha256=zz", secreto), false);
  });

  test("Token de suscripción en tiempo constante", () => {
    assert.equal(verificarTokenSuscripcion("abc", "abc"), true);
    assert.equal(verificarTokenSuscripcion("abd", "abc"), false);
    assert.equal(verificarTokenSuscripcion("ab", "abc"), false);
    assert.equal(verificarTokenSuscripcion(null, "abc"), false);
  });
});

describe("Lectura del payload", () => {
  const payload = (mensajes: unknown[], phoneNumberId = "pn-1", extra: Record<string, unknown> = {}) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages: mensajes, ...extra } }] }],
  });

  test("Extrae texto (máx. 200 caracteres) y selección interactiva", () => {
    const r = extraerMensajesEntrantes(
      payload([
        { id: "wamid.1", from: "5213312345678", timestamp: "1760000000", type: "text", text: { body: "x".repeat(500) } },
        { id: "wamid.2", from: "5213312345678", timestamp: "1760000001", type: "interactive", interactive: { list_reply: { id: "vinculo-9" } } },
      ]),
      "pn-1"
    );
    assert.equal(r.length, 2);
    assert.equal(r[0].texto!.length, 200);
    assert.equal(r[0].recibidoEn.getTime(), 1760000000 * 1000);
    assert.equal(r[1].seleccionId, "vinculo-9");
    assert.equal(r[1].texto, null);
  });

  test("Ignora otro número de ARQENTO, otros objetos, statuses y mensajes malformados; nunca lanza", () => {
    const m = { id: "wamid.1", from: "5213312345678", type: "text", text: { body: "hola" } };
    assert.equal(extraerMensajesEntrantes(payload([m], "pn-otro"), "pn-1").length, 0);
    assert.equal(extraerMensajesEntrantes({ ...payload([m]), object: "page" }, "pn-1").length, 0);
    assert.equal(extraerMensajesEntrantes(payload([], "pn-1", { statuses: [{ id: "s" }] }), "pn-1").length, 0);
    assert.equal(extraerMensajesEntrantes(payload([{ id: "w", from: "abc" }, { from: "5213312345678" }, null]), "pn-1").length, 0);
    for (const raro of [null, undefined, 42, "texto", [], { object: "whatsapp_business_account", entry: "x" }]) {
      assert.deepEqual(extraerMensajesEntrantes(raro, "pn-1"), []);
    }
  });

  test("Documentos e imágenes: solo se registra el tipo (nunca la URL ni el id del archivo)", () => {
    const [r] = extraerMensajesEntrantes(payload([{ id: "w", from: "5213312345678", type: "document", document: { id: "media-1", link: "https://x" } }]), "pn-1");
    assert.deepEqual(Object.keys(r).sort(), ["recibidoEn", "seleccionId", "texto", "tipo", "waId", "wamid"]);
    assert.equal(r.tipo, "document");
    assert.equal(r.texto, null);
  });

  test("Comandos", () => {
    assert.equal(comandoDeTexto(" ayuda "), "AYUDA");
    assert.equal(comandoDeTexto("Menú"), "AYUDA");
    assert.equal(comandoDeTexto("cambiar empresa"), "EMPRESA");
    assert.equal(comandoDeTexto("¿cuánto debo?"), null);
  });
});

describe("Permisos de WhatsApp (D1)", () => {
  test("Solo Master configura el canal por Empresa", () => {
    assert.equal(puedeConfigurarWhatsappEmpresa(usuarioDePrueba({ rol: "MASTER" })), true);
    for (const rol of ["DIRECTOR", "ADMINISTRADOR", "SUPERVISOR"] as const) assert.equal(puedeConfigurarWhatsappEmpresa(usuarioDePrueba({ rol })), false);
  });

  test("Administrador y Director administran su Empresa; Supervisor y Master no", () => {
    assert.equal(puedeAdministrarWhatsappEmpresa(usuarioDePrueba({ rol: "ADMINISTRADOR" })), true);
    assert.equal(puedeAdministrarWhatsappEmpresa(usuarioDePrueba({ rol: "DIRECTOR" })), true);
    assert.equal(puedeAdministrarWhatsappEmpresa(usuarioDePrueba({ rol: "SUPERVISOR" })), false);
    assert.equal(puedeAdministrarWhatsappEmpresa(usuarioDePrueba({ rol: "MASTER" })), false);
  });

  test("Pueden vincular su teléfono Director, Administrador y Supervisor — nunca Master", () => {
    assert.equal(rolPuedeVincularWhatsapp("SUPERVISOR"), true);
    assert.equal(rolPuedeVincularWhatsapp("MASTER"), false);
  });
});

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EnvioWhatsappError, enviarMensajeWhatsapp, salidaSimulada } from "@/lib/server/whatsapp/cliente";
import { destinatarioDeEnvio } from "@/lib/whatsapp/telefono";
import { recibirWebhookWhatsapp } from "@/lib/server/whatsapp/mensajes";
import { iniciarVinculacionWhatsapp } from "@/lib/server/whatsapp/vinculos";
import { obtenerEstadoMensajesMaster } from "@/lib/server/master/whatsapp";
import type { UsuarioSesion } from "@/lib/server/session";
import { crearBdWhatsapp } from "../helpers/bd-whatsapp";
import { usuarioDePrueba } from "../helpers/usuarios";

// Diagnóstico del ENVÍO a Meta Cloud API (noviembre 2026): cuando Meta
// rechaza una respuesta solo quedan el HTTP status y el código numérico de
// error de Meta. Sin red: `fetch` se sustituye; token y teléfonos ficticios.

const TOKEN = "token-ficticio-de-prueba-NO-REAL";
const WA = "5213312345678";
const TEXTO = "Texto de respuesta ficticio";
const APP_SECRET = "secreto-webhook-de-prueba";

type Llamada = { url: string; init: RequestInit };
let llamadas: Llamada[];
let avisos: string[];
const fetchOriginal = globalThis.fetch;
const warnOriginal = console.warn;

function simularMeta(responder: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    return responder();
  }) as typeof fetch;
}
const errorDeMeta = (status: number, code: unknown) =>
  new Response(
    JSON.stringify({ error: { message: `Detalle de Meta con ${WA}, ${TOKEN} y ${TEXTO}`, type: "OAuthException", code, error_data: { details: WA }, fbtrace_id: "traza-ficticia" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );

beforeEach(() => {
  llamadas = [];
  avisos = [];
  salidaSimulada.length = 0;
  process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
  console.warn = (...args: unknown[]) => void avisos.push(args.map(String).join(" "));
});
afterEach(() => {
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  globalThis.fetch = fetchOriginal;
  console.warn = warnOriginal;
});

async function rechazo(): Promise<unknown> {
  try {
    await enviarMensajeWhatsapp({ tipo: "texto", waId: WA, texto: TEXTO });
  } catch (error) {
    return error;
  }
  assert.fail("el envío debió fallar");
}
const sinDatosSensibles = (valor: string) =>
  assert.ok(![WA, WA.slice(-10), TOKEN, TEXTO, "graph.facebook.com", "traza-ficticia", "OAuthException"].some((s) => valor.includes(s)), valor);

describe("Cliente de Meta — diagnóstico de rechazos", () => {
  const casos: [string, number, number, string][] = [
    ["400 con código de Meta (destinatario no permitido)", 400, 131030, "http400:meta131030"],
    ["401 con código de Meta (token inválido o vencido)", 401, 190, "http401:meta190"],
    ["403 con código de Meta (permiso faltante)", 403, 10, "http403:meta10"],
    ["429 con código de Meta (límite de envíos)", 429, 130429, "http429:meta130429"],
  ];
  for (const [nombre, status, code, esperado] of casos) {
    test(`${nombre}: solo HTTP status y código numérico`, async () => {
      simularMeta(() => errorDeMeta(status, code));
      const error = await rechazo();
      assert.ok(error instanceof EnvioWhatsappError);
      assert.equal(error.status, status);
      assert.equal(error.codigoMeta, code);
      assert.equal(error.diagnostico, esperado);
      // Ni el objeto de error ni su mensaje llevan nada de la respuesta de Meta.
      sinDatosSensibles(`${error.message} ${JSON.stringify(error)} ${error.diagnostico}`);
      assert.deepEqual(Object.keys(error).sort(), ["codigoMeta", "name", "status"]);
      assert.equal(llamadas.length, 1, "un solo intento: el cliente nunca reintenta");
    });
  }

  test("Respuestas inesperadas: sin código de Meta utilizable queda solo el HTTP status", async () => {
    const cuerpos: [number, string | null][] = [
      [500, "<html><body>Bad Gateway</body></html>"],
      [502, null],
      [400, "{ json cortado"],
      [400, JSON.stringify({ error: { code: "131030" } })],
      [400, JSON.stringify({ error: { code: 1.5 } })],
      [400, JSON.stringify({ error: { code: -1 } })],
      [400, JSON.stringify({ error: { code: 99_999_999_999 } })],
      [400, JSON.stringify({ error: "texto" })],
      [400, JSON.stringify({ code: 190 })],
      [400, "null"],
      [400, JSON.stringify({ error: { code: 190 }, relleno: "x".repeat(10_000) })],
    ];
    for (const [status, cuerpo] of cuerpos) {
      simularMeta(() => new Response(cuerpo, { status }));
      const error = await rechazo();
      assert.ok(error instanceof EnvioWhatsappError, String(cuerpo).slice(0, 30));
      assert.equal(error.codigoMeta, null, String(cuerpo).slice(0, 30));
      assert.equal(error.diagnostico, `http${status}`);
    }
  });

  test("Cuerpo ilegible tras el rechazo: se conserva el HTTP status", async () => {
    simularMeta(() => {
      const r = new Response(null, { status: 403 });
      Object.defineProperty(r, "text", { value: () => Promise.reject(new Error("corte de red")) });
      return r;
    });
    const error = await rechazo();
    assert.ok(error instanceof EnvioWhatsappError);
    assert.equal(error.diagnostico, "http403");
  });

  test("Timeout y fallas de red no son rechazos de Meta: conservan su tipo de error", async () => {
    simularMeta(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    const timeout = await rechazo();
    assert.ok(!(timeout instanceof EnvioWhatsappError));
    assert.equal((timeout as Error).name, "TimeoutError");
    simularMeta(() => Promise.reject(new TypeError("fetch failed")));
    assert.equal(((await rechazo()) as Error).name, "TypeError");
  });

  test("Respuesta 2xx: envío correcto, con el token solo en la cabecera y límite de tiempo", async () => {
    simularMeta(() => new Response(JSON.stringify({ messages: [{ id: "wamid.salida" }] }), { status: 200 }));
    await enviarMensajeWhatsapp({ tipo: "texto", waId: WA, texto: TEXTO });
    assert.equal(llamadas.length, 1);
    assert.ok(!llamadas[0].url.includes(TOKEN), "el token nunca va en la URL");
    assert.equal((llamadas[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assert.ok(llamadas[0].init.signal instanceof AbortSignal);
    // México: el remitente llega como 521… y la respuesta se dirige a 52….
    assert.equal(JSON.parse(String(llamadas[0].init.body)).to, "523312345678");
    assert.equal(salidaSimulada.length, 0);
  });
});

describe("Destinatario al enviar — solo México 521 → 52", () => {
  const destinoDe = async (waId: string, tipo: "texto" | "lista" = "texto") => {
    llamadas = [];
    simularMeta(() => new Response("{}", { status: 200 }));
    await enviarMensajeWhatsapp(tipo === "texto" ? { tipo, waId, texto: TEXTO } : { tipo, waId, texto: TEXTO, opciones: [{ id: "v1", titulo: "Constructora A" }] });
    return JSON.parse(String(llamadas[0].init.body)).to as string;
  };

  test("521 + 10 dígitos se envía como 52 + 10 dígitos (texto y lista)", async () => {
    assert.equal(await destinoDe("5213312345678"), "523312345678");
    assert.equal(await destinoDe("5215598765432", "lista"), "525598765432");
    assert.equal(destinatarioDeEnvio("5218112345678"), "528112345678");
  });

  test("México ya en formato 52 no cambia", async () => {
    assert.equal(await destinoDe("523312345678"), "523312345678");
    assert.equal(destinatarioDeEnvio("525512345678"), "525512345678");
  });

  test("Números de otros países se envían tal como llegaron", async () => {
    for (const waId of ["14155550100", "34612345678", "5491112345678", "5511987654321", "573001234567", "447911123456", "5215551234", "52133123456789", "5210312345678", "5211312345678"]) {
      assert.equal(await destinoDe(waId), waId, waId);
      assert.equal(destinatarioDeEnvio(waId), waId, waId);
    }
  });
});

describe("Webhook — un envío fallido deja diagnóstico y no altera la vinculación", () => {
  const SUP = { id: "sup-a", nombre: "Supervisor ficticio", rol: "SUPERVISOR", activo: true, empresaId: "A" as string | null, whatsappAutorizado: true };
  const MASTER = { id: "master", nombre: "Master ficticio", rol: "MASTER", activo: true, empresaId: null as string | null, whatsappAutorizado: false };
  const sesionDe = (u: typeof SUP): UsuarioSesion => {
    const base = usuarioDePrueba({ rol: u.rol as UsuarioSesion["rol"], empresaId: u.empresaId ?? undefined });
    return { ...base, id: u.id, empresaId: u.empresaId, empresa: base.empresa ? { ...base.empresa, id: u.empresaId! } : null } as UsuarioSesion;
  };
  let bd: ReturnType<typeof crearBdWhatsapp>;
  let n = 0;
  beforeEach(() => {
    bd = crearBdWhatsapp({
      empresas: [{ id: "A", nombre: "Constructora A", activa: true, whatsappHabilitado: true, inteligenciaHabilitada: false }],
      usuarios: [{ ...SUP }, { ...MASTER }],
    });
  });
  afterEach(() => bd.restaurar());

  const mensaje = (body: string, id = `wamid.envio.${++n}`) => ({ id, from: WA, timestamp: "1760000000", type: "text", text: { body } });
  async function recibir(...mensajes: Record<string, unknown>[]) {
    const cuerpo = Buffer.from(
      JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-number-id-simulado" }, messages: mensajes } }] }] })
    );
    return recibirWebhookWhatsapp(cuerpo, `sha256=${createHmac("sha256", APP_SECRET).update(cuerpo).digest("hex")}`);
  }
  const ultimo = () => bd.t.mensajes.at(-1)!;

  test("Meta rechaza (400/131030): se vincula igual, responde 200, guarda envio:http400:meta131030 y nunca reenvía", async () => {
    simularMeta(() => errorDeMeta(400, 131030));
    const { codigo } = await iniciarVinculacionWhatsapp(sesionDe(SUP), "+52 33 1234 5678");
    const entrega = mensaje(codigo);

    assert.equal((await recibir(entrega)).status, 200, "un envío fallido no pide reentrega a Meta");
    assert.equal(bd.t.vinculos[0].estado, "VERIFICADO", "la vinculación no depende del envío");
    // El vínculo conserva el identificador ORIGINAL de Meta; solo el envío usa 52.
    assert.equal(bd.t.vinculos[0].waId, WA);
    assert.equal(bd.t.vinculos[0].telefonoE164, "+523312345678");
    assert.equal(JSON.parse(String(llamadas[0].init.body)).to, "523312345678");
    assert.equal(ultimo().estadoProceso, "PROCESADO");
    assert.equal(ultimo().resultado, "VINCULADO");
    assert.equal(ultimo().respondido, false);
    assert.equal(ultimo().error, "envio:http400:meta131030");
    assert.equal(ultimo().intentos, 1);
    assert.equal(ultimo().remitentePendiente, null);
    assert.equal(ultimo().textoPendiente, null);
    assert.equal(llamadas.length, 1);

    // Reentrega del mismo mensaje: ya está PROCESADO, no se vuelve a enviar.
    assert.equal((await recibir(entrega)).status, 200);
    assert.equal(llamadas.length, 1, "nunca un segundo envío de la misma respuesta");
    assert.equal(bd.t.mensajes.length, 1);

    // Un fallo de envío no es un error de proceso: los contadores no cambian.
    assert.deepEqual(await obtenerEstadoMensajesMaster(sesionDe(MASTER)), { pendientes: 0, reintentables: 0, definitivos: 0 });

    // Ni la base ni el registro del servidor guardan token, teléfono, texto o respuesta de Meta.
    sinDatosSensibles(JSON.stringify(bd.t.mensajes));
    assert.ok(!JSON.stringify(bd.t.mensajes).includes(codigo));
    assert.deepEqual(avisos, [JSON.stringify({ evento: "whatsapp_envio_fallido", diagnostico: "envio:http400:meta131030" })]);
  });

  test("401, 403, 429, respuesta inesperada y timeout: cada uno deja su diagnóstico; el mensaje queda PROCESADO", async () => {
    const { codigo } = await iniciarVinculacionWhatsapp(sesionDe(SUP), "+52 33 1234 5678");
    simularMeta(() => new Response(JSON.stringify({ messages: [{ id: "wamid.salida" }] }), { status: 200 }));
    await recibir(mensaje(codigo));
    assert.equal(ultimo().respondido, true);
    assert.equal(ultimo().error, null);

    const casos: [() => Response | Promise<Response>, string][] = [
      [() => errorDeMeta(401, 190), "envio:http401:meta190"],
      [() => errorDeMeta(403, 10), "envio:http403:meta10"],
      [() => errorDeMeta(429, 130429), "envio:http429:meta130429"],
      [() => new Response("<html>Bad Gateway</html>", { status: 502 }), "envio:http502"],
      [() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "envio:TimeoutError"],
    ];
    for (const [responder, esperado] of casos) {
      simularMeta(responder);
      assert.equal((await recibir(mensaje("AYUDA"))).status, 200, esperado);
      assert.equal(ultimo().estadoProceso, "PROCESADO", esperado);
      assert.equal(ultimo().resultado, "AYUDA", esperado);
      assert.equal(ultimo().respondido, false, esperado);
      assert.equal(ultimo().error, esperado);
    }
    assert.equal(llamadas.length, 1 + casos.length, "un envío por mensaje, sin reintentos");
    sinDatosSensibles(JSON.stringify(bd.t.mensajes) + avisos.join(""));
  });
});

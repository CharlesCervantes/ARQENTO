import "server-only";
import { destinatarioDeEnvio } from "@/lib/whatsapp/telefono";
import { configuracionWhatsapp } from "./config";

// Envío de mensajes por la Graph API de Meta (Fase 1 WhatsApp + ARQENTO IA).
// Sin WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID (local, pruebas
// automatizadas, cualquier entorno sin configurar) NO sale nada a la red: el
// mensaje se registra en memoria (salidaSimulada) para poder verificarlo.
// Todas las respuestas de esta fase contestan a un mensaje del usuario,
// dentro de la ventana de atención de 24 horas — no requieren plantillas.

export type MensajeSaliente =
  | { tipo: "texto"; waId: string; texto: string }
  | { tipo: "lista"; waId: string; texto: string; opciones: { id: string; titulo: string }[] };

export const salidaSimulada: MensajeSaliente[] = [];

// Rechazo de Meta al enviar (noviembre 2026). Solo lleva dos datos técnicos:
// el HTTP status y, si la respuesta lo trae, el código NUMÉRICO de error de
// Meta (error.code). Nunca el cuerpo de la respuesta, ni su mensaje, ni el
// destinatario, el texto, el token o la URL.
export class EnvioWhatsappError extends Error {
  readonly status: number;
  readonly codigoMeta: number | null;
  constructor(status: number, codigoMeta: number | null) {
    super(`Meta rechazó el envío (HTTP ${status}).`);
    this.name = "EnvioWhatsappError";
    this.status = status;
    this.codigoMeta = codigoMeta;
  }
  // P. ej. "http400:meta131030" o "http401".
  get diagnostico(): string {
    return `http${this.status}${this.codigoMeta === null ? "" : `:meta${this.codigoMeta}`}`;
  }
}

// Lee SOLO error.code de la respuesta de Meta, y solo si es un entero
// razonable; cualquier otra forma (HTML, JSON distinto, cuerpo ilegible o
// enorme) da null. El resto del cuerpo se descarta.
async function codigoDeErrorDeMeta(respuesta: Response): Promise<number | null> {
  try {
    const cuerpo = (await respuesta.text()).slice(0, 4096);
    const codigo = (JSON.parse(cuerpo) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof codigo === "number" && Number.isInteger(codigo) && codigo >= 0 && codigo <= 9_999_999 ? codigo : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Descarga de un archivo recibido (Fase 2A, noviembre 2026)
// ---------------------------------------------------------------------------

// Falla al obtener un archivo de Meta. `definitivo` = reintentar no sirve (el
// archivo ya no existe en Meta o excede el tamaño permitido). `code` es un
// diagnóstico técnico: nunca la URL, el token, el identificador ni el
// contenido.
export class DescargaMediaError extends Error {
  readonly definitivo: boolean;
  readonly motivo: "NO_DISPONIBLE" | "TAMANO";
  readonly code: string;
  constructor(code: string, definitivo: false);
  constructor(code: string, definitivo: true, motivo: "NO_DISPONIBLE" | "TAMANO");
  constructor(code: string, definitivo: boolean, motivo: "NO_DISPONIBLE" | "TAMANO" = "NO_DISPONIBLE") {
    super(`No se pudo obtener el archivo de Meta (${code}).`);
    this.name = "DescargaMedia";
    this.code = code;
    this.definitivo = definitivo;
    this.motivo = motivo;
  }
}

const TIEMPO_CONSULTA_MEDIA_MS = 8000;
const TIEMPO_DESCARGA_MEDIA_MS = 20000;
// La URL de descarga la entrega Meta; aun así se valida contra una lista
// ESTRICTA (protección contra SSRF y contra enviar el token a otro lugar):
// solo HTTPS, puerto por omisión, sin credenciales en la URL y solo hacia los
// dominios de archivos de Meta. La Cloud API entrega los archivos desde
// lookaside.fbsbx.com; los otros dos son las redes de contenido de Meta, por
// si redirige. Las redirecciones NO se siguen de forma automática: cada salto
// pasa por la misma validación (ver descargarConRedireccionesValidadas).
const DOMINIOS_DE_ARCHIVOS_DE_META = ["fbsbx.com", "fbcdn.net", "whatsapp.net"];
const MAX_REDIRECCIONES_MEDIA = 3;

export function urlDeMetaValida(valor: unknown): URL | null {
  if (typeof valor !== "string" || valor.length > 2048) return null;
  try {
    const url = new URL(valor);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
    const host = url.hostname.toLowerCase();
    return DOMINIOS_DE_ARCHIVOS_DE_META.some((d) => host.endsWith(`.${d}`)) ? url : null;
  } catch {
    return null;
  }
}

// Descarga sin seguir redirecciones a ciegas: cada destino se valida contra
// la misma lista antes de pedirlo (y de enviarle el token).
async function descargarConRedireccionesValidadas(inicial: URL, cabeceras: Record<string, string>): Promise<Response> {
  let url = inicial;
  // Un solo límite de tiempo para toda la descarga, con sus redirecciones.
  const limite = AbortSignal.timeout(TIEMPO_DESCARGA_MEDIA_MS);
  for (let salto = 0; ; salto++) {
    const respuesta = await fetch(url, { headers: cabeceras, redirect: "manual", signal: limite });
    if (respuesta.status < 300 || respuesta.status >= 400) return respuesta;
    const destino = urlDeMetaValida(respuesta.headers.get("location"));
    await respuesta.body?.cancel().catch(() => {});
    if (!destino || salto >= MAX_REDIRECCIONES_MEDIA) throw new DescargaMediaError("media-redireccion", false);
    url = destino;
  }
}

function errorDeRespuesta(etapa: string, status: number, codigoMeta: number | null): DescargaMediaError {
  // 400/404: Meta ya no tiene ese archivo (su identificador caduca) — no se
  // reintenta. Lo demás (401/403 de token o permisos, 429, 5xx) es temporal.
  if (status === 400 || status === 404) return new DescargaMediaError(`${etapa}${status}`, true, "NO_DISPONIBLE");
  return new DescargaMediaError(`${etapa}${status}${codigoMeta === null ? "" : `.${codigoMeta}`}`.slice(0, 20), false);
}

// Descarga un archivo recibido: consulta sus datos, comprueba el tamaño que
// declara Meta ANTES de descargar y vuelve a limitarlo durante la descarga
// (nunca se confía en el tamaño declarado). Con límites de tiempo.
export async function descargarMediaDeMeta(mediaId: string, limiteBytes: number): Promise<{ bytes: Buffer; tipoDeclarado: string | null }> {
  const { accessToken, graphVersion } = configuracionWhatsapp();
  if (!accessToken) throw new DescargaMediaError("sin-token", false);
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(mediaId)) throw new DescargaMediaError("id", true, "NO_DISPONIBLE");
  const cabeceras = { Authorization: `Bearer ${accessToken}` };

  const consulta = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}`, {
    headers: cabeceras,
    signal: AbortSignal.timeout(TIEMPO_CONSULTA_MEDIA_MS),
  });
  if (!consulta.ok) throw errorDeRespuesta("media", consulta.status, await codigoDeErrorDeMeta(consulta));
  let datos: { url?: unknown; mime_type?: unknown; file_size?: unknown };
  try {
    datos = (await consulta.json()) as typeof datos;
  } catch {
    throw new DescargaMediaError("media-json", false);
  }
  const url = urlDeMetaValida(datos?.url);
  if (!url) throw new DescargaMediaError("media-url", false);
  const declarado = Number(datos.file_size);
  if (Number.isFinite(declarado) && declarado > limiteBytes) throw new DescargaMediaError("tamano", true, "TAMANO");

  const descarga = await descargarConRedireccionesValidadas(url, cabeceras);
  if (!descarga.ok) throw errorDeRespuesta("archivo", descarga.status, null);
  if (!descarga.body) throw new DescargaMediaError("archivo-vacio", false);
  const partes: Uint8Array[] = [];
  let total = 0;
  const lector = descarga.body.getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > limiteBytes) {
      await lector.cancel().catch(() => {});
      throw new DescargaMediaError("tamano", true, "TAMANO");
    }
    partes.push(value);
  }
  return { bytes: Buffer.concat(partes), tipoDeclarado: typeof datos.mime_type === "string" ? datos.mime_type.slice(0, 100) : null };
}

export async function enviarMensajeWhatsapp(mensaje: MensajeSaliente): Promise<void> {
  const { accessToken, phoneNumberId, graphVersion } = configuracionWhatsapp();
  if (!accessToken || !phoneNumberId) {
    salidaSimulada.push(mensaje);
    return;
  }
  // Solo cambia el formato del destinatario al enviar (México 521 → 52).
  const destinatario = destinatarioDeEnvio(mensaje.waId);
  const cuerpo =
    mensaje.tipo === "texto"
      ? { messaging_product: "whatsapp", to: destinatario, type: "text", text: { body: mensaje.texto } }
      : {
          messaging_product: "whatsapp",
          to: destinatario,
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: mensaje.texto },
            action: {
              button: "Elegir",
              sections: [{ title: "Empresas", rows: mensaje.opciones.slice(0, 10).map((o) => ({ id: o.id, title: o.titulo.slice(0, 24) })) }],
            },
          },
        };
  const respuesta = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(5000),
  });
  if (!respuesta.ok) throw new EnvioWhatsappError(respuesta.status, await codigoDeErrorDeMeta(respuesta));
}

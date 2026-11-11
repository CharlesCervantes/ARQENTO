import "server-only";
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

export async function enviarMensajeWhatsapp(mensaje: MensajeSaliente): Promise<void> {
  const { accessToken, phoneNumberId, graphVersion } = configuracionWhatsapp();
  if (!accessToken || !phoneNumberId) {
    salidaSimulada.push(mensaje);
    return;
  }
  const cuerpo =
    mensaje.tipo === "texto"
      ? { messaging_product: "whatsapp", to: mensaje.waId, type: "text", text: { body: mensaje.texto } }
      : {
          messaging_product: "whatsapp",
          to: mensaje.waId,
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

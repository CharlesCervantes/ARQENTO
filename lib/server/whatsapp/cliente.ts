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
  if (!respuesta.ok) throw new Error(`Meta respondió ${respuesta.status} al enviar el mensaje.`);
}

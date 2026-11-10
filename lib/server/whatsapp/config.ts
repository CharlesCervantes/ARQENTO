import "server-only";
import { createHmac } from "node:crypto";

// Configuración del canal WhatsApp (Meta WhatsApp Business Platform) — solo
// variables de entorno, nunca valores en el código. Sin ellas, el webhook
// responde "no configurado" y no se envía ningún mensaje real (el adaptador
// de envío queda en modo simulado; ver cliente.ts). Fase 1 WhatsApp + ARQENTO
// IA, octubre 2026.

export class WhatsappNoConfiguradoError extends Error {
  constructor(variable: string) {
    super(`WhatsApp no está configurado en este entorno (falta ${variable}).`);
  }
}

export const configuracionWhatsapp = () => ({
  appSecret: process.env.WHATSAPP_APP_SECRET || null,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || null,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
  numeroOficial: process.env.WHATSAPP_NUMERO_OFICIAL || null,
  graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "v21.0",
});

// Secreto para los HMAC de códigos y remitentes — obligatorio para generar o
// verificar códigos (nunca se usa un valor por defecto).
export function secretoWhatsapp(): string {
  const secreto = process.env.WHATSAPP_CODIGO_PEPPER;
  if (!secreto || secreto.length < 16) throw new WhatsappNoConfiguradoError("WHATSAPP_CODIGO_PEPPER");
  return secreto;
}

// Identificador opaco y estable de un remitente (para límites, idempotencia
// y diagnóstico) sin guardar su número.
export function hashRemitente(e164OWaId: string): string {
  return createHmac("sha256", secretoWhatsapp()).update(`remitente:${e164OWaId}`).digest("hex");
}

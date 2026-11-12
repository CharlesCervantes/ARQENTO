import type { NextRequest } from "next/server";
import { configuracionWhatsapp } from "@/lib/server/whatsapp/config";
import { verificarTokenSuscripcion } from "@/lib/server/whatsapp/firma";
import { recibirWebhookWhatsapp } from "@/lib/server/whatsapp/mensajes";

// Webhook de Meta WhatsApp Business Platform (Fase 1 WhatsApp + ARQENTO IA,
// octubre 2026). Ruta pública (proxy.ts excluye /api), protegida por la
// firma de Meta. Vinculación de usuarios y, desde la Fase 2A, recepción de
// comprobantes (fotografía o PDF) para revisión humana; nunca responde
// información interna.

// Recibir un comprobante incluye descargarlo de Meta y guardarlo. Nada
// depende de que esta ejecución termine (la recepción se reanuda por
// etapas), pero se le da margen para completarla en el primer intento.
export const maxDuration = 60;

const LIMITE_BYTES = 256 * 1024;

// Verificación de la suscripción (Meta → configuración del webhook).
export async function GET(request: NextRequest) {
  const { verifyToken } = configuracionWhatsapp();
  if (!verifyToken) return new Response(null, { status: 503 });
  const parametros = request.nextUrl.searchParams;
  const challenge = parametros.get("hub.challenge");
  if (parametros.get("hub.mode") === "subscribe" && challenge && verificarTokenSuscripcion(parametros.get("hub.verify_token"), verifyToken)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(null, { status: 403 });
}

export async function POST(request: NextRequest) {
  const declarado = Number(request.headers.get("content-length") ?? "0");
  if (declarado > LIMITE_BYTES) return new Response(null, { status: 413 });
  // La firma se valida sobre los BYTES ORIGINALES del cuerpo.
  const cuerpo = Buffer.from(await request.arrayBuffer());
  try {
    const { status } = await recibirWebhookWhatsapp(cuerpo, request.headers.get("x-hub-signature-256"));
    return new Response(null, { status });
  } catch {
    // No se pudo registrar (p. ej. base no disponible): 500 para que Meta
    // reintente — el registro por wamid evita procesar dos veces.
    return new Response(null, { status: 500 });
  }
}

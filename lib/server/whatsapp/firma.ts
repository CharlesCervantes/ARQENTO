import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Autenticidad del webhook de Meta (Fase 1 WhatsApp + ARQENTO IA):
// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(App Secret, CUERPO ORIGINAL).
// Se calcula sobre los bytes exactos recibidos — nunca sobre el JSON
// re-serializado — y se compara en tiempo constante.

export function verificarFirmaMeta(cuerpo: Buffer, cabecera: string | null, appSecret: string): boolean {
  if (!cabecera || !cabecera.startsWith("sha256=")) return false;
  const recibida = cabecera.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(recibida)) return false;
  const esperada = createHmac("sha256", appSecret).update(cuerpo).digest("hex");
  return timingSafeEqual(Buffer.from(esperada, "hex"), Buffer.from(recibida.toLowerCase(), "hex"));
}

// Verificación de suscripción (GET hub.verify_token), en tiempo constante.
export function verificarTokenSuscripcion(recibido: string | null, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

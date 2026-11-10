import { createHmac, randomInt } from "node:crypto";

// Código temporal de vinculación de WhatsApp (Fase 1, octubre 2026):
// "ARQ-" + 6 caracteres de un alfabeto sin caracteres ambiguos (sin I, L, O,
// 0 ni 1) — 31^6 ≈ 887 millones de combinaciones. Un solo uso, 15 minutos,
// 5 intentos. Solo se guarda su HMAC con un secreto del servidor.

export const PREFIJO_CODIGO = "ARQ-";
export const ALFABETO_CODIGO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const VIGENCIA_CODIGO_MINUTOS = 15;
export const MAX_INTENTOS_CODIGO = 5;
export const MAX_CODIGOS_POR_HORA = 5;

export function generarCodigoVinculacion(): string {
  let cuerpo = "";
  for (let i = 0; i < 6; i++) cuerpo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  return `${PREFIJO_CODIGO}${cuerpo}`;
}

// Busca un código dentro de un mensaje de texto ("ARQ-7K2M9Q", "arq 7k2m9q",
// "Mi código es ARQ7K2M9Q"). Devuelve la forma canónica o null.
export function extraerCodigoVinculacion(texto: string): string | null {
  const m = /\bARQ[\s-]?([A-Z0-9]{6})\b/i.exec(texto ?? "");
  if (!m) return null;
  const cuerpo = m[1].toUpperCase();
  if (![...cuerpo].every((c) => ALFABETO_CODIGO.includes(c))) return null;
  return `${PREFIJO_CODIGO}${cuerpo}`;
}

export function hashCodigoVinculacion(codigo: string, secreto: string): string {
  return createHmac("sha256", secreto).update(`codigo:${codigo.toUpperCase()}`).digest("hex");
}

// Normalización de teléfonos para WhatsApp (Fase 1 WhatsApp + ARQENTO IA,
// octubre 2026) — sin dependencias externas. Reglas deliberadamente
// conservadoras: nunca se "adivina" un país ni se reescribe un número salvo
// el único caso conocido y sin ambigüedad.
//
// - Siempre formato internacional: "+" (o "00") + código de país + número.
//   Un número sin código de país se rechaza (nunca se asume México).
// - E.164: de 8 a 15 dígitos, sin empezar en 0.
// - México (+52): el número nacional siempre tiene 10 dígitos y ninguna
//   clave lada empieza en 0 ni 1. WhatsApp todavía reporta a veces números
//   móviles mexicanos con el prefijo antiguo "1" (+52 1 XXXXXXXXXX); ese 1
//   extra es la ÚNICA transformación que se aplica, y solo cuando quedan
//   exactamente 11 dígitos nacionales que empiezan con 1.
// - Cualquier otro país se conserva tal cual (p. ej. Argentina +54 9 …: el
//   9 forma parte de cómo lo reporta WhatsApp y no se toca).

export type ResultadoTelefono = { ok: true; e164: string } | { ok: false; error: string };

const MENSAJE_FORMATO = "Escribe el número en formato internacional, con + y código de país (por ejemplo, +52 33 1234 5678).";

export function normalizarTelefono(entrada: string): ResultadoTelefono {
  let t = (entrada ?? "").trim().replace(/[\s\-().]/g, "");
  if (t.startsWith("00")) t = `+${t.slice(2)}`;
  if (!t.startsWith("+")) return { ok: false, error: MENSAJE_FORMATO };
  const digitos = t.slice(1);
  if (!/^[1-9]\d{7,14}$/.test(digitos)) return { ok: false, error: MENSAJE_FORMATO };

  if (digitos.startsWith("52")) {
    let nacional = digitos.slice(2);
    if (nacional.length === 11 && nacional.startsWith("1")) nacional = nacional.slice(1);
    if (!/^[2-9]\d{9}$/.test(nacional)) {
      return { ok: false, error: "Un número de México debe tener 10 dígitos después de +52." };
    }
    return { ok: true, e164: `+52${nacional}` };
  }
  return { ok: true, e164: `+${digitos}` };
}

// wa_id de Meta: solo dígitos, con código de país y sin "+".
export function normalizarWaId(waId: string): ResultadoTelefono {
  if (!/^\d+$/.test(waId ?? "")) return { ok: false, error: "Identificador de WhatsApp inválido." };
  return normalizarTelefono(`+${waId}`);
}

// Teléfono enmascarado para mostrarlo a terceros (Master, administradores):
// solo el código de país (o sus primeros dígitos) y los últimos 4.
export function enmascararTelefono(e164: string): string {
  const digitos = e164.replace(/^\+/, "");
  if (digitos.length < 6) return "+••••";
  const prefijo = digitos.startsWith("52") ? "52" : digitos.startsWith("1") ? "1" : digitos.slice(0, 2);
  return `+${prefijo} •••• ${digitos.slice(-4)}`;
}

// Respuestas del número oficial de ARQENTO en la Fase 1 (octubre 2026).
// Reglas: siempre genéricas, nunca información financiera, ni nombres de
// obras, ni datos de otros usuarios. Para no permitir enumeración, TODA
// falla de vinculación (código incorrecto, vencido, usado, de otro teléfono,
// usuario o Empresa inactivos, WhatsApp apagado…) recibe el MISMO texto, y un
// número sin vínculo verificado recibe siempre el mismo mensaje genérico.

export const RESPUESTAS_WHATSAPP = {
  vinculado: "Listo: tu WhatsApp quedó vinculado a tu usuario de ARQENTO.",
  vinculacionFallida:
    "No pudimos completar la vinculación. Genera un código nuevo desde tu perfil en ARQENTO e inténtalo de nuevo.",
  numeroNoVinculado:
    "Este número no está vinculado a ARQENTO. Para vincularlo, genera un código desde tu perfil en ARQENTO y envíalo aquí.",
  ayuda:
    "Tu número está vinculado a ARQENTO. Por ahora este número solo se usa para vincular cuentas; pronto podrás enviar comprobantes.",
  soloVinculacion: "Por ahora este número solo recibe códigos de vinculación. No envíes comprobantes todavía.",
  unaSolaEmpresa: "Tu número está vinculado a una sola Empresa en ARQENTO.",
  eligeEmpresa: "¿Con qué Empresa quieres trabajar?",
  empresaElegida: (empresa: string) => `Listo: trabajarás con ${empresa} durante los próximos 30 minutos.`,
} as const;

// Comandos de texto aceptados en la Fase 1 (además de un código ARQ-…).
export type ComandoWhatsapp = "AYUDA" | "EMPRESA" | null;

export function comandoDeTexto(texto: string): ComandoWhatsapp {
  const t = (texto ?? "").trim().toUpperCase();
  if (t === "AYUDA" || t === "HOLA" || t === "MENU" || t === "MENÚ") return "AYUDA";
  if (t === "EMPRESA" || t === "CAMBIAR EMPRESA" || t === "EMPRESAS") return "EMPRESA";
  return null;
}

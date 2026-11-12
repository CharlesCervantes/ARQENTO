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
  ayuda: "Tu número está vinculado a ARQENTO. Puedes enviar aquí la fotografía o el PDF de un comprobante para que lo revisen en tu Empresa.",
  soloVinculacion: "Por ahora solo recibimos fotografías y archivos PDF de comprobantes.",
  // Fase 2A (noviembre 2026) — recepción de comprobantes. Siempre genéricas:
  // la misma confirmación para un archivo nuevo y para uno repetido, y nunca
  // importes, proveedores ni datos del documento.
  archivoRecibido: "Recibimos tu comprobante. Quedó pendiente de revisión en ARQENTO.",
  archivoNoPermitido: "No pudimos recibir ese archivo. Envía una fotografía (JPG o PNG) o un PDF de hasta 10 MB y 20 páginas.",
  archivoNoDisponible: "No pudimos obtener tu archivo. Envíalo de nuevo, por favor.",
  // El comprobante no se perdió: quedó detenido y recuperable.
  archivoDetenido:
    "Todavía no pudimos guardar tu comprobante. Quedó pendiente y tu Empresa puede reintentarlo desde ARQENTO. Consérvalo por si te piden enviarlo de nuevo.",
  // Límite de archivos por número: nunca se descarta en silencio.
  archivoLimitado:
    "Recibimos demasiados archivos de este número en poco tiempo y este comprobante no se guardó. Espera 10 minutos y vuelve a enviarlo. Los que envíes antes de ese tiempo tampoco se guardarán.",
  eligeEmpresaYReenvia: "Tu número está vinculado a varias Empresas. Elige con cuál quieres trabajar y después vuelve a enviar el comprobante.",
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

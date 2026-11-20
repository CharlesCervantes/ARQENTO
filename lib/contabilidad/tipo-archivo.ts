// Tipo REAL de un archivo por sus primeros bytes (magic bytes) — nunca se
// confía en el tipo que declara quien lo envía (navegador o WhatsApp) ni en
// la extensión del nombre. Lo comparten la subida web de Captura Inteligente
// y la recepción por WhatsApp (Fase 2A, noviembre 2026). Función pura.

export type MimeSoportado = "application/pdf" | "image/jpeg" | "image/png";

export const MAX_BYTES_POR_DOCUMENTO = 10 * 1024 * 1024; // 10 MB
export const MAX_PAGINAS_POR_DOCUMENTO = 20;

const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function tipoArchivoDetectado(bytes: Uint8Array): MimeSoportado | null {
  if (bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && FIRMA_PNG.every((b, i) => bytes[i] === b)) return "image/png";
  return null;
}

const EXTENSION: Record<MimeSoportado, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

// Nombre SEGURO para guardar un archivo recibido: solo letras, números,
// punto, guion y guion bajo; sin rutas, sin espacios, con la extensión del
// tipo REAL y longitud acotada. Si el nombre original no sirve (las fotos de
// WhatsApp no traen nombre), se usa uno genérico con la fecha.
export function nombreSeguroDeArchivo(nombreOriginal: string | null | undefined, tipo: MimeSoportado, fecha: Date): string {
  const extension = EXTENSION[tipo];
  const base = (nombreOriginal ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const sello = fecha.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `${base || `comprobante-${sello}`}.${extension}`;
}

export const MAX_CARACTERES_CONTEXTO = 200;

// Pie de foto como CONTEXTO del comprobante: texto plano en una sola línea,
// sin caracteres de control, acotado. Es una nota de quien lo envió — nunca
// información financiera confirmada. Vacío → null.
export function contextoDePieDeFoto(texto: string | null | undefined): string | null {
  const limpio = (texto ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CARACTERES_CONTEXTO)
    .trim();
  return limpio || null;
}

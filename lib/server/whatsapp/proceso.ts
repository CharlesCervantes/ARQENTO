import "server-only";
import { db } from "@/lib/server/db";
import { EnvioWhatsappError, enviarMensajeWhatsapp, type MensajeSaliente } from "./cliente";

// Piezas comunes del procesamiento de un mensaje de WhatsApp (texto o
// archivo): conteo de intentos, diagnóstico sin datos personales y envío de
// la respuesta. Las comparten mensajes.ts y archivos-recibidos.ts.

export const MAX_INTENTOS_PROCESO = 3;

// PROCESADO: quedó procesado en esta llamada. OMITIDO: ya estaba procesado
// (u otra llamada lo terminó), con error definitivo o detenido.
// ERROR_REINTENTABLE: falló y aún tiene intentos — hay que pedir a Meta que
// lo reentregue. DETENIDO: un mensaje CON ARCHIVO agotó los intentos
// automáticos; no se descarta ni se borra nada: queda identificable y solo
// avanza con un reintento explícito (bandeja de su Empresa o Master).
export type ResultadoProceso = "PROCESADO" | "OMITIDO" | "ERROR_REINTENTABLE" | "ERROR_DEFINITIVO" | "DETENIDO";

export const RESULTADO_DETENIDO = "ARCHIVO_DETENIDO";

// Diagnóstico técnico SIN datos personales: solo el tipo de error y, si
// existe, su código (p. ej. "PrismaClientKnownRequestError:P2034"). Nunca el
// mensaje del error (podría citar valores, números o texto del usuario).
export function diagnosticoDeError(error: unknown): string {
  const nombre = error instanceof Error ? error.name : typeof error;
  const codigo = (error as { code?: unknown } | null)?.code;
  const sufijo = typeof codigo === "string" && /^[A-Za-z0-9_.-]{1,20}$/.test(codigo) ? `:${codigo}` : "";
  return `${nombre}${sufijo}`.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 100) || "Error";
}

// `intentoYaContado`: la recepción de archivos cuenta el intento AL EMPEZAR
// (así una ejecución que la plataforma corta a la mitad también cuenta).
export async function marcarErrorDeProceso(id: string, error: unknown, opciones: { intentoYaContado?: boolean } = {}): Promise<ResultadoProceso> {
  const actual = await db.mensajeWhatsapp.findUnique({ where: { id }, select: { intentos: true, estadoProceso: true, archivoPendiente: true } });
  if (!actual || actual.estadoProceso === "PROCESADO") return "OMITIDO";
  const intentos = actual.intentos + (opciones.intentoYaContado ? 0 : 1);
  const agotado = intentos >= MAX_INTENTOS_PROCESO;
  // Un comprobante NUNCA se descarta por fallas del sistema: se detiene y
  // conserva lo necesario para recuperarlo (identificador en Meta, archivo ya
  // almacenado, remitente).
  const detenido = agotado && actual.archivoPendiente !== null;
  const definitivo = agotado && !detenido;
  await db.mensajeWhatsapp.update({
    where: { id },
    data: {
      estadoProceso: "ERROR",
      intentos,
      // Diagnóstico técnico (tipo/código del error, intentos, tipo de
      // mensaje, fechas y el HMAC del remitente se conservan); nunca datos
      // personales.
      error: `proceso:${diagnosticoDeError(error)}`,
      ...(detenido ? { resultado: RESULTADO_DETENIDO } : {}),
      // Mensaje de texto con los reintentos agotados: no se conserva el
      // número ni el texto.
      ...(definitivo ? { resultado: "ERROR_DEFINITIVO", remitentePendiente: null, textoPendiente: null, procesadoEn: new Date() } : {}),
    },
  });
  return detenido ? "DETENIDO" : definitivo ? "ERROR_DEFINITIVO" : "ERROR_REINTENTABLE";
}

// Envía la respuesta de un mensaje YA resuelto. Informativa: nunca se
// reenvía (evita duplicados). Si falla queda el diagnóstico: el HTTP status y
// el código numérico de Meta ("envio:http400:meta131030") o el tipo de error
// ("envio:TimeoutError"). Nunca destinatario, texto ni token.
// `conservarError`: no sustituye el diagnóstico de proceso ya guardado.
export async function responderMensaje(id: string, respuesta: MensajeSaliente | null, opciones: { conservarError?: boolean } = {}): Promise<void> {
  if (!respuesta) return;
  try {
    await enviarMensajeWhatsapp(respuesta);
    await db.mensajeWhatsapp.update({ where: { id }, data: { respondido: true } });
  } catch (error) {
    const diagnostico = `envio:${error instanceof EnvioWhatsappError ? error.diagnostico : diagnosticoDeError(error)}`;
    console.warn(JSON.stringify({ evento: "whatsapp_envio_fallido", diagnostico }));
    if (!opciones.conservarError) await db.mensajeWhatsapp.update({ where: { id }, data: { error: diagnostico } }).catch(() => {});
  }
}

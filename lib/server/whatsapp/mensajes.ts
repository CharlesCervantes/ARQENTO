import "server-only";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { normalizarWaId } from "@/lib/whatsapp/telefono";
import { extraerCodigoVinculacion } from "@/lib/whatsapp/codigo";
import { RESPUESTAS_WHATSAPP, comandoDeTexto } from "@/lib/whatsapp/respuestas";
import { extraerMensajesEntrantes, type MensajeEntrante } from "@/lib/whatsapp/payload";
import { WhatsappNoConfiguradoError, configuracionWhatsapp, hashRemitente, secretoWhatsapp } from "./config";
import { verificarFirmaMeta } from "./firma";
import { EnvioWhatsappError, enviarMensajeWhatsapp, type MensajeSaliente } from "./cliente";
import { verificarCodigoTx, vinculosUtilizablesTx } from "./vinculos";
import { seleccionarEmpresaTx } from "./seleccion-empresa";

// Recepción de mensajes de WhatsApp (Fase 1 WhatsApp + ARQENTO IA, octubre
// 2026). Solo vinculación: NUNCA se descargan ni procesan archivos, y nunca
// hay consultas financieras ni operaciones contables por este canal.
//
// - Idempotente: cada mensaje se registra UNA vez por su wamid (único) y se
//   procesa una sola vez (bloqueo de fila + estado PROCESADO); la respuesta
//   al usuario solo se envía tras confirmar el PROCESADO, nunca dos veces.
// - Recuperable (noviembre 2026), sin depender de trabajo posterior a la
//   respuesta (after()):
//   1. Si falla el REGISTRO, el webhook responde 500 y Meta reentrega.
//   2. Si un mensaje queda con error REINTENTABLE (o sin poder marcarse),
//      el webhook responde 500: Meta reentrega el mismo wamid (hasta 7
//      días) y el registro existente se vuelve a procesar.
//   3. Una reentrega de un mensaje que sigue PENDIENTE o con error
//      reintentable (p. ej. la función se cortó a medio proceso) también se
//      procesa — un duplicado nunca se descarta en silencio.
//   4. Al tercer intento el error es DEFINITIVO: se responde 200 (Meta deja
//      de reentregar) y quedan solo datos técnicos de diagnóstico.
//   5. Respaldo explícito: Master puede reprocesar los pendientes
//      (reprocesarMensajesPendientesMaster) y la misma función queda lista
//      para un cron (no activado).
// - Mínimo de datos: del remitente solo queda un HMAC; su wa_id y el texto
//   se guardan solo mientras el mensaje está pendiente y se borran al
//   procesarlo o al agotar los intentos.

export const MAX_MENSAJES_POR_VENTANA = 20;
export const VENTANA_LIMITE_MINUTOS = 10;
export const MAX_INTENTOS_PROCESO = 3;
const MAX_MENSAJES_POR_LLAMADA = 20;
const LIMITE_BYTES_WEBHOOK = 256 * 1024;
const RESPUESTA_GENERICA_CADA_HORAS = 24;

type Cliente = Prisma.TransactionClient;

export type ResultadoWebhook = { status: number };

export async function recibirWebhookWhatsapp(cuerpo: Buffer, firma: string | null): Promise<ResultadoWebhook> {
  const { appSecret, phoneNumberId } = configuracionWhatsapp();
  if (!appSecret || !phoneNumberId) return { status: 503 };
  // Sin secreto de códigos/remitentes no se procesa nada: configuración
  // incompleta, igual que si faltara todo (503).
  try {
    secretoWhatsapp();
  } catch (error) {
    if (error instanceof WhatsappNoConfiguradoError) return { status: 503 };
    throw error;
  }
  if (cuerpo.length > LIMITE_BYTES_WEBHOOK) return { status: 413 };
  if (!verificarFirmaMeta(cuerpo, firma, appSecret)) return { status: 401 };

  let payload: unknown;
  try {
    payload = JSON.parse(cuerpo.toString("utf8"));
  } catch {
    return { status: 400 };
  }

  // Si el registro falla, la excepción llega a la ruta → 500 → Meta reentrega.
  const porProcesar = await registrarMensajesEntrantes(extraerMensajesEntrantes(payload, phoneNumberId).slice(0, MAX_MENSAJES_POR_LLAMADA));
  let reentregar = false;
  for (const id of porProcesar) {
    if ((await procesarMensajeWhatsapp(id)) === "ERROR_REINTENTABLE") reentregar = true;
  }
  // Recuperación oportunista de pendientes de llamadas anteriores (acotada);
  // no cambia la respuesta de ESTA entrega.
  // Excluye los de esta entrega: un fallo no se reintenta en la misma llamada
  // (cada intento corresponde a una entrega de Meta o a un reproceso).
  await procesarMensajesPendientes(5, porProcesar).catch(() => {});
  return { status: reentregar ? 500 : 200 };
}

// Registro idempotente por wamid. Devuelve los ids a procesar: los mensajes
// NUEVOS y los ya registrados que siguen pendientes o con error reintentable
// (una reentrega de Meta). Los ya procesados o con error definitivo se omiten.
export async function registrarMensajesEntrantes(mensajes: MensajeEntrante[]): Promise<string[]> {
  const porProcesar: string[] = [];
  for (const m of mensajes) {
    const telefono = normalizarWaId(m.waId);
    try {
      const creado = await db.mensajeWhatsapp.create({
        data: {
          wamid: m.wamid,
          remitenteHash: hashRemitente(telefono.ok ? telefono.e164 : `waid:${m.waId}`),
          remitentePendiente: m.waId,
          tipo: m.tipo,
          textoPendiente: m.seleccionId ? `seleccion:${m.seleccionId}` : m.texto,
          recibidoEn: m.recibidoEn,
        },
        select: { id: true },
      });
      porProcesar.push(creado.id);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      // Reentrega de Meta: se reprocesa solo si quedó pendiente o reintentable.
      const existente = await db.mensajeWhatsapp.findUnique({
        where: { wamid: m.wamid },
        select: { id: true, estadoProceso: true, intentos: true, remitentePendiente: true },
      });
      if (existente && esRecuperable(existente)) porProcesar.push(existente.id);
    }
  }
  return [...new Set(porProcesar)];
}

const esRecuperable = (m: { estadoProceso: string; intentos: number; remitentePendiente: string | null }) =>
  m.remitentePendiente !== null && (m.estadoProceso === "PENDIENTE" || (m.estadoProceso === "ERROR" && m.intentos < MAX_INTENTOS_PROCESO));

// Diagnóstico técnico SIN datos personales: solo el tipo de error y, si
// existe, su código (p. ej. "PrismaClientKnownRequestError:P2034"). Nunca el
// mensaje del error (podría citar valores, números o texto del usuario).
export function diagnosticoDeError(error: unknown): string {
  const nombre = error instanceof Error ? error.name : typeof error;
  const codigo = (error as { code?: unknown } | null)?.code;
  const sufijo = typeof codigo === "string" && /^[A-Za-z0-9_.-]{1,20}$/.test(codigo) ? `:${codigo}` : "";
  return `${nombre}${sufijo}`.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 100) || "Error";
}

type Decision = {
  resultado: string;
  vinculoId?: string | null;
  empresaId?: string | null;
  usuarioId?: string | null;
  respuesta: MensajeSaliente | null;
};

// PROCESADO: quedó procesado en esta llamada. OMITIDO: ya estaba procesado
// (u otra llamada lo terminó) o con error definitivo. ERROR_REINTENTABLE:
// falló y aún tiene intentos — hay que pedir a Meta que lo reentregue.
export type ResultadoProceso = "PROCESADO" | "OMITIDO" | "ERROR_REINTENTABLE" | "ERROR_DEFINITIVO";

export async function procesarMensajeWhatsapp(id: string): Promise<ResultadoProceso> {
  let respuesta: MensajeSaliente | null = null;
  try {
    const r = await db.$transaction(async (tx) => {
      // Un mensaje se procesa una sola vez aunque dos llamadas lo intenten:
      // la segunda espera el bloqueo y encuentra PROCESADO.
      await tx.$queryRaw`SELECT id FROM mensajes_whatsapp WHERE id = ${id} FOR UPDATE`;
      const m = await tx.mensajeWhatsapp.findUnique({ where: { id } });
      if (!m || m.estadoProceso === "PROCESADO" || !m.remitentePendiente) return { omitido: true as const };
      const d = await decidirTx(tx, {
        remitenteHash: m.remitenteHash,
        waId: m.remitentePendiente,
        tipo: m.tipo,
        texto: m.textoPendiente ?? "",
      });
      await tx.mensajeWhatsapp.update({
        where: { id },
        data: {
          estadoProceso: "PROCESADO",
          resultado: d.resultado,
          vinculoId: d.vinculoId ?? null,
          empresaId: d.empresaId ?? null,
          usuarioId: d.usuarioId ?? null,
          procesadoEn: new Date(),
          intentos: { increment: 1 },
          error: null,
          remitentePendiente: null,
          textoPendiente: null,
        },
      });
      return { omitido: false as const, respuesta: d.respuesta };
    });
    if (r.omitido) return "OMITIDO";
    respuesta = r.respuesta;
  } catch (error) {
    // Si ni siquiera se pudo marcar el error (p. ej. base caída), el mensaje
    // sigue pendiente: también es reintentable.
    return marcarErrorDeProceso(id, error).catch((): ResultadoProceso => "ERROR_REINTENTABLE");
  }
  // La respuesta solo sale después del COMMIT del PROCESADO; una reentrega
  // encuentra PROCESADO y la omite — nunca se responde dos veces.
  if (respuesta) {
    try {
      await enviarMensajeWhatsapp(respuesta);
      await db.mensajeWhatsapp.update({ where: { id }, data: { respondido: true } });
    } catch (error) {
      // Informativa: nunca se reenvía (evita duplicados). Queda el diagnóstico:
      // si Meta rechazó el envío, su HTTP status y su código numérico
      // ("envio:http400:meta131030"); si no hubo respuesta, el tipo de error
      // ("envio:TimeoutError"). Nunca destinatario, texto ni token.
      const diagnostico = `envio:${error instanceof EnvioWhatsappError ? error.diagnostico : diagnosticoDeError(error)}`;
      console.warn(JSON.stringify({ evento: "whatsapp_envio_fallido", diagnostico }));
      await db.mensajeWhatsapp.update({ where: { id }, data: { error: diagnostico } }).catch(() => {});
    }
  }
  return "PROCESADO";
}

async function marcarErrorDeProceso(id: string, error: unknown): Promise<ResultadoProceso> {
  const actual = await db.mensajeWhatsapp.findUnique({ where: { id }, select: { intentos: true, estadoProceso: true } });
  if (!actual || actual.estadoProceso === "PROCESADO") return "OMITIDO";
  const intentos = actual.intentos + 1;
  const definitivo = intentos >= MAX_INTENTOS_PROCESO;
  await db.mensajeWhatsapp.update({
    where: { id },
    data: {
      estadoProceso: "ERROR",
      intentos,
      // Diagnóstico técnico (tipo/código del error, intentos, tipo de
      // mensaje, fechas y el HMAC del remitente se conservan); nunca datos
      // personales.
      error: `proceso:${diagnosticoDeError(error)}`,
      // Agotados los reintentos, no se conserva el número ni el texto.
      ...(definitivo ? { resultado: "ERROR_DEFINITIVO", remitentePendiente: null, textoPendiente: null, procesadoEn: new Date() } : {}),
    },
  });
  return definitivo ? "ERROR_DEFINITIVO" : "ERROR_REINTENTABLE";
}

export type ResumenReproceso = { revisados: number; procesados: number; reintentables: number; definitivos: number; omitidos: number };

// Reprocesa mensajes que quedaron PENDIENTES (más de 30 s, para no competir
// con la llamada que los está procesando) o con error reintentable. La usan
// el webhook (de forma oportunista), la acción explícita de Master y, en el
// futuro, un cron (no activado).
export async function procesarMensajesPendientes(limite = 10, excluir: string[] = []): Promise<ResumenReproceso> {
  const corte = new Date(Date.now() - 30_000);
  const candidatos = await db.mensajeWhatsapp.findMany({
    where: {
      remitentePendiente: { not: null },
      ...(excluir.length > 0 ? { id: { notIn: excluir } } : {}),
      OR: [
        { estadoProceso: "PENDIENTE", createdAt: { lt: corte } },
        { estadoProceso: "ERROR", intentos: { lt: MAX_INTENTOS_PROCESO } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limite,
    select: { id: true },
  });
  const resumen: ResumenReproceso = { revisados: candidatos.length, procesados: 0, reintentables: 0, definitivos: 0, omitidos: 0 };
  for (const c of candidatos) {
    const r = await procesarMensajeWhatsapp(c.id);
    if (r === "PROCESADO") resumen.procesados++;
    else if (r === "ERROR_REINTENTABLE") resumen.reintentables++;
    else if (r === "ERROR_DEFINITIVO") resumen.definitivos++;
    else resumen.omitidos++;
  }
  return resumen;
}

// Estado del canal para Master: solo conteos, sin números ni textos.
export async function estadoMensajesWhatsapp() {
  const corte = new Date(Date.now() - 30_000);
  const [pendientes, reintentables, definitivos] = await Promise.all([
    db.mensajeWhatsapp.count({ where: { estadoProceso: "PENDIENTE", remitentePendiente: { not: null }, createdAt: { lt: corte } } }),
    db.mensajeWhatsapp.count({ where: { estadoProceso: "ERROR", remitentePendiente: { not: null }, intentos: { lt: MAX_INTENTOS_PROCESO } } }),
    db.mensajeWhatsapp.count({ where: { estadoProceso: "ERROR", resultado: "ERROR_DEFINITIVO" } }),
  ]);
  return { pendientes, reintentables, definitivos };
}

async function decidirTx(tx: Cliente, m: { remitenteHash: string; waId: string; tipo: string; texto: string }): Promise<Decision> {
  const ahora = new Date();
  const texto = (contenido: string): MensajeSaliente => ({ tipo: "texto", waId: m.waId, texto: contenido });

  // Límite contra abuso por número (incluye este mensaje).
  const recientes = await tx.mensajeWhatsapp.count({
    where: { remitenteHash: m.remitenteHash, createdAt: { gte: new Date(ahora.getTime() - VENTANA_LIMITE_MINUTOS * 60_000) } },
  });
  if (recientes > MAX_MENSAJES_POR_VENTANA) return { resultado: "LIMITADO", respuesta: null };

  const telefono = normalizarWaId(m.waId);
  const e164 = telefono.ok ? telefono.e164 : null;

  // 1) Código de vinculación — mismo mensaje ante cualquier falla.
  const codigo = m.tipo === "text" ? extraerCodigoVinculacion(m.texto) : null;
  if (codigo) {
    const r = await verificarCodigoTx(tx, { codigo, telefonoE164: e164, waId: m.waId, ahora });
    return r.vinculado
      ? { resultado: "VINCULADO", vinculoId: r.vinculoId, empresaId: r.empresaId, usuarioId: r.usuarioId, respuesta: texto(RESPUESTAS_WHATSAPP.vinculado) }
      : { resultado: "CODIGO_INVALIDO", respuesta: texto(RESPUESTAS_WHATSAPP.vinculacionFallida) };
  }

  // 2) Número sin vínculo utilizable: una respuesta genérica cada 24 horas.
  const vinculos = e164 ? await vinculosUtilizablesTx(tx, e164) : [];
  if (vinculos.length === 0) {
    const yaRespondido = await tx.mensajeWhatsapp.findFirst({
      where: {
        remitenteHash: m.remitenteHash,
        resultado: "NO_VINCULADO",
        respondido: true,
        createdAt: { gte: new Date(ahora.getTime() - RESPUESTA_GENERICA_CADA_HORAS * 3_600_000) },
      },
      select: { id: true },
    });
    return { resultado: "NO_VINCULADO", respuesta: yaRespondido ? null : texto(RESPUESTAS_WHATSAPP.numeroNoVinculado) };
  }
  const contexto = vinculos.length === 1 ? { vinculoId: vinculos[0].id, empresaId: vinculos[0].empresaId, usuarioId: vinculos[0].usuarioId } : {};

  // 3) Selección de Empresa (respuesta a la lista interactiva).
  if (m.tipo === "interactive" && m.texto.startsWith("seleccion:")) {
    const elegido = await seleccionarEmpresaTx(tx, { remitenteHash: m.remitenteHash, vinculoId: m.texto.slice("seleccion:".length), vinculos, ahora });
    if (!elegido) return { resultado: "SELECCION_INVALIDA", ...contexto, respuesta: listaDeEmpresas(m.waId, vinculos) };
    return {
      resultado: "EMPRESA_SELECCIONADA",
      vinculoId: elegido.id,
      empresaId: elegido.empresaId,
      usuarioId: elegido.usuarioId,
      respuesta: texto(RESPUESTAS_WHATSAPP.empresaElegida(elegido.empresa.nombre)),
    };
  }

  // 4) Comandos de texto.
  if (m.tipo === "text") {
    if (comandoDeTexto(m.texto) === "EMPRESA") {
      return vinculos.length > 1
        ? { resultado: "EMPRESAS_OFRECIDAS", respuesta: listaDeEmpresas(m.waId, vinculos) }
        : { resultado: "UNA_EMPRESA", ...contexto, respuesta: texto(RESPUESTAS_WHATSAPP.unaSolaEmpresa) };
    }
    return { resultado: "AYUDA", ...contexto, respuesta: texto(RESPUESTAS_WHATSAPP.ayuda) };
  }

  // 5) Imágenes, documentos, audio…: en esta fase NUNCA se descargan.
  return { resultado: "ARCHIVO_IGNORADO", ...contexto, respuesta: texto(RESPUESTAS_WHATSAPP.soloVinculacion) };
}

// Solo nombres de las Empresas con vínculo verificado y utilizable de ESTE
// número (D5) — nunca obras, importes ni datos de otros usuarios.
function listaDeEmpresas(waId: string, vinculos: Awaited<ReturnType<typeof vinculosUtilizablesTx>>): MensajeSaliente {
  return {
    tipo: "lista",
    waId,
    texto: RESPUESTAS_WHATSAPP.eligeEmpresa,
    opciones: vinculos.map((v) => ({ id: v.id, titulo: v.empresa.nombre })),
  };
}

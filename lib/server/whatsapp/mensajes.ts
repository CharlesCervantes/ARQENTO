import "server-only";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { normalizarWaId } from "@/lib/whatsapp/telefono";
import { extraerCodigoVinculacion } from "@/lib/whatsapp/codigo";
import { RESPUESTAS_WHATSAPP, comandoDeTexto } from "@/lib/whatsapp/respuestas";
import { extraerMensajesEntrantes, type MensajeEntrante } from "@/lib/whatsapp/payload";
import { WhatsappNoConfiguradoError, configuracionWhatsapp, hashRemitente, secretoWhatsapp } from "./config";
import { verificarFirmaMeta } from "./firma";
import type { MensajeSaliente } from "./cliente";
import { MAX_INTENTOS_PROCESO, diagnosticoDeError, marcarErrorDeProceso, responderMensaje, type ResultadoProceso } from "./proceso";
import { continuarArchivoRecibido } from "./archivos-recibidos";

export { MAX_INTENTOS_PROCESO, diagnosticoDeError, type ResultadoProceso };
import { verificarCodigoTx, vinculosUtilizablesTx } from "./vinculos";
import { seleccionarEmpresaTx } from "./seleccion-empresa";

// Recepción de mensajes de WhatsApp (Fase 1 WhatsApp + ARQENTO IA, octubre
// 2026). Vinculación y, desde la Fase 2A (noviembre 2026), recepción de
// fotografías y PDF de comprobantes (ver archivos-recibidos.ts): solo se
// reciben y guardan para revisión humana. Nunca hay consultas financieras ni
// operaciones contables por este canal.
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
//   4. Al tercer intento se responde 200 (Meta deja de reentregar). Un
//      mensaje de TEXTO queda en error DEFINITIVO, solo con datos técnicos
//      de diagnóstico. Un mensaje CON ARCHIVO nunca se descarta: queda
//      DETENIDO, con todo lo necesario para recuperarlo (ver
//      archivos-recibidos.ts).
//   5. Respaldo explícito: Master puede reprocesar los pendientes y los
//      detenidos (reprocesarMensajesPendientesMaster) y la bandeja de cada
//      Empresa, los suyos. La misma función queda lista para un cron (no
//      activado).
// - Mínimo de datos: del remitente solo queda un HMAC; su wa_id y el texto
//   se guardan solo mientras el mensaje está pendiente y se borran al
//   procesarlo o al agotar los intentos.

// Límites contra abuso por número, en una ventana de 10 minutos que termina
// en el propio mensaje (se cuentan los recibidos HASTA él: el resultado no
// depende del orden ni del momento en que se procese, y una ráfaga nunca
// limita a los primeros).
// - Mensajes que no son archivos: 20. Del 21 en adelante no se responden.
// - Archivos (fotografías y documentos) de un número vinculado: 50, contados
//   aparte. El que excede NUNCA se descarta en silencio: queda con estado
//   explícito (ARCHIVO_LIMITADO) y se avisa al remitente para que lo reenvíe;
//   el aviso deja de enviarse al doble del límite (el propio aviso lo advierte).
export const MAX_MENSAJES_POR_VENTANA = 20;
export const MAX_ARCHIVOS_POR_VENTANA = 50;
export const VENTANA_LIMITE_MINUTOS = 10;
const TIPOS_DE_ARCHIVO = ["image", "document"];
// Cuántos mensajes se PROCESAN dentro de una misma llamada del webhook y
// durante cuánto tiempo. Los que no alcancen quedan registrados y pendientes
// (nunca se descartan): el webhook responde 500 y Meta los reentrega.
const MAX_MENSAJES_POR_LLAMADA = 20;
const PRESUPUESTO_PROCESO_MS = 40_000;
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
  // TODOS los mensajes de la entrega se registran (durable e idempotente).
  const porProcesar = await registrarMensajesEntrantes(extraerMensajesEntrantes(payload, phoneNumberId));
  const inicio = Date.now();
  let reentregar = false;
  let procesados = 0;
  for (const id of porProcesar) {
    // Sin tiempo o sobre el límite: queda pendiente y se pide la reentrega.
    if (procesados >= MAX_MENSAJES_POR_LLAMADA || Date.now() - inicio > PRESUPUESTO_PROCESO_MS) {
      reentregar = true;
      continue;
    }
    procesados++;
    if ((await procesarMensajeWhatsapp(id)) === "ERROR_REINTENTABLE") reentregar = true;
  }
  // Recuperación oportunista de pendientes de llamadas anteriores (acotada);
  // no cambia la respuesta de ESTA entrega.
  // Excluye los de esta entrega: un fallo no se reintenta en la misma llamada
  // (cada intento corresponde a una entrega de Meta o a un reproceso).
  if (Date.now() - inicio < PRESUPUESTO_PROCESO_MS) await procesarMensajesPendientes(5, porProcesar).catch(() => {});
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
          // Fotografía o documento: lo necesario para descargarlo después.
          ...(m.archivo ? { archivoPendiente: { mediaId: m.archivo.mediaId, nombre: m.archivo.nombre } } : {}),
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

// Con los intentos automáticos agotados (error definitivo o archivo
// detenido) una reentrega de Meta ya no lo procesa.
const esRecuperable = (m: { estadoProceso: string; intentos: number; remitentePendiente: string | null }) =>
  m.remitentePendiente !== null && (m.estadoProceso === "PENDIENTE" || m.estadoProceso === "ERROR") && m.intentos < MAX_INTENTOS_PROCESO;

type Decision = {
  resultado: string;
  vinculoId?: string | null;
  empresaId?: string | null;
  usuarioId?: string | null;
  respuesta: MensajeSaliente | null;
  // El mensaje trae un comprobante y su remitente y Empresa quedaron
  // resueltos: el mensaje NO se cierra aquí; sigue la recepción del archivo.
  asignarArchivo?: boolean;
  // El archivo no se recibirá, con estado explícito.
  etapaArchivo?: "RECHAZADO";
};

// `manual`: reintento explícito de una persona (bandeja o Master); también
// avanza los mensajes con archivo detenidos.
export async function procesarMensajeWhatsapp(id: string, opciones: { manual?: boolean } = {}): Promise<ResultadoProceso> {
  let respuesta: MensajeSaliente | null = null;
  try {
    const r = await db.$transaction(async (tx) => {
      // Un mensaje se procesa una sola vez aunque dos llamadas lo intenten:
      // la segunda espera el bloqueo y encuentra PROCESADO.
      await tx.$queryRaw`SELECT id FROM mensajes_whatsapp WHERE id = ${id} FOR UPDATE`;
      const m = await tx.mensajeWhatsapp.findUnique({ where: { id } });
      if (!m || m.estadoProceso === "PROCESADO" || !m.remitentePendiente) return { omitido: true as const };
      // Intentos automáticos agotados (archivo detenido): solo avanza con un
      // reintento explícito.
      if (!opciones.manual && m.intentos >= MAX_INTENTOS_PROCESO) return { omitido: true as const };
      // Recepción de archivo ya iniciada (reintento o reentrega): se reanuda
      // donde quedó, sin volver a decidir ni a contar el mensaje.
      if (m.etapaArchivo === "ASIGNADO" || m.etapaArchivo === "ALMACENADO") return { omitido: false as const, archivo: true as const, respuesta: null };
      const d = await decidirTx(tx, {
        remitenteHash: m.remitenteHash,
        waId: m.remitentePendiente,
        tipo: m.tipo,
        texto: m.textoPendiente ?? "",
        tieneArchivo: m.archivoPendiente !== null,
        creadoEn: m.createdAt,
      });
      if (d.asignarArchivo) {
        // Etapa ASIGNADO: persistida antes de descargar nada.
        await tx.mensajeWhatsapp.update({
          where: { id },
          data: { etapaArchivo: "ASIGNADO", vinculoId: d.vinculoId ?? null, empresaId: d.empresaId ?? null, usuarioId: d.usuarioId ?? null },
        });
        return { omitido: false as const, archivo: true as const, respuesta: null };
      }
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
          // Un archivo que no se va a recibir (remitente sin vínculo, falta
          // elegir Empresa, límite): tampoco se conserva su identificador.
          ...(m.archivoPendiente !== null ? { archivoPendiente: Prisma.DbNull } : {}),
          ...(d.etapaArchivo ? { etapaArchivo: d.etapaArchivo } : {}),
        },
      });
      return { omitido: false as const, archivo: false as const, respuesta: d.respuesta };
    });
    if (r.omitido) return "OMITIDO";
    // La descarga y el guardado van FUERA de la transacción, por etapas.
    if (r.archivo) return continuarArchivoRecibido(id, opciones);
    respuesta = r.respuesta;
  } catch (error) {
    // Si ni siquiera se pudo marcar el error (p. ej. base caída), el mensaje
    // sigue pendiente: también es reintentable.
    return marcarErrorDeProceso(id, error).catch((): ResultadoProceso => "ERROR_REINTENTABLE");
  }
  // La respuesta solo sale después del COMMIT del PROCESADO; una reentrega
  // encuentra PROCESADO y la omite — nunca se responde dos veces.
  // Informativa: nunca se reenvía (ver responderMensaje).
  await responderMensaje(id, respuesta);
  return "PROCESADO";
}

// `revisados` = los que se intentaron en esta ejecución.
export type ResumenReproceso = { revisados: number; procesados: number; reintentables: number; definitivos: number; detenidos: number; omitidos: number };

// Reprocesa mensajes que quedaron PENDIENTES (más de 30 s, para no competir
// con la llamada que los está procesando) o con error reintentable. La usan
// el webhook (de forma oportunista), las acciones explícitas de Master y de
// la bandeja y, en el futuro, un cron (no activado).
// - `alcance.empresaId`: solo las recepciones de archivos ya asignadas a esa
//   Empresa (lo usa su bandeja; nunca toca mensajes de otra).
// - `alcance.manual`: reintento explícito de una persona; incluye los
//   mensajes con archivo DETENIDOS (intentos automáticos agotados).
// - `alcance.presupuestoMs`: deja de empezar mensajes al agotarse; los que
//   falten siguen pendientes.
export async function procesarMensajesPendientes(
  limite = 10,
  excluir: string[] = [],
  alcance: { empresaId?: string; manual?: boolean; presupuestoMs?: number } = {}
): Promise<ResumenReproceso> {
  const inicio = Date.now();
  const corte = new Date(inicio - 30_000);
  const candidatos = await db.mensajeWhatsapp.findMany({
    where: {
      remitentePendiente: { not: null },
      ...(alcance.empresaId ? { empresaId: alcance.empresaId, etapaArchivo: { in: ["ASIGNADO", "ALMACENADO"] } } : {}),
      ...(excluir.length > 0 ? { id: { notIn: excluir } } : {}),
      ...(alcance.manual ? {} : { intentos: { lt: MAX_INTENTOS_PROCESO } }),
      OR: [{ estadoProceso: "PENDIENTE", createdAt: { lt: corte } }, { estadoProceso: "ERROR" }],
    },
    orderBy: { createdAt: "asc" },
    take: limite,
    select: { id: true },
  });
  const resumen: ResumenReproceso = { revisados: 0, procesados: 0, reintentables: 0, definitivos: 0, detenidos: 0, omitidos: 0 };
  for (const c of candidatos) {
    if (alcance.presupuestoMs !== undefined && Date.now() - inicio > alcance.presupuestoMs) break;
    resumen.revisados++;
    const r = await procesarMensajeWhatsapp(c.id, { manual: alcance.manual });
    if (r === "PROCESADO") resumen.procesados++;
    else if (r === "ERROR_REINTENTABLE") resumen.reintentables++;
    else if (r === "ERROR_DEFINITIVO") resumen.definitivos++;
    else if (r === "DETENIDO") resumen.detenidos++;
    else resumen.omitidos++;
  }
  return resumen;
}

// Estado del canal para Master: solo conteos, sin números ni textos.
export async function estadoMensajesWhatsapp() {
  const corte = new Date(Date.now() - 30_000);
  const automaticos = { remitentePendiente: { not: null }, intentos: { lt: MAX_INTENTOS_PROCESO } };
  const [pendientes, reintentables, detenidos, definitivos] = await Promise.all([
    db.mensajeWhatsapp.count({ where: { estadoProceso: "PENDIENTE", ...automaticos, createdAt: { lt: corte } } }),
    db.mensajeWhatsapp.count({ where: { estadoProceso: "ERROR", ...automaticos } }),
    // Mensajes con archivo que agotaron los intentos automáticos: esperan un
    // reintento explícito.
    db.mensajeWhatsapp.count({
      where: { estadoProceso: { in: ["PENDIENTE", "ERROR"] }, remitentePendiente: { not: null }, intentos: { gte: MAX_INTENTOS_PROCESO } },
    }),
    db.mensajeWhatsapp.count({ where: { estadoProceso: "ERROR", resultado: "ERROR_DEFINITIVO" } }),
  ]);
  return { pendientes, reintentables, detenidos, definitivos };
}

async function decidirTx(
  tx: Cliente,
  m: { remitenteHash: string; waId: string; tipo: string; texto: string; tieneArchivo: boolean; creadoEn: Date }
): Promise<Decision> {
  const ahora = new Date();
  const texto = (contenido: string): MensajeSaliente => ({ tipo: "texto", waId: m.waId, texto: contenido });

  // Límite contra abuso por número: mensajes de su misma clase (archivos o
  // no) recibidos en los 10 minutos anteriores, incluido este. Ver las
  // constantes de arriba.
  const esArchivo = TIPOS_DE_ARCHIVO.includes(m.tipo) && m.tieneArchivo;
  const recientes = await tx.mensajeWhatsapp.count({
    where: {
      remitenteHash: m.remitenteHash,
      tipo: esArchivo ? { in: TIPOS_DE_ARCHIVO } : { notIn: TIPOS_DE_ARCHIVO },
      createdAt: { gte: new Date(m.creadoEn.getTime() - VENTANA_LIMITE_MINUTOS * 60_000), lte: m.creadoEn },
    },
  });
  if (!esArchivo && recientes > MAX_MENSAJES_POR_VENTANA) return { resultado: "LIMITADO", respuesta: null };

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
    // Archivos de un número SIN vínculo: no son comprobantes de nadie; se
    // limitan igual que cualquier otro mensaje.
    if (esArchivo && recientes > MAX_MENSAJES_POR_VENTANA) return { resultado: "LIMITADO", respuesta: null };
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

  // 5) Fotografía o PDF de un comprobante (Fase 2A). Aquí solo se decide A
  // QUÉ EMPRESA pertenece; la descarga y el guardado siguen después, por
  // etapas. Con varias Empresas y sin selección vigente NUNCA se asigna a
  // una por omisión: se pide elegir y reenviar.
  if (esArchivo) {
    let activo = vinculos.length === 1 ? vinculos[0] : null;
    if (!activo) {
      const sesion = await tx.sesionWhatsapp.findUnique({ where: { remitenteHash: m.remitenteHash } });
      if (sesion && sesion.expiraEn > ahora) activo = vinculos.find((v) => v.id === sesion.vinculoId) ?? null;
    }
    // Sobre el límite de archivos: no se descarga ni se guarda, pero queda
    // con estado explícito, ligado a su Empresa si ya se conoce, y con aviso.
    if (recientes > MAX_ARCHIVOS_POR_VENTANA) {
      return {
        resultado: "ARCHIVO_LIMITADO",
        etapaArchivo: "RECHAZADO",
        ...(activo ? { vinculoId: activo.id, empresaId: activo.empresaId, usuarioId: activo.usuarioId } : {}),
        respuesta: recientes <= MAX_ARCHIVOS_POR_VENTANA * 2 ? texto(RESPUESTAS_WHATSAPP.archivoLimitado) : null,
      };
    }
    if (!activo) {
      return { resultado: "EMPRESA_REQUERIDA", respuesta: { ...listaDeEmpresas(m.waId, vinculos), texto: RESPUESTAS_WHATSAPP.eligeEmpresaYReenvia } };
    }
    return { resultado: "ARCHIVO_ASIGNADO", vinculoId: activo.id, empresaId: activo.empresaId, usuarioId: activo.usuarioId, respuesta: null, asignarArchivo: true };
  }

  // 6) Audio, video, stickers…: no se reciben ni se descargan.
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

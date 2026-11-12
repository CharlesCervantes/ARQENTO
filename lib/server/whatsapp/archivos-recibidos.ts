import "server-only";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { almacenamientoConfigurado, eliminarArchivo, existeArchivo, subirBytes } from "@/lib/server/archivos";
import { buscarDocumentoPorHash, calcularHashArchivo } from "@/lib/server/inteligencia/trabajos";
import { ArchivoRechazadoError, guardarDocumentoRecibidoTx, validarArchivoRecibido } from "@/lib/server/contabilidad/documentos/recepcion";
import { MAX_BYTES_POR_DOCUMENTO, contextoDePieDeFoto, nombreSeguroDeArchivo, type MimeSoportado } from "@/lib/contabilidad/tipo-archivo";
import { RESPUESTAS_WHATSAPP } from "@/lib/whatsapp/respuestas";
import { DescargaMediaError, descargarMediaDeMeta, type MensajeSaliente } from "./cliente";
import { MAX_INTENTOS_PROCESO, marcarErrorDeProceso, responderMensaje, type ResultadoProceso } from "./proceso";

// Recepción de un comprobante (fotografía o PDF) enviado por WhatsApp — Fase
// 2A, noviembre 2026. Solo recibe y guarda: no llama a ninguna IA, no crea
// trabajos de análisis ni gastos.
//
// RECUPERABLE POR ETAPAS. Nada depende de que una sola ejecución termine:
// cada etapa se persiste en el mensaje (MensajeWhatsapp.etapaArchivo) antes
// de avanzar, y cualquier ejecución posterior reanuda donde quedó.
//
//   (registro)   El webhook guarda el mensaje con el identificador del archivo
//                en Meta. Si esto falla, responde 500 y Meta reentrega.
//   ASIGNADO     Remitente autorizado y Empresa resuelta (mensajes.ts, en una
//                transacción corta). Falta descargar.
//   ALMACENADO   El archivo se descargó de Meta, se validó y se subió al
//                almacenamiento privado; su referencia y su huella quedaron
//                en el mensaje. Una reanudación ya NO necesita a Meta (el
//                identificador del archivo caduca a los pocos días).
//   GUARDADO     El documento existe. Solo entonces se confirma al remitente.
//   RECHAZADO    El ARCHIVO no es aceptable (tipo, tamaño, contenido, ya no
//                existe en Meta, remitente sin autorización o límite): no se
//                guardó y el remitente recibe un aviso.
//
// UNA FALLA DEL SISTEMA NUNCA DESCARTA UN COMPROBANTE. Cada intento se cuenta
// AL EMPEZAR (una ejecución que la plataforma corta a la mitad también
// cuenta). Tras 3 intentos automáticos la recepción queda DETENIDA: conserva
// el identificador en Meta, el archivo ya almacenado y el remitente; deja de
// reintentarse sola (no consume cada webhook) y se reintenta con una acción
// explícita desde la bandeja de su Empresa o desde Master. Al detenerse se
// avisa al remitente una sola vez.
//
// IDEMPOTENTE. La clave del objeto depende SOLO del mensaje, así que repetir
// la subida sobrescribe el mismo objeto y siempre se sabe qué objeto borrar
// si la recepción termina sin documento. Un archivo repetido se detecta por
// su huella ANTES de subirlo (no deja copia). El documento se crea bajo el
// bloqueo de la fila del mensaje y el de (Empresa, huella): una reentrega
// encuentra el mensaje PROCESADO y dos mensajes con el mismo archivo producen
// un solo documento.
//
// QUIÉN REANUDA una recepción interrumpida (ninguna vía es la única):
//   1. Meta: el webhook responde 500 mientras quede algo sin terminar, y Meta
//      reentrega el mismo mensaje.
//   2. El siguiente webhook que llegue (recuperación oportunista).
//   3. Bandeja «Recibidos por WhatsApp» → «Reintentar recepción» (las de esa
//      Empresa, incluidas las detenidas). Es una acción explícita: abrir la
//      bandeja solo las MUESTRA, no procesa nada.
//   4. Master → WhatsApp → «Reprocesar mensajes pendientes» (incluidas las
//      detenidas).
// No hay tarea programada: sin tráfico y sin que alguien abra la bandeja, una
// recepción interrumpida espera, identificable, hasta el siguiente disparo.

type ArchivoListo = { ref: string | null; hash: string; tipoMime: MimeSoportado; archivoNombre: string };
type ArchivoPendiente = { mediaId: string; nombre: string | null } & Partial<ArchivoListo>;

// Falla del sistema (no del archivo): se reintenta. `code` es un diagnóstico
// sin datos personales.
class RecepcionInterrumpidaError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Recepción interrumpida (${code}).`);
    this.name = "RecepcionInterrumpida";
    this.code = code;
  }
}

function leerPendiente(valor: unknown): ArchivoPendiente | null {
  const v = valor as Partial<ArchivoPendiente> | null;
  if (!v || typeof v !== "object" || typeof v.mediaId !== "string" || !v.mediaId) return null;
  return {
    mediaId: v.mediaId,
    nombre: typeof v.nombre === "string" ? v.nombre : null,
    ...(typeof v.ref === "string" && typeof v.hash === "string" && typeof v.tipoMime === "string" && typeof v.archivoNombre === "string"
      ? { ref: v.ref, hash: v.hash, tipoMime: v.tipoMime as MimeSoportado, archivoNombre: v.archivoNombre }
      : {}),
  };
}

// Clave del objeto de una recepción: depende SOLO del mensaje y su Empresa
// (sin nombre de archivo ni extensión; el tipo va en los metadatos del objeto
// y en el documento).
export function claveDeArchivoRecibido(empresaId: string, mensajeId: string): string {
  return `contabilidad/${empresaId}/documentos-egreso/whatsapp/${mensajeId}`;
}

// Borra un objeto que ya no se va a usar — nunca uno que algún documento
// referencie. Si falla, no interrumpe nada: el objeto queda sin referencia,
// pero identificable por su clave (el id del mensaje).
async function eliminarSiNadieLoUsa(ref: string | null | undefined): Promise<void> {
  if (!ref) return;
  try {
    if ((await db.documentoEgreso.count({ where: { archivoRef: ref } })) === 0) await eliminarArchivo(ref);
  } catch {
    console.warn(JSON.stringify({ evento: "whatsapp_objeto_sin_referencia" }));
  }
}

const LIMPIAR_PENDIENTES = { remitentePendiente: null, textoPendiente: null, archivoPendiente: Prisma.DbNull } as const;

// `manual`: reintento explícito de una persona (bandeja o Master); también
// avanza las recepciones detenidas.
export async function continuarArchivoRecibido(id: string, opciones: { manual?: boolean } = {}): Promise<ResultadoProceso> {
  // El intento se cuenta AL EMPEZAR, de forma atómica: si la ejecución se
  // corta a la mitad, el intento ya quedó contado y un archivo que tumba la
  // función no se reintenta sin fin.
  const reclamo = await db.mensajeWhatsapp.updateMany({
    where: {
      id,
      estadoProceso: { not: "PROCESADO" },
      remitentePendiente: { not: null },
      etapaArchivo: { in: ["ASIGNADO", "ALMACENADO"] },
      ...(opciones.manual ? {} : { intentos: { lt: MAX_INTENTOS_PROCESO } }),
    },
    data: { intentos: { increment: 1 } },
  });
  if (reclamo.count === 0) return "OMITIDO";
  const m = await db.mensajeWhatsapp.findUnique({ where: { id } });
  if (!m || m.estadoProceso === "PROCESADO" || !m.remitentePendiente) return "OMITIDO";

  const waId = m.remitentePendiente;
  const texto = (contenido: string): MensajeSaliente => ({ tipo: "texto", waId, texto: contenido });
  const pendiente = leerPendiente(m.archivoPendiente);
  const clave = m.empresaId ? claveDeArchivoRecibido(m.empresaId, m.id) : null;
  // Hubo (o pudo haber) una subida con esta clave: en este intento o en uno
  // anterior, aunque no haya quedado registrada.
  let pudoSubirse = m.intentos > 1 || m.etapaArchivo === "ALMACENADO";

  try {
    const { empresaId, usuarioId, vinculoId } = m;
    if (!pendiente || !clave || !empresaId || !usuarioId || !vinculoId) throw new RecepcionInterrumpidaError("sin-datos");
    // Antes de descargar nada: sin almacenamiento configurado no se recibe.
    if (!almacenamientoConfigurado()) throw new RecepcionInterrumpidaError("almacenamiento");

    let listo: ArchivoListo | null = null;
    // Reanudación: si el archivo ya estaba almacenado (y sigue ahí), no se
    // vuelve a pedir a Meta.
    if (m.etapaArchivo === "ALMACENADO" && pendiente.ref && pendiente.hash && pendiente.tipoMime && pendiente.archivoNombre) {
      if (await existeArchivo(pendiente.ref)) {
        listo = { ref: pendiente.ref, hash: pendiente.hash, tipoMime: pendiente.tipoMime, archivoNombre: pendiente.archivoNombre };
      }
    }

    if (!listo) {
      const { bytes, tipoDeclarado } = await descargarMediaDeMeta(pendiente.mediaId, MAX_BYTES_POR_DOCUMENTO);
      const tipoMime = await validarArchivoRecibido(bytes, tipoDeclarado);
      const archivoNombre = nombreSeguroDeArchivo(pendiente.nombre, tipoMime, m.recibidoEn);
      const hash = calcularHashArchivo(bytes);
      // Archivo repetido en esta Empresa: no se sube otra copia. (La revisión
      // definitiva, con bloqueo, ocurre al guardar.)
      if (await buscarDocumentoPorHash(empresaId, hash, db, { excluirDescartados: true })) {
        listo = { ref: null, hash, tipoMime, archivoNombre };
      } else {
        pudoSubirse = true;
        await subirBytes(clave, bytes, tipoMime);
        listo = { ref: clave, hash, tipoMime, archivoNombre };
        await db.mensajeWhatsapp.updateMany({
          where: { id, estadoProceso: { not: "PROCESADO" }, etapaArchivo: { in: ["ASIGNADO", "ALMACENADO"] } },
          data: { etapaArchivo: "ALMACENADO", archivoPendiente: { mediaId: pendiente.mediaId, nombre: pendiente.nombre, ...listo } },
        });
      }
    }

    const guardar = listo;
    const r = await db.$transaction(async (tx) => {
      // Una sola ejecución cierra el mensaje: la segunda espera el bloqueo y
      // lo encuentra PROCESADO.
      await tx.$queryRaw`SELECT id FROM mensajes_whatsapp WHERE id = ${id} FOR UPDATE`;
      const actual = await tx.mensajeWhatsapp.findUnique({ where: { id }, select: { estadoProceso: true } });
      if (!actual || actual.estadoProceso === "PROCESADO") return { tipo: "omitido" as const };

      // La autorización se revalida al guardar: pudo cambiar mientras se
      // descargaba (usuario desactivado o desautorizado, vínculo revocado,
      // WhatsApp apagado para la Empresa).
      const vigente = await tx.vinculoWhatsapp.findFirst({
        where: {
          id: vinculoId,
          empresaId,
          usuarioId,
          estado: "VERIFICADO",
          usuario: { activo: true, whatsappAutorizado: true, empresaId },
          empresa: { activa: true, whatsappHabilitado: true },
        },
        select: { id: true },
      });
      const cierre = { estadoProceso: "PROCESADO" as const, procesadoEn: new Date(), error: null, ...LIMPIAR_PENDIENTES };
      if (!vigente) {
        await tx.mensajeWhatsapp.update({ where: { id }, data: { ...cierre, resultado: "ARCHIVO_NO_AUTORIZADO", etapaArchivo: "RECHAZADO" } });
        return { tipo: "noAutorizado" as const };
      }
      const documento = await guardarDocumentoRecibidoTx(tx, {
        empresaId,
        usuarioId,
        archivoRef: guardar.ref,
        archivoNombre: guardar.archivoNombre,
        tipoMime: guardar.tipoMime,
        hashArchivo: guardar.hash,
        contexto: contextoDePieDeFoto(m.textoPendiente),
      });
      await tx.mensajeWhatsapp.update({
        where: { id },
        data: {
          ...cierre,
          // Registro interno: distingue la recepción de un archivo repetido
          // (el remitente recibe la misma confirmación en ambos casos).
          resultado: documento.duplicado ? "DOCUMENTO_REPETIDO" : "DOCUMENTO_RECIBIDO",
          etapaArchivo: "GUARDADO",
          documentoEgresoId: documento.documentoEgresoId,
        },
      });
      return { tipo: "guardado" as const, duplicado: documento.duplicado };
    });

    // Otra ejecución lo terminó: su objeto es el mismo (misma clave) — no se toca.
    if (r.tipo === "omitido") return "OMITIDO";
    if (r.tipo === "noAutorizado") {
      if (pudoSubirse) await eliminarSiNadieLoUsa(clave);
      await responderMensaje(id, texto(RESPUESTAS_WHATSAPP.numeroNoVinculado));
      return "PROCESADO";
    }
    // Archivo repetido: se reutilizó el documento existente; si llegó a
    // subirse una copia, sobra.
    if (r.duplicado && pudoSubirse) await eliminarSiNadieLoUsa(clave);
    // Solo aquí, con el documento confirmado, se avisa al remitente. La misma
    // confirmación para un archivo nuevo y para uno repetido.
    await responderMensaje(id, texto(RESPUESTAS_WHATSAPP.archivoRecibido));
    return "PROCESADO";
  } catch (error) {
    try {
      // El ARCHIVO no es aceptable o ya no existe en Meta: reintentar no lo
      // arregla. Estado explícito (RECHAZADO), con aviso al remitente.
      const motivo =
        error instanceof ArchivoRechazadoError ? error.motivo : error instanceof DescargaMediaError && error.definitivo ? error.motivo : null;
      if (motivo) {
        const cerrados = await db.mensajeWhatsapp.updateMany({
          where: { id, estadoProceso: { not: "PROCESADO" } },
          data: {
            estadoProceso: "PROCESADO",
            resultado: `ARCHIVO_RECHAZADO_${motivo}`,
            etapaArchivo: "RECHAZADO",
            procesadoEn: new Date(),
            error: null,
            ...LIMPIAR_PENDIENTES,
          },
        });
        if (cerrados.count === 0) return "OMITIDO";
        if (pudoSubirse) await eliminarSiNadieLoUsa(clave);
        await responderMensaje(id, texto(motivo === "NO_DISPONIBLE" ? RESPUESTAS_WHATSAPP.archivoNoDisponible : RESPUESTAS_WHATSAPP.archivoNoPermitido));
        return "PROCESADO";
      }
      // Falla del sistema (Meta, almacenamiento o base). El intento ya se
      // contó; con los automáticos agotados la recepción queda DETENIDA y
      // conserva todo lo necesario para recuperarla. El aviso al remitente
      // sale una sola vez, al detenerse.
      const resultado = await marcarErrorDeProceso(id, error, { intentoYaContado: true });
      if (resultado === "DETENIDO" && m.intentos === MAX_INTENTOS_PROCESO) {
        await responderMensaje(id, texto(RESPUESTAS_WHATSAPP.archivoDetenido), { conservarError: true });
      }
      return resultado;
    } catch {
      // Ni siquiera se pudo registrar el error: el mensaje sigue pendiente.
      return "ERROR_REINTENTABLE";
    }
  }
}

export type RecepcionPendiente = {
  id: string;
  recibidoEn: Date;
  usuarioId: string | null;
  // DETENIDA: agotó los intentos automáticos; espera un reintento explícito.
  estado: "EN_CURSO" | "DETENIDA";
  // El archivo ya está en el almacenamiento privado (no depende de Meta).
  almacenado: boolean;
};

// Recepciones de una Empresa que no han terminado: siguen identificables
// hasta que se guardan o se rechazan.
export async function recepcionesPendientes(empresaId: string): Promise<RecepcionPendiente[]> {
  const mensajes = await db.mensajeWhatsapp.findMany({
    where: { empresaId, etapaArchivo: { in: ["ASIGNADO", "ALMACENADO"] }, remitentePendiente: { not: null }, estadoProceso: { not: "PROCESADO" } },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, recibidoEn: true, usuarioId: true, intentos: true, etapaArchivo: true },
  });
  return mensajes.map((m) => ({
    id: m.id,
    recibidoEn: m.recibidoEn,
    usuarioId: m.usuarioId,
    estado: m.intentos >= MAX_INTENTOS_PROCESO ? "DETENIDA" : "EN_CURSO",
    almacenado: m.etapaArchivo === "ALMACENADO",
  }));
}

// Comprobantes de una Empresa que NO se guardaron por el límite de archivos
// por número, desde `desde` (el remitente ya fue avisado).
export async function archivosLimitadosDesde(empresaId: string, desde: Date): Promise<number> {
  return db.mensajeWhatsapp.count({ where: { empresaId, resultado: "ARCHIVO_LIMITADO", createdAt: { gte: desde } } });
}

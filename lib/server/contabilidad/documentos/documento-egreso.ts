import "server-only";
import { db } from "@/lib/server/db";
import { subirArchivo } from "@/lib/server/archivos";
import { calcularHashArchivo, buscarDocumentoPorHash, encolarTrabajo } from "@/lib/server/inteligencia/trabajos";
import { extraerTextoPdfNativo } from "@/lib/server/inteligencia/extractor-pdf-nativo";
import { procesarTrabajos } from "@/lib/server/inteligencia/worker";
import type { Prisma } from "@/lib/generated/prisma/client";
import { VERSION_SCHEMA_HECHOS_EGRESO } from "./schema-hechos-egreso";
import { puedeVerContabilidad, puedeRegistrarMovimientoContable } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { requerirCapturaInteligente } from "./habilitacion";
import { MAX_BYTES_POR_DOCUMENTO, MAX_PAGINAS_POR_DOCUMENTO, tipoArchivoDetectado } from "@/lib/contabilidad/tipo-archivo";
import "./reconciliar-egreso"; // efecto secundario: se auto-registra en registro-operaciones

// Carga inteligente de documentos — entrypoint de Contabilidad. Único
// archivo de este módulo que conoce R2/hash/cola; el procesamiento real
// (extracción + reconciliación) vive en reconciliar-egreso.ts (Carga
// inteligente de documentos, V1 — octubre 2026).

const MAX_ARCHIVOS_POR_LOTE = 5;
const MAX_BYTES_POR_ARCHIVO = MAX_BYTES_POR_DOCUMENTO; // 10MB

function requerirContabilidad(usuario: UsuarioSesion): string {
  if (!puedeVerContabilidad(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// Validación de MIME real por MAGIC BYTES — nunca se confía en el
// Content-Type que manda el navegador ni en la extensión del nombre de
// archivo. V1 soporta PDF (texto nativo o escaneado — estrategia VISION
// para este último, ver reconciliar-egreso.ts) y JPG/PNG directos (siempre
// VISION, no hay texto que extraer de una imagen suelta) — V1.2, octubre
// 2026.
// (El detector vive en lib/contabilidad/tipo-archivo.ts — lo comparte la
// recepción por WhatsApp, Fase 2A.)

export type DocumentoSubidoResultado = {
  documentoEgresoId: string;
  duplicado: boolean;
  nombre: string;
};

export async function subirDocumentosEgreso(
  usuario: UsuarioSesion,
  archivos: { nombre: string; tipoMime: string; bytes: Buffer }[],
  contextoUsuario?: string
): Promise<{ loteId: string; documentos: DocumentoSubidoResultado[] }> {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();
  // Antes de validar, subir a R2 o encolar nada.
  await requerirCapturaInteligente(empresaId);

  if (archivos.length === 0) throw new ValidacionError("Sube al menos un documento.");
  if (archivos.length > MAX_ARCHIVOS_POR_LOTE) {
    throw new ValidacionError(`No se pueden subir más de ${MAX_ARCHIVOS_POR_LOTE} documentos a la vez.`);
  }

  const contexto = contextoUsuario?.trim() || null;
  const loteId = crypto.randomUUID();
  const documentos: DocumentoSubidoResultado[] = [];

  for (const archivo of archivos) {
    if (archivo.bytes.length > MAX_BYTES_POR_ARCHIVO) {
      throw new ValidacionError(`"${archivo.nombre}" supera el límite de 10MB.`);
    }
    const tipoDetectado = tipoArchivoDetectado(archivo.bytes);
    if (!tipoDetectado) {
      throw new ValidacionError(`"${archivo.nombre}" no es un PDF, JPG o PNG válido.`);
    }

    if (tipoDetectado === "application/pdf") {
      const { paginas } = await extraerTextoPdfNativo(archivo.bytes);
      if (paginas > MAX_PAGINAS_POR_DOCUMENTO) {
        throw new ValidacionError(`"${archivo.nombre}" tiene ${paginas} páginas — el máximo soportado es ${MAX_PAGINAS_POR_DOCUMENTO}.`);
      }
    }

    const hashArchivo = calcularHashArchivo(archivo.bytes);

    // Deduplicación exacta — SIEMPRE scoped por empresaId (ver trabajos.ts).
    // Si ya se subió este mismo archivo antes en esta Empresa, se reutiliza
    // ese documento en vez de reprocesar y pagar IA de nuevo. Primero una
    // revisión rápida (evita subir a R2 un archivo repetido)…
    const previo = await buscarDocumentoPorHash(empresaId, hashArchivo);
    if (previo) {
      await reutilizarDocumento(db, previo, { loteId, contexto, usuarioId: usuario.id });
      documentos.push({ documentoEgresoId: previo.id, duplicado: true, nombre: archivo.nombre });
      continue;
    }

    // A partir de aquí se usa el tipo REAL detectado por magic bytes, nunca
    // el que mandó el cliente — así R2 y el worker siempre saben con qué
    // están trabajando de verdad.
    const subido = await subirArchivo(`contabilidad/${empresaId}/documentos-egreso`, archivoComoFile(archivo, tipoDetectado));

    // …y la revisión definitiva, serializada por (Empresa, huella) con un
    // bloqueo transaccional: dos subidas simultáneas del mismo archivo nunca
    // crean dos documentos (Fase 0 WhatsApp + ARQENTO IA, octubre 2026).
    // Documento, trabajo y su enlace se crean juntos o no se crea nada.
    const resultado = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`documento-egreso:${empresaId}:${hashArchivo}`}, 0))`;
      const duplicado = await buscarDocumentoPorHash(empresaId, hashArchivo, tx);
      if (duplicado) {
        // Ganó otra subida simultánea: el objeto recién subido a R2 queda
        // sin referencia (inofensivo; nunca se procesa ni se muestra).
        await reutilizarDocumento(tx, duplicado, { loteId, contexto, usuarioId: usuario.id });
        return { documentoEgresoId: duplicado.id, duplicado: true };
      }
      const documentoEgreso = await tx.documentoEgreso.create({
        data: {
          empresaId,
          archivoRef: subido.ref,
          archivoNombre: subido.nombre,
          tipoMime: tipoDetectado,
          hashArchivo,
          loteId,
          contextoUsuario: contexto,
          subidoPorId: usuario.id,
        },
      });
      const trabajo = await encolarTrabajo(
        {
          empresaId,
          modulo: "contabilidad",
          operacion: "extraccion_documento_egreso",
          referenciaModulo: documentoEgreso.id,
          archivoRef: subido.ref,
          tipoMime: tipoDetectado,
          creadoPorId: usuario.id,
          extractorVersion: "extraccion-v2", // detecta y elige TEXTO_NATIVO o VISION — ver estrategiaExtraccion
          modeloIA: "gpt-5-mini",
          promptVersion: VERSION_SCHEMA_HECHOS_EGRESO,
        },
        tx
      );
      // Enlace documento → trabajo: la bandeja puede mostrar el estado y
      // los errores reales de procesamiento.
      await tx.documentoEgreso.update({ where: { id: documentoEgreso.id }, data: { trabajoProcesamientoId: trabajo.id } });
      return { documentoEgresoId: documentoEgreso.id, duplicado: false };
    });

    documentos.push({ ...resultado, nombre: archivo.nombre });
  }

  // Sin procesamiento "disparado y olvidado" aquí: quien llama decide cómo
  // avanzar (la acción de subida lo intenta con after(), y la consulta del
  // lote avanza un trabajo por consulta — ver avanzarProcesamientoDeLote).
  // Nada depende solo de trabajo ejecutado después de responder.
  return { loteId, documentos };
}

// Reutiliza un documento ya existente (mismo archivo, misma Empresa) para
// el lote actual — nunca reprocesa ni vuelve a pagar IA.
export async function reutilizarDocumento(
  cliente: Prisma.TransactionClient,
  duplicado: { id: string; loteId: string; contextoUsuario: string | null; contextosAdicionales: unknown },
  ctx: { loteId: string; contexto: string | null; usuarioId: string }
) {
  // Reasignar al lote actual — si no, la pantalla de esta subida (que
  // consulta por loteId) nunca encuentra el documento reutilizado y queda
  // con una "Propuesta" vacía (bug encontrado en pruebas reales, octubre
  // 2026).
  const datosActualizacion: { loteId?: string; contextosAdicionales?: object } = {};
  if (duplicado.loteId !== ctx.loteId) datosActualizacion.loteId = ctx.loteId;

  // El contexto ORIGINAL nunca se sobreescribe. Si esta subida trae un
  // contexto distinto, se agrega como anotación adicional (auditable) en vez
  // de perderse — nunca dispara una nueva llamada a IA; un futuro
  // "Reanalizar con nuevo contexto" sería una acción explícita aparte.
  if (ctx.contexto && ctx.contexto !== duplicado.contextoUsuario) {
    const existentes = Array.isArray(duplicado.contextosAdicionales) ? duplicado.contextosAdicionales : [];
    datosActualizacion.contextosAdicionales = [
      ...existentes,
      { texto: ctx.contexto, fecha: new Date().toISOString(), usuarioId: ctx.usuarioId },
    ];
  }

  if (Object.keys(datosActualizacion).length > 0) {
    await cliente.documentoEgreso.update({ where: { id: duplicado.id }, data: datosActualizacion });
  }
}

// Avance garantizado del procesamiento sin depender de trabajo posterior a
// la respuesta ni de un cron (Fase 0 WhatsApp + ARQENTO IA, octubre 2026):
// cada consulta del lote procesa, dentro de la misma petición, A LO MÁS UN
// trabajo pendiente de ese lote — solo de la Empresa del usuario, nunca de
// otra. Si una ejecución se corta, el trabajo vuelve a quedar disponible
// por el timeout de abandono del worker y la siguiente consulta lo retoma.
export async function avanzarProcesamientoDeLote(usuario: UsuarioSesion, loteId: string) {
  const empresaId = requerirContabilidad(usuario);
  await requerirCapturaInteligente(empresaId);
  const pendientes = await db.documentoEgreso.findMany({
    where: { empresaId, loteId, estatus: "PENDIENTE" },
    select: { id: true },
  });
  if (pendientes.length === 0) return;
  await procesarTrabajos({ empresaId, referencias: pendientes.map((d) => d.id) }, 1);
}

// Procesa de inmediato los documentos recién subidos (vía rápida, la usa la
// acción de subida dentro de after()). Solo de esa Empresa y esos documentos.
export async function procesarDocumentosSubidos(empresaId: string, documentoEgresoIds: string[]) {
  if (documentoEgresoIds.length === 0) return;
  await procesarTrabajos({ empresaId, referencias: documentoEgresoIds }, documentoEgresoIds.length);
}

function archivoComoFile(archivo: { nombre: string; bytes: Buffer }, tipoMime: string): File {
  return new File([new Uint8Array(archivo.bytes)], archivo.nombre, { type: tipoMime });
}

export async function obtenerDocumentoEgreso(usuario: UsuarioSesion, id: string) {
  const empresaId = requerirContabilidad(usuario);
  await requerirCapturaInteligente(empresaId);
  const documento = await db.documentoEgreso.findFirst({
    where: { id, empresaId },
    include: { trabajoProcesamiento: { select: { estatus: true, error: true, intentos: true, maxIntentos: true } } },
  });
  if (!documento) throw new ValidacionError("Documento no encontrado.");
  return documento;
}

export async function obtenerDocumentosDelLote(usuario: UsuarioSesion, loteId: string) {
  const empresaId = requerirContabilidad(usuario);
  await requerirCapturaInteligente(empresaId);
  return db.documentoEgreso.findMany({
    where: { empresaId, loteId },
    include: {
      trabajoProcesamiento: { select: { estatus: true, error: true, intentos: true, maxIntentos: true } },
      // Remitente (origen del documento) y si tiene beneficiario de pago
      // vinculado — la bandeja lo necesita para ofrecer "pagó quien lo envió".
      subidoPor: { select: { id: true, nombre: true, beneficiario: { select: { activo: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
}

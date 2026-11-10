import "server-only";
import { db } from "@/lib/server/db";
import type { TrabajoProcesamientoDocumento } from "@/lib/generated/prisma/client";
import { obtenerArchivo } from "@/lib/server/archivos";
import { obtenerManejador } from "./registro-operaciones";

// Worker GENÉRICO — nunca importa nada de Contabilidad ni de ningún otro
// módulo. Orquesta: tomar un job con lock optimista, correr los pasos que
// aún falten (nunca repite un paso ya marcado listo — así un retry nunca
// vuelve a pagar una llamada a IA que ya había funcionado), y dejarlo
// COMPLETADO o ERROR con reintentos acotados. Ningún job puede quedar
// bloqueado para siempre: uno abandonado en PROCESANDO (el proceso que lo
// tomó murió/expiró) vuelve a estar disponible tras el timeout de abandono
// (Carga inteligente de documentos, V1 — octubre 2026).

const TIMEOUT_ABANDONO_MINUTOS = 10;
const LIMITE_JOBS_POR_CORRIDA = 10;

function backoffMinutos(intentos: number): number {
  return Math.min(2 ** Math.max(intentos, 1), 30); // 2, 4, 8, 16, 30… tope 30 min
}

function mensajeDeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reclamarJob(
  id: string,
  estatusEsperado: "PENDIENTE" | "PROCESANDO" | "ERROR",
  procesandoDesdeEsperado?: Date | null
): Promise<boolean> {
  const resultado = await db.trabajoProcesamientoDocumento.updateMany({
    where: {
      id,
      estatus: estatusEsperado,
      ...(procesandoDesdeEsperado !== undefined ? { procesandoDesde: procesandoDesdeEsperado } : {}),
    },
    data: { estatus: "PROCESANDO", procesandoDesde: new Date() },
  });
  return resultado.count === 1;
}

// Alcance opcional de una corrida (Fase 0 WhatsApp + ARQENTO IA, octubre
// 2026): una petición de un usuario solo procesa trabajos de SU Empresa —
// y, si se indica, solo de ciertas referencias (p. ej. los documentos del
// lote que está consultando). Sin alcance = todas las Empresas (cron).
export type AlcanceCorrida = { empresaId?: string; referencias?: string[] };

async function buscarCandidatos(alcance: AlcanceCorrida, limite: number): Promise<TrabajoProcesamientoDocumento[]> {
  const ahora = new Date();
  const corteAbandono = new Date(ahora.getTime() - TIMEOUT_ABANDONO_MINUTOS * 60_000);
  const filtro = {
    ...(alcance.empresaId ? { empresaId: alcance.empresaId } : {}),
    ...(alcance.referencias ? { referenciaModulo: { in: alcance.referencias } } : {}),
  };

  const [pendientes, abandonados, conError] = await Promise.all([
    db.trabajoProcesamientoDocumento.findMany({
      where: { ...filtro, estatus: "PENDIENTE" },
      orderBy: { createdAt: "asc" },
      take: limite,
    }),
    db.trabajoProcesamientoDocumento.findMany({
      where: { ...filtro, estatus: "PROCESANDO", procesandoDesde: { lt: corteAbandono } },
      orderBy: { procesandoDesde: "asc" },
      take: limite,
    }),
    db.trabajoProcesamientoDocumento.findMany({
      where: { ...filtro, estatus: "ERROR" },
      orderBy: { ultimoIntentoEn: "asc" },
      take: limite * 3, // se filtra fino en JS (backoff depende de `intentos`, por fila)
    }),
  ]);

  const erroresListosParaReintentar = conError.filter((j) => {
    if (j.intentos >= j.maxIntentos) return false; // terminal — nunca se reintenta solo
    if (!j.ultimoIntentoEn) return true;
    const minutosDesdeUltimoIntento = (ahora.getTime() - j.ultimoIntentoEn.getTime()) / 60_000;
    return minutosDesdeUltimoIntento >= backoffMinutos(j.intentos);
  });

  return [...pendientes, ...abandonados, ...erroresListosParaReintentar].slice(0, limite);
}

async function procesarJob(job: TrabajoProcesamientoDocumento): Promise<void> {
  const manejador = obtenerManejador(job.modulo, job.operacion);
  if (!manejador) {
    await db.trabajoProcesamientoDocumento.update({
      where: { id: job.id },
      data: { estatus: "ERROR", intentos: job.maxIntentos, error: `Sin manejador registrado para ${job.modulo}.${job.operacion}` },
    });
    return;
  }

  try {
    const bytes = await obtenerArchivo(job.archivoRef);

    // Variable local en vez de releer job.resultadoIAListo: dentro de esta
    // misma corrida, el paso determinístico puede decidir que no hace falta
    // IA (ver ManejadorOperacion) — el objeto `job` en memoria no se
    // refresca solo, así que esta bandera es la única fuente de verdad
    // dentro de procesarJob() para la decisión que sigue.
    let resultadoIAListo = job.resultadoIAListo;

    if (!job.resultadoDeterministicoListo) {
      const { continuarProcesamiento } = await manejador.ejecutarExtraccionDeterministica(job, bytes);
      if (!continuarProcesamiento) resultadoIAListo = true;
      await db.trabajoProcesamientoDocumento.update({
        where: { id: job.id },
        data: { resultadoDeterministicoListo: true, ...(resultadoIAListo ? { resultadoIAListo: true } : {}) },
      });
    }

    if (!resultadoIAListo) {
      await manejador.ejecutarExtraccionIA(job, bytes);
      await db.trabajoProcesamientoDocumento.update({ where: { id: job.id }, data: { resultadoIAListo: true } });
    }

    await manejador.reconciliarYFinalizar(job);

    await db.trabajoProcesamientoDocumento.update({
      where: { id: job.id },
      data: { estatus: "COMPLETADO", terminadoEn: new Date() },
    });
  } catch (error) {
    await db.trabajoProcesamientoDocumento.update({
      where: { id: job.id },
      data: {
        estatus: "ERROR",
        intentos: { increment: 1 },
        ultimoIntentoEn: new Date(),
        error: mensajeDeError(error),
      },
    });
  }
}

export type ResultadoCorridaWorker = { tomados: number; completados: number; conError: number };

// Punto de entrada único — lo llama el endpoint de cron, y también se puede
// invocar justo después de encolar un trabajo para procesar de inmediato
// sin esperar a la siguiente corrida de cron (el cron queda como red de
// seguridad para jobs abandonados/reintentos, no como el único disparador).
export async function procesarTrabajosPendientes(): Promise<ResultadoCorridaWorker> {
  return procesarCandidatos(await buscarCandidatos({}, LIMITE_JOBS_POR_CORRIDA));
}

// Corrida acotada a una Empresa (y opcionalmente a ciertas referencias) —
// la usa una petición de usuario (después de subir, o al consultar el
// avance de un lote) para procesar SOLO lo suyo, nunca trabajos de otras
// Empresas. Mismo reclamo optimista que la corrida general: dos peticiones
// simultáneas nunca procesan el mismo trabajo dos veces.
export async function procesarTrabajos(
  alcance: { empresaId: string; referencias?: string[] },
  limite = 1
): Promise<ResultadoCorridaWorker> {
  if (!alcance.empresaId) throw new Error("procesarTrabajos requiere una Empresa.");
  return procesarCandidatos(await buscarCandidatos(alcance, limite));
}

async function procesarCandidatos(candidatos: TrabajoProcesamientoDocumento[]): Promise<ResultadoCorridaWorker> {
  let tomados = 0;
  let completados = 0;
  let conError = 0;

  for (const candidato of candidatos) {
    // Por construcción, buscarCandidatos() solo devuelve filas en uno de
    // estos tres estatus — nunca COMPLETADO.
    const estatusOrigen = candidato.estatus as "PENDIENTE" | "PROCESANDO" | "ERROR";
    const gano = await reclamarJob(
      candidato.id,
      estatusOrigen,
      estatusOrigen === "PROCESANDO" ? candidato.procesandoDesde : undefined
    );
    if (!gano) continue; // otro worker ya lo tomó — no es un error, solo se salta

    tomados++;
    await procesarJob(candidato);
    const final = await db.trabajoProcesamientoDocumento.findUnique({ where: { id: candidato.id }, select: { estatus: true } });
    if (final?.estatus === "COMPLETADO") completados++;
    else if (final?.estatus === "ERROR") conError++;
  }

  return { tomados, completados, conError };
}

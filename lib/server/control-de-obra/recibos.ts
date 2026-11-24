import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeVerRecibosFinancieros } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import type { EstatusPago } from "@/lib/generated/prisma/enums";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError, sumarContratoVigentePorBeneficiario } from "./estructura-contractual";
import { obtenerArchivo } from "@/lib/server/archivos";

// Mismo patrón que cierre-semana.ts/financiero-cliente.ts: las funciones de
// cálculo contractual aceptan un cliente Prisma genérico (db fuera de
// transacción, tx dentro de generarRecibo) en vez de asumir uno solo — así
// generarRecibo puede leer los mismos números que ya se muestran en pantalla
// sin duplicar la consulta ni arriesgar una carrera con el corte que se está
// generando.
type Cliente = Prisma.TransactionClient;

function requerirVerRecibos(usuario: UsuarioSesion): string {
  if (!puedeVerRecibosFinancieros(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// ---------------------------------------------------------------------------
// Control contractual del contratista (Contratistas: Control Contractual +
// Estimaciones, septiembre 2026) — mismo criterio que obtenerControlContractual
// de Cliente (financiero-cliente.ts): todo en vivo, nada persistido. La base
// "trabajos"/contractual es SIEMPRE CorteSemanal.montoBruto (cantidadEjecutada
// × precioUnitarioContratista), nunca montoNeto — montoNeto = montoBruto +
// ajustes, y `ajustes` es un campo reservado en el schema que ningún flujo
// escribe hoy (queda siempre en 0), pero mezclarlo aquí rompería la
// comparabilidad de base económica con montoContrato (mismo tipo de
// corrección que ya se hizo para Administración/Control Contractual de
// Cliente esta sesión). montoNeto sigue siendo el importe real pagadero —
// nunca se toca su uso existente ("Importe", "Pagado acumulado").
// ---------------------------------------------------------------------------

type CorteContractual = {
  id: string;
  montoBruto: number;
  semanaFechaInicio: Date;
};

// Todos los cortes GENERADO de un contratista, ordenados cronológicamente —
// base compartida para el número de estimación derivado y los acumulados. Un
// corte ANULADO siempre tiene montoBruto = 0 (se anula exactamente cuando
// montoNeto llega a 0 — ver generarOReconciliarCorte), así que excluirlos no
// pierde ningún importe.
async function obtenerCortesContractualesOrdenados(
  cliente: Cliente,
  beneficiarioProyectoId: string
): Promise<CorteContractual[]> {
  const cortes = await cliente.corteSemanal.findMany({
    where: { beneficiarioProyectoId, estatus: "GENERADO" },
    select: { id: true, montoBruto: true, semana: { select: { fechaInicio: true } } },
    orderBy: { semana: { fechaInicio: "asc" } },
  });
  return cortes.map((c) => ({
    id: c.id,
    montoBruto: Number(c.montoBruto),
    semanaFechaInicio: c.semana.fechaInicio,
  }));
}

async function montoContratoDeBeneficiario(cliente: Cliente, beneficiarioProyectoId: string): Promise<number> {
  const contratos = await cliente.contratoContratista.findMany({
    where: { beneficiarioProyectoId },
    select: {
      beneficiarioProyectoId: true,
      // Ver estructura-contractual.ts:contratosConConceptos — un concepto
      // eliminado/cancelado deja de contar en "Contrato vigente".
      conceptos: {
        where: { concepto: { estatus: "ACTIVO" } },
        select: { cantidad: true, precioUnitarioContratista: true },
      },
    },
  });
  return sumarContratoVigentePorBeneficiario(contratos).get(beneficiarioProyectoId) ?? 0;
}

export type ResumenContractualContratista = {
  montoContrato: number;
  estimadoAnterior: number;
  estaEstimacion: number;
  estimadoAcumulado: number;
  saldoContractual: number;
  porcentajeAvance: number;
};

// Resumen contractual de un contratista completo (sin corteId — usado por el
// resumen del acordeón: solo montoContrato/estimadoAcumulado/saldoContractual/
// porcentajeAvance tienen significado, estimadoAnterior/estaEstimacion quedan
// en 0) o de UN corte puntual dentro de su propia serie cronológica (con
// corteId — usado por el detalle histórico y el PDF: "estimado anterior"
// excluye ese corte, "esta estimación" es su propio montoBruto, "acumulado"
// los incluye a ambos).
function calcularResumenContractual(
  montoContrato: number,
  cortesOrdenados: CorteContractual[],
  corteId?: string
): ResumenContractualContratista {
  let acumulandoTotal = 0;
  let anteriorAlCorte = 0;
  let estaEstimacion = 0;

  for (const c of cortesOrdenados) {
    if (corteId && c.id === corteId) {
      anteriorAlCorte = acumulandoTotal;
      estaEstimacion = c.montoBruto;
    }
    acumulandoTotal += c.montoBruto;
  }

  const estimadoAcumulado = acumulandoTotal;
  return {
    montoContrato,
    estimadoAnterior: corteId ? anteriorAlCorte : 0,
    estaEstimacion: corteId ? estaEstimacion : 0,
    estimadoAcumulado,
    saldoContractual: montoContrato - estimadoAcumulado,
    porcentajeAvance: montoContrato > 0 ? (estimadoAcumulado / montoContrato) * 100 : 0,
  };
}

// Posición cronológica de un corte entre los GENERADO de su propio contratista
// — derivada en lectura, nunca guardada (ver punto 5 del plan de Contratistas,
// septiembre 2026). Una vez que existe un ReciboPago para ese corte, el número
// impreso/mostrado usa el que quedó congelado en su configuracionSnapshot en
// vez de este cálculo en vivo (ver generarRecibo/obtenerDatosPdfRecibo) — así
// un documento ya generado nunca cambia de número aunque una semana anterior
// se reabra y anule después.
function numeroEstimacionDerivado(
  cortesOrdenados: CorteContractual[],
  corteId: string
): string | null {
  const idx = cortesOrdenados.findIndex((c) => c.id === corteId);
  return idx === -1 ? null : `EST-${String(idx + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Resumen financiero por contratista (expediente) — proyecto+beneficiario.
// Todo se lee de CorteSemanal, nunca se recalcula desde Contrato General ni
// desde Avance de Obra (regla explícita de esta etapa). "Contrato vigente"
// sigue siendo la suma de ContratoConcepto (cantidad × P.U.), la misma lógica
// que ya usa contratistas-view.tsx, calculada aquí por beneficiario en vez de
// por contrato individual (un contratista puede tener más de un contrato).
//
// Nota para el futuro (no implementado a propósito): Aditiva ya existe como
// modelo pero pertenece al flujo más viejo de Reporte General
// (BeneficiarioProyecto.montoContrato en texto libre) — cuando este módulo
// necesite anticipos/aditivas propios de Contrato General, este es el lugar
// donde Saldo contractual tendría que restarlos también.
// ---------------------------------------------------------------------------

export type ResumenFinancieroContratista = {
  contratoVigente: number;
  // Base contractual (Σ montoBruto de cortes GENERADO) — comparable con
  // contratoVigente, nunca incluye montoNeto/ajustes (ver comentario arriba).
  estimadoAcumulado: number;
  // Importe real: Σ montoNeto de cortes cuyo MovimientoSemanal ya está
  // LIQUIDADO — a diferencia de estimadoAcumulado, este SÍ debe reflejar el
  // dinero real entregado, nunca solo la base contractual.
  pagadoAcumulado: number;
  saldoContractual: number;
  porcentajeAvance: number;
};

export async function obtenerResumenFinancieroContratistas(
  usuario: UsuarioSesion,
  proyectoId: string
): Promise<Map<string, ResumenFinancieroContratista>> {
  requerirVerRecibos(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const [contratos, cortes] = await Promise.all([
    db.contratoContratista.findMany({
      where: { beneficiarioProyecto: { proyectoId } },
      select: {
        beneficiarioProyectoId: true,
        conceptos: {
          where: { concepto: { estatus: "ACTIVO" } },
          select: { cantidad: true, precioUnitarioContratista: true },
        },
      },
    }),
    db.corteSemanal.findMany({
      where: { proyectoId, estatus: "GENERADO" },
      select: {
        beneficiarioProyectoId: true,
        montoBruto: true,
        montoNeto: true,
        movimientoSemanal: { select: { estatusPago: true } },
      },
    }),
  ]);

  const contratoVigentePorBeneficiario = sumarContratoVigentePorBeneficiario(contratos);

  const estimadoPorBeneficiario = new Map<string, number>();
  const pagadoPorBeneficiario = new Map<string, number>();
  for (const corte of cortes) {
    estimadoPorBeneficiario.set(
      corte.beneficiarioProyectoId,
      (estimadoPorBeneficiario.get(corte.beneficiarioProyectoId) ?? 0) + Number(corte.montoBruto)
    );
    if (corte.movimientoSemanal?.estatusPago === "LIQUIDADO") {
      pagadoPorBeneficiario.set(
        corte.beneficiarioProyectoId,
        (pagadoPorBeneficiario.get(corte.beneficiarioProyectoId) ?? 0) + Number(corte.montoNeto)
      );
    }
  }

  const beneficiarioIds = new Set([
    ...contratoVigentePorBeneficiario.keys(),
    ...estimadoPorBeneficiario.keys(),
  ]);

  const resultado = new Map<string, ResumenFinancieroContratista>();
  for (const id of beneficiarioIds) {
    const contratoVigente = contratoVigentePorBeneficiario.get(id) ?? 0;
    const estimadoAcumulado = estimadoPorBeneficiario.get(id) ?? 0;
    resultado.set(id, {
      contratoVigente,
      estimadoAcumulado,
      pagadoAcumulado: pagadoPorBeneficiario.get(id) ?? 0,
      saldoContractual: contratoVigente - estimadoAcumulado,
      porcentajeAvance: contratoVigente > 0 ? (estimadoAcumulado / contratoVigente) * 100 : 0,
    });
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Historial de cortes — solo GENERADO (ANULADO se conserva en histórico/
// auditoría pero no aparece en la vista operativa normal, tal como se pidió).
// ---------------------------------------------------------------------------

export type CorteHistorial = {
  id: string;
  numero: number;
  // Identificador contractual/cronológico principal — derivado en vivo si
  // este corte todavía no tiene ReciboPago; congelado (nunca recalculado) en
  // cuanto uno existe (ver numeroEstimacionParaCorte).
  numeroEstimacion: string;
  semanaId: string;
  semanaNumero: number;
  semanaAnio: number;
  montoNeto: number;
  estimadoAcumulado: number;
  saldoContractual: number;
  estatusPago: EstatusPago | null;
  reciboVigenteId: string | null;
  reciboVigenteFolio: string | null;
  reciboVigenteFirmado: boolean;
  createdAt: string;
};

// Snapshot mínimo que interesa leer de vuelta de un ReciboPago ya generado —
// mismo criterio de fallback ya usado para logoUrl/mostrarLeyenda: si el
// recibo se generó antes de que este campo existiera, se recalcula en vivo
// como si nunca se hubiera generado (nunca se "repara" el snapshot viejo).
function numeroEstimacionParaCorte(
  reciboSnapshot: { numeroEstimacion?: string } | null,
  cortesOrdenados: CorteContractual[],
  corteId: string
): string {
  return (
    reciboSnapshot?.numeroEstimacion ??
    numeroEstimacionDerivado(cortesOrdenados, corteId) ??
    "—"
  );
}

export async function obtenerHistorialCortes(
  usuario: UsuarioSesion,
  proyectoId: string,
  beneficiarioProyectoId: string
): Promise<CorteHistorial[]> {
  requerirVerRecibos(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const [montoContrato, cortesOrdenados, cortes] = await Promise.all([
    montoContratoDeBeneficiario(db, beneficiarioProyectoId),
    obtenerCortesContractualesOrdenados(db, beneficiarioProyectoId),
    db.corteSemanal.findMany({
      where: { proyectoId, beneficiarioProyectoId, estatus: "GENERADO" },
      orderBy: { semana: { fechaInicio: "desc" } },
      include: {
        semana: { select: { numero: true, anio: true } },
        movimientoSemanal: { select: { estatusPago: true } },
        recibos: {
          where: { estatus: "VIGENTE" },
          select: { id: true, folio: true, archivoEvidenciaRef: true, configuracionSnapshot: true },
        },
      },
    }),
  ]);

  return cortes.map((c) => {
    const recibo = c.recibos[0] ?? null;
    const resumen = calcularResumenContractual(montoContrato, cortesOrdenados, c.id);
    return {
      id: c.id,
      numero: c.numero,
      numeroEstimacion: numeroEstimacionParaCorte(
        recibo?.configuracionSnapshot as { numeroEstimacion?: string } | null,
        cortesOrdenados,
        c.id
      ),
      semanaId: c.semanaId,
      semanaNumero: c.semana.numero,
      semanaAnio: c.semana.anio,
      montoNeto: Number(c.montoNeto),
      estimadoAcumulado: resumen.estimadoAcumulado,
      saldoContractual: resumen.saldoContractual,
      estatusPago: c.movimientoSemanal?.estatusPago ?? null,
      reciboVigenteId: recibo?.id ?? null,
      reciboVigenteFolio: recibo?.folio ?? null,
      reciboVigenteFirmado: Boolean(recibo?.archivoEvidenciaRef),
      createdAt: c.createdAt.toISOString(),
    };
  });
}

// Igual que obtenerHistorialCortes pero para TODOS los contratistas del
// proyecto de una sola consulta (evita N+1 al pintar Contratistas completo).
export async function obtenerHistorialCortesPorProyecto(
  usuario: UsuarioSesion,
  proyectoId: string
): Promise<Map<string, CorteHistorial[]>> {
  requerirVerRecibos(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const [contratos, cortes] = await Promise.all([
    db.contratoContratista.findMany({
      where: { beneficiarioProyecto: { proyectoId } },
      select: {
        beneficiarioProyectoId: true,
        conceptos: {
          where: { concepto: { estatus: "ACTIVO" } },
          select: { cantidad: true, precioUnitarioContratista: true },
        },
      },
    }),
    db.corteSemanal.findMany({
      where: { proyectoId, estatus: "GENERADO" },
      orderBy: { semana: { fechaInicio: "asc" } },
      include: {
        semana: { select: { numero: true, anio: true, fechaInicio: true } },
        movimientoSemanal: { select: { estatusPago: true } },
        recibos: {
          where: { estatus: "VIGENTE" },
          select: { id: true, folio: true, archivoEvidenciaRef: true, configuracionSnapshot: true },
        },
      },
    }),
  ]);

  const contratoVigentePorBeneficiario = sumarContratoVigentePorBeneficiario(contratos);

  // Serie cronológica ascendente por beneficiario — misma consulta ya trae
  // todos los cortes del proyecto ordenados por semana, así que se agrupan
  // aquí en vez de repetir una consulta por contratista (evita N+1).
  const cortesOrdenadosPorBeneficiario = new Map<string, CorteContractual[]>();
  for (const c of cortes) {
    const lista = cortesOrdenadosPorBeneficiario.get(c.beneficiarioProyectoId) ?? [];
    lista.push({ id: c.id, montoBruto: Number(c.montoBruto), semanaFechaInicio: c.semana.fechaInicio });
    cortesOrdenadosPorBeneficiario.set(c.beneficiarioProyectoId, lista);
  }

  const resultado = new Map<string, CorteHistorial[]>();
  for (const c of cortes) {
    const recibo = c.recibos[0] ?? null;
    const montoContrato = contratoVigentePorBeneficiario.get(c.beneficiarioProyectoId) ?? 0;
    const cortesOrdenados = cortesOrdenadosPorBeneficiario.get(c.beneficiarioProyectoId) ?? [];
    const resumen = calcularResumenContractual(montoContrato, cortesOrdenados, c.id);
    const fila: CorteHistorial = {
      id: c.id,
      numero: c.numero,
      numeroEstimacion: numeroEstimacionParaCorte(
        recibo?.configuracionSnapshot as { numeroEstimacion?: string } | null,
        cortesOrdenados,
        c.id
      ),
      semanaId: c.semanaId,
      semanaNumero: c.semana.numero,
      semanaAnio: c.semana.anio,
      montoNeto: Number(c.montoNeto),
      estimadoAcumulado: resumen.estimadoAcumulado,
      saldoContractual: resumen.saldoContractual,
      estatusPago: c.movimientoSemanal?.estatusPago ?? null,
      reciboVigenteId: recibo?.id ?? null,
      reciboVigenteFolio: recibo?.folio ?? null,
      reciboVigenteFirmado: Boolean(recibo?.archivoEvidenciaRef),
      createdAt: c.createdAt.toISOString(),
    };
    const lista = resultado.get(c.beneficiarioProyectoId) ?? [];
    lista.push(fila);
    resultado.set(c.beneficiarioProyectoId, lista);
  }
  // La UI espera más reciente primero (mismo orden que antes) — se ordenó
  // ascendente arriba solo para poder calcular acumulados en una pasada.
  for (const lista of resultado.values()) {
    lista.reverse();
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Detalle de un corte — snapshot congelado exclusivamente desde
// CorteSemanalConcepto. La Partida se resuelve en vivo vía Concepto.partida
// (organizativo, no un precio) — nunca se lee ningún P.U. actual.
// ---------------------------------------------------------------------------

export type DetalleCorte = {
  id: string;
  numero: number;
  numeroEstimacion: string;
  proyectoNombre: string;
  contratistaNombre: string;
  especialidadContratista: string | null;
  semanaNumero: number;
  semanaAnio: number;
  fechaCorte: string;
  generadoPorNombre: string;
  estatus: "GENERADO" | "ANULADO";
  estatusPago: EstatusPago | null;
  montoBruto: number;
  ajustes: number;
  montoNeto: number;
  // null para un corte ANULADO (sin avance vigente — no tiene sentido de
  // "avance contractual" ese caso puntual, ver calcularResumenContractual).
  resumenContractual: ResumenContractualContratista | null;
  reciboVigente: {
    id: string;
    folio: string;
    archivoEvidenciaRef: string | null;
    archivoEvidenciaNombre: string | null;
    fechaRecepcion: string | null;
  } | null;
  detalle: {
    id: string;
    partidaNombre: string | null;
    descripcionConcepto: string;
    unidad: string;
    cantidadContratada: number;
    cantidadEjecutada: number;
    cantidadAcumulada: number;
    precioUnitarioContratista: number;
    importe: number;
  }[];
};

// Cantidad ejecutada acumulada por concepto, sumando CorteSemanalConcepto de
// todos los cortes GENERADO de ESE contratista hasta (e incluyendo) la
// semana indicada — misma fuente congelada que ya usa el detalle del corte,
// nunca AvanceConcepto en vivo (que no distingue "hasta esta semana" de
// cortes ya cerrados de "avance actual del proyecto").
async function cantidadAcumuladaPorConcepto(
  cliente: Cliente,
  beneficiarioProyectoId: string,
  conceptoIds: string[],
  hastaFechaInicio: Date
): Promise<Map<string, number>> {
  if (conceptoIds.length === 0) return new Map();
  const filas = await cliente.corteSemanalConcepto.findMany({
    where: {
      conceptoId: { in: conceptoIds },
      corteSemanal: {
        beneficiarioProyectoId,
        estatus: "GENERADO",
        semana: { fechaInicio: { lte: hastaFechaInicio } },
      },
    },
    select: { conceptoId: true, cantidadEjecutada: true },
  });
  const mapa = new Map<string, number>();
  for (const f of filas) {
    mapa.set(f.conceptoId, (mapa.get(f.conceptoId) ?? 0) + Number(f.cantidadEjecutada));
  }
  return mapa;
}

export async function obtenerDetalleCorte(
  usuario: UsuarioSesion,
  corteSemanalId: string
): Promise<DetalleCorte> {
  const empresaId = requerirVerRecibos(usuario);

  const corte = await db.corteSemanal.findFirst({
    where: { id: corteSemanalId, empresaId },
    include: {
      proyecto: { select: { nombre: true } },
      beneficiarioProyecto: {
        include: { beneficiario: { select: { nombre: true, contratista: { select: { descripcion: true } } } } },
      },
      semana: { select: { numero: true, anio: true, fechaInicio: true } },
      generadoPor: { select: { nombre: true } },
      movimientoSemanal: { select: { estatusPago: true } },
      recibos: {
        where: { estatus: "VIGENTE" },
        select: {
          id: true,
          folio: true,
          archivoEvidenciaRef: true,
          archivoEvidenciaNombre: true,
          fechaRecepcion: true,
          configuracionSnapshot: true,
        },
      },
      detalle: {
        include: {
          concepto: { select: { partida: { select: { nombre: true } } } },
          contratoConcepto: { select: { cantidad: true } },
        },
      },
    },
  });
  if (!corte) throw new RegistroNoEncontradoError("El corte");

  const reciboVigente = corte.recibos[0] ?? null;

  const [montoContrato, cortesOrdenados, acumuladoPorConcepto] = await Promise.all([
    montoContratoDeBeneficiario(db, corte.beneficiarioProyectoId),
    obtenerCortesContractualesOrdenados(db, corte.beneficiarioProyectoId),
    cantidadAcumuladaPorConcepto(
      db,
      corte.beneficiarioProyectoId,
      corte.detalle.map((d) => d.conceptoId),
      corte.semana.fechaInicio
    ),
  ]);

  const resumenContractual =
    corte.estatus === "GENERADO" ? calcularResumenContractual(montoContrato, cortesOrdenados, corte.id) : null;

  return {
    id: corte.id,
    numero: corte.numero,
    numeroEstimacion: numeroEstimacionParaCorte(
      reciboVigente?.configuracionSnapshot as { numeroEstimacion?: string } | null,
      cortesOrdenados,
      corte.id
    ),
    proyectoNombre: corte.proyecto.nombre,
    contratistaNombre: corte.beneficiarioProyecto.beneficiario.nombre,
    especialidadContratista: corte.beneficiarioProyecto.beneficiario.contratista?.descripcion ?? null,
    semanaNumero: corte.semana.numero,
    semanaAnio: corte.semana.anio,
    fechaCorte: corte.createdAt.toISOString(),
    generadoPorNombre: corte.generadoPor.nombre,
    estatus: corte.estatus,
    estatusPago: corte.movimientoSemanal?.estatusPago ?? null,
    montoBruto: Number(corte.montoBruto),
    ajustes: Number(corte.ajustes),
    montoNeto: Number(corte.montoNeto),
    resumenContractual,
    reciboVigente: reciboVigente
      ? {
          id: reciboVigente.id,
          folio: reciboVigente.folio,
          archivoEvidenciaRef: reciboVigente.archivoEvidenciaRef,
          archivoEvidenciaNombre: reciboVigente.archivoEvidenciaNombre,
          fechaRecepcion: reciboVigente.fechaRecepcion?.toISOString() ?? null,
        }
      : null,
    detalle: corte.detalle.map((d) => ({
      id: d.id,
      partidaNombre: d.concepto.partida.nombre,
      descripcionConcepto: d.descripcionConcepto,
      unidad: d.unidad,
      cantidadContratada: Number(d.contratoConcepto.cantidad),
      cantidadEjecutada: Number(d.cantidadEjecutada),
      cantidadAcumulada: acumuladoPorConcepto.get(d.conceptoId) ?? Number(d.cantidadEjecutada),
      precioUnitarioContratista: Number(d.precioUnitarioContratista),
      importe: Number(d.importe),
    })),
  };
}

// ---------------------------------------------------------------------------
// Generar/regenerar recibo — folio atómico por empresa, "un corte, a lo más
// un recibo VIGENTE a la vez" resuelto en el servicio dentro de una
// transacción.
// ---------------------------------------------------------------------------

export type ReciboGenerado = {
  id: string;
  folio: string;
  esRegeneracion: boolean;
};

export async function generarRecibo(
  usuario: UsuarioSesion,
  corteSemanalId: string
): Promise<ReciboGenerado> {
  const empresaId = requerirVerRecibos(usuario);

  return db.$transaction(async (tx) => {
    const corte = await tx.corteSemanal.findFirst({
      where: { id: corteSemanalId, empresaId },
      include: {
        recibos: { where: { estatus: "VIGENTE" } },
        beneficiarioProyecto: {
          include: { beneficiario: { select: { contratista: { select: { descripcion: true } } } } },
        },
        proyecto: { select: { numeroContrato: true, supervisorUsuario: { select: { nombre: true } } } },
      },
    });
    if (!corte) throw new RegistroNoEncontradoError("El corte");
    if (corte.estatus !== "GENERADO") {
      throw new ValidacionError(
        "Este corte está anulado (sin avance aprobado) — no se puede generar un recibo."
      );
    }

    const vigente = corte.recibos[0] ?? null;
    if (vigente?.archivoEvidenciaRef) {
      throw new ValidacionError(
        "Ya existe un recibo firmado para este corte. No se puede regenerar — cualquier corrección se maneja aparte."
      );
    }

    if (vigente) {
      await tx.reciboPago.update({
        where: { id: vigente.id },
        data: { estatus: "SUPERSEDIDO" },
      });
    }

    // Contador atómico: Postgres bloquea esta fila hasta que la transacción
    // termina — dos generaciones simultáneas de la misma empresa nunca
    // pueden sacar el mismo folio (ver prisma/schema.prisma, Empresa).
    const empresa = await tx.empresa.update({
      where: { id: empresaId },
      data: { ultimoFolioRecibo: { increment: 1 } },
      select: {
        ultimoFolioRecibo: true,
        nombre: true,
        razonSocial: true,
        logoRef: true,
        reciboTitulo: true,
        reciboLeyenda: true,
        reciboRazonSocial: true,
        reciboMostrarDetalle: true,
        reciboMostrarPU: true,
        reciboMostrarLeyenda: true,
        reciboTituloLeyenda: true,
      },
    });
    const folio = `REC-${String(empresa.ultimoFolioRecibo).padStart(6, "0")}`;

    // Resumen contractual + número de estimación + especialidad + supervisor
    // — se calculan una sola vez, AQUÍ, y quedan congelados para siempre en
    // configuracionSnapshot (mismo criterio que título/leyenda/logo de
    // arriba): reasignar el Supervisor del proyecto, editar el contrato o
    // capturar más semanas después nunca altera un documento ya generado.
    const [montoContrato, cortesOrdenados] = await Promise.all([
      montoContratoDeBeneficiario(tx, corte.beneficiarioProyectoId),
      obtenerCortesContractualesOrdenados(tx, corte.beneficiarioProyectoId),
    ]);
    const resumenContractual = calcularResumenContractual(montoContrato, cortesOrdenados, corte.id);
    const numeroEstimacion = numeroEstimacionDerivado(cortesOrdenados, corte.id) ?? "—";

    const configuracionSnapshot = {
      titulo: empresa.reciboTitulo,
      leyenda: empresa.reciboLeyenda,
      razonSocial: empresa.reciboRazonSocial ?? empresa.razonSocial ?? empresa.nombre,
      mostrarDetalle: empresa.reciboMostrarDetalle,
      mostrarPU: empresa.reciboMostrarPU,
      mostrarLeyenda: empresa.reciboMostrarLeyenda,
      tituloLeyenda: empresa.reciboTituloLeyenda,
      // Logo AL MOMENTO de generar — el documento histórico se ve igual
      // aunque el logo de la Empresa cambie después (branding congelado,
      // Portal Master). La clave sigue llamándose `logoUrl` por compatibilidad
      // con snapshots ya guardados; el valor es una referencia de
      // almacenamiento (lib/server/archivos.ts), no una URL usable directo —
      // se resuelve recién al armar los datos del PDF (obtenerDatosPdfRecibo).
      logoUrl: empresa.logoRef,
      numeroEstimacion,
      resumenContractual,
      especialidadContratista: corte.beneficiarioProyecto.beneficiario.contratista?.descripcion ?? null,
      proyectoNumeroContrato: corte.proyecto.numeroContrato,
      // null si el proyecto no tiene Supervisor asignado — el PDF deja la
      // línea de firma sin nombre impreso en ese caso (nunca se sustituye por
      // cerradoPor/generadoPor, ver Proyecto.supervisorUsuarioId).
      supervisorNombre: corte.proyecto.supervisorUsuario?.nombre ?? null,
    };

    const recibo = await tx.reciboPago.create({
      data: {
        empresaId,
        corteSemanalId: corte.id,
        numeroFolio: empresa.ultimoFolioRecibo,
        folio,
        estatus: "VIGENTE",
        configuracionSnapshot,
        generadoPorId: usuario.id,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "ReciboPago",
      entidadId: recibo.id,
      accion: vigente ? "EDITAR" : "CREAR",
      valorAnterior: vigente ? { folio: vigente.folio, estatus: "VIGENTE" } : null,
      valorNuevo: { folio: recibo.folio, estatus: "VIGENTE", corteSemanalId: corte.id },
    });

    return { id: recibo.id, folio: recibo.folio, esRegeneracion: Boolean(vigente) };
  });
}

// ---------------------------------------------------------------------------
// Evidencia firmada — la sube la Server Action (que ya subió el archivo vía
// subirArchivo(), lib/server/archivos.ts) y esta función solo persiste la
// referencia resultante + audita.
// ---------------------------------------------------------------------------

const EvidenciaSchema = z.object({
  archivoEvidenciaRef: z.string().trim().min(1),
  archivoEvidenciaNombre: z.string().trim().min(1),
  fechaRecepcion: z.coerce.date().optional().nullable(),
});

export async function registrarEvidenciaRecibo(
  usuario: UsuarioSesion,
  reciboId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirVerRecibos(usuario);
  const datos = EvidenciaSchema.parse(datosCrudos);

  const recibo = await db.reciboPago.findFirst({ where: { id: reciboId, empresaId } });
  if (!recibo) throw new RegistroNoEncontradoError("El recibo");
  if (recibo.estatus !== "VIGENTE") {
    throw new ValidacionError(
      "Este recibo ya no está vigente (fue reemplazado por uno más reciente) — la evidencia debe subirse sobre el recibo vigente actual."
    );
  }

  const actualizado = await db.reciboPago.update({
    where: { id: recibo.id },
    data: {
      archivoEvidenciaRef: datos.archivoEvidenciaRef,
      archivoEvidenciaNombre: datos.archivoEvidenciaNombre,
      fechaRecepcion: datos.fechaRecepcion ?? new Date(),
      subidoPorId: usuario.id,
      subidoEn: new Date(),
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "ReciboPago",
    entidadId: actualizado.id,
    accion: "EDITAR",
    valorAnterior: { archivoEvidenciaRef: recibo.archivoEvidenciaRef },
    valorNuevo: {
      archivoEvidenciaRef: actualizado.archivoEvidenciaRef,
      archivoEvidenciaNombre: actualizado.archivoEvidenciaNombre,
    },
  });

  return actualizado;
}

// Referencia de almacenamiento de la evidencia firmada de UN recibo, para el
// endpoint de descarga autenticada — mismo gate que el resto de este archivo
// (puedeVerRecibosFinancieros, capa de privacidad financiera/Vista Privada).
export async function obtenerRefEvidenciaRecibo(
  usuario: UsuarioSesion,
  reciboId: string
): Promise<string | null> {
  const empresaId = requerirVerRecibos(usuario);
  const recibo = await db.reciboPago.findFirst({
    where: { id: reciboId, empresaId },
    select: { archivoEvidenciaRef: true },
  });
  if (!recibo) throw new RegistroNoEncontradoError("El recibo");
  return recibo.archivoEvidenciaRef;
}

// ---------------------------------------------------------------------------
// Datos para el PDF — recibo individual y el combinado por semana.
// ---------------------------------------------------------------------------

export type DatosPdfRecibo = {
  folio: string;
  // Derivado o congelado (ver numeroEstimacionParaCorte) — null solo si el
  // corte no tiene ningún corte GENERADO propio que numerar (no debería
  // pasar para un recibo real, pero nunca se fuerza un valor inventado).
  numeroEstimacion: string | null;
  proyectoNombre: string;
  proyectoNumeroContrato: string | null;
  contratistaNombre: string;
  especialidadContratista: string | null;
  // null = sin Supervisor asignado al proyecto al momento de generar — el PDF
  // deja la línea de firma sin nombre impreso, nunca inventa un sustituto.
  supervisorNombre: string | null;
  semanaNumero: number;
  semanaAnio: number;
  semanaFechaInicio: string;
  semanaFechaFin: string;
  // Fecha del corte semanal (cierre de esa semana) — distinta de
  // fechaGeneracion (cuándo se generó/regeneró ESTE documento, que puede ser
  // posterior si el recibo se generó días después del cierre).
  fechaCorte: string;
  fechaGeneracion: string;
  numeroCorte: number;
  // null para recibos generados antes de agregar este bloque al snapshot —
  // el PDF simplemente omite la sección, nunca se recalcula retroactivamente.
  resumenContractual: ResumenContractualContratista | null;
  configuracion: {
    titulo: string;
    leyenda: string | null;
    razonSocial: string;
    mostrarDetalle: boolean;
    mostrarPU: boolean;
    mostrarLeyenda: boolean;
    tituloLeyenda: string;
  };
  // Bytes ya resueltos del logo (o null si no hay/si no se pudo descargar) —
  // el PDF nunca recibe una URL/ref cruda, evita depender de que
  // @react-pdf/renderer resuelva una URL firmada antes de que expire.
  logoBuffer: Buffer | null;
  detalle: {
    descripcion: string;
    unidad: string;
    cantidadContratada: number;
    cantidad: number;
    cantidadAcumulada: number;
    precioUnitario: number;
    importe: number;
  }[];
  total: number;
};

type ConfiguracionSnapshotGuardada = DatosPdfRecibo["configuracion"] & {
  logoUrl: string | null;
  numeroEstimacion?: string;
  resumenContractual?: ResumenContractualContratista;
  especialidadContratista?: string | null;
  proyectoNumeroContrato?: string | null;
  supervisorNombre?: string | null;
};

export async function obtenerDatosPdfRecibo(
  usuario: UsuarioSesion,
  reciboId: string
): Promise<DatosPdfRecibo> {
  const empresaId = requerirVerRecibos(usuario);

  const recibo = await db.reciboPago.findFirst({
    where: { id: reciboId, empresaId },
    include: {
      corteSemanal: {
        include: {
          proyecto: { select: { nombre: true } },
          beneficiarioProyecto: {
            include: {
              beneficiario: { select: { nombre: true } },
            },
          },
          semana: { select: { numero: true, anio: true, fechaInicio: true, fechaFin: true } },
          detalle: { include: { contratoConcepto: { select: { cantidad: true } } } },
        },
      },
    },
  });
  if (!recibo) throw new RegistroNoEncontradoError("El recibo");

  // Recibos generados antes de agregar cada campo al snapshot no lo tienen en
  // su JSON guardado — se completa con null/el mismo default de siempre,
  // nunca con el valor actual de Empresa/Proyecto (el snapshot histórico no
  // se "repara" retroactivamente).
  const configGuardada = recibo.configuracionSnapshot as ConfiguracionSnapshotGuardada;
  const logoRefGuardada = configGuardada.logoUrl ?? null;
  // Resuelve la referencia (ref de R2 o URL histórica de Vercel Blob) a
  // bytes reales — si falla (archivo ya no existe, referencia corrupta), el
  // PDF se genera igual, sin logo, en vez de romper la descarga completa.
  const logoBuffer = logoRefGuardada ? await obtenerArchivo(logoRefGuardada).catch(() => null) : null;

  const conceptoIds = recibo.corteSemanal.detalle.map((d) => d.conceptoId);
  const acumuladoPorConcepto = await cantidadAcumuladaPorConcepto(
    db,
    recibo.corteSemanal.beneficiarioProyectoId,
    conceptoIds,
    recibo.corteSemanal.semana.fechaInicio
  );

  return {
    folio: recibo.folio,
    numeroEstimacion: configGuardada.numeroEstimacion ?? null,
    proyectoNombre: recibo.corteSemanal.proyecto.nombre,
    proyectoNumeroContrato: configGuardada.proyectoNumeroContrato ?? null,
    contratistaNombre: recibo.corteSemanal.beneficiarioProyecto.beneficiario.nombre,
    especialidadContratista: configGuardada.especialidadContratista ?? null,
    supervisorNombre: configGuardada.supervisorNombre ?? null,
    semanaNumero: recibo.corteSemanal.semana.numero,
    semanaAnio: recibo.corteSemanal.semana.anio,
    semanaFechaInicio: recibo.corteSemanal.semana.fechaInicio.toISOString(),
    semanaFechaFin: recibo.corteSemanal.semana.fechaFin.toISOString(),
    fechaCorte: recibo.corteSemanal.createdAt.toISOString(),
    fechaGeneracion: recibo.createdAt.toISOString(),
    numeroCorte: recibo.corteSemanal.numero,
    resumenContractual: configGuardada.resumenContractual ?? null,
    configuracion: {
      titulo: configGuardada.titulo,
      leyenda: configGuardada.leyenda,
      razonSocial: configGuardada.razonSocial,
      mostrarDetalle: configGuardada.mostrarDetalle,
      mostrarPU: configGuardada.mostrarPU,
      // Recibos generados antes de agregar mostrarLeyenda/tituloLeyenda al
      // snapshot no los tienen guardados — se completan con los mismos
      // defaults que ya tenía Empresa antes de esta config (leyenda visible,
      // título estándar), nunca recalculados desde la Empresa actual.
      mostrarLeyenda: configGuardada.mostrarLeyenda ?? true,
      tituloLeyenda: configGuardada.tituloLeyenda ?? "DECLARACIONES Y ACEPTACIÓN DE LA ESTIMACIÓN",
    },
    logoBuffer,
    detalle: recibo.corteSemanal.detalle.map((d) => ({
      descripcion: d.descripcionConcepto,
      unidad: d.unidad,
      cantidadContratada: Number(d.contratoConcepto.cantidad),
      cantidad: Number(d.cantidadEjecutada),
      cantidadAcumulada: acumuladoPorConcepto.get(d.conceptoId) ?? Number(d.cantidadEjecutada),
      precioUnitario: Number(d.precioUnitarioContratista),
      importe: Number(d.importe),
    })),
    total: Number(recibo.corteSemanal.montoNeto),
  };
}

// Para "Descargar todos los recibos de la semana" — solo cortes GENERADO con
// monto > 0, cada uno con su recibo VIGENTE (se genera uno al vuelo si no
// existe todavía, mismo folio atómico que generarRecibo).
export async function obtenerDatosPdfRecibosSemana(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<DatosPdfRecibo[]> {
  requerirVerRecibos(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const cortes = await db.corteSemanal.findMany({
    where: { proyectoId, semanaId, estatus: "GENERADO", montoNeto: { gt: 0 } },
    select: { id: true, recibos: { where: { estatus: "VIGENTE" }, select: { id: true } } },
  });

  const datos: DatosPdfRecibo[] = [];
  for (const corte of cortes) {
    const reciboId = corte.recibos[0]?.id ?? (await generarRecibo(usuario, corte.id)).id;
    datos.push(await obtenerDatosPdfRecibo(usuario, reciboId));
  }
  return datos;
}

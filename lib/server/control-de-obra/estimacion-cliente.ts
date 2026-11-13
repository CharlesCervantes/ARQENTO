import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeEmitirEstimacionCliente, puedeMaterializarEstimacionHistorica } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";
import type { CapaEstimacion } from "@/lib/generated/prisma/enums";
import {
  calcularPrecioConcepto,
  calcularPrecioOperativoConcepto,
  calcularTotalesEstimacion,
  type PorcentajesDefaultProyecto,
} from "@/lib/control-de-obra/contrato-general";
import { sumaEjecutadaPorConcepto } from "./avance-calculo";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";

type Cliente = Prisma.TransactionClient;

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

function numOrNull(valor: { toNumber(): number } | null): number | null {
  return valor === null ? null : valor.toNumber();
}

// ---------------------------------------------------------------------------
// Valorización por concepto — semana ABIERTA (sin EstimacionCliente todavía).
// La misma cantidad física (AvanceConcepto), dos precios (operativo/Cliente y
// privado/Cliente Priv.) — usada únicamente como vista previa antes de
// cerrar; en cuanto la semana cierra, la fuente de cantidades pasa a ser
// EstimacionClienteConcepto (físico congelado) y cada capa se valoriza por
// separado (ver valorizarCapaEnVivo más abajo). Arquitectura por capas —
// Cliente/Cliente Priv. como documentos financieros independientes, agosto
// 2026.
// ---------------------------------------------------------------------------

export type FilaEstimacion = {
  conceptoId: string;
  partidaNombre: string;
  descripcionConcepto: string;
  unidad: string;

  cantidadContratada: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  cantidadPorEjercer: number;
  avancePorcentaje: number;

  precioUnitarioOperativo: number;
  importeContratadoOperativo: number;
  importeEstaSemanaOperativo: number;
  importeAcumuladoOperativo: number;
  importePorEjercerOperativo: number;

  precioUnitarioPrivado: number;
  importeContratadoPrivado: number;
  importeEstaSemanaPrivado: number;
  importeAcumuladoPrivado: number;
  importePorEjercerPrivado: number;
  porcentajeAplicadoPrivado: number | null;

  precioUnitarioBasePrivado: number;
  importeContratadoBasePrivado: number;
  importeEstaSemanaBasePrivado: number;
  importeAcumuladoBasePrivado: number;
  importePorEjercerBasePrivado: number;
};

export type FilaEstimacionOperativa = Omit<
  FilaEstimacion,
  | "precioUnitarioPrivado"
  | "importeContratadoPrivado"
  | "importeEstaSemanaPrivado"
  | "importeAcumuladoPrivado"
  | "importePorEjercerPrivado"
  | "porcentajeAplicadoPrivado"
  | "precioUnitarioBasePrivado"
  | "importeContratadoBasePrivado"
  | "importeEstaSemanaBasePrivado"
  | "importeAcumuladoBasePrivado"
  | "importePorEjercerBasePrivado"
>;

export function soloOperativo(filas: FilaEstimacion[]): FilaEstimacionOperativa[] {
  return filas.map((f) => ({
    conceptoId: f.conceptoId,
    partidaNombre: f.partidaNombre,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    cantidadPorEjercer: f.cantidadPorEjercer,
    avancePorcentaje: f.avancePorcentaje,
    precioUnitarioOperativo: f.precioUnitarioOperativo,
    importeContratadoOperativo: f.importeContratadoOperativo,
    importeEstaSemanaOperativo: f.importeEstaSemanaOperativo,
    importeAcumuladoOperativo: f.importeAcumuladoOperativo,
    importePorEjercerOperativo: f.importePorEjercerOperativo,
  }));
}

export function agruparPorPartida<F extends { partidaNombre: string }>(
  filas: F[]
): { partidaNombre: string; conceptos: F[] }[] {
  const orden: string[] = [];
  const grupos = new Map<string, F[]>();
  for (const fila of filas) {
    if (!grupos.has(fila.partidaNombre)) {
      grupos.set(fila.partidaNombre, []);
      orden.push(fila.partidaNombre);
    }
    grupos.get(fila.partidaNombre)!.push(fila);
  }
  return orden.map((nombre) => ({ partidaNombre: nombre, conceptos: grupos.get(nombre)! }));
}

export function totalOperativo(filas: FilaEstimacionOperativa[] | FilaEstimacion[]): number {
  return filas.reduce((t, f) => t + f.importeEstaSemanaOperativo, 0);
}

export type TotalesPrivados = {
  subtotal: number;
  montoAdministracionOUtilidad: number;
  total: number;
};

export type TotalesOperativos = {
  subtotal: number;
  montoAdministracion: number;
  total: number;
};

type ResultadoValorizacion = {
  filas: FilaEstimacion[];
  totalesOperativos: TotalesOperativos;
  totalesPrivados: TotalesPrivados;
};

async function construirDetalleValorizado(
  cliente: Cliente,
  proyectoId: string,
  semana: { id: string; fechaInicio: Date },
  esquemaContractual: EsquemaContractual | null,
  porcentajesDefault: PorcentajesDefaultProyecto
): Promise<ResultadoValorizacion> {
  const conceptos = await cliente.concepto.findMany({
    where: { partida: { proyectoId }, estatus: "ACTIVO" },
    include: { partida: { select: { nombre: true } } },
  });
  const conceptoIds = conceptos.map((c) => c.id);

  const [anteriorPorConcepto, filasEstaSemana] = await Promise.all([
    sumaEjecutadaPorConcepto(conceptoIds, semana.fechaInicio, cliente),
    cliente.avanceConcepto.findMany({
      where: { conceptoId: { in: conceptoIds }, semanaId: semana.id, estatusAprobacion: "APROBADO" },
    }),
  ]);
  const estaSemanaPorConcepto = new Map(
    filasEstaSemana.map((f) => [f.conceptoId, Number(f.cantidadEjecutada)])
  );

  const filas: FilaEstimacion[] = [];
  let subtotalPrivado = 0;
  let montoPrivado = 0;
  let subtotalOperativo = 0;
  let montoOperativo = 0;

  for (const concepto of conceptos) {
    const estaSemana = estaSemanaPorConcepto.get(concepto.id) ?? 0;
    if (estaSemana <= 0) continue;

    const anterior = anteriorPorConcepto.get(concepto.id) ?? 0;
    const cantidadContratada = Number(concepto.cantidadContratada);
    const acumulada = anterior + estaSemana;
    const porEjercer = cantidadContratada - acumulada;
    const avancePorcentaje = cantidadContratada > 0 ? (acumulada / cantidadContratada) * 100 : 0;

    const costos = {
      precioUnitarioContratista: numOrNull(concepto.precioUnitarioContratista),
      precioUnitarioContratistaPrivado: numOrNull(concepto.precioUnitarioContratistaPrivado),
      precioUnitarioMateriales: numOrNull(concepto.precioUnitarioMateriales),
      precioUnitarioIndirectos: numOrNull(concepto.precioUnitarioIndirectos),
      precioUnitarioHerramienta: numOrNull(concepto.precioUnitarioHerramienta),
      porcentajeUtilidad: numOrNull(concepto.porcentajeUtilidad),
      porcentajeAdministracion: numOrNull(concepto.porcentajeAdministracion),
    };

    const operativo = calcularPrecioOperativoConcepto(costos, esquemaContractual, porcentajesDefault.administracion);
    const privado = calcularPrecioConcepto(costos, esquemaContractual, porcentajesDefault);

    subtotalPrivado += privado.costoBase * estaSemana;
    montoPrivado += privado.montoPorcentaje * estaSemana;
    subtotalOperativo += operativo.subtotalPorUnidad * estaSemana;
    montoOperativo += operativo.montoAdministracionPorUnidad * estaSemana;

    filas.push({
      conceptoId: concepto.id,
      partidaNombre: concepto.partida.nombre,
      descripcionConcepto: concepto.descripcion,
      unidad: concepto.unidad,

      cantidadContratada,
      cantidadAnterior: anterior,
      cantidadEstaSemana: estaSemana,
      cantidadAcumulada: acumulada,
      cantidadPorEjercer: porEjercer,
      avancePorcentaje,

      precioUnitarioOperativo: operativo.precioUnitarioConAdministracion,
      importeContratadoOperativo: operativo.precioUnitarioConAdministracion * cantidadContratada,
      importeEstaSemanaOperativo: operativo.precioUnitarioConAdministracion * estaSemana,
      importeAcumuladoOperativo: operativo.precioUnitarioConAdministracion * acumulada,
      importePorEjercerOperativo: operativo.precioUnitarioConAdministracion * porEjercer,

      precioUnitarioPrivado: privado.precioUnitarioRecomendado,
      importeContratadoPrivado: privado.precioUnitarioRecomendado * cantidadContratada,
      importeEstaSemanaPrivado: privado.precioUnitarioRecomendado * estaSemana,
      importeAcumuladoPrivado: privado.precioUnitarioRecomendado * acumulada,
      importePorEjercerPrivado: privado.precioUnitarioRecomendado * porEjercer,
      porcentajeAplicadoPrivado: privado.porcentajeAplicado,

      precioUnitarioBasePrivado: privado.costoBase,
      importeContratadoBasePrivado: privado.costoBase * cantidadContratada,
      importeEstaSemanaBasePrivado: privado.costoBase * estaSemana,
      importeAcumuladoBasePrivado: privado.costoBase * acumulada,
      importePorEjercerBasePrivado: privado.costoBase * porEjercer,
    });
  }

  filas.sort((a, b) => a.descripcionConcepto.localeCompare(b.descripcionConcepto));

  return {
    filas,
    totalesOperativos: {
      subtotal: subtotalOperativo,
      montoAdministracion: montoOperativo,
      total: subtotalOperativo + montoOperativo,
    },
    totalesPrivados: {
      subtotal: subtotalPrivado,
      montoAdministracionOUtilidad: montoPrivado,
      total: subtotalPrivado + montoPrivado,
    },
  };
}

async function obtenerContextoProyecto(cliente: Cliente, proyectoId: string) {
  const proyecto = await cliente.proyecto.findFirst({
    where: { id: proyectoId },
    select: {
      esquemaContractual: true,
      porcentajeUtilidadDefault: true,
      porcentajeAdministracionDefault: true,
      porcentajeAdministracionPrivadoDefault: true,
    },
  });
  if (!proyecto) throw new RegistroNoEncontradoError("El proyecto");
  const porcentajesDefault: PorcentajesDefaultProyecto = {
    utilidad: numOrNull(proyecto.porcentajeUtilidadDefault),
    administracion: numOrNull(proyecto.porcentajeAdministracionDefault),
    administracionPrivado: numOrNull(proyecto.porcentajeAdministracionPrivadoDefault),
  };
  return { esquemaContractual: proyecto.esquemaContractual, porcentajesDefault };
}

// Vista preliminar de semana ABIERTA: avance valorizado + los gastos
// cobrables que entrarían a cada capa al cerrar (`preliminar`). Solo lectura.
export async function obtenerEstimacionSemanalEnVivo(
  usuario: UsuarioSesion,
  proyectoId: string,
  semana: { id: string; fechaInicio: Date }
): Promise<ResultadoValorizacion & { preliminar: PreliminarSemanaAbierta }> {
  await obtenerProyecto(usuario, proyectoId);
  const { esquemaContractual, porcentajesDefault } = await obtenerContextoProyecto(db, proyectoId);
  const valorizacion = await construirDetalleValorizado(db, proyectoId, semana, esquemaContractual, porcentajesDefault);
  const preliminar = await construirPreliminar(db, proyectoId, semana, valorizacion, esquemaContractual, porcentajesDefault);
  return { ...valorizacion, preliminar };
}

// ---------------------------------------------------------------------------
// Capas — Cliente y Cliente Priv. como documentos financieros independientes
// (agosto 2026). Físico compartido (EstimacionCliente + EstimacionClienteConcepto,
// solo cantidades) → snapshot monetario por capa (EstimacionClienteCapa +
// EstimacionClienteCapaConcepto). Mientras una capa sigue BORRADOR, su dinero
// se calcula EN LECTURA (valorizarCapaEnVivo, abajo) — nunca se escribe nada
// hasta que esa capa se emite. Ver el plan "Estimación Cliente: General y
// Privado como documentos financieros independientes" para el detalle
// completo de esta arquitectura.
// ---------------------------------------------------------------------------

export type FilaEstimacionCapa = {
  conceptoId: string;
  partidaNombre: string;
  descripcionConcepto: string;
  unidad: string;

  cantidadContratada: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  cantidadPorEjercer: number;
  avancePorcentaje: number;

  precioUnitarioBase: number;
  porcentajeAplicado: number | null;
  precioUnitario: number;
  importeContratado: number;
  importeEstaSemana: number;
  importeAcumulado: number;
  importePorEjercer: number;
};

export type TotalesCapaCalculados = {
  subtotal: number;
  montoAdministracionTrabajos: number;
  subtotalGastosCobrables: number;
  porcentajeAdministracionGastos: number | null;
  montoAdministracionGastos: number;
  // Trabajos + gastos combinados — único valor que debe mostrarse en la fila
  // "Administración"/"Utilidad" de la Estimación semanal (Cliente,
  // Cliente Priv. y PDF) y en ningún otro lado se vuelve a sumar por su
  // cuenta (single source of truth, septiembre 2026).
  montoAdministracionTotal: number;
  montoIVA: number;
  total: number;
};

export type EstimacionClienteCapaResumen = TotalesCapaCalculados & {
  id: string;
  estimacionClienteId: string;
  capa: CapaEstimacion;
  estatus: "BORRADOR" | "EMITIDA";
  numero: number | null;
  aplicaIVA: boolean;
  porcentajeIVA: number | null;
  generadoPorNombre: string;
  generadoEn: string;
  emitidoPorNombre: string | null;
  emitidoEn: string | null;
};

export type FilaGastoEstimacion = {
  id: string;
  gastoObraId: string;
  fecha: string;
  descripcion: string;
  categoria: string;
  monto: number;
  detalle: { descripcion: string; unidad: string; cantidad: number; precioUnitario: number }[];
};

type DetalleFisico = {
  conceptoId: string;
  partidaNombre: string;
  descripcionConcepto: string;
  unidad: string;
  cantidadContratada: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  cantidadPorEjercer: number;
  avancePorcentaje: number;
};

// % de Administración/Utilidad a aplicar sobre gastos cobrables, por capa —
// un gasto no tiene concepto, así que nunca puede traer un override propio;
// usa siempre el default vigente del proyecto.
function porcentajesGastosPorCapa(
  esquemaContractual: EsquemaContractual | null,
  porcentajesDefault: PorcentajesDefaultProyecto
): { OPERATIVO: number | null; PRIVADO: number | null } {
  if (esquemaContractual === "ADMINISTRACION") {
    return {
      OPERATIVO: porcentajesDefault.administracion,
      PRIVADO: porcentajesDefault.administracionPrivado ?? porcentajesDefault.administracion,
    };
  }
  if (esquemaContractual === "PRECIO_ALZADO") {
    return { OPERATIVO: null, PRIVADO: porcentajesDefault.utilidad };
  }
  return { OPERATIVO: null, PRIVADO: null };
}

// Valorización EN VIVO de una capa — nunca escribe nada. Toma las cantidades
// ya congeladas físicamente (EstimacionClienteConcepto) y las combina con el
// precio VIGENTE AHORA MISMO de cada Concepto — así una capa BORRADOR
// siempre refleja la configuración actual, incluso si se editó después de
// que la otra capa ya emitió. Los gastos cobrables de una capa BORRADOR se
// leen en vivo desde GastoObra (ya reclamados vía incluidoEnCapa{X}Id, pero
// todavía sin snapshot propio) — seguro de leer así porque un GastoObra
// APROBADO ya es inmutable. La misma función se usa, sin cambios, en el
// instante de emitir (para calcular lo que se va a congelar).
async function valorizarCapaEnVivo(
  cliente: Cliente,
  params: {
    capa: CapaEstimacion;
    capaId: string;
    detalleFisico: DetalleFisico[];
    esquemaContractual: EsquemaContractual | null;
    porcentajesDefault: PorcentajesDefaultProyecto;
    aplicaIVA: boolean;
    porcentajeIVA: number | null;
  }
): Promise<{ filas: FilaEstimacionCapa[]; totales: TotalesCapaCalculados; gastos: FilaGastoEstimacion[] }> {
  const conceptoIds = params.detalleFisico.map((f) => f.conceptoId);
  const conceptos = await cliente.concepto.findMany({ where: { id: { in: conceptoIds } } });
  const conceptoPorId = new Map(conceptos.map((c) => [c.id, c]));

  const filas: FilaEstimacionCapa[] = [];
  let subtotal = 0;
  let montoAdministracionTrabajos = 0;

  for (const f of params.detalleFisico) {
    const concepto = conceptoPorId.get(f.conceptoId);
    if (!concepto) continue; // concepto eliminado después de congelar el físico — defensivo, no debería pasar

    const costos = {
      precioUnitarioContratista: numOrNull(concepto.precioUnitarioContratista),
      precioUnitarioContratistaPrivado: numOrNull(concepto.precioUnitarioContratistaPrivado),
      precioUnitarioMateriales: numOrNull(concepto.precioUnitarioMateriales),
      precioUnitarioIndirectos: numOrNull(concepto.precioUnitarioIndirectos),
      precioUnitarioHerramienta: numOrNull(concepto.precioUnitarioHerramienta),
      porcentajeUtilidad: numOrNull(concepto.porcentajeUtilidad),
      porcentajeAdministracion: numOrNull(concepto.porcentajeAdministracion),
    };

    let precioUnitarioBase: number;
    let porcentajeAplicado: number | null;
    let precioUnitario: number;

    if (params.capa === "OPERATIVO") {
      const r = calcularPrecioOperativoConcepto(costos, params.esquemaContractual, params.porcentajesDefault.administracion);
      precioUnitarioBase = r.subtotalPorUnidad;
      porcentajeAplicado = r.porcentajeAdministracionAplicado;
      precioUnitario = r.precioUnitarioConAdministracion;
      subtotal += r.subtotalPorUnidad * f.cantidadEstaSemana;
      montoAdministracionTrabajos += r.montoAdministracionPorUnidad * f.cantidadEstaSemana;
    } else {
      const r = calcularPrecioConcepto(costos, params.esquemaContractual, params.porcentajesDefault);
      precioUnitarioBase = r.costoBase;
      porcentajeAplicado = r.porcentajeAplicado;
      precioUnitario = r.precioUnitarioRecomendado;
      subtotal += r.costoBase * f.cantidadEstaSemana;
      montoAdministracionTrabajos += r.montoPorcentaje * f.cantidadEstaSemana;
    }

    filas.push({
      conceptoId: f.conceptoId,
      partidaNombre: f.partidaNombre,
      descripcionConcepto: f.descripcionConcepto,
      unidad: f.unidad,
      cantidadContratada: f.cantidadContratada,
      cantidadAnterior: f.cantidadAnterior,
      cantidadEstaSemana: f.cantidadEstaSemana,
      cantidadAcumulada: f.cantidadAcumulada,
      cantidadPorEjercer: f.cantidadPorEjercer,
      avancePorcentaje: f.avancePorcentaje,
      precioUnitarioBase,
      porcentajeAplicado,
      precioUnitario,
      importeContratado: precioUnitario * f.cantidadContratada,
      importeEstaSemana: precioUnitario * f.cantidadEstaSemana,
      importeAcumulado: precioUnitario * f.cantidadAcumulada,
      importePorEjercer: precioUnitario * f.cantidadPorEjercer,
    });
  }
  filas.sort((a, b) => a.descripcionConcepto.localeCompare(b.descripcionConcepto));

  const gastosClaimed = await cliente.gastoObra.findMany({
    where: { [campoCapaGasto(params.capa)]: params.capaId },
    include: INCLUDE_DETALLE_GASTO,
    orderBy: { fecha: "asc" },
  });
  const gastos = gastosClaimed.map(aFilaGastoEstimacion);

  return {
    filas,
    totales: totalesCapa({
      capa: params.capa,
      subtotal,
      montoAdministracionTrabajos,
      gastos,
      esquemaContractual: params.esquemaContractual,
      porcentajesDefault: params.porcentajesDefault,
      aplicaIVA: params.aplicaIVA,
      porcentajeIVA: params.porcentajeIVA,
    }),
    gastos,
  };
}

function campoCapaGasto(capa: CapaEstimacion) {
  return capa === "OPERATIVO" ? ("incluidoEnCapaOperativoId" as const) : ("incluidoEnCapaPrivadoId" as const);
}

const INCLUDE_DETALLE_GASTO = { detalle: { orderBy: { orden: "asc" as const } } };

function aFilaGastoEstimacion(
  g: Prisma.GastoObraGetPayload<{ include: typeof INCLUDE_DETALLE_GASTO }>
): FilaGastoEstimacion {
  return {
    id: g.id,
    gastoObraId: g.id,
    fecha: g.fecha.toISOString(),
    descripcion: g.descripcion,
    categoria: g.categoria,
    monto: Number(g.monto),
    detalle: g.detalle.map((d) => ({
      descripcion: d.descripcion,
      unidad: d.unidad,
      cantidad: Number(d.cantidad),
      precioUnitario: Number(d.precioUnitario),
    })),
  };
}

// Totales de UNA capa a partir de sus trabajos ya valorizados y sus gastos
// cobrables — único cálculo compartido por la capa BORRADOR en vivo, el
// instante de emitir y el preliminar de semana abierta, para que los tres
// den exactamente el mismo número con los mismos insumos.
function totalesCapa(p: {
  capa: CapaEstimacion;
  subtotal: number;
  montoAdministracionTrabajos: number;
  gastos: FilaGastoEstimacion[];
  esquemaContractual: EsquemaContractual | null;
  porcentajesDefault: PorcentajesDefaultProyecto;
  aplicaIVA: boolean;
  porcentajeIVA: number | null;
}): TotalesCapaCalculados {
  const subtotalGastosCobrables = p.gastos.reduce((t, g) => t + g.monto, 0);
  const porcentajeAdministracionGastos = porcentajesGastosPorCapa(p.esquemaContractual, p.porcentajesDefault)[p.capa];
  const calc = calcularTotalesEstimacion({
    subtotalTrabajos: p.subtotal,
    montoAdministracionTrabajos: p.montoAdministracionTrabajos,
    subtotalGastosCobrables,
    porcentajeAdministracionGastos,
    aplicaIVA: p.aplicaIVA,
    porcentajeIVA: p.porcentajeIVA,
  });
  return {
    subtotal: p.subtotal,
    montoAdministracionTrabajos: p.montoAdministracionTrabajos,
    subtotalGastosCobrables,
    porcentajeAdministracionGastos,
    montoAdministracionGastos: calc.montoAdministracionGastos,
    montoAdministracionTotal: calc.montoAdministracionTotal,
    montoIVA: calc.montoIVA,
    total: calc.total,
  };
}

function detalleFisicoDesdeConcepto(d: {
  conceptoId: string;
  partidaNombre: string;
  descripcionConcepto: string;
  unidad: string;
  cantidadContratada: Prisma.Decimal;
  cantidadAnterior: Prisma.Decimal;
  cantidadEstaSemana: Prisma.Decimal;
  cantidadAcumulada: Prisma.Decimal;
  cantidadPorEjercer: Prisma.Decimal;
  avancePorcentaje: Prisma.Decimal;
}): DetalleFisico {
  return {
    conceptoId: d.conceptoId,
    partidaNombre: d.partidaNombre,
    descripcionConcepto: d.descripcionConcepto,
    unidad: d.unidad,
    cantidadContratada: Number(d.cantidadContratada),
    cantidadAnterior: Number(d.cantidadAnterior),
    cantidadEstaSemana: Number(d.cantidadEstaSemana),
    cantidadAcumulada: Number(d.cantidadAcumulada),
    cantidadPorEjercer: Number(d.cantidadPorEjercer),
    avancePorcentaje: Number(d.avancePorcentaje),
  };
}

// Lectura — para una capa concreta de una semana ya cerrada. EMITIDA lee el
// snapshot congelado tal cual (nunca se recalcula). BORRADOR se calcula en
// vivo (valorizarCapaEnVivo) — abrir esta pantalla NUNCA escribe en la base
// de datos.
export async function obtenerEstimacionCliente(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  capa: CapaEstimacion
): Promise<{ estimacion: EstimacionClienteCapaResumen; filas: FilaEstimacionCapa[]; gastos: FilaGastoEstimacion[] } | null> {
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const estimacion = await db.estimacionCliente.findUnique({
    where: { proyectoId_semanaId: { proyectoId, semanaId } },
    include: {
      detalle: true,
      capas: {
        where: { capa },
        include: {
          detalle: true,
          gastos: {
            include: { detalle: { orderBy: { orden: "asc" } } },
            orderBy: { fecha: "asc" },
          },
          generadoPor: { select: { nombre: true } },
          emitidoPor: { select: { nombre: true } },
        },
      },
    },
  });
  if (!estimacion || estimacion.empresaId !== empresaId) return null;
  const capaRow = estimacion.capas[0];
  if (!capaRow) return null;

  if (capaRow.estatus === "EMITIDA") {
    const capaConceptoPorId = new Map(capaRow.detalle.map((d) => [d.conceptoId, d]));
    const filas: FilaEstimacionCapa[] = estimacion.detalle
      .map((fis) => {
        const cc = capaConceptoPorId.get(fis.conceptoId);
        if (!cc) return null;
        return {
          conceptoId: fis.conceptoId,
          partidaNombre: fis.partidaNombre,
          descripcionConcepto: fis.descripcionConcepto,
          unidad: fis.unidad,
          cantidadContratada: Number(fis.cantidadContratada),
          cantidadAnterior: Number(fis.cantidadAnterior),
          cantidadEstaSemana: Number(fis.cantidadEstaSemana),
          cantidadAcumulada: Number(fis.cantidadAcumulada),
          cantidadPorEjercer: Number(fis.cantidadPorEjercer),
          avancePorcentaje: Number(fis.avancePorcentaje),
          precioUnitarioBase: Number(cc.precioUnitarioBase),
          porcentajeAplicado: numOrNull(cc.porcentajeAplicado),
          precioUnitario: Number(cc.precioUnitario),
          importeContratado: Number(cc.importeContratado),
          importeEstaSemana: Number(cc.importeEstaSemana),
          importeAcumulado: Number(cc.importeAcumulado),
          importePorEjercer: Number(cc.importePorEjercer),
        };
      })
      .filter((f): f is FilaEstimacionCapa => f !== null)
      .sort((a, b) => a.descripcionConcepto.localeCompare(b.descripcionConcepto));

    const gastos: FilaGastoEstimacion[] = capaRow.gastos.map((g) => ({
      id: g.id,
      gastoObraId: g.gastoObraId,
      fecha: g.fecha.toISOString(),
      descripcion: g.descripcion,
      categoria: g.categoria,
      monto: Number(g.monto),
      detalle: g.detalle.map((d) => ({
        descripcion: d.descripcion,
        unidad: d.unidad,
        cantidad: Number(d.cantidad),
        precioUnitario: Number(d.precioUnitario),
      })),
    }));

    return {
      estimacion: {
        id: capaRow.id,
        estimacionClienteId: estimacion.id,
        capa: capaRow.capa,
        estatus: capaRow.estatus,
        numero: capaRow.numero,
        aplicaIVA: capaRow.aplicaIVA,
        porcentajeIVA: numOrNull(capaRow.porcentajeIVA),
        subtotal: Number(capaRow.subtotal),
        montoAdministracionTrabajos: Number(capaRow.montoAdministracionTrabajos),
        subtotalGastosCobrables: Number(capaRow.subtotalGastosCobrables),
        porcentajeAdministracionGastos: numOrNull(capaRow.porcentajeAdministracionGastos),
        montoAdministracionGastos: Number(capaRow.montoAdministracionGastos),
        // Suma de los dos componentes ya persistidos — nunca se guarda como
        // columna propia, se deriva igual que en el caso en vivo
        // (TotalesCapaCalculados.montoAdministracionTotal).
        montoAdministracionTotal:
          Number(capaRow.montoAdministracionTrabajos) + Number(capaRow.montoAdministracionGastos),
        montoIVA: Number(capaRow.montoIVA),
        total: Number(capaRow.total),
        generadoPorNombre: capaRow.generadoPor.nombre,
        generadoEn: capaRow.generadoEn.toISOString(),
        emitidoPorNombre: capaRow.emitidoPor?.nombre ?? null,
        emitidoEn: capaRow.emitidoEn?.toISOString() ?? null,
      },
      filas,
      gastos,
    };
  }

  // BORRADOR — calculado en vivo, no se escribe nada.
  const { esquemaContractual, porcentajesDefault } = await obtenerContextoProyecto(db, proyectoId);
  const detalleFisico = estimacion.detalle.map(detalleFisicoDesdeConcepto);
  const { filas, totales, gastos } = await valorizarCapaEnVivo(db, {
    capa,
    capaId: capaRow.id,
    detalleFisico,
    esquemaContractual,
    porcentajesDefault,
    aplicaIVA: capaRow.aplicaIVA,
    porcentajeIVA: numOrNull(capaRow.porcentajeIVA),
  });

  return {
    estimacion: {
      id: capaRow.id,
      estimacionClienteId: estimacion.id,
      capa: capaRow.capa,
      estatus: capaRow.estatus,
      numero: null,
      aplicaIVA: capaRow.aplicaIVA,
      porcentajeIVA: numOrNull(capaRow.porcentajeIVA),
      ...totales,
      generadoPorNombre: capaRow.generadoPor.nombre,
      generadoEn: capaRow.generadoEn.toISOString(),
      emitidoPorNombre: null,
      emitidoEn: null,
    },
    filas,
    gastos,
  };
}

// ---------------------------------------------------------------------------
// Gastos cobrables — a qué capa le toca cada uno. Regla cronológica exacta,
// evaluada POR CAPA (una obra puede tener General ya emitida para la semana
// 35 mientras Privado sigue en BORRADOR — cada capa resuelve su propio
// destino sin ver a la otra): primero su propia semana; si la capa de esa
// semana ya fue EMITIDA, la primera capa BORRADOR del mismo tipo
// cronológicamente posterior (por Semana.fechaInicio, nunca por `numero`);
// si su propia semana todavía no tiene esa capa, espera. NUNCA crea una capa
// por adelantado solo para tener dónde reclamar un gasto — eso es
// responsabilidad exclusiva de asegurarFisicoYCapas (al cerrar semana).
// ---------------------------------------------------------------------------

// Capa que el cierre de una semana ABIERTA crearía (BORRADOR, todavía sin
// fila). Solo la usa el preliminar de semana abierta para simular el cierre
// con exactamente la misma regla — nunca se escribe.
type CapaHipotetica = { semanaId: string; fechaInicio: Date };
const CAPA_PRELIMINAR = "__capa_preliminar__";

async function resolverCapaElegibleParaGasto(
  tx: Cliente,
  proyectoId: string,
  capa: CapaEstimacion,
  semanaOrigenId: string,
  hipotetica?: CapaHipotetica
): Promise<{ id: string } | null> {
  const propia = await tx.estimacionClienteCapa.findFirst({
    where: { capa, estimacionCliente: { proyectoId, semanaId: semanaOrigenId } },
    select: { id: true, estatus: true, estimacionCliente: { select: { semana: { select: { fechaInicio: true } } } } },
  });
  if (!propia) {
    // su propia semana todavía no tiene esta capa (o la tendrá al cerrar)
    return hipotetica?.semanaId === semanaOrigenId ? { id: CAPA_PRELIMINAR } : null;
  }
  if (propia.estatus === "BORRADOR") return { id: propia.id };

  const semanaOrigenFecha = propia.estimacionCliente.semana.fechaInicio;
  const posteriores = (
    await tx.estimacionClienteCapa.findMany({
      where: {
        capa,
        estatus: "BORRADOR",
        estimacionCliente: { proyectoId, semana: { fechaInicio: { gt: semanaOrigenFecha } } },
      },
      select: { id: true, estimacionCliente: { select: { semana: { select: { fechaInicio: true } } } } },
    })
  ).map((c) => ({ id: c.id, fechaInicio: c.estimacionCliente.semana.fechaInicio }));
  if (hipotetica && hipotetica.fechaInicio > semanaOrigenFecha) {
    posteriores.push({ id: CAPA_PRELIMINAR, fechaInicio: hipotetica.fechaInicio });
  }
  posteriores.sort((a, b) => a.fechaInicio.getTime() - b.fechaInicio.getTime());
  return posteriores[0] ? { id: posteriores[0].id } : null;
}

// Criterio ÚNICO de qué gastos barre un cierre de semana — lo comparten el
// cierre real (reclamarGastosCobrablesPendientes) y el preliminar de semana
// abierta (simularGastosDelCierre), para que nunca diverjan.
function filtroGastosPorReclamar(proyectoId: string, hastaFechaInicio: Date): Prisma.GastoObraWhereInput {
  return {
    proyectoId,
    tratamientoCliente: "COBRABLE_EN_ESTIMACION",
    estatus: "APROBADO",
    semana: { fechaInicio: { lte: hastaFechaInicio } },
    OR: [{ incluidoEnCapaOperativoId: null }, { incluidoEnCapaPrivadoId: null }],
  };
}

async function hayGastoCobrableAprobadoEnSemana(cliente: Cliente, proyectoId: string, semanaId: string) {
  const gasto = await cliente.gastoObra.findFirst({
    where: { proyectoId, semanaId, estatus: "APROBADO", tratamientoCliente: "COBRABLE_EN_ESTIMACION" },
    select: { id: true },
  });
  return gasto !== null;
}

// Intenta reclamar UN gasto en cada capa que todavía no lo tenga — llamada
// tanto al aprobar un gasto (un solo gasto) como en el barrido de
// asegurarFisicoYCapas (varios). Reclamar (escribir el FK) sí es una
// escritura real, pero solo ocurre cuando ya existe una capa BORRADOR
// elegible — nunca crea una.
export async function intentarReclamarGastoParaCapas(
  tx: Cliente,
  proyectoId: string,
  gasto: {
    id: string;
    semanaId: string;
    incluidoEnCapaOperativoId: string | null;
    incluidoEnCapaPrivadoId: string | null;
  }
): Promise<void> {
  const updates: { incluidoEnCapaOperativoId?: string; incluidoEnCapaPrivadoId?: string } = {};
  if (!gasto.incluidoEnCapaOperativoId) {
    const destino = await resolverCapaElegibleParaGasto(tx, proyectoId, "OPERATIVO", gasto.semanaId);
    if (destino) updates.incluidoEnCapaOperativoId = destino.id;
  }
  if (!gasto.incluidoEnCapaPrivadoId) {
    const destino = await resolverCapaElegibleParaGasto(tx, proyectoId, "PRIVADO", gasto.semanaId);
    if (destino) updates.incluidoEnCapaPrivadoId = destino.id;
  }
  if (Object.keys(updates).length > 0) {
    await tx.gastoObra.update({ where: { id: gasto.id }, data: updates });
  }
}

async function reclamarGastosCobrablesPendientes(
  tx: Cliente,
  proyectoId: string,
  semanaActual: { id: string; fechaInicio: Date }
): Promise<void> {
  const candidatos = await tx.gastoObra.findMany({
    where: filtroGastosPorReclamar(proyectoId, semanaActual.fechaInicio),
    select: { id: true, semanaId: true, incluidoEnCapaOperativoId: true, incluidoEnCapaPrivadoId: true },
  });
  for (const g of candidatos) {
    await intentarReclamarGastoParaCapas(tx, proyectoId, g);
  }
}

// ---------------------------------------------------------------------------
// Preliminar de semana ABIERTA (noviembre 2026) — qué gastos cobrables
// entrarían a cada capa de esta semana si se cerrara AHORA. Simula
// asegurarFisicoYCapas + reclamarGastosCobrablesPendientes con los mismos
// criterios (filtroGastosPorReclamar, hayGastoCobrableAprobadoEnSemana,
// resolverCapaElegibleParaGasto con la capa hipotética) — SOLO LECTURA: no
// crea estimaciones ni capas, no liga gastos, no escribe nada.
// ---------------------------------------------------------------------------

export type PreliminarCapa = { gastos: FilaGastoEstimacion[]; totales: TotalesCapaCalculados; aplicaIVA: boolean };
export type PreliminarSemanaAbierta = Record<CapaEstimacion, PreliminarCapa>;

async function simularGastosDelCierre(
  cliente: Cliente,
  proyectoId: string,
  semana: { id: string; fechaInicio: Date },
  hayAvance: boolean
): Promise<{ capa: CapaEstimacion; gastos: FilaGastoEstimacion[]; aplicaIVA: boolean; porcentajeIVA: number | null }[]> {
  const existente = await cliente.estimacionCliente.findUnique({
    where: { proyectoId_semanaId: { proyectoId, semanaId: semana.id } },
    select: { capas: { select: { id: true, capa: true, estatus: true, aplicaIVA: true, porcentajeIVA: true } } },
  });
  const congelado = existente?.capas.some((c) => c.estatus === "EMITIDA") ?? false;
  const cierreCrearia = hayAvance || !!existente || (await hayGastoCobrableAprobadoEnSemana(cliente, proyectoId, semana.id));

  const candidatos =
    cierreCrearia && !congelado
      ? await cliente.gastoObra.findMany({
          where: filtroGastosPorReclamar(proyectoId, semana.fechaInicio),
          include: INCLUDE_DETALLE_GASTO,
          orderBy: { fecha: "asc" },
        })
      : [];

  const resultado = [];
  for (const capa of ["OPERATIVO", "PRIVADO"] as const) {
    const campo = campoCapaGasto(capa);
    const real = existente?.capas.find((c) => c.capa === capa);
    // Semana reabierta: su capa BORRADOR real ya existe y conserva lo que
    // ya tenía reclamado.
    const yaReclamados = real
      ? await cliente.gastoObra.findMany({ where: { [campo]: real.id }, include: INCLUDE_DETALLE_GASTO })
      : [];
    const destino = real?.id ?? CAPA_PRELIMINAR;
    const hipotetica = real ? undefined : { semanaId: semana.id, fechaInicio: semana.fechaInicio };

    const nuevos = [];
    for (const g of candidatos) {
      if (g[campo] !== null) continue;
      const d = await resolverCapaElegibleParaGasto(cliente, proyectoId, capa, g.semanaId, hipotetica);
      if (d?.id === destino) nuevos.push(g);
    }

    const gastos = [...yaReclamados, ...nuevos]
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime())
      .map(aFilaGastoEstimacion);
    resultado.push({
      capa,
      gastos,
      aplicaIVA: real?.aplicaIVA ?? false,
      porcentajeIVA: real ? numOrNull(real.porcentajeIVA) : null,
    });
  }
  return resultado;
}

async function construirPreliminar(
  cliente: Cliente,
  proyectoId: string,
  semana: { id: string; fechaInicio: Date },
  valorizacion: ResultadoValorizacion,
  esquemaContractual: EsquemaContractual | null,
  porcentajesDefault: PorcentajesDefaultProyecto
): Promise<PreliminarSemanaAbierta> {
  const simulado = await simularGastosDelCierre(cliente, proyectoId, semana, valorizacion.filas.length > 0);
  const trabajos = {
    OPERATIVO: {
      subtotal: valorizacion.totalesOperativos.subtotal,
      montoAdministracionTrabajos: valorizacion.totalesOperativos.montoAdministracion,
    },
    PRIVADO: {
      subtotal: valorizacion.totalesPrivados.subtotal,
      montoAdministracionTrabajos: valorizacion.totalesPrivados.montoAdministracionOUtilidad,
    },
  };
  const porCapa = {} as PreliminarSemanaAbierta;
  for (const s of simulado) {
    porCapa[s.capa] = {
      gastos: s.gastos,
      aplicaIVA: s.aplicaIVA,
      totales: totalesCapa({
        capa: s.capa,
        ...trabajos[s.capa],
        gastos: s.gastos,
        esquemaContractual,
        porcentajesDefault,
        aplicaIVA: s.aplicaIVA,
        porcentajeIVA: s.porcentajeIVA,
      }),
    };
  }
  return porCapa;
}

// ---------------------------------------------------------------------------
// Aprobación de un gasto cobrable cuya semana YA está cerrada y nunca generó
// estimación (se cerró sin avance ni gastos cobrables, o antes de que
// existiera este módulo) — noviembre 2026. Sin esto, el gasto quedaba sin
// capa para siempre: su propia semana no tenía capa y el cierre ya no se
// vuelve a ejecutar. Reutiliza asegurarFisicoYCapas tal cual (la misma que
// usa el cierre y la materialización histórica).
//
// - Solo actúa si la semana está CERRADA y NO existe EstimacionCliente. Si
//   ya existe (BORRADOR o EMITIDA) no crea nada: el reclamo normal decide
//   (una capa EMITIDA nunca se toca; el gasto pasa a la siguiente BORRADOR).
// - Bloquea la fila del cierre (FOR UPDATE): dos aprobaciones simultáneas de
//   la misma semana se serializan y la segunda ya ve la estimación creada —
//   nunca duplica. reabrirSemana también espera ese candado.
// - Llamada dentro de la transacción de aprobarGasto, con el gasto ya
//   APROBADO en esa transacción.
// ---------------------------------------------------------------------------

export async function asegurarEstimacionDeSemanaCerradaTx(
  tx: Cliente,
  ctx: { empresaId: string; proyectoId: string; semanaId: string; usuarioId: string }
): Promise<boolean> {
  const [cierre] = await tx.$queryRaw<{ estatus: string }[]>`
    SELECT estatus::text AS estatus FROM cierres_semana_proyecto
    WHERE "proyectoId" = ${ctx.proyectoId} AND "semanaId" = ${ctx.semanaId}
    FOR UPDATE`;
  if (!cierre || cierre.estatus !== "CERRADA") return false;

  const existente = await tx.estimacionCliente.findUnique({
    where: { proyectoId_semanaId: { proyectoId: ctx.proyectoId, semanaId: ctx.semanaId } },
    select: { id: true },
  });
  if (existente) return false;

  const semana = await tx.semana.findFirst({
    where: { id: ctx.semanaId, empresaId: ctx.empresaId },
    select: { id: true, fechaInicio: true },
  });
  if (!semana) throw new RegistroNoEncontradoError("La semana");

  const resultado = await asegurarFisicoYCapas(tx, { ...ctx, origen: "aprobacion_gasto_semana_cerrada" }, semana);
  return resultado.tipo === "CREADA";
}

// ---------------------------------------------------------------------------
// Cierre de semana — asegura el físico (EstimacionCliente + EstimacionClienteConcepto)
// y ambas filas EstimacionClienteCapa (BORRADOR, vacías). Llamada UNA VEZ por
// proyecto+semana dentro de la misma transacción atómica de cerrarSemana().
// En cuanto CUALQUIERA de las dos capas llegue a EMITIDA, el físico queda
// congelado para siempre — ni un recierre posterior lo vuelve a tocar.
// ---------------------------------------------------------------------------

export type ResultadoAsegurarCapas =
  | { tipo: "CONGELADO" } // alguna capa ya emitida — físico intocable, no se escribió nada
  | { tipo: "SIN_AVANCE" } // nada que registrar, no existía nada antes tampoco
  | { tipo: "CREADA" | "RECONCILIADA" | "SIN_CAMBIOS" };

export async function asegurarFisicoYCapas(
  tx: Cliente,
  ctx: {
    empresaId: string;
    proyectoId: string;
    semanaId: string;
    usuarioId: string;
    origen?: "cierre_semana" | "backfill_historico" | "aprobacion_gasto_semana_cerrada";
  },
  semana: { id: string; fechaInicio: Date }
): Promise<ResultadoAsegurarCapas> {
  const existente = await tx.estimacionCliente.findUnique({
    where: { proyectoId_semanaId: { proyectoId: ctx.proyectoId, semanaId: ctx.semanaId } },
    include: { detalle: true, capas: true },
  });

  const algunaCapaEmitida = existente?.capas.some((c) => c.estatus === "EMITIDA") ?? false;
  if (algunaCapaEmitida) {
    return { tipo: "CONGELADO" };
  }

  const { esquemaContractual, porcentajesDefault } = await obtenerContextoProyecto(tx, ctx.proyectoId);
  const { filas } = await construirDetalleValorizado(tx, ctx.proyectoId, semana, esquemaContractual, porcentajesDefault);

  // Sin avance físico Y sin estimación previa normalmente significa "no hay
  // nada que estimar esta semana" — pero una obra puede tener una semana sin
  // avance de trabajos y aun así un gasto cobrable real (material comprado,
  // obra pausada, etc.) que sí hay que poder cobrarle al cliente. Si existe
  // al menos un gasto cobrable ya aprobado de ESTA semana, sí vale la pena
  // crear la estimación (con detalle físico vacío) para que ese gasto tenga
  // dónde reclamarse y la capa se pueda emitir solo con el material
  // (decisión de sesión, septiembre 2026 — semanas sin avance con gasto).
  if (filas.length === 0 && !existente) {
    if (!(await hayGastoCobrableAprobadoEnSemana(tx, ctx.proyectoId, ctx.semanaId))) {
      return { tipo: "SIN_AVANCE" };
    }
  }

  const datosDetalleFisico = filas.map((f) => ({
    conceptoId: f.conceptoId,
    partidaNombre: f.partidaNombre,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    cantidadPorEjercer: f.cantidadPorEjercer,
    avancePorcentaje: f.avancePorcentaje,
  }));

  let estimacionClienteId: string;
  let tipo: "CREADA" | "RECONCILIADA" | "SIN_CAMBIOS";

  if (existente) {
    estimacionClienteId = existente.id;
    const sinCambios =
      existente.detalle.length === datosDetalleFisico.length &&
      existente.detalle
        .slice()
        .sort((a, b) => a.conceptoId.localeCompare(b.conceptoId))
        .every((d, i) => {
          const nuevo = [...datosDetalleFisico].sort((a, b) => a.conceptoId.localeCompare(b.conceptoId))[i];
          return d.conceptoId === nuevo.conceptoId && Number(d.cantidadEstaSemana) === nuevo.cantidadEstaSemana;
        });

    if (!sinCambios) {
      const valorAnterior = { conceptos: existente.detalle.length };
      await tx.estimacionClienteConcepto.deleteMany({ where: { estimacionClienteId: existente.id } });
      if (datosDetalleFisico.length > 0) {
        await tx.estimacionClienteConcepto.createMany({
          data: datosDetalleFisico.map((d) => ({ ...d, estimacionClienteId: existente.id })),
        });
      }
      await registrarAuditoriaTx(tx, {
        empresaId: ctx.empresaId,
        usuarioId: ctx.usuarioId,
        entidad: "EstimacionCliente",
        entidadId: existente.id,
        accion: "EDITAR",
        valorAnterior,
        valorNuevo: { conceptos: datosDetalleFisico.length },
      });
      tipo = "RECONCILIADA";
    } else {
      tipo = "SIN_CAMBIOS";
    }
  } else {
    const creada = await tx.estimacionCliente.create({
      data: {
        empresaId: ctx.empresaId,
        proyectoId: ctx.proyectoId,
        semanaId: ctx.semanaId,
        generadoPorId: ctx.usuarioId,
        esquemaContractualUsado: esquemaContractual,
        detalle: { create: datosDetalleFisico },
      },
    });
    estimacionClienteId = creada.id;
    tipo = "CREADA";
    await registrarAuditoriaTx(tx, {
      empresaId: ctx.empresaId,
      usuarioId: ctx.usuarioId,
      entidad: "EstimacionCliente",
      entidadId: creada.id,
      accion: "CREAR",
      valorNuevo: { conceptos: datosDetalleFisico.length, origen: ctx.origen ?? "cierre_semana" },
    });
  }

  const capasExistentes = existente?.capas ?? [];
  for (const capa of ["OPERATIVO", "PRIVADO"] as const) {
    if (!capasExistentes.some((c) => c.capa === capa)) {
      const creada = await tx.estimacionClienteCapa.create({
        data: { estimacionClienteId, capa, generadoPorId: ctx.usuarioId },
      });
      await registrarAuditoriaTx(tx, {
        empresaId: ctx.empresaId,
        usuarioId: ctx.usuarioId,
        entidad: "EstimacionClienteCapa",
        entidadId: creada.id,
        accion: "CREAR",
        valorNuevo: { capa, estatus: "BORRADOR" },
      });
    }
  }

  await reclamarGastosCobrablesPendientes(tx, ctx.proyectoId, semana);

  return { tipo };
}

// ---------------------------------------------------------------------------
// Materialización histórica — para una semana que ya estaba CERRADA antes de
// que este módulo existiera y por lo tanto no tiene EstimacionCliente.
// Reutiliza asegurarFisicoYCapas — la única diferencia es CUÁNDO se llama y
// que la bitácora queda marcada como backfill.
// ---------------------------------------------------------------------------

export async function materializarEstimacionHistorica(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<{ id: string; yaExistia: boolean }> {
  if (!puedeMaterializarEstimacionHistorica(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);

  const cierre = await db.cierreSemanaProyecto.findUnique({
    where: { proyectoId_semanaId: { proyectoId, semanaId } },
  });
  if (!cierre || cierre.estatus !== "CERRADA") {
    throw new ValidacionError(
      "Esta semana no está cerrada — solo se puede materializar una estimación histórica sobre una semana ya cerrada."
    );
  }

  const existente = await db.estimacionCliente.findUnique({
    where: { proyectoId_semanaId: { proyectoId, semanaId } },
  });
  if (existente) {
    return { id: existente.id, yaExistia: true };
  }

  const semana = await db.semana.findFirst({ where: { id: semanaId, empresaId } });
  if (!semana) throw new RegistroNoEncontradoError("La semana");

  return db.$transaction(async (tx) => {
    const resultado = await asegurarFisicoYCapas(
      tx,
      { empresaId, proyectoId, semanaId, usuarioId: usuario.id, origen: "backfill_historico" },
      semana
    );

    if (resultado.tipo !== "CREADA") {
      throw new ValidacionError("Esta semana no tiene avance aprobado — no hay nada que materializar.");
    }

    const creada = await tx.estimacionCliente.findUniqueOrThrow({
      where: { proyectoId_semanaId: { proyectoId, semanaId } },
    });
    return { id: creada.id, yaExistia: false };
  });
}

// ---------------------------------------------------------------------------
// IVA — configuración editable de una capa mientras sigue BORRADOR. Se
// persiste de inmediato al configurarse (decisión real del usuario, no un
// cálculo derivado) pero NUNCA recalcula ni escribe ningún monto — el total
// con ese IVA se ve reflejado la próxima vez que se lea la capa en vivo.
// ---------------------------------------------------------------------------

const DatosIvaSchema = z.object({
  aplicaIVA: z.boolean(),
  porcentajeIVA: z.number().nonnegative().nullable(),
});

export async function configurarIvaEstimacion(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string,
  datosCrudos: unknown
) {
  if (!puedeEmitirEstimacionCliente(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosIvaSchema.parse(datosCrudos);

  const capaRow = await db.estimacionClienteCapa.findFirst({
    where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
  });
  if (!capaRow) throw new RegistroNoEncontradoError("La estimación");
  if (capaRow.estatus === "EMITIDA") {
    throw new ValidacionError("Esta estimación ya fue emitida — el IVA no se puede modificar.");
  }

  const aplicaIVA = datos.aplicaIVA;
  const porcentajeIVA = aplicaIVA ? (datos.porcentajeIVA ?? 16) : null;

  const actualizada = await db.estimacionClienteCapa.update({
    where: { id: estimacionClienteCapaId },
    data: { aplicaIVA, porcentajeIVA },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "EstimacionClienteCapa",
    entidadId: estimacionClienteCapaId,
    accion: "EDITAR",
    valorAnterior: { aplicaIVA: capaRow.aplicaIVA, porcentajeIVA: numOrNull(capaRow.porcentajeIVA) },
    valorNuevo: { aplicaIVA, porcentajeIVA },
  });

  return actualizada;
}

// ---------------------------------------------------------------------------
// Emitir — congela UNA capa para siempre. Es el único momento en el que se
// materializa el snapshot monetario (EstimacionClienteCapaConcepto +
// EstimacionClienteGasto) — nunca antes. No toca la otra capa en absoluto:
// ni su fila EstimacionClienteCapa, ni su detalle, ni sus gastos.
// ---------------------------------------------------------------------------

export async function emitirEstimacion(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string,
  aplicarFondo: boolean
) {
  if (!puedeEmitirEstimacionCliente(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const referencia = await db.estimacionClienteCapa.findFirst({
    where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
    select: { estimacionCliente: { select: { proyectoId: true } } },
  });
  if (!referencia) throw new RegistroNoEncontradoError("La estimación");

  return db.$transaction(async (tx) => {
    // Mismo orden de bloqueo que aplicarFondoAEstimacion/registrarPagoEstimacion
    // (proyecto primero, luego la propia capa) — un doble clic (o dos
    // requests concurrentes) nunca puede pasar dos veces la validación
    // "todavía BORRADOR" ni aplicar fondo dos veces contra el mismo proyecto
    // simultáneamente.
    await tx.$queryRaw`SELECT id FROM proyectos WHERE id = ${referencia.estimacionCliente.proyectoId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM estimacion_cliente_capas WHERE id = ${estimacionClienteCapaId} FOR UPDATE`;

    const capaRow = await tx.estimacionClienteCapa.findFirst({
      where: { id: estimacionClienteCapaId },
      include: { estimacionCliente: { include: { detalle: true } } },
    });
    if (!capaRow) throw new RegistroNoEncontradoError("La estimación");
    if (capaRow.estatus === "EMITIDA") throw new ValidacionError("Esta estimación ya fue emitida.");

    const proyectoId = capaRow.estimacionCliente.proyectoId;
    const { esquemaContractual, porcentajesDefault } = await obtenerContextoProyecto(tx, proyectoId);
    const detalleFisico = capaRow.estimacionCliente.detalle.map(detalleFisicoDesdeConcepto);
    const { filas, totales, gastos } = await valorizarCapaEnVivo(tx, {
      capa: capaRow.capa,
      capaId: capaRow.id,
      detalleFisico,
      esquemaContractual,
      porcentajesDefault,
      aplicaIVA: capaRow.aplicaIVA,
      porcentajeIVA: numOrNull(capaRow.porcentajeIVA),
    });

    if (totales.total <= 0) {
      throw new ValidacionError("No se puede emitir una estimación sin importe.");
    }

    const campoContador = capaRow.capa === "OPERATIVO" ? "ultimoNumeroEstimacionOperativo" : "ultimoNumeroEstimacionPrivado";
    const proyecto = await tx.proyecto.update({
      where: { id: proyectoId },
      data: { [campoContador]: { increment: 1 } },
    });
    const numero = proyecto[campoContador];

    if (filas.length > 0) {
      await tx.estimacionClienteCapaConcepto.createMany({
        data: filas.map((f) => ({
          estimacionClienteCapaId: capaRow.id,
          conceptoId: f.conceptoId,
          precioUnitarioBase: f.precioUnitarioBase,
          porcentajeAplicado: f.porcentajeAplicado,
          precioUnitario: f.precioUnitario,
          importeContratado: f.importeContratado,
          importeEstaSemana: f.importeEstaSemana,
          importeAcumulado: f.importeAcumulado,
          importePorEjercer: f.importePorEjercer,
        })),
      });
    }

    for (const g of gastos) {
      const creado = await tx.estimacionClienteGasto.create({
        data: {
          estimacionClienteId: capaRow.estimacionCliente.id,
          estimacionClienteCapaId: capaRow.id,
          gastoObraId: g.gastoObraId,
          fecha: new Date(g.fecha),
          descripcion: g.descripcion,
          categoria: g.categoria,
          monto: g.monto,
        },
      });
      if (g.detalle.length > 0) {
        await tx.estimacionClienteGastoDetalle.createMany({
          data: g.detalle.map((d, i) => ({
            estimacionClienteGastoId: creado.id,
            descripcion: d.descripcion,
            unidad: d.unidad,
            cantidad: d.cantidad,
            precioUnitario: d.precioUnitario,
            orden: i,
          })),
        });
      }
    }

    const actualizada = await tx.estimacionClienteCapa.update({
      where: { id: capaRow.id },
      data: {
        estatus: "EMITIDA",
        numero,
        emitidoPorId: usuario.id,
        emitidoEn: new Date(),
        subtotal: totales.subtotal,
        montoAdministracionTrabajos: totales.montoAdministracionTrabajos,
        subtotalGastosCobrables: totales.subtotalGastosCobrables,
        porcentajeAdministracionGastos: totales.porcentajeAdministracionGastos,
        montoAdministracionGastos: totales.montoAdministracionGastos,
        montoIVA: totales.montoIVA,
        total: totales.total,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "EstimacionClienteCapa",
      entidadId: actualizada.id,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "BORRADOR" },
      valorNuevo: { estatus: "EMITIDA", numero, total: totales.total },
    });

    if (aplicarFondo) {
      const { aplicarFondoAEstimacionTx } = await import("./financiero-cliente");
      await aplicarFondoAEstimacionTx(tx, { empresaId, proyectoId, usuarioId: usuario.id }, actualizada.id);
    }

    return actualizada;
  });
}

import "server-only";
import { db } from "@/lib/server/db";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError } from "@/lib/server/control-de-obra/proyectos";
import { filtroGastosVisibles, filtroObrasVisibles } from "@/lib/server/control-de-obra/obras-visibles";
import { puedeVerInformacionPrivada, puedeVerContabilidad, puedeVerInicio } from "@/lib/server/permisos";
import { obtenerOCrearSemanaActual, formatearRangoSemana } from "@/lib/server/semanas";
import {
  asegurarGastosRecurrentesGenerados,
  obtenerOcurrenciasRecurrentesPendientes,
} from "@/lib/server/control-de-obra/gastos-recurrentes";
import { obtenerReposicionesPendientes } from "@/lib/server/control-de-obra/reposiciones";
import { calcularMontoContrato } from "@/lib/server/control-de-obra/financiero-cliente";
import {
  atribuirCobrosGeneral,
  calcularCobroEstimacion,
  capaRealDeEstimacion,
  redondear,
  type MovimientoCobro,
} from "@/lib/control-de-obra/cobro-estimacion";
import { obtenerFacturasPendientes } from "@/lib/server/contabilidad/facturas-pendientes";
import { obtenerFacturasConDiferencia } from "@/lib/server/contabilidad/facturas";
import {
  calcularPrecioOperativoConcepto,
  calcularPrecioConcepto,
  type PorcentajesDefaultProyecto,
} from "@/lib/control-de-obra/contrato-general";
import { sumaEjecutadaPorConcepto } from "@/lib/server/control-de-obra/avance-calculo";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";

// ---------------------------------------------------------------------------
// Inicio — dashboard ejecutivo (agosto 2026). Capa de lectura DEDICADA: lee,
// consolida e interpreta datos de las fuentes de verdad ya existentes
// (Proyecto, AvanceConcepto, EstimacionClienteCapa, MovimientoSemanal,
// MovimientoFinancieroCliente, RegistroAuditoria) — nunca las duplica ni
// inventa una tabla nueva de totales. Todas las queries están agrupadas por
// bloque (nunca una por proyecto/tarjeta) para evitar N+1; el resto de la
// agregación ocurre en memoria sobre esos resultados ya cargados.
//
// Fórmulas — ver el plan "Inicio — dashboard ejecutivo" para la discusión
// completa; resumen de las reglas no obvias:
// - Avance físico: SIEMPRE ponderado con precio operativo (nunca cambia con
//   el switch General/Privado — es una sola realidad física). Universo =
//   TODO Concepto ACTIVO con cantidadContratada > 0 (no solo los que ya
//   tienen avance). Un concepto sin precio/costo capturado (null, no 0)
//   marca el proyecto como "incompleto" — nunca se inventa ni promedia un
//   precio para no distorsionar el %.
// - Avance financiero General = Σ(EstimacionClienteCapa.subtotal +
//   montoAdministracionTrabajos) EMITIDA capa OPERATIVO / calcularMontoContrato
//   (misma base: trabajos+administración, SIN gastos cobrables, SIN IVA en
//   ambos lados — EstimacionClienteCapa.total SÍ los incluye, por eso no se
//   usa directo).
// - Avance financiero Privado = Σ MovimientoSemanal (estatusPago EN
//   {LIQUIDADO, PAGADO_PUENTE} — dinero que YA salió, nunca PENDIENTE_PAGO)
//   / Σ costoBase×cantidadContratada (motor privado, SIN margen — nunca
//   calcularMontoContrato(capa="privado"), que sí incluye margen). Solo se
//   calcula/regresa en vista Privado efectiva (AccesoDashboard.incluirPrivado,
//   que ya exige puedeVerInformacionPrivada) — en vista General no se
//   calcula ni influye en salud, orden ni alertas, aunque el usuario tenga
//   el permiso (separación General/Privado, octubre 2026).
// ---------------------------------------------------------------------------

export type VistaDashboard = "general" | "privado";
export type PeriodoDashboard = "semana" | "mes" | "mes_anterior" | "acumulado";
export type EstadoSalud = "SALUDABLE" | "ATENCION" | "REQUIERE_ACCION" | "EN_SEGUIMIENTO";
// "completo" = Administrador/Director (puedeVerContabilidad) — ve montos,
// flujo, Contabilidad y compromisos. "operativo" = Supervisor — nunca ve
// montos financieros, Contabilidad ni compromisos, aunque siga originando
// los Gastos que los alimentan (Rediseño de Inicio, septiembre 2026).
export type NivelAccesoDashboard = "completo" | "operativo";

const UMBRAL_DESVIACION_PP = 15;
const DIAS_PAGO_PENDIENTE_CRITICO = 14;
const SEMANAS_SIN_AVANCE_ATENCION = 2;
const SEMANAS_SIN_AVANCE_CRITICO = 4;
const SEMANAS_SIN_CERRAR_CRITICO = 2;

function numOrNull(v: { toNumber(): number } | null): number | null {
  return v === null ? null : v.toNumber();
}
function num(v: { toNumber(): number } | null): number {
  return v === null ? 0 : v.toNumber();
}

// ---------------------------------------------------------------------------
// Rango de fechas por periodo — "esta semana"/"este mes" comparan contra el
// periodo inmediato anterior; "acumulado" no tiene comparación (punto C.7).
// ---------------------------------------------------------------------------

export type RangoPeriodo = { inicio: Date; fin: Date; inicioAnterior: Date | null; finAnterior: Date | null };

export function resolverRangoPeriodo(periodo: PeriodoDashboard, hoy: Date): RangoPeriodo {
  if (periodo === "semana") {
    const dia = hoy.getDay() || 7;
    const inicio = new Date(hoy);
    inicio.setHours(0, 0, 0, 0);
    inicio.setDate(inicio.getDate() - (dia - 1));
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 7);
    const inicioAnterior = new Date(inicio);
    inicioAnterior.setDate(inicioAnterior.getDate() - 7);
    return { inicio, fin, inicioAnterior, finAnterior: inicio };
  }
  if (periodo === "mes") {
    const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    const inicioAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    return { inicio, fin, inicioAnterior, finAnterior: inicio };
  }
  if (periodo === "mes_anterior") {
    // El mes ya cerrado — sin comparación propia (comparar un periodo ya
    // cerrado contra el anterior a él es ambiguo y no se pidió; mismo
    // criterio que "acumulado", C.9 del rediseño de Inicio).
    const inicio = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    return { inicio, fin, inicioAnterior: null, finAnterior: null };
  }
  // Acumulado — sin límite inferior, sin comparación.
  return { inicio: new Date(0), fin: new Date(8640000000000000), inicioAnterior: null, finAnterior: null };
}

// ---------------------------------------------------------------------------
// Avance físico consolidado — sin precios inventados (C.13 del plan).
// ---------------------------------------------------------------------------

type ConceptoParaAvance = {
  id: string;
  proyectoId: string;
  cantidadContratada: number;
  precioUnitarioContratista: number | null;
  precioUnitarioMateriales: number | null;
};

type ResultadoAvanceFisico = {
  porcentaje: number | null;
  incompleto: boolean;
  faltantes: number;
  totalConceptos: number;
};

function calcularAvanceFisicoDeConceptos(
  conceptos: ConceptoParaAvance[],
  esquema: EsquemaContractual | null,
  acumuladoPorConcepto: Map<string, number>
): ResultadoAvanceFisico {
  if (conceptos.length === 0) {
    return { porcentaje: null, incompleto: false, faltantes: 0, totalConceptos: 0 };
  }

  const esPrecioAlzado = esquema === "PRECIO_ALZADO";
  let faltantes = 0;
  let numerador = 0;
  let denominador = 0;

  for (const c of conceptos) {
    const faltaContratista = c.precioUnitarioContratista === null;
    const faltaMateriales = esPrecioAlzado && c.precioUnitarioMateriales === null;
    if (faltaContratista || faltaMateriales) {
      faltantes++;
      continue;
    }
    const { subtotalPorUnidad: peso } = calcularPrecioOperativoConcepto(
      {
        precioUnitarioContratista: c.precioUnitarioContratista,
        precioUnitarioMateriales: c.precioUnitarioMateriales,
        porcentajeAdministracion: null, // el peso es SIN administración a propósito — es la base física, no el precio comercial
      },
      esquema,
      null
    );
    const acumulada = acumuladoPorConcepto.get(c.id) ?? 0;
    numerador += acumulada * peso;
    denominador += c.cantidadContratada * peso;
  }

  if (faltantes > 0) {
    return { porcentaje: null, incompleto: true, faltantes, totalConceptos: conceptos.length };
  }
  const porcentaje = denominador > 0 ? (numerador / denominador) * 100 : null;
  return { porcentaje, incompleto: false, faltantes: 0, totalConceptos: conceptos.length };
}

// ---------------------------------------------------------------------------
// Presupuesto de costo interno (SIN margen) — solo para Avance Financiero
// Privado. Reutiliza el mismo motor de precio privado (calcularPrecioConcepto)
// pero toma su campo costoBase en vez de precioUnitarioRecomendado.
// ---------------------------------------------------------------------------

type ConceptoParaCostoInterno = ConceptoParaAvance & {
  precioUnitarioContratistaPrivado: number | null;
  precioUnitarioIndirectos: number | null;
  precioUnitarioHerramienta: number | null;
  porcentajeUtilidad: number | null;
  porcentajeAdministracion: number | null;
};

function calcularPresupuestoCostoInterno(
  conceptos: ConceptoParaCostoInterno[],
  esquema: EsquemaContractual | null,
  porcentajesDefault: PorcentajesDefaultProyecto
): number {
  let total = 0;
  for (const c of conceptos) {
    const { costoBase } = calcularPrecioConcepto(
      {
        precioUnitarioContratista: c.precioUnitarioContratista,
        precioUnitarioContratistaPrivado: c.precioUnitarioContratistaPrivado,
        precioUnitarioMateriales: c.precioUnitarioMateriales,
        precioUnitarioIndirectos: c.precioUnitarioIndirectos,
        precioUnitarioHerramienta: c.precioUnitarioHerramienta,
        porcentajeUtilidad: c.porcentajeUtilidad,
        porcentajeAdministracion: c.porcentajeAdministracion,
      },
      esquema,
      porcentajesDefault
    );
    total += costoBase * c.cantidadContratada;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Tipos de salida
// ---------------------------------------------------------------------------

export type AlertaDashboard = {
  tipo:
    | "pagos_pendientes"
    | "semanas_sin_cerrar"
    | "gastos_pendientes"
    | "estimaciones_listas"
    | "pendiente_cobro"
    | "desviacion"
    | "facturas_pendientes"
    | "cfdi_diferencia"
    | "reposicion_pendiente_antigua"
    | "gasto_recurrente_variable_pendiente"
    | "sin_avance_reciente";
  severidad: "ATENCION" | "REQUIERE_ACCION";
  titulo: string;
  detalle: string;
  monto?: number;
  proyectoNombre?: string;
  href: string;
};

// Utilidad/margen — SIEMPRE "a la fecha" (acumulado desde el inicio del
// proyecto), nunca recortado al periodo seleccionado: son relaciones contra
// el contrato completo o lo emitido/pagado hasta hoy, igual criterio que
// avanceFinancieroPorcentaje/desviacionPrivadaPP, que tampoco respetan
// `periodo` (Rediseño de Inicio, C.9 — un indicador acumulado por
// naturaleza nunca cambia de significado silenciosamente). Solo se llenan
// si puedeVerInformacionPrivada; null en General.
export type UtilidadProyecto = {
  costoRealPagado: number;
  utilidadPresupuestada: number | null;
  margenPresupuestadoPct: number | null;
  utilidadReal: number | null;
  margenRealPct: number | null;
};

export type FilaProyectoDashboard = {
  id: string;
  nombre: string;
  tipo: string;
  imagenRef: string | null;
  estatus: "ACTIVO" | "PAUSADO";
  etapa: "EN_EJECUCION" | "POR_INICIAR";
  avanceFisico: ResultadoAvanceFisico;
  // Financiero — null para nivelAcceso "operativo" (Supervisor nunca ve
  // montos, aunque el cálculo ya haya corrido para el resto del dashboard).
  avanceFinancieroPorcentaje: number | null;
  ejecutado: number | null;
  montoContrato: number | null;
  ejecutadoPeriodoAnterior: number | null;
  porPagar: number | null;
  utilidad: UtilidadProyecto | null;
  salud: EstadoSalud;
  // Pendiente principal de la obra (Inicio V2) — la señal más grave de las
  // mismas que deciden `salud`, en texto. Supervisor solo recibe señales
  // operativas (nunca pagos); la desviación solo en vista Privado.
  // "AVISO": señal que todavía no cambia la salud (p. ej. semana por cerrar
  // de menos de 7 días) — se muestra sin color de alerta.
  motivo: { texto: string; severidad: "ATENCION" | "REQUIERE_ACCION" | "AVISO" } | null;
  // Señales crudas expuestas para construir las alertas de "Requiere tu
  // atención" sin volver a re-derivarlas a partir de `salud` (que ya las
  // combina y pierde granularidad).
  desviacionPrivadaPP: number | null;
  semanasSinCerrarDias: number;
  diasPagoPendienteMax: number;
  gastosPendientesCount: number;
  semanasSinAvance: number;
};

export type ActividadItem = {
  id: string;
  fecha: string;
  entidad: string;
  accion: string;
  descripcion: string;
  proyectoNombre: string | null;
  monto: number | null;
  usuarioNombre: string | null;
};

// Gasto recurrente de monto variable sin capturar, reposición abierta o pago
// aprobado esperando liquidación — "Próximos compromisos" (Rediseño de
// Inicio, septiembre 2026). Reemplaza Actividad reciente como bloque
// prioritario de Inicio; obtenerActividadReciente se conserva en este mismo
// archivo para quien la necesite después, solo deja de llamarse aquí.
export type CompromisoDashboard = {
  tipo: "gasto_recurrente_variable" | "reposicion_pendiente" | "pago_pendiente";
  titulo: string;
  detalle: string;
  monto: number | null;
  href: string;
};

// Pendiente de "Requiere tu atención" (Inicio V2, noviembre 2026): fusión de
// alertas y compromisos sin repetir el mismo asunto, ya ordenada por
// prioridad. Ver priorizarPendientes.
export type PendienteDashboard = {
  tipo: AlertaDashboard["tipo"] | CompromisoDashboard["tipo"];
  severidad: "ATENCION" | "REQUIERE_ACCION";
  titulo: string;
  detalle: string;
  monto: number | null;
  href: string;
};

// Indicadores de la fila principal de vista Privado (Inicio V2). Solo existen
// con vista Privado efectiva (incluirPrivado); null en General y Supervisor.
// - costoCubierto: MovimientoSemanal APROBADO en LIQUIDADO o PAGADO_PUENTE —
//   la misma suma "ejercido" del % por obra, SIN gasto directo solo aprobado.
//   Elección de presentación V2; no resuelve D8 de forma global ni cambia el
//   flujo (que sigue contando solo LIQUIDADO).
// - obrasAdelantadas: desviacionPrivadaPP > UMBRAL_DESVIACION_PP (misma regla
//   que la alerta de desviación), de mayor a menor.
export type IndicadoresPrivados = {
  costoCubierto: number;
  presupuestoCosto: number;
  porcentajeCubierto: number | null;
  obrasConDesviacionCalculable: number;
  obrasAdelantadas: { id: string; nombre: string; desviacionPP: number }[];
  umbralPP: number;
};

export type UtilidadConsolidada = {
  utilidadPresupuestada: number;
  margenPresupuestadoPct: number | null;
  utilidadReal: number;
  margenRealPct: number | null;
};

export type ResumenEjecutivo = {
  saludo: string;
  empresaNombre: string;
  semanaLabel: string;
  nivelAcceso: NivelAccesoDashboard;
  puedeVerPrivado: boolean;
  vista: VistaDashboard;
  periodo: PeriodoDashboard;
  obrasActivas: { total: number; enEjecucion: number; porIniciar: number; pausadas: number };
  avanceFisicoConsolidado: {
    porcentaje: number | null;
    proyectosIncompletos: number;
    proyectosConsiderados: number;
    deltaVsAnterior: number | null;
  };
  // "Por pagar" separado Obras vs. Empresa (nunca una sola cifra mezclada —
  // mismo criterio que Reporte General) — null para nivelAcceso "operativo".
  porPagarObras: number | null;
  porPagarEmpresa: number | null;
  porPagarTotal: number | null;
  // Días del pago de obra aprobado y sin liquidar más antiguo — SOLO Obras
  // (Por pagar Empresa no tiene antigüedad calculada; nunca se le atribuye).
  porPagarObrasDiasMax: number | null;
  porCobrar: number | null;
  // Estimaciones con saldo pendiente dentro del mismo cálculo de porCobrar.
  estimacionesPorCobrar: number | null;
  // base "general" = Flujo General (vista General: cobros a valores General,
  // con tope cronológico por estimación — no necesariamente efectivo
  // bancario); base "real" = Flujo real (vista Privado: todo cobro real).
  flujoDinero: { base: "general" | "real"; entradas: number; pagosDeObra: number; gastosReposicionesDentro: number; neto: number } | null;
  gastosProyectoPeriodo: number | null;
  gastosEmpresaPeriodo: number | null;
  utilidadConsolidada: UtilidadConsolidada | null;
  privado: IndicadoresPrivados | null;
  // Obras activas en ejecución con SEMANAS_SIN_AVANCE_ATENCION o más sin
  // avance — mismo criterio que la alerta operativa; dato no financiero.
  obrasSinAvanceReciente: number;
  alertas: AlertaDashboard[];
  compromisos: CompromisoDashboard[];
  pendientes: PendienteDashboard[];
  proyectos: FilaProyectoDashboard[];
};

// ---------------------------------------------------------------------------
// Acceso — quién ve qué en Inicio
// ---------------------------------------------------------------------------

export type AccesoDashboard = {
  // Corte de acceso real (Rediseño de Inicio, septiembre 2026) — Supervisor
  // nunca ve montos financieros, Contabilidad ni compromisos, aunque siga
  // originando los Gastos que los alimentan. Mismo permiso ya usado para
  // gatear el módulo Contabilidad completo (Administrador/Director, nunca
  // Master) — no se inventa un permiso nuevo para esto.
  nivelAcceso: NivelAccesoDashboard;
  // Permiso real de ver Privado (rol + switch personal + Empresa) — solo
  // decide si se ofrece el selector General/Privado.
  puedeVerPrivado: boolean;
  vistaEfectiva: VistaDashboard;
  // Única bandera que decide si un dato privado entra al cálculo: solo en
  // vista Privado efectiva. En General nada privado se consulta, calcula ni
  // influye en salud, orden o alertas — aunque el usuario tenga el permiso
  // (separación General/Privado, octubre 2026).
  incluirPrivado: boolean;
};

export function resolverAccesoDashboard(usuario: UsuarioSesion, vista: VistaDashboard): AccesoDashboard {
  const puedeVerPrivado = puedeVerInformacionPrivada(usuario);
  const vistaEfectiva: VistaDashboard = vista === "privado" && !puedeVerPrivado ? "general" : vista;
  const nivelAcceso: NivelAccesoDashboard = puedeVerContabilidad(usuario) ? "completo" : "operativo";
  return { nivelAcceso, puedeVerPrivado, vistaEfectiva, incluirPrivado: vistaEfectiva === "privado" };
}

// ---------------------------------------------------------------------------
// Orquestador principal — carga (cargarDatosDashboard, única parte que toca
// la BD) y proyección (proyectarResumenEjecutivo, pura) separadas para poder
// probar la proyección sin base de datos.
// ---------------------------------------------------------------------------

export async function obtenerResumenEjecutivo(
  usuario: UsuarioSesion,
  vista: VistaDashboard,
  periodo: PeriodoDashboard
): Promise<ResumenEjecutivo> {
  if (!usuario.empresa) throw new SinPermisoError();
  // Inicio es un módulo habilitable por Empresa: sin él no se consulta (ni
  // se crea la semana actual ni se generan recurrentes) nada de obras.
  if (!puedeVerInicio(usuario)) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;
  const acceso = resolverAccesoDashboard(usuario, vista);
  const { nivelAcceso, puedeVerPrivado, vistaEfectiva } = acceso;

  const hoy = new Date();
  const rango = resolverRangoPeriodo(periodo, hoy);
  const semanaActual = await obtenerOCrearSemanaActual(empresaId);
  // Perezoso e idempotente — asegura que los gastos recurrentes del periodo
  // en curso ya existan aunque nadie haya entrado a Gastos/Reporte General
  // todavía (Gastos transversal — recurrentes, septiembre 2026).
  await asegurarGastosRecurrentesGenerados(empresaId, semanaActual.id);

  const encabezado = {
    saludo: saludo(usuario.nombre),
    empresaNombre: usuario.empresa.nombre,
    semanaLabel: formatearRangoSemana(semanaActual),
  };

  const datos = await cargarDatosDashboard(usuario, empresaId, acceso, rango, hoy);

  if (!datos) {
    return {
      ...encabezado,
      nivelAcceso,
      puedeVerPrivado,
      vista: vistaEfectiva,
      periodo,
      obrasActivas: { total: 0, enEjecucion: 0, porIniciar: 0, pausadas: 0 },
      avanceFisicoConsolidado: { porcentaje: null, proyectosIncompletos: 0, proyectosConsiderados: 0, deltaVsAnterior: null },
      porPagarObras: null,
      porPagarEmpresa: null,
      porPagarTotal: null,
      porPagarObrasDiasMax: null,
      porCobrar: null,
      estimacionesPorCobrar: null,
      flujoDinero: null,
      gastosProyectoPeriodo: null,
      gastosEmpresaPeriodo: null,
      utilidadConsolidada: null,
      privado: null,
      obrasSinAvanceReciente: 0,
      alertas: [],
      compromisos: [],
      pendientes: [],
      proyectos: [],
    };
  }

  return { ...encabezado, ...proyectarResumenEjecutivo(datos, acceso, periodo, rango, hoy) };
}

// Toda la lectura de BD de Inicio, agrupada por bloque (nunca una query por
// proyecto). null = la Empresa no tiene obras activas/pausadas.
async function cargarDatosDashboard(
  usuario: UsuarioSesion,
  empresaId: string,
  acceso: AccesoDashboard,
  rango: RangoPeriodo,
  hoy: Date
) {
  const { nivelAcceso, incluirPrivado } = acceso;

  const proyectos = await db.proyecto.findMany({
    // tipo != OFICINA — ese Proyecto es el vehículo interno de Gastos de
    // Empresa (ver proyecto-oficina.ts), nunca una obra real; no debe
    // distorsionar el dashboard ejecutivo (Gastos transversal, sept. 2026).
    // Un Supervisor solo ve sus obras asignadas: todo lo demás de Inicio se
    // calcula a partir de esta lista.
    where: { AND: [{ empresaId, estatus: { in: ["ACTIVO", "PAUSADO"] }, tipo: { not: "OFICINA" } }, filtroObrasVisibles(usuario)] },
    select: {
      id: true,
      nombre: true,
      tipo: true,
      estatus: true,
      imagenRef: true,
      esquemaContractual: true,
      porcentajeUtilidadDefault: true,
      porcentajeAdministracionDefault: true,
      porcentajeAdministracionPrivadoDefault: true,
    },
    orderBy: { nombre: "asc" },
  });
  const proyectoIds = proyectos.map((p) => p.id);

  if (proyectoIds.length === 0) return null;

  // --- Carga por lote (nunca una query por proyecto) -----------------------

  const conceptosRaw = await db.concepto.findMany({
    where: { partida: { proyectoId: { in: proyectoIds } }, estatus: "ACTIVO", cantidadContratada: { gt: 0 } },
    select: {
      id: true,
      partida: { select: { proyectoId: true } },
      cantidadContratada: true,
      precioUnitarioContratista: true,
      precioUnitarioMateriales: true,
      // Precios del Contrato General Privado — solo se leen en vista Privado.
      precioUnitarioContratistaPrivado: incluirPrivado,
      precioUnitarioIndirectos: incluirPrivado,
      precioUnitarioHerramienta: incluirPrivado,
      porcentajeUtilidad: incluirPrivado,
      porcentajeAdministracion: incluirPrivado,
    },
  });
  const conceptoIds = conceptosRaw.map((c) => c.id);

  const [acumuladoActual, acumuladoAnterior] = await Promise.all([
    sumaEjecutadaPorConcepto(conceptoIds),
    rango.inicioAnterior ? sumaEjecutadaPorConcepto(conceptoIds, rango.finAnterior!) : Promise.resolve(new Map<string, number>()),
  ]);

  const capasEmitidas = await db.estimacionClienteCapa.findMany({
    where: { estatus: "EMITIDA", estimacionCliente: { proyectoId: { in: proyectoIds } } },
    select: {
      id: true,
      estimacionClienteId: true,
      capa: true,
      subtotal: true,
      montoAdministracionTrabajos: true,
      total: true,
      emitidoEn: true,
      estimacionCliente: { select: { proyectoId: true } },
    },
  });

  const movimientosSemanales = await db.movimientoSemanal.findMany({
    where: { beneficiarioProyecto: { proyectoId: { in: proyectoIds } } },
    select: {
      montoFinSemana: true,
      estatusAprobacion: true,
      estatusPago: true,
      fechaPago: true,
      createdAt: true,
      origen: true,
      beneficiarioProyecto: { select: { proyectoId: true } },
    },
  });

  // estatus: VIGENTE — un movimiento CANCELADO nunca debe contar en ningún
  // agregado financiero (Cobros de cliente, septiembre 2026).
  const movimientosFinancieros = await db.movimientoFinancieroCliente.findMany({
    where: { proyectoId: { in: proyectoIds }, estatus: "VIGENTE" },
    select: {
      id: true,
      proyectoId: true,
      tipo: true,
      monto: true,
      fecha: true,
      createdAt: true,
      estimacionClienteCapaId: true,
      estimacionClienteCapa: { select: { capa: true } },
    },
  });

  const gastosPendientes = await db.gastoObra.groupBy({
    by: ["proyectoId"],
    where: { AND: [filtroGastosVisibles(usuario)], proyectoId: { in: proyectoIds }, estatus: "PENDIENTE_REVISION" },
    _count: { _all: true },
  });

  const cierresSemana = await db.cierreSemanaProyecto.findMany({
    where: { proyectoId: { in: proyectoIds } },
    select: { proyectoId: true, semanaId: true, estatus: true, semana: { select: { fechaFin: true } } },
  });

  const semanasCerradasVencidas = await db.semana.findMany({
    where: { empresaId, fechaFin: { lt: hoy } },
    select: { id: true, fechaFin: true },
  });

  // "Listas para emitir" — capa BORRADOR cuya semana física ya cerró (el
  // avance de esa semana ya es definitivo, solo falta la decisión de
  // emitir). EstimacionCliente no tiene una relación directa a
  // CierreSemanaProyecto (solo comparten proyectoId+semanaId) — se cruzan
  // en memoria contra `cierresSemana` ya cargado. No recalcula el monto en
  // vivo (sería costoso por proyecto) — solo cuenta, tal como permite el
  // punto 10 del encargo ("mostrar cantidad; monto cuando aplique").
  // En vista General solo cuentan las capas OPERATIVO — un borrador PRIVADO
  // no debe ni revelarse como conteo.
  const capasBorrador = await db.estimacionClienteCapa.findMany({
    where: {
      estatus: "BORRADOR",
      estimacionCliente: { proyectoId: { in: proyectoIds } },
      ...(incluirPrivado ? {} : { capa: "OPERATIVO" as const }),
    },
    select: { capa: true, estimacionCliente: { select: { proyectoId: true, semanaId: true } } },
  });

  const tieneAlgunAvance = await db.avanceConcepto.groupBy({
    by: ["conceptoId"],
    where: { conceptoId: { in: conceptoIds }, estatusAprobacion: "APROBADO" },
  });

  const ultimaSemanaConAvance = await db.avanceConcepto.findMany({
    where: { conceptoId: { in: conceptoIds }, estatusAprobacion: "APROBADO" },
    select: { conceptoId: true, semana: { select: { fechaFin: true } } },
  });

  // Monto de contrato (capa operativo) — se reutiliza `calcularMontoContrato`
  // tal cual (fuente canónica, misma que usa Control Contractual) en vez de
  // reimplementar la fórmula; se piden todas en paralelo, sobre la lista ya
  // acotada de proyectos activos/pausados (no es un N+1 real — mismo
  // trade-off ya usado por `obtenerControlContractual`, que llama a esta
  // misma función internamente).
  const montosContratoGeneral = new Map(
    await Promise.all(
      proyectos.map(async (p) => {
        const pct: PorcentajesDefaultProyecto = {
          utilidad: numOrNull(p.porcentajeUtilidadDefault),
          administracion: numOrNull(p.porcentajeAdministracionDefault),
          administracionPrivado: numOrNull(p.porcentajeAdministracionPrivadoDefault),
        };
        const monto = await calcularMontoContrato(p.id, p.esquemaContractual, pct, "operativo");
        return [p.id, monto] as const;
      })
    )
  );

  // --- Gastos transversal / Contabilidad — SOLO si hay acceso completo o
  // Privado, respectivamente. Supervisor (nivelAcceso "operativo") nunca
  // dispara estas queries — ahorro real, no solo un campo oculto en la UI
  // (Rediseño de Inicio, septiembre 2026).
  //
  // "Costo real pagado" (Privado) — audit deliberada para no doblar conteo:
  // financieroPrivado.ejercido (ya existente) YA suma TODO MovimientoSemanal
  // liquidado/pagado-puente sin filtrar por origen — cubre CORTE_CONTRATISTA
  // (mano de obra), REPOSICION_GASTOS (gastos pagados personalmente, ya
  // reembolsados) y ORDEN_COMPRA (compras a proveedor) en una sola suma, sin
  // riesgo de contarlos dos veces porque son movimientos, no gastos. Lo único
  // que ese número NUNCA ha incluido es un GastoObra pagado DIRECTO por la
  // empresa (sin pagador, sin orden de compra) — ese nunca genera
  // MovimientoSemanal (confirmado en gastos.ts: asignarGastoAReposicionTx
  // solo corre si hay pagador), así que es invisible para `ejercido` y debe
  // sumarse aparte, una sola vez, aquí. Solo en vista Privado.
  const costoDirectoEmpresaPorProyecto = incluirPrivado
    ? new Map(
        (
          await db.gastoObra.groupBy({
            by: ["proyectoId"],
            where: {
              proyectoId: { in: proyectoIds },
              estatus: "APROBADO",
              pagadorBeneficiarioId: null,
              ordenCompraId: null,
            },
            _sum: { monto: true },
          })
        ).map((g) => [g.proyectoId, num(g._sum.monto)] as const)
      )
    : new Map<string, number>();

  // El resumen fiscal (Contabilidad) ya no se pide aquí: Inicio V2 lo retira
  // (plan D2/D4, punto 1.9) y Contabilidad lo conserva.
  const [
    facturasPendientesLista,
    facturasConDiferencia,
    reposicionesPendientesLista,
    ocurrenciasRecurrentesPendientesLista,
    gastosProyectoPeriodoAgg,
    gastosEmpresaPeriodoAgg,
    porPagarEmpresaAgg,
  ] = await Promise.all([
    nivelAcceso === "completo" ? obtenerFacturasPendientes(usuario, { incluirPrivado }) : Promise.resolve([]),
    nivelAcceso === "completo" ? obtenerFacturasConDiferencia(usuario, { incluirPrivado }) : Promise.resolve([]),
    nivelAcceso === "completo" ? obtenerReposicionesPendientes(usuario) : Promise.resolve([]),
    nivelAcceso === "completo" ? obtenerOcurrenciasRecurrentesPendientes(usuario) : Promise.resolve([]),
    nivelAcceso === "completo"
      ? db.gastoObra.aggregate({
          where: { proyectoId: { in: proyectoIds }, estatus: "APROBADO", fecha: { gte: rango.inicio, lt: rango.fin } },
          _sum: { monto: true },
        })
      : Promise.resolve(null),
    nivelAcceso === "completo"
      ? db.gastoObra.aggregate({
          where: { empresaId, proyecto: { tipo: "OFICINA" }, estatus: "APROBADO", fecha: { gte: rango.inicio, lt: rango.fin } },
          _sum: { monto: true },
        })
      : Promise.resolve(null),
    nivelAcceso === "completo"
      ? db.movimientoSemanal.aggregate({
          where: {
            beneficiarioProyecto: { proyecto: { tipo: "OFICINA", empresaId } },
            estatusAprobacion: "APROBADO",
            estatusPago: "PENDIENTE_PAGO",
          },
          _sum: { montoFinSemana: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    proyectos,
    conceptosRaw,
    acumuladoActual,
    acumuladoAnterior,
    capasEmitidas,
    movimientosSemanales,
    movimientosFinancieros,
    gastosPendientes,
    cierresSemana,
    semanasCerradasVencidas,
    capasBorrador,
    tieneAlgunAvance,
    ultimaSemanaConAvance,
    montosContratoGeneral,
    costoDirectoEmpresaPorProyecto,
    facturasPendientesLista,
    facturasConDiferencia,
    reposicionesPendientesLista,
    ocurrenciasRecurrentesPendientesLista,
    gastosProyectoPeriodoAgg,
    gastosEmpresaPeriodoAgg,
    porPagarEmpresaAgg,
  };
}

export type DatosDashboard = NonNullable<Awaited<ReturnType<typeof cargarDatosDashboard>>>;

// Proyección pura de los datos ya cargados — sin BD. Todo lo que decide qué
// ve cada quien vive aquí (y se prueba en tests/dashboard).
export function proyectarResumenEjecutivo(
  datos: DatosDashboard,
  acceso: AccesoDashboard,
  periodo: PeriodoDashboard,
  rango: RangoPeriodo,
  hoy: Date
): Omit<ResumenEjecutivo, "saludo" | "empresaNombre" | "semanaLabel"> {
  const {
    proyectos,
    conceptosRaw,
    acumuladoActual,
    acumuladoAnterior,
    capasEmitidas,
    movimientosSemanales,
    movimientosFinancieros,
    gastosPendientes,
    cierresSemana,
    semanasCerradasVencidas,
    capasBorrador,
    tieneAlgunAvance,
    ultimaSemanaConAvance,
    montosContratoGeneral,
    costoDirectoEmpresaPorProyecto,
    facturasPendientesLista,
    facturasConDiferencia,
    reposicionesPendientesLista,
    ocurrenciasRecurrentesPendientesLista,
    gastosProyectoPeriodoAgg,
    gastosEmpresaPeriodoAgg,
    porPagarEmpresaAgg,
  } = datos;
  const { nivelAcceso, puedeVerPrivado, vistaEfectiva, incluirPrivado } = acceso;

  // "Listas para emitir" — cruce en memoria de capasBorrador contra los
  // cierres ya cargados (ver comentario en cargarDatosDashboard). En General
  // solo capas OPERATIVO (la carga ya las filtra; se repite aquí para que la
  // proyección nunca dependa de ello).
  const semanaCerradaIds = new Set(
    cierresSemana.filter((c) => c.estatus === "CERRADA").map((c) => c.semanaId)
  );
  const capasListasParaEmitir = capasBorrador.filter(
    (c) => (incluirPrivado || c.capa === "OPERATIVO") && semanaCerradaIds.has(c.estimacionCliente.semanaId)
  );

  const conceptoIdsConAvance = new Set(tieneAlgunAvance.map((f) => f.conceptoId));

  // --- Índices por proyecto --------------------------------------------------

  const conceptosPorProyecto = new Map<string, typeof conceptosRaw>();
  for (const c of conceptosRaw) {
    const arr = conceptosPorProyecto.get(c.partida.proyectoId) ?? [];
    arr.push(c);
    conceptosPorProyecto.set(c.partida.proyectoId, arr);
  }

  const ultimaFechaAvancePorProyecto = new Map<string, Date>();
  const primeraFechaAvancePorProyecto = new Map<string, Date>();
  for (const fila of ultimaSemanaConAvance) {
    const concepto = conceptosRaw.find((c) => c.id === fila.conceptoId);
    if (!concepto) continue;
    const proyectoId = concepto.partida.proyectoId;
    const actual = ultimaFechaAvancePorProyecto.get(proyectoId);
    if (!actual || fila.semana.fechaFin > actual) {
      ultimaFechaAvancePorProyecto.set(proyectoId, fila.semana.fechaFin);
    }
    const primera = primeraFechaAvancePorProyecto.get(proyectoId);
    if (!primera || fila.semana.fechaFin < primera) {
      primeraFechaAvancePorProyecto.set(proyectoId, fila.semana.fechaFin);
    }
  }

  const capasPorProyecto = new Map<string, typeof capasEmitidas>();
  for (const c of capasEmitidas) {
    const arr = capasPorProyecto.get(c.estimacionCliente.proyectoId) ?? [];
    arr.push(c);
    capasPorProyecto.set(c.estimacionCliente.proyectoId, arr);
  }

  const movimientosPorProyecto = new Map<string, typeof movimientosSemanales>();
  for (const m of movimientosSemanales) {
    const arr = movimientosPorProyecto.get(m.beneficiarioProyecto.proyectoId) ?? [];
    arr.push(m);
    movimientosPorProyecto.set(m.beneficiarioProyecto.proyectoId, arr);
  }

  const gastosPendientesPorProyecto = new Map(gastosPendientes.map((g) => [g.proyectoId, g._count._all]));

  const cierresPorProyecto = new Map<string, typeof cierresSemana>();
  for (const c of cierresSemana) {
    const arr = cierresPorProyecto.get(c.proyectoId) ?? [];
    arr.push(c);
    cierresPorProyecto.set(c.proyectoId, arr);
  }

  // --- Cálculo por proyecto ---------------------------------------------------

  const filas: FilaProyectoDashboard[] = [];
  let sumaNumFisico = 0;
  let sumaDenFisico = 0;
  let proyectosIncompletos = 0;
  let proyectosConsiderados = 0;
  let sumaNumFisicoAnterior = 0;
  let sumaDenFisicoAnterior = 0;
  // Consolidado de utilidad/margen (Privado) — sumas crudas, nunca un
  // promedio de porcentajes (el margen % consolidado se deriva al final,
  // sobre estas sumas, para que quede correctamente ponderado por tamaño de
  // obra).
  let sumaMontoContratoGeneral = 0;
  let sumaEjecutadoGeneral = 0;
  let sumaPresupuestoCosto = 0;
  let sumaCostoRealPagado = 0;
  // Costo cubierto (Privado, Inicio V2) — Σ financieroPrivado.ejercido, sin
  // el gasto directo aprobado que sí suma costoRealPagado.
  let sumaCostoCubierto = 0;

  for (const proyecto of proyectos) {
    const conceptos = conceptosPorProyecto.get(proyecto.id) ?? [];
    const porcentajesDefault: PorcentajesDefaultProyecto = {
      utilidad: numOrNull(proyecto.porcentajeUtilidadDefault),
      administracion: numOrNull(proyecto.porcentajeAdministracionDefault),
      administracionPrivado: numOrNull(proyecto.porcentajeAdministracionPrivadoDefault),
    };

    const conceptosParaPeso: ConceptoParaAvance[] = conceptos.map((c) => ({
      id: c.id,
      proyectoId: proyecto.id,
      cantidadContratada: num(c.cantidadContratada),
      precioUnitarioContratista: numOrNull(c.precioUnitarioContratista),
      precioUnitarioMateriales: numOrNull(c.precioUnitarioMateriales),
    }));

    const avanceFisico = calcularAvanceFisicoDeConceptos(conceptosParaPeso, proyecto.esquemaContractual, acumuladoActual);

    const tieneAvanceHistorico = conceptos.some((c) => conceptoIdsConAvance.has(c.id));
    const etapa: "EN_EJECUCION" | "POR_INICIAR" = tieneAvanceHistorico ? "EN_EJECUCION" : "POR_INICIAR";

    if (proyecto.estatus === "ACTIVO") {
      if (!avanceFisico.incompleto && avanceFisico.porcentaje !== null) {
        // Consolidado ponderado por dinero (proyectos grandes pesan más).
        for (const c of conceptosParaPeso) {
          if (c.precioUnitarioContratista === null) continue;
          const { subtotalPorUnidad: peso } = calcularPrecioOperativoConcepto(
            { precioUnitarioContratista: c.precioUnitarioContratista, precioUnitarioMateriales: c.precioUnitarioMateriales, porcentajeAdministracion: null },
            proyecto.esquemaContractual,
            null
          );
          sumaNumFisico += (acumuladoActual.get(c.id) ?? 0) * peso;
          sumaDenFisico += c.cantidadContratada * peso;
          if (rango.inicioAnterior) {
            sumaNumFisicoAnterior += (acumuladoAnterior.get(c.id) ?? 0) * peso;
            sumaDenFisicoAnterior += c.cantidadContratada * peso;
          }
        }
        proyectosConsiderados++;
      } else if (avanceFisico.incompleto) {
        proyectosIncompletos++;
      }
    }

    // Financiero — General.
    const capasProyecto = capasPorProyecto.get(proyecto.id) ?? [];
    const capasOperativo = capasProyecto.filter((c) => c.capa === "OPERATIVO");
    const ejecutadoGeneral = capasOperativo.reduce((t, c) => t + num(c.subtotal) + num(c.montoAdministracionTrabajos), 0);
    const montoContratoGeneral = montosContratoGeneral.get(proyecto.id) ?? 0;

    // Por pagar (proyecto) — siempre visible, no depende del switch.
    const movsProyecto = movimientosPorProyecto.get(proyecto.id) ?? [];
    const porPagarProyecto = movsProyecto
      .filter((m) => m.estatusAprobacion === "APROBADO" && m.estatusPago === "PENDIENTE_PAGO")
      .reduce((t, m) => t + num(m.montoFinSemana), 0);

    // Financiero Privado — solo en vista Privado (incluirPrivado). Se
    // reutiliza para "Ejecutado", utilidad y desviación; en General no
    // existe, así que la desviación privada no influye en salud ni alertas
    // (separación General/Privado, octubre 2026 — antes se calculaba con el
    // solo permiso, sin importar la vista).
    let financieroPrivado: { presupuestoCosto: number; ejercido: number; porcentaje: number | null } | null = null;
    if (incluirPrivado) {
      const conceptosCosto: ConceptoParaCostoInterno[] = conceptos.map((c) => ({
        id: c.id,
        proyectoId: proyecto.id,
        cantidadContratada: num(c.cantidadContratada),
        precioUnitarioContratista: numOrNull(c.precioUnitarioContratista),
        precioUnitarioMateriales: numOrNull(c.precioUnitarioMateriales),
        precioUnitarioContratistaPrivado: numOrNull(c.precioUnitarioContratistaPrivado),
        precioUnitarioIndirectos: numOrNull(c.precioUnitarioIndirectos),
        precioUnitarioHerramienta: numOrNull(c.precioUnitarioHerramienta),
        porcentajeUtilidad: numOrNull(c.porcentajeUtilidad),
        porcentajeAdministracion: numOrNull(c.porcentajeAdministracion),
      }));
      const presupuestoCosto = calcularPresupuestoCostoInterno(conceptosCosto, proyecto.esquemaContractual, porcentajesDefault);
      const ejercido = movsProyecto
        .filter((m) => m.estatusAprobacion === "APROBADO" && (m.estatusPago === "LIQUIDADO" || m.estatusPago === "PAGADO_PUENTE"))
        .reduce((t, m) => t + num(m.montoFinSemana), 0);
      financieroPrivado = { presupuestoCosto, ejercido, porcentaje: presupuestoCosto > 0 ? (ejercido / presupuestoCosto) * 100 : null };
    }

    // Utilidad/margen — SIEMPRE "a la fecha" (acumulado, nunca recortado al
    // periodo — ver comentario de UtilidadProyecto). Presupuestada compara
    // el CONTRATO COMPLETO contra el presupuesto interno completo (línea
    // base estable); real compara lo YA FACTURADO contra el costo YA
    // PAGADO (fluctúa con el tiempo de pago) — nunca se mezclan en un solo
    // número (Rediseño de Inicio, septiembre 2026).
    let utilidadProyecto: UtilidadProyecto | null = null;
    if (financieroPrivado) {
      const costoRealPagado = financieroPrivado.ejercido + (costoDirectoEmpresaPorProyecto.get(proyecto.id) ?? 0);
      const utilidadPresupuestada = montoContratoGeneral - financieroPrivado.presupuestoCosto;
      const utilidadReal = ejecutadoGeneral - costoRealPagado;
      utilidadProyecto = {
        costoRealPagado,
        utilidadPresupuestada,
        margenPresupuestadoPct: montoContratoGeneral > 0 ? (utilidadPresupuestada / montoContratoGeneral) * 100 : null,
        utilidadReal,
        margenRealPct: ejecutadoGeneral > 0 ? (utilidadReal / ejecutadoGeneral) * 100 : null,
      };
      sumaMontoContratoGeneral += montoContratoGeneral;
      sumaEjecutadoGeneral += ejecutadoGeneral;
      sumaPresupuestoCosto += financieroPrivado.presupuestoCosto;
      sumaCostoRealPagado += costoRealPagado;
      sumaCostoCubierto += financieroPrivado.ejercido;
    }

    const ejecutado = vistaEfectiva === "privado" && financieroPrivado ? financieroPrivado.ejercido : ejecutadoGeneral;
    const montoContrato = vistaEfectiva === "privado" && financieroPrivado ? financieroPrivado.presupuestoCosto : montoContratoGeneral;
    const avanceFinancieroPorcentaje =
      vistaEfectiva === "privado" && financieroPrivado
        ? financieroPrivado.porcentaje
        : montoContratoGeneral > 0
          ? (ejecutadoGeneral / montoContratoGeneral) * 100
          : null;

    // Desviación Privada — SIEMPRE la misma relación, solo en vista Privado.
    const desviacionPrivadaPP =
      financieroPrivado?.porcentaje !== null && financieroPrivado?.porcentaje !== undefined && avanceFisico.porcentaje !== null && !avanceFisico.incompleto
        ? financieroPrivado.porcentaje - avanceFisico.porcentaje
        : null;

    // Semana sin cerrar más antigua de este proyecto.
    const cierresProyecto = cierresPorProyecto.get(proyecto.id) ?? [];
    const semanaCerradaIdsProyecto = new Set(
      cierresProyecto.filter((c) => c.estatus === "CERRADA").map((c) => c.semanaId)
    );
    let semanasSinCerrarDiasMax = 0;
    for (const s of semanasCerradasVencidas) {
      if (semanaCerradaIdsProyecto.has(s.id)) continue;
      // Solo cuentan las semanas entre el primer y el último avance aprobado
      // de la obra. Las semanas son de toda la empresa: sin el límite inicial,
      // una obra nueva arrastraría las anteriores a su propio inicio.
      const primeraFecha = primeraFechaAvancePorProyecto.get(proyecto.id);
      const ultimaFecha = ultimaFechaAvancePorProyecto.get(proyecto.id);
      if (!primeraFecha || !ultimaFecha) continue;
      if (s.fechaFin < primeraFecha || s.fechaFin > ultimaFecha) continue;
      const dias = (hoy.getTime() - s.fechaFin.getTime()) / 86400000;
      if (dias > semanasSinCerrarDiasMax) semanasSinCerrarDiasMax = dias;
    }

    // Pago aprobado pendiente más antiguo.
    let diasPagoPendienteMax = 0;
    for (const m of movsProyecto) {
      if (m.estatusAprobacion !== "APROBADO" || m.estatusPago !== "PENDIENTE_PAGO") continue;
      const dias = (hoy.getTime() - m.createdAt.getTime()) / 86400000;
      if (dias > diasPagoPendienteMax) diasPagoPendienteMax = dias;
    }

    // Semanas sin avance reciente.
    const ultimaFechaAvance = ultimaFechaAvancePorProyecto.get(proyecto.id);
    const semanasSinAvance = ultimaFechaAvance
      ? (hoy.getTime() - ultimaFechaAvance.getTime()) / (7 * 86400000)
      : 0;

    const gastosPendientesCount = gastosPendientesPorProyecto.get(proyecto.id) ?? 0;

    const salud = calcularSaludProyecto({
      estatus: proyecto.estatus,
      etapa,
      semanasSinCerrarDias: semanasSinCerrarDiasMax,
      gastosPendientesCount,
      desviacionPrivadaPP,
      diasPagoPendienteMax,
      semanasSinAvance: tieneAvanceHistorico ? semanasSinAvance : 0,
    });

    const esCompleto = nivelAcceso === "completo";
    filas.push({
      id: proyecto.id,
      nombre: proyecto.nombre,
      tipo: proyecto.tipo,
      imagenRef: proyecto.imagenRef,
      estatus: proyecto.estatus as "ACTIVO" | "PAUSADO",
      etapa,
      avanceFisico,
      // Financiero — null para Supervisor, nunca solo ocultado en la UI.
      avanceFinancieroPorcentaje: esCompleto ? avanceFinancieroPorcentaje : null,
      ejecutado: esCompleto ? ejecutado : null,
      montoContrato: esCompleto ? montoContrato : null,
      ejecutadoPeriodoAnterior: null,
      porPagar: esCompleto ? porPagarProyecto : null,
      utilidad: utilidadProyecto,
      salud,
      motivo:
        proyecto.estatus === "PAUSADO" || etapa === "POR_INICIAR"
          ? null
          : motivoPrincipal({
              esCompleto,
              semanasSinCerrarDias: semanasSinCerrarDiasMax,
              diasPagoPendienteMax,
              gastosPendientesCount,
              semanasSinAvance: tieneAvanceHistorico ? semanasSinAvance : 0,
              desviacionPrivadaPP,
            }),
      desviacionPrivadaPP,
      semanasSinCerrarDias: semanasSinCerrarDiasMax,
      diasPagoPendienteMax,
      gastosPendientesCount,
      semanasSinAvance: tieneAvanceHistorico ? semanasSinAvance : 0,
    });
  }

  const avanceFisicoConsolidado = sumaDenFisico > 0 ? (sumaNumFisico / sumaDenFisico) * 100 : null;
  const avanceFisicoAnterior = sumaDenFisicoAnterior > 0 ? (sumaNumFisicoAnterior / sumaDenFisicoAnterior) * 100 : null;
  const deltaVsAnterior =
    rango.inicioAnterior && avanceFisicoConsolidado !== null && avanceFisicoAnterior !== null
      ? avanceFisicoConsolidado - avanceFisicoAnterior
      : null;

  // --- Tarjetas globales -----------------------------------------------------

  // "Por pagar Obras" — ya son las obras reales (proyectoIds excluye
  // Proyecto-Oficina desde su origen); "Por pagar Empresa" es la Reposición/
  // OC del lado de Gastos de Empresa, mostrada SIEMPRE aparte, nunca
  // mezclada en una sola cifra (mismo criterio que Reporte General —
  // confirmado explícitamente).
  const porPagarObras = movimientosSemanales
    .filter((m) => m.estatusAprobacion === "APROBADO" && m.estatusPago === "PENDIENTE_PAGO")
    .reduce((t, m) => t + num(m.montoFinSemana), 0);
  const porPagarEmpresa = num(porPagarEmpresaAgg?._sum.montoFinSemana ?? null);

  // Cobro real por estimación — movimientos vigentes de AMBAS capas
  // (incluidos los de Operativo registrados antes de emitir Privado, leídos
  // tal cual). Misma fórmula que Cliente/Cliente Priv. y las validaciones de
  // saldo (lib/control-de-obra/cobro-estimacion.ts), nunca reimplementada.
  const capasPorEstimacionClienteId = new Map<string, typeof capasEmitidas>();
  for (const c of capasEmitidas) {
    const arr = capasPorEstimacionClienteId.get(c.estimacionClienteId) ?? [];
    arr.push(c);
    capasPorEstimacionClienteId.set(c.estimacionClienteId, arr);
  }
  const estimacionPorCapaId = new Map(capasEmitidas.map((c) => [c.id, c.estimacionClienteId]));
  const cobrosPorEstimacion = new Map<string, MovimientoCobro[]>();
  for (const m of movimientosFinancieros) {
    if (m.tipo !== "PAGO_ESTIMACION" && m.tipo !== "APLICACION_ESTIMACION") continue;
    const estimacionClienteId = m.estimacionClienteCapaId ? estimacionPorCapaId.get(m.estimacionClienteCapaId) : undefined;
    if (!estimacionClienteId) continue;
    const arr = cobrosPorEstimacion.get(estimacionClienteId) ?? [];
    arr.push(m);
    cobrosPorEstimacion.set(estimacionClienteId, arr);
  }

  // Por cobrar — General: importe Operativo menos cobro real (con tope).
  // Privado: total real de cada estimación (Privado emitida si existe; si no,
  // Operativo — nunca ambas capas sumadas como obligaciones distintas).
  let porCobrarTotal = 0;
  let estimacionesPorCobrar = 0;
  for (const [estimacionClienteId, capasEstimacion] of capasPorEstimacionClienteId) {
    // capasEmitidas solo trae capas EMITIDA.
    const capaReal = capaRealDeEstimacion(capasEstimacion.map((c) => ({ capa: c.capa, estatus: "EMITIDA" })));
    const capaBase = capasEstimacion.find((c) => c.capa === (vistaEfectiva === "privado" ? capaReal : "OPERATIVO"));
    if (!capaBase) continue;
    const { pendiente } = calcularCobroEstimacion(num(capaBase.total), cobrosPorEstimacion.get(estimacionClienteId) ?? []);
    porCobrarTotal += pendiente;
    if (pendiente > 0) estimacionesPorCobrar++;
  }

  // Flujo — TODO movimiento real, con o sin factura. Deliberadamente
  // distinto de `resumenFiscal` (Contabilidad, abajo) — nunca se muestran
  // como si fueran el mismo número (Rediseño de Inicio, C. Fiscal vs
  // Operativo).
  // - Vista Privado: Flujo real — todo cobro real del periodo.
  // - Vista General: Flujo General (E1) — cada cobro de una estimación solo
  //   entra hasta completar su importe Operativo, en orden cronológico
  //   (pagos y aplicaciones de fondo consumen el tope en conjunto; las
  //   aplicaciones nunca son entrada). Nunca revela el excedente privado.
  const enPeriodo = (fecha: Date) => fecha >= rango.inicio && fecha < rango.fin;
  let entradas: number;
  if (vistaEfectiva === "privado") {
    entradas = movimientosFinancieros
      .filter((m) => m.tipo === "PAGO_ESTIMACION" && enPeriodo(m.fecha))
      .reduce((t, m) => t + num(m.monto), 0);
  } else {
    entradas = 0;
    for (const [estimacionClienteId, capasEstimacion] of capasPorEstimacionClienteId) {
      const operativo = capasEstimacion.find((c) => c.capa === "OPERATIVO");
      // Estimación solo con Privado emitida: no existe en General.
      if (!operativo) continue;
      for (const cobro of atribuirCobrosGeneral(num(operativo.total), cobrosPorEstimacion.get(estimacionClienteId) ?? [])) {
        if (enPeriodo(cobro.fecha)) entradas += cobro.entradaGeneral;
      }
    }
    // Pagos sin capa (registros anteriores a las capas): no hay importe que
    // topar, mismo criterio que Contabilidad.
    entradas += movimientosFinancieros
      .filter((m) => m.tipo === "PAGO_ESTIMACION" && !m.estimacionClienteCapaId && enPeriodo(m.fecha))
      .reduce((t, m) => t + num(m.monto), 0);
    entradas = redondear(entradas);
  }
  const aportaciones = movimientosFinancieros
    .filter((m) => m.tipo === "APORTACION_FONDO" && enPeriodo(m.fecha))
    .reduce((t, m) => t + num(m.monto), 0);
  const pagosDeObraDelPeriodo = movimientosSemanales.filter(
    (m) => m.estatusPago === "LIQUIDADO" && m.fechaPago && m.fechaPago >= rango.inicio && m.fechaPago < rango.fin
  );
  const pagosDeObra = pagosDeObraDelPeriodo.reduce((t, m) => t + num(m.montoFinSemana), 0);
  const gastosReposicionesDentro = pagosDeObraDelPeriodo
    .filter((m) => m.origen === "REPOSICION_GASTOS")
    .reduce((t, m) => t + num(m.montoFinSemana), 0);

  const flujoDinero: NonNullable<ResumenEjecutivo["flujoDinero"]> = {
    base: vistaEfectiva === "privado" ? "real" : "general",
    entradas: entradas + aportaciones,
    pagosDeObra,
    gastosReposicionesDentro,
    neto: entradas + aportaciones - pagosDeObra,
  };

  const obrasActivas = {
    total: proyectos.filter((p) => p.estatus === "ACTIVO").length,
    enEjecucion: filas.filter((f) => f.estatus === "ACTIVO" && f.etapa === "EN_EJECUCION").length,
    porIniciar: filas.filter((f) => f.estatus === "ACTIVO" && f.etapa === "POR_INICIAR").length,
    pausadas: proyectos.filter((p) => p.estatus === "PAUSADO").length,
  };

  const alertas =
    nivelAcceso === "completo"
      ? construirAlertas({
          proyectos: filas,
          capasListasParaEmitirCount: capasListasParaEmitir.length,
          porCobrarTotal,
          incluirPrivado,
          facturasPendientesCount: facturasPendientesLista.length,
          facturasConDiferencia,
          reposicionesPendientes: reposicionesPendientesLista,
          ocurrenciasRecurrentesPendientesCount: ocurrenciasRecurrentesPendientesLista.length,
        })
      : construirAlertasOperativas(filas);

  const compromisos =
    nivelAcceso === "completo"
      ? construirCompromisos({
          ocurrenciasRecurrentesPendientes: ocurrenciasRecurrentesPendientesLista,
          reposicionesPendientes: reposicionesPendientesLista,
          proyectos: filas,
        })
      : [];

  const gastosProyectoPeriodo = nivelAcceso === "completo" ? num(gastosProyectoPeriodoAgg?._sum.monto ?? null) : null;
  const gastosEmpresaPeriodo = nivelAcceso === "completo" ? num(gastosEmpresaPeriodoAgg?._sum.monto ?? null) : null;

  const utilidadConsolidada: UtilidadConsolidada | null = incluirPrivado
    ? (() => {
        const utilidadPresupuestada = sumaMontoContratoGeneral - sumaPresupuestoCosto;
        const utilidadReal = sumaEjecutadoGeneral - sumaCostoRealPagado;
        return {
          utilidadPresupuestada,
          margenPresupuestadoPct: sumaMontoContratoGeneral > 0 ? (utilidadPresupuestada / sumaMontoContratoGeneral) * 100 : null,
          utilidadReal,
          margenRealPct: sumaEjecutadoGeneral > 0 ? (utilidadReal / sumaEjecutadoGeneral) * 100 : null,
        };
      })()
    : null;

  // Indicadores de la fila principal Privado — solo con vista Privado
  // efectiva (incluirPrivado ya exige puedeVerInformacionPrivada, que a su
  // vez excluye a Supervisor); se repite nivelAcceso por defensa en
  // profundidad. Agregan datos ya calculados por obra, sin fórmula nueva.
  const privado: IndicadoresPrivados | null =
    incluirPrivado && nivelAcceso === "completo"
      ? {
          costoCubierto: sumaCostoCubierto,
          presupuestoCosto: sumaPresupuestoCosto,
          porcentajeCubierto: sumaPresupuestoCosto > 0 ? (sumaCostoCubierto / sumaPresupuestoCosto) * 100 : null,
          obrasConDesviacionCalculable: filas.filter((f) => f.desviacionPrivadaPP !== null).length,
          obrasAdelantadas: filas
            .filter((f) => f.desviacionPrivadaPP !== null && f.desviacionPrivadaPP > UMBRAL_DESVIACION_PP)
            .map((f) => ({ id: f.id, nombre: f.nombre, desviacionPP: f.desviacionPrivadaPP as number }))
            .sort((a, b) => b.desviacionPP - a.desviacionPP),
          umbralPP: UMBRAL_DESVIACION_PP,
        }
      : null;

  // Antigüedad SOLO de Obras — el mismo dato que ya alimenta salud/alertas.
  const porPagarObrasDiasMax = filas.reduce((max, f) => Math.max(max, f.diasPagoPendienteMax), 0);

  return {
    nivelAcceso,
    puedeVerPrivado,
    vista: vistaEfectiva,
    periodo,
    obrasActivas,
    avanceFisicoConsolidado: {
      porcentaje: avanceFisicoConsolidado,
      proyectosIncompletos,
      proyectosConsiderados,
      deltaVsAnterior,
    },
    porPagarObras: nivelAcceso === "completo" ? porPagarObras : null,
    porPagarEmpresa: nivelAcceso === "completo" ? porPagarEmpresa : null,
    porPagarTotal: nivelAcceso === "completo" ? porPagarObras + porPagarEmpresa : null,
    porPagarObrasDiasMax: nivelAcceso === "completo" && porPagarObras > 0 ? Math.floor(porPagarObrasDiasMax) : null,
    porCobrar: nivelAcceso === "completo" ? porCobrarTotal : null,
    estimacionesPorCobrar: nivelAcceso === "completo" ? estimacionesPorCobrar : null,
    flujoDinero: nivelAcceso === "completo" ? flujoDinero : null,
    gastosProyectoPeriodo,
    gastosEmpresaPeriodo,
    utilidadConsolidada,
    privado,
    obrasSinAvanceReciente: filas.filter(conAvanceAtrasado).length,
    alertas,
    compromisos,
    pendientes: priorizarPendientes(alertas, compromisos, vistaEfectiva),
    proyectos: filas,
  };
}

// ---------------------------------------------------------------------------
// Pendientes de Inicio V2 — un solo bloque con alertas y compromisos.
// - Se omite lo que ya muestra un indicador de la fila principal de esa
//   vista (Por pagar/Por cobrar en General; desviación en Privado).
// - Un compromiso se omite si su asunto ya tiene alerta (la alerta lo
//   agrega) o si lo cubre un indicador visible.
// - Orden: severidad actual, luego la prioridad propuesta en D13
//   (decisiones-financieras-pendientes.md §5) — solo ordena, no cambia
//   qué genera una alerta ni su severidad.
// ---------------------------------------------------------------------------

const PRIORIDAD_PENDIENTE: AlertaDashboard["tipo"][] = [
  "sin_avance_reciente",
  "pagos_pendientes",
  "semanas_sin_cerrar",
  "reposicion_pendiente_antigua",
  "desviacion",
  "estimaciones_listas",
  "pendiente_cobro",
  "gastos_pendientes",
  "gasto_recurrente_variable_pendiente",
  "cfdi_diferencia",
  "facturas_pendientes",
];

const CUBIERTO_POR_INDICADOR: Record<VistaDashboard, AlertaDashboard["tipo"][]> = {
  general: ["pagos_pendientes", "pendiente_cobro"],
  privado: ["desviacion"],
};

const ALERTA_DEL_COMPROMISO: Record<CompromisoDashboard["tipo"], AlertaDashboard["tipo"]> = {
  gasto_recurrente_variable: "gasto_recurrente_variable_pendiente",
  reposicion_pendiente: "reposicion_pendiente_antigua",
  pago_pendiente: "pagos_pendientes",
};

export function priorizarPendientes(
  alertas: AlertaDashboard[],
  compromisos: CompromisoDashboard[],
  vista: VistaDashboard
): PendienteDashboard[] {
  const cubiertos = new Set(CUBIERTO_POR_INDICADOR[vista]);
  const tiposConAlerta = new Set(alertas.map((a) => a.tipo));
  const rango = (tipo: AlertaDashboard["tipo"]) => {
    const i = PRIORIDAD_PENDIENTE.indexOf(tipo);
    return i === -1 ? PRIORIDAD_PENDIENTE.length : i;
  };

  const items: (PendienteDashboard & { orden: number })[] = [
    ...alertas
      .filter((a) => !cubiertos.has(a.tipo))
      .map((a) => ({
        tipo: a.tipo,
        severidad: a.severidad,
        titulo: a.titulo,
        detalle: a.detalle,
        monto: a.monto ?? null,
        href: a.href,
        orden: rango(a.tipo),
      })),
    ...compromisos
      .filter((c) => {
        const alerta = ALERTA_DEL_COMPROMISO[c.tipo];
        return !tiposConAlerta.has(alerta) && !cubiertos.has(alerta);
      })
      .map((c) => ({
        tipo: c.tipo,
        severidad: "ATENCION" as const,
        titulo: c.titulo,
        detalle: c.detalle,
        monto: c.monto,
        href: c.href,
        orden: rango(ALERTA_DEL_COMPROMISO[c.tipo]),
      })),
  ];

  return items
    .sort(
      (a, b) =>
        (a.severidad === b.severidad ? 0 : a.severidad === "REQUIERE_ACCION" ? -1 : 1) ||
        a.orden - b.orden ||
        (b.monto ?? 0) - (a.monto ?? 0)
    )
    .map((p) => ({ tipo: p.tipo, severidad: p.severidad, titulo: p.titulo, detalle: p.detalle, monto: p.monto, href: p.href }));
}

function conAvanceAtrasado(p: FilaProyectoDashboard): boolean {
  return p.estatus === "ACTIVO" && p.etapa === "EN_EJECUCION" && p.semanasSinAvance >= SEMANAS_SIN_AVANCE_ATENCION;
}

function saludo(nombreCompleto: string): string {
  const hora = new Date().getHours();
  const momento = hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";
  return `${momento}, ${nombreCompleto.split(" ")[0]}`;
}

// ---------------------------------------------------------------------------
// Salud del proyecto (C.5 — definitiva)
// ---------------------------------------------------------------------------

function calcularSaludProyecto(señales: {
  estatus: string;
  etapa: "EN_EJECUCION" | "POR_INICIAR";
  semanasSinCerrarDias: number;
  gastosPendientesCount: number;
  desviacionPrivadaPP: number | null;
  diasPagoPendienteMax: number;
  semanasSinAvance: number;
}): EstadoSalud {
  if (señales.estatus === "PAUSADO" || señales.etapa === "POR_INICIAR") return "EN_SEGUIMIENTO";

  const semanasSinCerrar = señales.semanasSinCerrarDias / 7;
  const desviacion = señales.desviacionPrivadaPP ?? 0;

  const requiereAccion =
    semanasSinCerrar >= SEMANAS_SIN_CERRAR_CRITICO ||
    desviacion > UMBRAL_DESVIACION_PP * 2 ||
    señales.diasPagoPendienteMax >= DIAS_PAGO_PENDIENTE_CRITICO ||
    señales.semanasSinAvance >= SEMANAS_SIN_AVANCE_CRITICO;
  if (requiereAccion) return "REQUIERE_ACCION";

  const atencion =
    semanasSinCerrar >= 1 ||
    señales.gastosPendientesCount > 0 ||
    desviacion > UMBRAL_DESVIACION_PP ||
    señales.diasPagoPendienteMax > 0 ||
    señales.semanasSinAvance >= SEMANAS_SIN_AVANCE_ATENCION;
  if (atencion) return "ATENCION";

  return "SALUDABLE";
}

// Misma lógica y umbrales que calcularSaludProyecto, devolviendo la primera
// señal (la más grave) en texto.
function motivoPrincipal(s: {
  esCompleto: boolean;
  semanasSinCerrarDias: number;
  diasPagoPendienteMax: number;
  gastosPendientesCount: number;
  semanasSinAvance: number;
  desviacionPrivadaPP: number | null;
}): FilaProyectoDashboard["motivo"] {
  const dias = (n: number) => `${Math.floor(n)} día${Math.floor(n) === 1 ? "" : "s"}`;
  const semanas = (n: number) => `${Math.floor(n)} semana${Math.floor(n) === 1 ? "" : "s"}`;
  const desviacion = s.desviacionPrivadaPP ?? 0;
  const candidatos: { activo: boolean; severidad: "ATENCION" | "REQUIERE_ACCION" | "AVISO"; texto: string }[] = [
    { activo: s.esCompleto && s.semanasSinCerrarDias / 7 >= SEMANAS_SIN_CERRAR_CRITICO, severidad: "REQUIERE_ACCION", texto: `Semana sin cerrar desde hace ${dias(s.semanasSinCerrarDias)}` },
    { activo: s.esCompleto && s.diasPagoPendienteMax >= DIAS_PAGO_PENDIENTE_CRITICO, severidad: "REQUIERE_ACCION", texto: `Pago pendiente desde hace ${dias(s.diasPagoPendienteMax)}` },
    { activo: s.semanasSinAvance >= SEMANAS_SIN_AVANCE_CRITICO, severidad: "REQUIERE_ACCION", texto: `Sin avance desde hace ${semanas(s.semanasSinAvance)}` },
    { activo: desviacion > UMBRAL_DESVIACION_PP * 2, severidad: "REQUIERE_ACCION", texto: `Costo adelantado al avance (+${desviacion.toFixed(0)} pp)` },
    { activo: s.esCompleto && s.semanasSinCerrarDias / 7 >= 1, severidad: "ATENCION", texto: `Semana sin cerrar desde hace ${dias(s.semanasSinCerrarDias)}` },
    { activo: s.esCompleto && s.diasPagoPendienteMax > 0, severidad: "ATENCION", texto: `Pago pendiente desde hace ${dias(s.diasPagoPendienteMax)}` },
    { activo: s.esCompleto && s.gastosPendientesCount > 0, severidad: "ATENCION", texto: `${s.gastosPendientesCount} gasto${s.gastosPendientesCount === 1 ? "" : "s"} por revisar` },
    { activo: s.semanasSinAvance >= SEMANAS_SIN_AVANCE_ATENCION, severidad: "ATENCION", texto: `Sin avance desde hace ${semanas(s.semanasSinAvance)}` },
    { activo: desviacion > UMBRAL_DESVIACION_PP, severidad: "ATENCION", texto: `Costo adelantado al avance (+${desviacion.toFixed(0)} pp)` },
    { activo: s.esCompleto && s.semanasSinCerrarDias > 0, severidad: "AVISO", texto: "Semana por cerrar" },
  ];
  const elegido = candidatos.find((c) => c.activo);
  return elegido ? { texto: elegido.texto, severidad: elegido.severidad } : null;
}

// ---------------------------------------------------------------------------
// Alertas — "Requiere tu atención"
// ---------------------------------------------------------------------------

function construirAlertas(ctx: {
  proyectos: FilaProyectoDashboard[];
  capasListasParaEmitirCount: number;
  porCobrarTotal: number;
  incluirPrivado: boolean;
  facturasPendientesCount: number;
  facturasConDiferencia: { facturaId: string; razonSocial: string; diferencia: number }[];
  reposicionesPendientes: { id: string; beneficiarioNombre: string; saldoPendiente: number; diasAbierta: number }[];
  ocurrenciasRecurrentesPendientesCount: number;
}): AlertaDashboard[] {
  const alertas: AlertaDashboard[] = [];

  // Pagos pendientes — proyectos con algo APROBADO+PENDIENTE_PAGO.
  const conPagoPendiente = ctx.proyectos.filter((p) => (p.porPagar ?? 0) > 0);
  if (conPagoPendiente.length > 0) {
    const monto = conPagoPendiente.reduce((t, p) => t + (p.porPagar ?? 0), 0);
    alertas.push({
      tipo: "pagos_pendientes",
      severidad: conPagoPendiente.some((p) => p.diasPagoPendienteMax >= DIAS_PAGO_PENDIENTE_CRITICO) ? "REQUIERE_ACCION" : "ATENCION",
      titulo: `${formatMoneySimple(monto)} pendientes de pago`,
      detalle: `${conPagoPendiente.length} proyecto${conPagoPendiente.length === 1 ? "" : "s"} con movimientos autorizados esperando liquidación.`,
      monto,
      href: "/reporte-general",
    });
  }

  // Semanas pendientes de cierre.
  const conSemanaSinCerrar = ctx.proyectos.filter((p) => p.semanasSinCerrarDias > 0);
  if (conSemanaSinCerrar.length > 0) {
    alertas.push({
      tipo: "semanas_sin_cerrar",
      severidad: conSemanaSinCerrar.some((p) => p.semanasSinCerrarDias / 7 >= SEMANAS_SIN_CERRAR_CRITICO) ? "REQUIERE_ACCION" : "ATENCION",
      titulo: `${conSemanaSinCerrar.length} proyecto${conSemanaSinCerrar.length === 1 ? "" : "s"} con semanas pendientes de cierre`,
      detalle: conSemanaSinCerrar.map((p) => p.nombre).slice(0, 3).join(", "),
      // Con una sola obra se lleva directo a donde se cierra la semana.
      href: hrefDeObra(conSemanaSinCerrar, "/ejecucion/avance"),
    });
  }

  // Gastos pendientes de revisión.
  const conGastosPendientes = ctx.proyectos.filter((p) => p.gastosPendientesCount > 0);
  if (conGastosPendientes.length > 0) {
    const totalGastos = conGastosPendientes.reduce((t, p) => t + p.gastosPendientesCount, 0);
    alertas.push({
      tipo: "gastos_pendientes",
      severidad: "ATENCION",
      titulo: `${totalGastos} gasto${totalGastos === 1 ? "" : "s"} pendiente${totalGastos === 1 ? "" : "s"} de revisión`,
      detalle:
        conGastosPendientes.length === 1 ? `${conGastosPendientes[0].nombre} · requieren aprobación o rechazo.` : "Requieren aprobación o rechazo.",
      href: hrefDeObra(conGastosPendientes, "/ejecucion/gastos"),
    });
  }

  // Estimaciones listas para emitir.
  if (ctx.capasListasParaEmitirCount > 0) {
    alertas.push({
      tipo: "estimaciones_listas",
      severidad: "ATENCION",
      titulo: `${ctx.capasListasParaEmitirCount} estimación${ctx.capasListasParaEmitirCount === 1 ? "" : "es"} lista${ctx.capasListasParaEmitirCount === 1 ? "" : "s"} para emitir`,
      detalle: "La semana ya cerró — solo falta la decisión de emitir.",
      href: "/control-de-obra",
    });
  }

  // Pendiente de cobro.
  if (ctx.porCobrarTotal > 0) {
    alertas.push({
      tipo: "pendiente_cobro",
      severidad: "ATENCION",
      titulo: `${formatMoneySimple(ctx.porCobrarTotal)} pendiente de cobro`,
      detalle: "Estimaciones emitidas sin cubrir por completo.",
      monto: ctx.porCobrarTotal,
      href: "/control-de-obra",
    });
  }

  // Desviación físico-financiera — SIEMPRE con la relación Privada, y solo
  // en vista Privado (en General el dato ni siquiera se calcula, ver
  // proyectarResumenEjecutivo).
  if (ctx.incluirPrivado) {
    const conDesviacion = ctx.proyectos.filter((p) => (p.desviacionPrivadaPP ?? 0) > UMBRAL_DESVIACION_PP);
    if (conDesviacion.length > 0) {
      alertas.push({
        tipo: "desviacion",
        severidad: conDesviacion.some((p) => (p.desviacionPrivadaPP ?? 0) > UMBRAL_DESVIACION_PP * 2) ? "REQUIERE_ACCION" : "ATENCION",
        titulo: `${conDesviacion.length} proyecto${conDesviacion.length === 1 ? "" : "s"} con el costo adelantado al avance físico`,
        detalle: conDesviacion.map((p) => `${p.nombre} (+${(p.desviacionPrivadaPP ?? 0).toFixed(0)}pp)`).slice(0, 3).join(", "),
        href: hrefDeObra(conDesviacion, ""),
      });
    }
  }

  // Facturas pendientes (Contabilidad) — nunca duplica la pantalla, solo
  // avisa y lleva al módulo (Rediseño de Inicio, septiembre 2026).
  if (ctx.facturasPendientesCount > 0) {
    alertas.push({
      tipo: "facturas_pendientes",
      severidad: "ATENCION",
      titulo: `${ctx.facturasPendientesCount} factura${ctx.facturasPendientesCount === 1 ? "" : "s"} pendiente${ctx.facturasPendientesCount === 1 ? "" : "s"}`,
      detalle: "Gastos/ingresos marcados con factura que todavía no se ha cargado.",
      href: "/contabilidad/facturas",
    });
  }

  // CFDI con diferencia de monto contra el gasto/pago vinculado.
  if (ctx.facturasConDiferencia.length > 0) {
    alertas.push({
      tipo: "cfdi_diferencia",
      severidad: "ATENCION",
      titulo: `${ctx.facturasConDiferencia.length} factura${ctx.facturasConDiferencia.length === 1 ? "" : "s"} con diferencia de monto`,
      detalle: ctx.facturasConDiferencia.map((f) => f.razonSocial).slice(0, 3).join(", "),
      href: "/contabilidad/facturas",
    });
  }

  // Reposiciones abiertas antiguas — mismo umbral crítico que pagos
  // pendientes (DIAS_PAGO_PENDIENTE_CRITICO), es el mismo tipo de espera.
  const reposicionesAntiguas = ctx.reposicionesPendientes.filter((r) => r.diasAbierta > 0);
  if (reposicionesAntiguas.length > 0) {
    const monto = reposicionesAntiguas.reduce((t, r) => t + r.saldoPendiente, 0);
    alertas.push({
      tipo: "reposicion_pendiente_antigua",
      severidad: reposicionesAntiguas.some((r) => r.diasAbierta >= DIAS_PAGO_PENDIENTE_CRITICO) ? "REQUIERE_ACCION" : "ATENCION",
      titulo: `${formatMoneySimple(monto)} en reposiciones abiertas`,
      detalle: `${reposicionesAntiguas.length} reposición${reposicionesAntiguas.length === 1 ? "" : "es"} pendiente${reposicionesAntiguas.length === 1 ? "" : "s"} de pagar.`,
      monto,
      href: "/contabilidad/egresos",
    });
  }

  // Gastos recurrentes de monto variable sin capturar todavía.
  if (ctx.ocurrenciasRecurrentesPendientesCount > 0) {
    alertas.push({
      tipo: "gasto_recurrente_variable_pendiente",
      severidad: "ATENCION",
      titulo: `${ctx.ocurrenciasRecurrentesPendientesCount} gasto${ctx.ocurrenciasRecurrentesPendientesCount === 1 ? "" : "s"} recurrente${ctx.ocurrenciasRecurrentesPendientesCount === 1 ? "" : "s"} sin monto`,
      detalle: "Monto variable pendiente de capturar antes de poder aprobarse.",
      href: "/gastos/recurrentes",
    });
  }

  return alertas.sort((a, b) => (a.severidad === b.severidad ? 0 : a.severidad === "REQUIERE_ACCION" ? -1 : 1));
}

// Supervisor — solo señales operativas, nunca montos ni nada de Contabilidad
// (Rediseño de Inicio, septiembre 2026). Hoy la única señal genuinamente
// operativa y accionable por Supervisor con datos ya existentes es "sin
// avance reciente" (ya se calculaba para `salud`, aquí se expone como su
// propia alerta) — semanas sin cerrar y gastos pendientes de revisión son
// acciones de Administrador/Director, no de Supervisor.
function construirAlertasOperativas(proyectos: FilaProyectoDashboard[]): AlertaDashboard[] {
  const sinAvance = proyectos.filter(conAvanceAtrasado);
  if (sinAvance.length === 0) return [];
  return [
    {
      tipo: "sin_avance_reciente",
      severidad: sinAvance.some((p) => p.semanasSinAvance >= SEMANAS_SIN_AVANCE_CRITICO) ? "REQUIERE_ACCION" : "ATENCION",
      titulo: `${sinAvance.length} proyecto${sinAvance.length === 1 ? "" : "s"} sin avance capturado reciente`,
      detalle: sinAvance.map((p) => p.nombre).slice(0, 3).join(", "),
      href: hrefDeObra(sinAvance, "/ejecucion/avance"),
    },
  ];
}

// Una sola obra involucrada → su pantalla concreta; varias → la lista.
function hrefDeObra(proyectos: FilaProyectoDashboard[], subruta: string): string {
  return proyectos.length === 1 ? `/control-de-obra/${proyectos[0].id}${subruta}` : "/control-de-obra";
}

// ---------------------------------------------------------------------------
// Próximos compromisos — reemplaza Actividad reciente en Inicio (más
// accionable para el uso diario). Solo compromisos financieros/operativos
// reales, nunca un calendario de todo lo que existe (Rediseño de Inicio,
// septiembre 2026).
// ---------------------------------------------------------------------------

function construirCompromisos(ctx: {
  ocurrenciasRecurrentesPendientes: { gastoObraId: string; descripcion: string; proyectoNombre: string }[];
  reposicionesPendientes: { id: string; folio: string; proyectoNombre: string; beneficiarioNombre: string; saldoPendiente: number }[];
  proyectos: FilaProyectoDashboard[];
}): CompromisoDashboard[] {
  const compromisos: CompromisoDashboard[] = [];

  for (const o of ctx.ocurrenciasRecurrentesPendientes) {
    compromisos.push({
      tipo: "gasto_recurrente_variable",
      titulo: o.descripcion,
      detalle: `${o.proyectoNombre} · monto pendiente de capturar`,
      monto: null,
      href: "/gastos/recurrentes",
    });
  }

  for (const r of ctx.reposicionesPendientes) {
    compromisos.push({
      tipo: "reposicion_pendiente",
      titulo: `Reposición ${r.folio} — ${r.beneficiarioNombre}`,
      detalle: r.proyectoNombre,
      monto: r.saldoPendiente,
      href: "/contabilidad/egresos",
    });
  }

  for (const p of ctx.proyectos) {
    if ((p.porPagar ?? 0) > 0 && p.diasPagoPendienteMax > 0) {
      compromisos.push({
        tipo: "pago_pendiente",
        titulo: `Pago pendiente — ${p.nombre}`,
        detalle: `${Math.floor(p.diasPagoPendienteMax)} día${Math.floor(p.diasPagoPendienteMax) === 1 ? "" : "s"} esperando liquidación`,
        monto: p.porPagar,
        href: `/control-de-obra/${p.id}`,
      });
    }
  }

  // Más urgente primero — reposiciones/pagos con monto mayor y recurrentes
  // sin capturar (que bloquean su propia aprobación) al frente.
  return compromisos.sort((a, b) => (b.monto ?? 0) - (a.monto ?? 0));
}

function formatMoneySimple(n: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n);
}

// ---------------------------------------------------------------------------
// Actividad reciente — RegistroAuditoria, catálogo real de {entidad, accion}
// confirmado en el plan. Resolución de proyecto por lote según tipo de
// entidad (nunca una query por fila).
// ---------------------------------------------------------------------------

async function obtenerActividadReciente(empresaId: string, proyectoIds: string[]): Promise<ActividadItem[]> {
  const proyectoIdSet = new Set(proyectoIds);
  const ENTIDADES = [
    "GastoObra",
    "CierreSemanaProyecto",
    "EstimacionClienteCapa",
    "MovimientoFinancieroCliente",
    "MovimientoSemanal",
  ] as const;

  const registros = await db.registroAuditoria.findMany({
    where: { empresaId, entidad: { in: [...ENTIDADES] } },
    orderBy: { createdAt: "desc" },
    take: 40, // se filtra a proyectos activos/pausados después — se piden de más para no quedarse cortos
    include: { usuario: { select: { nombre: true } } },
  });
  if (registros.length === 0) return [];

  const idsPorEntidad = new Map<string, string[]>();
  for (const r of registros) {
    const arr = idsPorEntidad.get(r.entidad) ?? [];
    arr.push(r.entidadId);
    idsPorEntidad.set(r.entidad, arr);
  }

  const [gastos, cierres, capas, movFinancieros, movSemanales] = await Promise.all([
    idsPorEntidad.has("GastoObra")
      ? db.gastoObra.findMany({ where: { id: { in: idsPorEntidad.get("GastoObra")! } }, select: { id: true, proyectoId: true } })
      : Promise.resolve([]),
    idsPorEntidad.has("CierreSemanaProyecto")
      ? db.cierreSemanaProyecto.findMany({ where: { id: { in: idsPorEntidad.get("CierreSemanaProyecto")! } }, select: { id: true, proyectoId: true } })
      : Promise.resolve([]),
    idsPorEntidad.has("EstimacionClienteCapa")
      ? db.estimacionClienteCapa.findMany({ where: { id: { in: idsPorEntidad.get("EstimacionClienteCapa")! } }, select: { id: true, estimacionCliente: { select: { proyectoId: true } } } })
      : Promise.resolve([]),
    idsPorEntidad.has("MovimientoFinancieroCliente")
      ? db.movimientoFinancieroCliente.findMany({ where: { id: { in: idsPorEntidad.get("MovimientoFinancieroCliente")! } }, select: { id: true, proyectoId: true } })
      : Promise.resolve([]),
    idsPorEntidad.has("MovimientoSemanal")
      ? db.movimientoSemanal.findMany({ where: { id: { in: idsPorEntidad.get("MovimientoSemanal")! } }, select: { id: true, beneficiarioProyecto: { select: { proyectoId: true } } } })
      : Promise.resolve([]),
  ]);
  const proyectoIdPorGasto = new Map(gastos.map((g) => [g.id, g.proyectoId]));
  const proyectoIdPorCierre = new Map(cierres.map((c) => [c.id, c.proyectoId]));
  const proyectoIdPorCapa = new Map(capas.map((c) => [c.id, c.estimacionCliente.proyectoId]));
  const proyectoIdPorMovFinanciero = new Map(movFinancieros.map((m) => [m.id, m.proyectoId]));
  const proyectoIdPorMovSemanal = new Map(movSemanales.map((m) => [m.id, m.beneficiarioProyecto.proyectoId]));

  const nombrePorProyectoId = await (async () => {
    const filas = await db.proyecto.findMany({ where: { id: { in: proyectoIds } }, select: { id: true, nombre: true } });
    return new Map(filas.map((p) => [p.id, p.nombre]));
  })();

  const items: ActividadItem[] = [];
  for (const r of registros) {
    const valor = (r.valorNuevo ?? {}) as Record<string, unknown>;
    let proyectoId: string | null = null;
    let descripcion = "";
    let monto: number | null = null;

    if (r.entidad === "GastoObra") {
      proyectoId = proyectoIdPorGasto.get(r.entidadId) ?? null;
      monto = typeof valor.monto === "number" ? valor.monto : null;
      descripcion =
        r.accion === "CONFIRMAR" ? "Gasto aprobado" : r.accion === "RECHAZAR" ? "Gasto rechazado" : "Gasto actualizado";
    } else if (r.entidad === "CierreSemanaProyecto") {
      proyectoId = proyectoIdPorCierre.get(r.entidadId) ?? null;
      descripcion = valor.estatus === "ABIERTA" ? "Semana reabierta" : "Semana cerrada";
    } else if (r.entidad === "EstimacionClienteCapa") {
      proyectoId = proyectoIdPorCapa.get(r.entidadId) ?? null;
      monto = typeof valor.total === "number" ? valor.total : null;
      descripcion = r.accion === "CAMBIAR_ESTATUS" ? "Estimación emitida" : "Estimación actualizada";
    } else if (r.entidad === "MovimientoFinancieroCliente") {
      proyectoId = proyectoIdPorMovFinanciero.get(r.entidadId) ?? null;
      monto = typeof valor.monto === "number" ? valor.monto : null;
      descripcion =
        valor.tipo === "APORTACION_FONDO"
          ? "Aportación al fondo"
          : valor.tipo === "APLICACION_ESTIMACION"
            ? "Fondo aplicado a estimación"
            : "Pago de estimación registrado";
    } else if (r.entidad === "MovimientoSemanal") {
      proyectoId = proyectoIdPorMovSemanal.get(r.entidadId) ?? null;
      descripcion = "Pago liquidado";
    }

    // Solo actividad de proyectos activos/pausados (el alcance del
    // dashboard) — nunca de un proyecto cerrado/cancelado, ni de un
    // registro cuya entidad ya no se pudo resolver (defensivo).
    if (!proyectoId || !proyectoIdSet.has(proyectoId)) continue;

    items.push({
      id: r.id,
      fecha: r.createdAt.toISOString(),
      entidad: r.entidad,
      accion: r.accion,
      descripcion,
      proyectoNombre: nombrePorProyectoId.get(proyectoId) ?? null,
      monto,
      usuarioNombre: r.usuario?.nombre ?? null,
    });
    if (items.length >= 15) break;
  }
  return items;
}

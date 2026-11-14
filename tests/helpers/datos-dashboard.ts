import { Prisma } from "@/lib/generated/prisma/client";
import { resolverRangoPeriodo, type DatosDashboard } from "@/lib/server/dashboard";

// Escenario ficticio para Inicio — datos YA CARGADOS (salida de
// cargarDatosDashboard). Se entregan completos (incluidos los insumos
// privados) a propósito: la proyección debe descartarlos por sí misma en
// vista General, sin depender de que la carga los haya filtrado.
//
// Obras:
// - Torre Prueba (ACTIVO): estimación con capa OPERATIVO $980,000 y capa
//   PRIVADO $1,150,000; cobro real $500,000 registrado en la capa PRIVADO;
//   pago pendiente de 2 días; costo privado adelantado al avance (>30 pp).
// - Bodega Prueba (ACTIVO): solo capa OPERATIVO; desviación privada >15 pp.
// - Pausada Prueba (PAUSADO).
//
// Valores "trampa" que solo existen del lado privado — nunca deben aparecer
// en una respuesta de vista General.
export const TRAMPAS_PRIVADAS = {
  precioContratistaPrivadoTorre: 4321.09, // presupuesto de costo privado = 432,109
  presupuestoCostoTorre: 432109,
  subtotalCapaPrivada: 777777.77,
  costoDirectoEmpresaTorre: 12345.67,
};

export const HOY = new Date(2026, 9, 8, 15, 0, 0); // jueves 8 oct 2026, 15:00

const dec = (n: number) => new Prisma.Decimal(n);
const fecha = (mes: number, dia: number) => new Date(2026, mes - 1, dia, 12, 0, 0);

const TORRE = "proyecto-torre";
const BODEGA = "proyecto-bodega";
const PAUSADA = "proyecto-pausada";

export function rangoDePrueba(periodo: Parameters<typeof resolverRangoPeriodo>[0] = "semana") {
  return resolverRangoPeriodo(periodo, HOY);
}

export function datosDePrueba(): DatosDashboard {
  const proyectoBase = {
    tipo: "FORMAL" as const,
    imagenRef: null,
    esquemaContractual: "ADMINISTRACION" as const,
    porcentajeUtilidadDefault: null,
    porcentajeAdministracionDefault: null,
    porcentajeAdministracionPrivadoDefault: null,
  };
  const conceptoBase = {
    precioUnitarioMateriales: null,
    precioUnitarioIndirectos: null,
    precioUnitarioHerramienta: null,
    porcentajeUtilidad: null,
    porcentajeAdministracion: null,
  };

  return {
    proyectos: [
      { ...proyectoBase, id: BODEGA, nombre: "Bodega Prueba", estatus: "ACTIVO" },
      { ...proyectoBase, id: PAUSADA, nombre: "Pausada Prueba", estatus: "PAUSADO" },
      { ...proyectoBase, id: TORRE, nombre: "Torre Prueba", estatus: "ACTIVO" },
    ],
    conceptosRaw: [
      {
        ...conceptoBase,
        id: "concepto-torre",
        partida: { proyectoId: TORRE },
        cantidadContratada: dec(100),
        precioUnitarioContratista: dec(1000),
        precioUnitarioContratistaPrivado: dec(TRAMPAS_PRIVADAS.precioContratistaPrivadoTorre),
      },
      {
        ...conceptoBase,
        id: "concepto-bodega",
        partida: { proyectoId: BODEGA },
        cantidadContratada: dec(50),
        precioUnitarioContratista: dec(2000),
        precioUnitarioContratistaPrivado: dec(2600), // presupuesto de costo privado = 130,000
      },
    ],
    acumuladoActual: new Map([
      ["concepto-torre", 60], // 60 % físico
      ["concepto-bodega", 10], // 20 % físico
    ]),
    acumuladoAnterior: new Map([
      ["concepto-torre", 55],
      ["concepto-bodega", 8],
    ]),
    capasEmitidas: [
      {
        id: "capa-torre-operativo",
        estimacionClienteId: "estimacion-torre",
        capa: "OPERATIVO",
        subtotal: dec(800000),
        montoAdministracionTrabajos: dec(50000),
        total: dec(980000),
        emitidoEn: fecha(10, 1),
        estimacionCliente: { proyectoId: TORRE },
      },
      {
        id: "capa-torre-privado",
        estimacionClienteId: "estimacion-torre",
        capa: "PRIVADO",
        subtotal: dec(TRAMPAS_PRIVADAS.subtotalCapaPrivada),
        montoAdministracionTrabajos: dec(0),
        total: dec(1150000),
        emitidoEn: fecha(10, 1),
        estimacionCliente: { proyectoId: TORRE },
      },
      {
        id: "capa-bodega-operativo",
        estimacionClienteId: "estimacion-bodega",
        capa: "OPERATIVO",
        subtotal: dec(250000),
        montoAdministracionTrabajos: dec(0),
        total: dec(300000),
        emitidoEn: fecha(10, 2),
        estimacionCliente: { proyectoId: BODEGA },
      },
    ],
    movimientosSemanales: [
      {
        montoFinSemana: dec(400000),
        estatusAprobacion: "APROBADO",
        estatusPago: "LIQUIDADO",
        fechaPago: fecha(10, 6),
        createdAt: fecha(9, 28),
        origen: "CORTE_CONTRATISTA",
        beneficiarioProyecto: { proyectoId: TORRE },
      },
      {
        montoFinSemana: dec(120000),
        estatusAprobacion: "APROBADO",
        estatusPago: "PENDIENTE_PAGO",
        fechaPago: null,
        createdAt: fecha(10, 6), // ~2 días esperando pago
        origen: "CORTE_CONTRATISTA",
        beneficiarioProyecto: { proyectoId: TORRE },
      },
      {
        montoFinSemana: dec(50000),
        estatusAprobacion: "APROBADO",
        estatusPago: "LIQUIDADO",
        fechaPago: fecha(10, 7),
        createdAt: fecha(10, 2),
        origen: "REPOSICION_GASTOS",
        beneficiarioProyecto: { proyectoId: BODEGA },
      },
    ],
    movimientosFinancieros: [
      {
        id: "cobro-torre-1",
        proyectoId: TORRE,
        tipo: "PAGO_ESTIMACION",
        monto: dec(500000),
        fecha: fecha(10, 6),
        createdAt: fecha(10, 6),
        estimacionClienteCapaId: "capa-torre-privado",
        estimacionClienteCapa: { capa: "PRIVADO" },
      },
      {
        id: "cobro-bodega-1",
        proyectoId: BODEGA,
        tipo: "PAGO_ESTIMACION",
        monto: dec(100000),
        fecha: fecha(10, 7),
        createdAt: fecha(10, 7),
        estimacionClienteCapaId: "capa-bodega-operativo",
        estimacionClienteCapa: { capa: "OPERATIVO" },
      },
      {
        id: "aportacion-torre-1",
        proyectoId: TORRE,
        tipo: "APORTACION_FONDO",
        monto: dec(75000),
        fecha: fecha(10, 5),
        createdAt: fecha(10, 5),
        estimacionClienteCapaId: null,
        estimacionClienteCapa: null,
      },
    ],
    gastosPendientes: [] as unknown as DatosDashboard["gastosPendientes"],
    cierresSemana: [
      { proyectoId: TORRE, semanaId: "semana-40", estatus: "CERRADA", semana: { fechaFin: fecha(10, 4) } },
    ],
    semanasCerradasVencidas: [],
    capasBorrador: [
      { capa: "OPERATIVO", estimacionCliente: { proyectoId: TORRE, semanaId: "semana-40" } },
      { capa: "PRIVADO", estimacionCliente: { proyectoId: TORRE, semanaId: "semana-40" } },
    ],
    tieneAlgunAvance: [{ conceptoId: "concepto-torre" }, { conceptoId: "concepto-bodega" }] as unknown as DatosDashboard["tieneAlgunAvance"],
    ultimaSemanaConAvance: [
      { conceptoId: "concepto-torre", semana: { fechaFin: fecha(10, 4) } },
      { conceptoId: "concepto-bodega", semana: { fechaFin: fecha(10, 4) } },
    ],
    montosContratoGeneral: new Map([
      [TORRE, 1000000],
      [BODEGA, 1000000],
      [PAUSADA, 0],
    ]),
    costoDirectoEmpresaPorProyecto: new Map([[TORRE, TRAMPAS_PRIVADAS.costoDirectoEmpresaTorre]]),
    facturasPendientesLista: [],
    facturasConDiferencia: [],
    reposicionesPendientesLista: [],
    ocurrenciasRecurrentesPendientesLista: [],
    gastosProyectoPeriodoAgg: { _sum: { monto: dec(90000) } } as unknown as DatosDashboard["gastosProyectoPeriodoAgg"],
    gastosEmpresaPeriodoAgg: { _sum: { monto: dec(15000) } } as unknown as DatosDashboard["gastosEmpresaPeriodoAgg"],
    porPagarEmpresaAgg: { _sum: { montoFinSemana: dec(86200) } } as unknown as DatosDashboard["porPagarEmpresaAgg"],
  };
}

export const IDS = { TORRE, BODEGA, PAUSADA };

// Escenario E1: el base + (1) un segundo cobro de Torre en PRIVADO que hace
// que el cobro real ($1,100,000) supere el importe General ($980,000), y
// (2) una segunda estimación de Bodega en el caso 3: $150,000 cobrados en
// OPERATIVO (20 sep) antes de emitir PRIVADO, y $300,000 en PRIVADO (6 oct).
// OPERATIVO $400,000 · PRIVADO $500,000.
export function datosE1(): DatosDashboard {
  const datos = datosDePrueba();
  datos.capasEmitidas = [
    ...datos.capasEmitidas,
    {
      id: "capa-bodega2-operativo",
      estimacionClienteId: "estimacion-bodega-2",
      capa: "OPERATIVO",
      subtotal: dec(400000),
      montoAdministracionTrabajos: dec(0),
      total: dec(400000),
      emitidoEn: fecha(9, 15),
      estimacionCliente: { proyectoId: BODEGA },
    },
    {
      id: "capa-bodega2-privado",
      estimacionClienteId: "estimacion-bodega-2",
      capa: "PRIVADO",
      subtotal: dec(500000),
      montoAdministracionTrabajos: dec(0),
      total: dec(500000),
      emitidoEn: fecha(9, 25),
      estimacionCliente: { proyectoId: BODEGA },
    },
  ];
  datos.movimientosFinancieros = [
    ...datos.movimientosFinancieros,
    {
      id: "cobro-torre-2",
      proyectoId: TORRE,
      tipo: "PAGO_ESTIMACION",
      monto: dec(600000),
      fecha: fecha(10, 7),
      createdAt: fecha(10, 7),
      estimacionClienteCapaId: "capa-torre-privado",
      estimacionClienteCapa: { capa: "PRIVADO" },
    },
    {
      id: "cobro-bodega2-operativo",
      proyectoId: BODEGA,
      tipo: "PAGO_ESTIMACION",
      monto: dec(150000),
      fecha: fecha(9, 20),
      createdAt: fecha(9, 20),
      estimacionClienteCapaId: "capa-bodega2-operativo",
      estimacionClienteCapa: { capa: "OPERATIVO" },
    },
    {
      id: "cobro-bodega2-privado",
      proyectoId: BODEGA,
      tipo: "PAGO_ESTIMACION",
      monto: dec(300000),
      fecha: fecha(10, 6),
      createdAt: fecha(10, 6),
      estimacionClienteCapaId: "capa-bodega2-privado",
      estimacionClienteCapa: { capa: "PRIVADO" },
    },
  ];
  return datos;
}

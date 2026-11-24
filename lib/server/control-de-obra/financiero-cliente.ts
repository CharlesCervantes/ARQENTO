import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { CapaEstimacion } from "@/lib/generated/prisma/enums";
import { formatMoney } from "@/lib/dinero";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { obtenerBrandingEmpresa, type BrandingEmpresa } from "@/lib/server/branding";
import {
  puedeVerFinancieroCliente,
  puedeVerFinancieroClienteOperativo,
  puedeRegistrarMovimientoFinancieroCliente,
  puedeRegistrarMovimientoFinancieroClienteOperativo,
} from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";
import {
  calcularImportesConcepto,
  calcularImportesOperativoConcepto,
  type PorcentajesDefaultProyecto,
} from "@/lib/control-de-obra/contrato-general";
import {
  capaRealDeEstimacion,
  saldoDisponible,
  situacionCobroCapa,
  type EstadoCobro,
} from "@/lib/control-de-obra/cobro-estimacion";
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

function suma(movs: { tipo: string; monto: Prisma.Decimal }[], tipo: string): number {
  return movs.filter((m) => m.tipo === tipo).reduce((t, m) => t + Number(m.monto), 0);
}

export type CapaValorizacion = "operativo" | "privado";

function aCapaEstimacion(capa: CapaValorizacion): CapaEstimacion {
  return capa === "privado" ? "PRIVADO" : "OPERATIVO";
}

// ---------------------------------------------------------------------------
// Una sola realidad de dinero — General/Privado, septiembre 2026. La capa
// Privada comparte la cantidad física con Operativo pero tiene su propio
// precio (04-modulo-control-de-obra.md §24) y es la única que puede contener
// "anticipos reales del cliente" (§32) — por eso, en cuanto una
// EstimacionCliente tiene AMBAS capas emitidas, la capa Privada pasa a ser la
// ÚNICA que puede recibir movimientos reales (PAGO_ESTIMACION/
// APLICACION_ESTIMACION): un mismo depósito bancario nunca debe registrarse
// dos veces (una por capa). Operativo, en ese caso, dejar de admitir sus
// propios movimientos y en su lugar PROYECTA el cobro real de Privado sobre
// su propio total (con tope — nunca más del 100% de lo que Operativo
// factura), sin crear un segundo movimiento (decisión de sesión, Cobros de
// cliente). Si la estimación nunca tuvo capa Privado emitida (la mayoría de
// los proyectos), Operativo sigue siendo la única capa real, exactamente
// como antes de este cambio.
async function obtenerCapaCobroReal(cliente: Cliente, estimacionClienteId: string): Promise<CapaEstimacion> {
  const privado = await cliente.estimacionClienteCapa.findFirst({
    where: { estimacionClienteId, capa: "PRIVADO", estatus: "EMITIDA" },
    select: { id: true },
  });
  return privado ? "PRIVADO" : "OPERATIVO";
}

// Cobro real de una estimación (E1 / Por cobrar, octubre 2026) — la fórmula
// vive en lib/control-de-obra/cobro-estimacion.ts (pura, una sola fuente
// para Control de Obra, validaciones e Inicio). Cobro real = movimientos
// VIGENTES de AMBAS capas de la estimación — incluidos los cobros de
// Operativo registrados antes de emitir Privado, que se leen tal cual (nunca
// se mueven ni se modifican). El saldo para cobros nuevos se mide contra el
// total de la capa real (Privado emitida si existe, si no Operativo).
//
// Debe llamarse con el lock del proyecto ya tomado (todas las rutas que
// escriben cobros toman `proyectos … FOR UPDATE` primero), para que dos
// registros simultáneos nunca validen contra el mismo saldo.
async function situacionCobroRealTx(tx: Cliente, estimacionClienteId: string) {
  const capas = await tx.estimacionClienteCapa.findMany({
    where: { estimacionClienteId },
    select: { id: true, capa: true, estatus: true, total: true },
  });
  const movimientos = await tx.movimientoFinancieroCliente.findMany({
    where: {
      estimacionClienteCapaId: { in: capas.map((c) => c.id) },
      estatus: "VIGENTE",
      tipo: { in: ["PAGO_ESTIMACION", "APLICACION_ESTIMACION"] },
    },
    select: { id: true, tipo: true, monto: true, fecha: true, createdAt: true },
  });
  const capaReal = capaRealDeEstimacion(capas);
  const totalReal = Number(capas.find((c) => c.capa === capaReal && c.estatus === "EMITIDA")?.total ?? 0);
  return { capaReal, totalReal, movimientos };
}

const MENSAJE_SIN_SALDO =
  "Esta estimación no tiene saldo pendiente: ya está cubierta o tiene cobros registrados por encima de su importe. Revisa su historial de cobros.";

// ---------------------------------------------------------------------------
// Aplicación de fondo contra una estimación (una capa) — toda obra se cobra
// por Estimación; el fondo es una fuente de recursos opcional (existe si el
// proyecto tiene al menos una APORTACION_FONDO) que puede cubrir total o
// parcialmente cualquier estimación EMITIDA de cualquier capa. El fondo en sí
// es efectivo real del proyecto — único, compartido por ambas capas, porque
// solo ingresó una vez: `disponible = Σ aportaciones − Σ aplicaciones de
// TODAS las capas`. Si General aplica $20,000, esos $20,000 dejan de estar
// disponibles también para Privado — intencional, no un efecto accidental
// (arquitectura por capas, agosto 2026). Se usa tanto automáticamente al
// emitir (si se elige la casilla) como manualmente desde "Aplicar fondo" en
// el historial — una sola implementación del cálculo. La validación y el
// consumo son transaccionales bajo el lock de fila de Proyecto (ver
// aplicarFondoAEstimacion/emitirEstimacion), así que dos aplicaciones
// concurrentes nunca pueden aplicar el mismo dinero dos veces.
// ---------------------------------------------------------------------------

export async function aplicarFondoAEstimacionTx(
  tx: Cliente,
  ctx: { empresaId: string; proyectoId: string; usuarioId: string },
  estimacionClienteCapaId: string,
  // undefined = aplicar el máximo posible; con valor = tope adicional.
  montoSolicitado?: number
): Promise<{ aplicado: number }> {
  // Aislamiento multiempresa — la capa debe pertenecer a la Empresa y al
  // proyecto del contexto, aunque los llamadores ya lo validen (función
  // exportada: nunca confía en un id suelto).
  const capaRow = await tx.estimacionClienteCapa.findFirstOrThrow({
    where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId: ctx.empresaId, proyectoId: ctx.proyectoId } },
  });

  const movimientosProyecto = await tx.movimientoFinancieroCliente.findMany({
    where: { proyectoId: ctx.proyectoId, empresaId: ctx.empresaId, estatus: "VIGENTE" },
    select: { tipo: true, monto: true, estimacionClienteCapaId: true },
  });
  // Fondo disponible del proyecto — SIEMPRE todas las capas juntas, nunca
  // particionado (ver comentario arriba).
  const disponible =
    suma(movimientosProyecto, "APORTACION_FONDO") - suma(movimientosProyecto, "APLICACION_ESTIMACION");
  if (disponible <= 0) return { aplicado: 0 };

  // Una sola realidad de dinero (ver obtenerCapaCobroReal) — si esta capa ya
  // no es la que recibe movimientos reales (existe una capa Privado emitida
  // hermana), no aplicar nada aquí. No es un error: esta función también la
  // llama emitirEstimacion automáticamente al emitir con "aplicar fondo"
  // marcado, y ese flujo nunca debe fallar por esto — simplemente no aplica
  // nada en la capa que ya dejó de ser la real.
  const capaReal = await obtenerCapaCobroReal(tx, capaRow.estimacionClienteId);
  if (capaRow.capa !== capaReal) return { aplicado: 0 };

  // Saldo REAL de la estimación (cobros vigentes de ambas capas) — nunca se
  // aplica fondo por encima de lo que realmente falta cobrar.
  const situacion = await situacionCobroRealTx(tx, capaRow.estimacionClienteId);
  const saldo = saldoDisponible(situacion.totalReal, situacion.movimientos);
  if (saldo <= 0) return { aplicado: 0 };

  const tope = montoSolicitado !== undefined ? Math.min(montoSolicitado, disponible) : disponible;
  const aplicar = Math.min(tope, saldo);
  if (aplicar <= 0) return { aplicado: 0 };

  const movimiento = await tx.movimientoFinancieroCliente.create({
    data: {
      empresaId: ctx.empresaId,
      proyectoId: ctx.proyectoId,
      tipo: "APLICACION_ESTIMACION",
      monto: aplicar,
      fecha: new Date(),
      estimacionClienteCapaId,
      registradoPorId: ctx.usuarioId,
    },
  });
  await registrarAuditoriaTx(tx, {
    empresaId: ctx.empresaId,
    usuarioId: ctx.usuarioId,
    entidad: "MovimientoFinancieroCliente",
    entidadId: movimiento.id,
    accion: "CREAR",
    valorNuevo: { tipo: "APLICACION_ESTIMACION", monto: aplicar, estimacionClienteCapaId },
  });
  return { aplicado: aplicar };
}

const MontoAplicacionSchema = z.coerce.number().positive("El monto debe ser mayor a cero.").optional();

function puedeRegistrarParaCapa(usuario: UsuarioSesion, capa: CapaEstimacion): boolean {
  return capa === "PRIVADO"
    ? puedeRegistrarMovimientoFinancieroCliente(usuario)
    : puedeRegistrarMovimientoFinancieroClienteOperativo(usuario);
}

export async function aplicarFondoAEstimacion(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string,
  montoCrudo?: unknown
): Promise<{ aplicado: number }> {
  const empresaId = requerirEmpresa(usuario);
  const monto = MontoAplicacionSchema.parse(montoCrudo);

  const referencia = await db.estimacionClienteCapa.findFirst({
    where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
    select: { capa: true, estimacionCliente: { select: { proyectoId: true } } },
  });
  if (!referencia) throw new RegistroNoEncontradoError("La estimación");
  if (!puedeRegistrarParaCapa(usuario, referencia.capa)) throw new SinPermisoError();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM proyectos WHERE id = ${referencia.estimacionCliente.proyectoId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM estimacion_cliente_capas WHERE id = ${estimacionClienteCapaId} FOR UPDATE`;

    const capaRow = await tx.estimacionClienteCapa.findFirst({
      where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
    });
    if (!capaRow) throw new RegistroNoEncontradoError("La estimación");
    if (capaRow.estatus !== "EMITIDA") {
      throw new ValidacionError("Solo se puede aplicar fondo a una estimación emitida.");
    }
    const capaReal = await obtenerCapaCobroReal(tx, capaRow.estimacionClienteId);
    if (capaRow.capa !== capaReal) {
      throw new ValidacionError(
        capaReal === "PRIVADO"
          ? "Esta estimación ya tiene su versión Privado emitida — aplica el fondo desde Cliente Priv."
          : "Aplica el fondo desde Cliente (versión Operativo)."
      );
    }

    const resultado = await aplicarFondoAEstimacionTx(
      tx,
      { empresaId, proyectoId: referencia.estimacionCliente.proyectoId, usuarioId: usuario.id },
      estimacionClienteCapaId,
      monto
    );
    if (resultado.aplicado === 0) {
      throw new ValidacionError("No hay fondo disponible, o esta estimación ya está cubierta.");
    }
    return resultado;
  });
}

// ---------------------------------------------------------------------------
// Control Contractual — resumen de proyecto, sin acumulados persistidos.
// Existe tanto en Cliente (capa "operativo") como en Cliente Priv. (capa
// "privado"). `avanceContractual` varía según `capa` (monto de contrato,
// total estimado, saldo, % avance). `financiero` es la realidad de cobro de
// ESA MISMA capa — pagos/aplicaciones registrados contra estimaciones de esa
// capa, comparados contra el total emitido de esa misma capa (arquitectura
// por capas, agosto 2026: cada capa tiene su propio saldo independiente,
// nunca ancorado a la otra). El único dato realmente compartido entre capas
// es el fondo (`financiero.fondo`) — efectivo real del proyecto, ver
// aplicarFondoAEstimacionTx. `financiero` es `null` si el usuario no tiene
// permiso para verlo en esta capa.
// ---------------------------------------------------------------------------

export type CorteHistorico = {
  fechaCorte: Date;
  hastaSemanaFechaInicio: Date;
  montoContrato: number;
};

export type ControlContractual = {
  proyecto: {
    nombre: string;
    esquemaContractual: EsquemaContractual | null;
    fechaInicio: string | null;
  };
  avanceContractual: {
    montoContrato: number;
    // Trabajos contractuales estimados (acumulado de subtotal +
    // montoAdministracionTrabajos de las capas EMITIDA) — misma base que
    // montoContrato, nunca incluye gastos cobrables/administración de
    // gastos/IVA (ver totalTrabajosEmitidoPorCapa).
    trabajosEstimados: number;
    saldoPorEjercer: number;
    porcentajeEjercido: number;
  };
  financiero: {
    totalCubierto: number;
    pendienteFinancieroReal: number;
    fondo: { aportado: number; aplicado: number; disponible: number } | null;
  } | null;
};

// Exportada para el dashboard ejecutivo (Inicio) — mismo cálculo, ninguna
// fórmula nueva (agosto 2026).
export async function calcularMontoContrato(
  proyectoId: string,
  esquemaContractual: EsquemaContractual | null,
  porcentajesDefault: PorcentajesDefaultProyecto,
  capa: CapaValorizacion
): Promise<number> {
  const conceptos = await db.concepto.findMany({
    where: { partida: { proyectoId }, estatus: "ACTIVO" },
    select: {
      cantidadContratada: true,
      cantidadContratadaPrivado: true,
      precioUnitarioContratista: true,
      precioUnitarioContratistaPrivado: true,
      precioUnitarioMateriales: true,
      precioUnitarioIndirectos: true,
      precioUnitarioHerramienta: true,
      porcentajeUtilidad: true,
      porcentajeAdministracion: true,
    },
  });

  return conceptos.reduce((total, c) => {
    const cantidadContratada = Number(c.cantidadContratada);
    if (capa === "privado") {
      // El Privado usa su propia cantidad presupuestada cuando existe (mismo
      // criterio que su estimación por capa, noviembre 2026).
      const cantidadContratada = Number(c.cantidadContratadaPrivado ?? c.cantidadContratada);
      const importes = calcularImportesConcepto(
        {
          precioUnitarioContratista: numOrNull(c.precioUnitarioContratista),
          precioUnitarioContratistaPrivado: numOrNull(c.precioUnitarioContratistaPrivado),
          precioUnitarioMateriales: numOrNull(c.precioUnitarioMateriales),
          precioUnitarioIndirectos: numOrNull(c.precioUnitarioIndirectos),
          precioUnitarioHerramienta: numOrNull(c.precioUnitarioHerramienta),
          porcentajeUtilidad: numOrNull(c.porcentajeUtilidad),
          porcentajeAdministracion: numOrNull(c.porcentajeAdministracion),
          cantidadContratada,
        },
        esquemaContractual,
        porcentajesDefault
      );
      return total + importes.importeTotal;
    }
    const importes = calcularImportesOperativoConcepto(
      {
        precioUnitarioContratista: numOrNull(c.precioUnitarioContratista),
        precioUnitarioMateriales: numOrNull(c.precioUnitarioMateriales),
        porcentajeAdministracion: numOrNull(c.porcentajeAdministracion),
        cantidadContratada,
      },
      esquemaContractual,
      porcentajesDefault.administracion
    );
    return total + importes.importeTotal;
  }, 0);
}

// Total completo emitido (trabajos + gastos cobrables + administración de
// ambos + IVA) — SOLO para la situación financiera real / pendiente de
// cobro (lo que el cliente realmente debe cubrir). Nunca se compara contra
// montoContrato, que no incluye gastos ni IVA (ver totalTrabajosEmitidoPorCapa
// para el avance contractual, septiembre 2026 — misma base económica).
async function totalEmitidoPorCapa(
  proyectoId: string,
  capa: CapaEstimacion,
  hastaSemanaFechaInicio?: Date
): Promise<number> {
  const r = await db.estimacionClienteCapa.aggregate({
    where: {
      capa,
      estatus: "EMITIDA",
      estimacionCliente: {
        proyectoId,
        ...(hastaSemanaFechaInicio && { semana: { fechaInicio: { lte: hastaSemanaFechaInicio } } }),
      },
    },
    _sum: { total: true },
  });
  return Number(r._sum.total ?? 0);
}

// Trabajos contractuales estimados (subtotal + administración de trabajos
// ÚNICAMENTE) — misma composición exacta que calcularMontoContrato, así que
// es la única base válida para comparar contra el monto del contrato
// (avance contractual). Deliberadamente EXCLUYE gastos cobrables,
// administración sobre gastos e IVA — esos no consumen saldo contractual,
// solo forman parte de lo que se le cobra al cliente (situación financiera,
// arriba). Sin esta separación, una estimación de puro gasto (sin trabajos)
// infla el % de avance contractual artificialmente (septiembre 2026 —
// corrección de base económica).
async function totalTrabajosEmitidoPorCapa(
  proyectoId: string,
  capa: CapaEstimacion,
  hastaSemanaFechaInicio?: Date
): Promise<number> {
  const r = await db.estimacionClienteCapa.aggregate({
    where: {
      capa,
      estatus: "EMITIDA",
      estimacionCliente: {
        proyectoId,
        ...(hastaSemanaFechaInicio && { semana: { fechaInicio: { lte: hastaSemanaFechaInicio } } }),
      },
    },
    _sum: { subtotal: true, montoAdministracionTrabajos: true },
  });
  return Number(r._sum.subtotal ?? 0) + Number(r._sum.montoAdministracionTrabajos ?? 0);
}

export type EstimacionConCorte = {
  id: string;
  capa: CapaEstimacion;
  proyectoId: string;
  semanaId: string;
  numero: number;
  emitidoEn: Date | null;
  semanaFechaInicio: Date;
  semanaNumero: number;
  semanaAnio: number;
  corte: CorteHistorico;
  // Identidad de Empresa congelada al momento en que este documento se
  // generó por primera vez. Null solo si la capa fue emitida antes de que
  // este campo existiera (documento histórico previo a este cambio).
  branding: BrandingEmpresa | null;
};

// Fija (una sola vez, la primera vez que ESTA capa pide su documento) el
// instante de corte del ledger financiero y el monto del contrato de esta
// capa — lo mínimo que hace falta congelar para que el documento histórico
// sea reproducible para siempre. Independiente por capa (arquitectura por
// capas, agosto 2026): emitir/descargar Privado nunca fija ni modifica el
// corte de General. Si ya estaba fijado, lo devuelve tal cual.
export async function obtenerOFijarCorteDocumento(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string
): Promise<EstimacionConCorte> {
  const empresaId = requerirEmpresa(usuario);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM estimacion_cliente_capas WHERE id = ${estimacionClienteCapaId} FOR UPDATE`;

    const capaRow = await tx.estimacionClienteCapa.findFirst({
      where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
      include: {
        estimacionCliente: {
          include: {
            semana: { select: { fechaInicio: true, numero: true, anio: true } },
            proyecto: {
              select: {
                esquemaContractual: true,
                porcentajeUtilidadDefault: true,
                porcentajeAdministracionDefault: true,
                porcentajeAdministracionPrivadoDefault: true,
              },
            },
          },
        },
      },
    });
    if (!capaRow) throw new RegistroNoEncontradoError("La estimación");
    if (capaRow.estatus !== "EMITIDA") {
      throw new ValidacionError("Solo se puede generar el documento de una estimación emitida.");
    }

    let fechaCorteDocumento = capaRow.fechaCorteDocumento;
    let montoContrato = numOrNull(capaRow.montoContratoCongelado);
    let brandingSnapshot = capaRow.brandingSnapshot as BrandingEmpresa | null;

    if (!fechaCorteDocumento) {
      const { estimacionCliente } = capaRow;
      const porcentajesDefault: PorcentajesDefaultProyecto = {
        utilidad: numOrNull(estimacionCliente.proyecto.porcentajeUtilidadDefault),
        administracion: numOrNull(estimacionCliente.proyecto.porcentajeAdministracionDefault),
        administracionPrivado: numOrNull(estimacionCliente.proyecto.porcentajeAdministracionPrivadoDefault),
      };
      montoContrato = await calcularMontoContrato(
        estimacionCliente.proyectoId,
        estimacionCliente.proyecto.esquemaContractual,
        porcentajesDefault,
        capaRow.capa === "PRIVADO" ? "privado" : "operativo"
      );
      fechaCorteDocumento = new Date();
      // Identidad de Empresa AL MOMENTO en que este documento se genera por
      // primera vez — mismo criterio de congelamiento que montoContratoCongelado,
      // nunca se recalcula después (branding histórico, Portal Master).
      brandingSnapshot = await obtenerBrandingEmpresa(empresaId);
      await tx.estimacionClienteCapa.update({
        where: { id: estimacionClienteCapaId },
        data: { fechaCorteDocumento, montoContratoCongelado: montoContrato, brandingSnapshot },
      });
    }

    return {
      id: capaRow.id,
      capa: capaRow.capa,
      proyectoId: capaRow.estimacionCliente.proyectoId,
      semanaId: capaRow.estimacionCliente.semanaId,
      numero: capaRow.numero!,
      emitidoEn: capaRow.emitidoEn,
      semanaFechaInicio: capaRow.estimacionCliente.semana.fechaInicio,
      semanaNumero: capaRow.estimacionCliente.semana.numero,
      semanaAnio: capaRow.estimacionCliente.semana.anio,
      corte: {
        fechaCorte: fechaCorteDocumento,
        hastaSemanaFechaInicio: capaRow.estimacionCliente.semana.fechaInicio,
        montoContrato: montoContrato!,
      },
      branding: brandingSnapshot,
    };
  });
}

export async function obtenerControlContractual(
  usuario: UsuarioSesion,
  proyectoId: string,
  capa: CapaValorizacion,
  corte?: CorteHistorico
): Promise<ControlContractual> {
  const proyecto = await obtenerProyecto(usuario, proyectoId);
  const porcentajesDefault: PorcentajesDefaultProyecto = {
    utilidad: numOrNull(proyecto.porcentajeUtilidadDefault),
    administracion: numOrNull(proyecto.porcentajeAdministracionDefault),
    administracionPrivado: numOrNull(proyecto.porcentajeAdministracionPrivadoDefault),
  };
  const capaEnum = aCapaEstimacion(capa);

  const puedeVerFinanciero =
    capa === "privado" ? puedeVerFinancieroCliente(usuario) : puedeVerFinancieroClienteOperativo(usuario);
  const hastaSemanaFechaInicio = corte?.hastaSemanaFechaInicio;

  const [montoContrato, totalEmitidoCapa, trabajosEstimados, movimientosProyecto, capasEstaCapa] = await Promise.all([
    corte
      ? Promise.resolve(corte.montoContrato)
      : calcularMontoContrato(proyectoId, proyecto.esquemaContractual, porcentajesDefault, capa),
    totalEmitidoPorCapa(proyectoId, capaEnum, hastaSemanaFechaInicio),
    totalTrabajosEmitidoPorCapa(proyectoId, capaEnum, hastaSemanaFechaInicio),
    db.movimientoFinancieroCliente.findMany({
      where: { proyectoId, estatus: "VIGENTE", ...(corte && { createdAt: { lte: corte.fechaCorte } }) },
      select: { tipo: true, monto: true },
    }),
    // Cobro real por estimación de esta capa: los movimientos vigentes de
    // TODAS las capas de su estimación (ver situacionCobroCapa).
    db.estimacionClienteCapa.findMany({
      where: {
        capa: capaEnum,
        estatus: "EMITIDA",
        estimacionCliente: {
          proyectoId,
          ...(corte && { semana: { fechaInicio: { lte: corte.hastaSemanaFechaInicio } } }),
        },
      },
      select: {
        total: true,
        estimacionCliente: { select: { capas: selectCapasConCobros(corte) } },
      },
    }),
  ]);

  // Avance contractual — SOLO trabajos, misma base que montoContrato. Nunca
  // usa totalEmitidoCapa (ese incluye gastos cobrables/administración de
  // gastos/IVA, que no consumen saldo contractual — ver comentario en
  // totalTrabajosEmitidoPorCapa).
  const saldoPorEjercer = montoContrato - trabajosEstimados;
  const porcentajeEjercido = montoContrato > 0 ? (trabajosEstimados / montoContrato) * 100 : 0;

  let financiero: ControlContractual["financiero"] = null;
  if (puedeVerFinanciero) {
    // Fondo — proyecto-wide, todas las capas juntas (efectivo real, único).
    const aportado = suma(movimientosProyecto, "APORTACION_FONDO");
    const aplicadoTotalProyecto = suma(movimientosProyecto, "APLICACION_ESTIMACION");

    // Situación financiera de ESTA capa — suma, estimación por estimación,
    // el mismo cálculo que usa el historial (una sola fórmula, ver
    // situacionCobroCapa) para que ambas pantallas nunca
    // puedan mostrar números distintos del mismo hecho.
    let totalCubierto = 0;
    for (const c of capasEstaCapa) {
      const { aplicadoFondo, pagoDirecto } = situacionCobroCapa(capaEnum, Number(c.total), aCapasDeEstimacion(c.estimacionCliente.capas));
      totalCubierto += aplicadoFondo + pagoDirecto;
    }

    financiero = {
      totalCubierto,
      pendienteFinancieroReal: totalEmitidoCapa - totalCubierto,
      fondo: aportado > 0 ? { aportado, aplicado: aplicadoTotalProyecto, disponible: aportado - aplicadoTotalProyecto } : null,
    };
  }

  return {
    proyecto: {
      nombre: proyecto.nombre,
      esquemaContractual: proyecto.esquemaContractual,
      fechaInicio: proyecto.fechaInicio?.toISOString() ?? null,
    },
    avanceContractual: {
      montoContrato,
      trabajosEstimados,
      saldoPorEjercer,
      porcentajeEjercido,
    },
    financiero,
  };
}

// ---------------------------------------------------------------------------
// Historial semanal — una fila por EstimacionClienteCapa EMITIDA de la capa
// pedida. Estado siempre derivado de los movimientos de ESA capa, nunca
// persistido ni anclado a la otra capa.
// ---------------------------------------------------------------------------

export type EstadoPagoEstimacion = EstadoCobro;

export type FilaHistorialEstimacion = {
  id: string;
  numero: number;
  semanaNumero: number;
  semanaAnio: number;
  importe: number;
  emitidoEn: string | null;
  financiero: {
    aplicadoFondo: number;
    pagoDirecto: number;
    pendiente: number;
    estado: EstadoPagoEstimacion;
    // Cobros registrados por encima del total real de la estimación (> 0 =
    // sobrecobro histórico). Solo en la capa real — en Operativo con Privado
    // emitida siempre es 0 (el excedente sería información privada).
    sobrecobro: number;
  } | null;
};

// Capas de una estimación con sus cobros vigentes (respetando el corte de un
// documento histórico) — insumo de situacionCobroCapa.
function selectCapasConCobros(corte?: CorteHistorico) {
  return {
    select: {
      capa: true,
      estatus: true,
      total: true,
      movimientosFinancieros: {
        select: { id: true, tipo: true, monto: true, fecha: true, createdAt: true },
        where: { estatus: "VIGENTE" as const, ...(corte && { createdAt: { lte: corte.fechaCorte } }) },
      },
    },
  };
}

function aCapasDeEstimacion(
  capas: {
    capa: CapaEstimacion;
    estatus: string;
    total: Prisma.Decimal;
    movimientosFinancieros: { id: string; tipo: string; monto: Prisma.Decimal; fecha: Date; createdAt: Date }[];
  }[]
) {
  return capas.map((c) => ({ capa: c.capa, estatus: c.estatus, total: Number(c.total), movimientos: c.movimientosFinancieros }));
}

export async function obtenerHistorialEstimacionesCliente(
  usuario: UsuarioSesion,
  proyectoId: string,
  capa: CapaValorizacion,
  corte?: CorteHistorico
): Promise<FilaHistorialEstimacion[]> {
  await obtenerProyecto(usuario, proyectoId);
  const puedeVerFinanciero =
    capa === "privado" ? puedeVerFinancieroCliente(usuario) : puedeVerFinancieroClienteOperativo(usuario);
  const capaEnum = aCapaEstimacion(capa);

  const capas = await db.estimacionClienteCapa.findMany({
    where: {
      capa: capaEnum,
      estatus: "EMITIDA",
      estimacionCliente: {
        proyectoId,
        ...(corte && { semana: { fechaInicio: { lte: corte.hastaSemanaFechaInicio } } }),
      },
    },
    include: {
      // Todas las capas de la estimación con sus cobros vigentes — el cobro
      // real es uno solo por estimación (ver situacionCobroCapa).
      estimacionCliente: {
        include: {
          semana: { select: { numero: true, anio: true, fechaInicio: true } },
          capas: selectCapasConCobros(corte),
        },
      },
    },
    orderBy: { estimacionCliente: { semana: { fechaInicio: "asc" } } },
  });

  return capas.map((c) => {
    const importe = Number(c.total);

    let financiero: FilaHistorialEstimacion["financiero"] = null;
    if (puedeVerFinanciero) {
      financiero = situacionCobroCapa(capaEnum, importe, aCapasDeEstimacion(c.estimacionCliente.capas));
    }

    return {
      id: c.id,
      numero: c.numero!,
      semanaNumero: c.estimacionCliente.semana.numero,
      semanaAnio: c.estimacionCliente.semana.anio,
      importe,
      emitidoEn: c.emitidoEn?.toISOString() ?? null,
      financiero,
    };
  });
}

// ---------------------------------------------------------------------------
// Aportaciones al fondo — solo aumentan lo disponible; nunca aplican nada
// por sí solas.
// ---------------------------------------------------------------------------

export type FilaAportacionFondo = {
  id: string;
  fecha: string;
  referencia: string | null;
  notas: string | null;
  monto: number;
  registradoPorNombre: string;
  estatus: "VIGENTE" | "CANCELADO";
  motivoCancelacion: string | null;
};

export async function obtenerAportacionesFondo(
  usuario: UsuarioSesion,
  proyectoId: string
): Promise<FilaAportacionFondo[]> {
  // El fondo es una sola cifra compartida por ambas capas (no hay un "fondo
  // operativo" distinto de un "fondo privado"). Se usa el gate operativo
  // (superset del privado) para que la página Cliente normal, que ya decide
  // mostrar este bloque sin Vista privada, no choque aquí con un gate más
  // estricto.
  if (!puedeVerFinancieroClienteOperativo(usuario)) throw new SinPermisoError();
  await obtenerProyecto(usuario, proyectoId);

  // Se listan también las CANCELADAS (nunca se borran) para trazabilidad —
  // los cálculos de fondo disponible (aplicarFondoAEstimacionTx/
  // obtenerControlContractual) son los que las ignoran, no esta lista.
  const aportaciones = await db.movimientoFinancieroCliente.findMany({
    where: { proyectoId, tipo: "APORTACION_FONDO" },
    include: { registradoPor: { select: { nombre: true } } },
    orderBy: { fecha: "desc" },
  });

  return aportaciones.map((a) => ({
    id: a.id,
    fecha: a.fecha.toISOString(),
    referencia: a.referencia,
    notas: a.notas,
    monto: Number(a.monto),
    registradoPorNombre: a.registradoPor.nombre,
    estatus: a.estatus,
    motivoCancelacion: a.motivoCancelacion,
  }));
}

const DatosMovimientoSchema = z.object({
  monto: z.coerce.number().positive("El monto debe ser mayor a cero."),
  fecha: z.coerce.date(),
  referencia: z.string().trim().optional().nullable(),
  notas: z.string().trim().optional().nullable(),
  // Decoración fiscal opcional — captura en el mismo paso (Cobros de
  // cliente, septiembre 2026). Nunca bloquean el registro del cobro si no se
  // tienen todavía: se completan después desde Contabilidad.
  cuentaReceptoraId: z.string().trim().optional().nullable(),
  comprobanteRef: z.string().trim().optional().nullable(),
  comprobanteNombre: z.string().trim().optional().nullable(),
  facturaEsperada: z.coerce.boolean().optional().default(false),
});

// Crea la decoración Ingreso (Contabilidad) en la MISMA transacción que el
// movimiento real, solo si se capturó al menos un dato fiscal — nunca una
// fila vacía. Nunca se llama para APLICACION_ESTIMACION (no es dinero nuevo
// entrando, ver comentario en aplicarFondoAEstimacionTx) para no generar un
// segundo Ingreso del mismo depósito real.
async function crearDecoracionIngresoSiAplica(
  tx: Cliente,
  ctx: { empresaId: string; movimientoFinancieroClienteId: string; registradoPorId: string },
  datos: {
    cuentaReceptoraId?: string | null;
    comprobanteRef?: string | null;
    comprobanteNombre?: string | null;
    facturaEsperada?: boolean;
  }
): Promise<void> {
  const hayDatosFiscales = !!(datos.cuentaReceptoraId || datos.comprobanteRef || datos.facturaEsperada);
  if (!hayDatosFiscales) return;
  await tx.ingreso.create({
    data: {
      empresaId: ctx.empresaId,
      movimientoFinancieroClienteId: ctx.movimientoFinancieroClienteId,
      cuentaReceptoraId: datos.cuentaReceptoraId || null,
      comprobanteRef: datos.comprobanteRef || null,
      comprobanteNombre: datos.comprobanteNombre || null,
      facturaEsperada: datos.facturaEsperada ?? false,
      registradoPorId: ctx.registradoPorId,
    },
  });
}

export async function registrarAportacionFondo(
  usuario: UsuarioSesion,
  proyectoId: string,
  datosCrudos: unknown
) {
  if (!puedeRegistrarMovimientoFinancieroCliente(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosMovimientoSchema.parse(datosCrudos);
  await obtenerProyecto(usuario, proyectoId);

  return db.$transaction(async (tx) => {
    const movimiento = await tx.movimientoFinancieroCliente.create({
      data: {
        empresaId,
        proyectoId,
        tipo: "APORTACION_FONDO",
        monto: datos.monto,
        fecha: datos.fecha,
        referencia: datos.referencia || null,
        notas: datos.notas || null,
        registradoPorId: usuario.id,
      },
    });

    // APORTACION_FONDO es donde el dinero real entra a la Empresa — es el
    // único momento en que este anticipo/depósito tiene cuenta receptora y
    // comprobante propios (Cobros de cliente, septiembre 2026).
    await crearDecoracionIngresoSiAplica(tx, { empresaId, movimientoFinancieroClienteId: movimiento.id, registradoPorId: usuario.id }, datos);

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimiento.id,
      accion: "CREAR",
      valorNuevo: { tipo: "APORTACION_FONDO", monto: datos.monto, fecha: datos.fecha.toISOString() },
    });

    return movimiento;
  });
}

// ---------------------------------------------------------------------------
// Registrar pago directo de una estimación (una capa) — el saldo pendiente
// descuenta tanto aplicaciones de fondo como pagos ya registrados de ESA
// MISMA capa (una capa puede tener ambos a la vez, independiente de la
// otra). Toma el lock del proyecto además del de la propia capa: el saldo
// depende de aplicaciones de fondo que "Aplicar fondo" también escribe bajo
// el lock del proyecto.
// ---------------------------------------------------------------------------

export async function registrarPagoEstimacion(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosMovimientoSchema.parse(datosCrudos);

  const referencia = await db.estimacionClienteCapa.findFirst({
    where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
    select: { capa: true, estimacionCliente: { select: { proyectoId: true } } },
  });
  if (!referencia) throw new RegistroNoEncontradoError("La estimación");
  if (!puedeRegistrarParaCapa(usuario, referencia.capa)) throw new SinPermisoError();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM proyectos WHERE id = ${referencia.estimacionCliente.proyectoId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM estimacion_cliente_capas WHERE id = ${estimacionClienteCapaId} FOR UPDATE`;

    const capaRow = await tx.estimacionClienteCapa.findFirst({
      where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
    });
    if (!capaRow) throw new RegistroNoEncontradoError("La estimación");
    if (capaRow.estatus !== "EMITIDA") {
      throw new ValidacionError("Solo se pueden registrar pagos sobre una estimación emitida.");
    }
    const capaReal = await obtenerCapaCobroReal(tx, capaRow.estimacionClienteId);
    if (capaRow.capa !== capaReal) {
      throw new ValidacionError(
        capaReal === "PRIVADO"
          ? "Esta estimación ya tiene su versión Privado emitida — registra el pago desde Cliente Priv."
          : "Registra el pago desde Cliente (versión Operativo)."
      );
    }

    // Saldo REAL de la estimación (cobros vigentes de ambas capas, bajo el
    // lock del proyecto) — esta capa es la real, así que el saldo nunca
    // revela nada que el usuario no pueda ver.
    const situacion = await situacionCobroRealTx(tx, capaRow.estimacionClienteId);
    const saldoPendiente = saldoDisponible(situacion.totalReal, situacion.movimientos);

    if (saldoPendiente <= 0) throw new ValidacionError(MENSAJE_SIN_SALDO);
    if (datos.monto > saldoPendiente) {
      throw new ValidacionError(`El pago excede el saldo pendiente (${formatMoney(saldoPendiente)}).`);
    }

    const movimiento = await tx.movimientoFinancieroCliente.create({
      data: {
        empresaId,
        proyectoId: referencia.estimacionCliente.proyectoId,
        tipo: "PAGO_ESTIMACION",
        monto: datos.monto,
        fecha: datos.fecha,
        referencia: datos.referencia || null,
        notas: datos.notas || null,
        estimacionClienteCapaId,
        registradoPorId: usuario.id,
      },
    });

    await crearDecoracionIngresoSiAplica(tx, { empresaId, movimientoFinancieroClienteId: movimiento.id, registradoPorId: usuario.id }, datos);

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimiento.id,
      accion: "CREAR",
      valorNuevo: { tipo: "PAGO_ESTIMACION", monto: datos.monto, estimacionClienteCapaId },
    });

    return movimiento;
  });
}

// ---------------------------------------------------------------------------
// Editar / cancelar movimientos — nunca DELETE (Cobros de cliente, septiembre
// 2026). Metadata (referencia/notas/fecha/decoración fiscal) se corrige
// libremente, auditada con antes/después. El monto es financiero: se
// re-valida exactamente como si se registrara de nuevo, y se BLOQUEA si ya
// existen dependientes que la corrección dejaría inconsistentes (en vez de
// permitir cualquier cosa) — se exige cancelar y registrar de nuevo en ese
// caso, igual que pide la integridad del ledger.
// ---------------------------------------------------------------------------

const DatosEditarMetadataSchema = z.object({
  fecha: z.coerce.date().optional(),
  referencia: z.string().trim().optional().nullable(),
  notas: z.string().trim().optional().nullable(),
  cuentaReceptoraId: z.string().trim().optional().nullable(),
  comprobanteRef: z.string().trim().optional().nullable(),
  comprobanteNombre: z.string().trim().optional().nullable(),
  facturaEsperada: z.coerce.boolean().optional(),
});

// Upsert PARCIAL — a diferencia de guardarDecoracionIngreso (Contabilidad,
// formulario completo con reemplazo total), aquí solo se tocan las claves
// realmente enviadas (undefined = "no tocar"), para no pisar accidentalmente
// datos fiscales capturados en otro momento (mismo cuidado que
// vincularFacturaAGasto/vincularFacturaAIngreso, Contabilidad).
async function actualizarDecoracionIngresoParcial(
  tx: Cliente,
  ctx: { empresaId: string; movimientoFinancieroClienteId: string; registradoPorId: string },
  cambios: {
    cuentaReceptoraId?: string | null;
    comprobanteRef?: string | null;
    comprobanteNombre?: string | null;
    facturaEsperada?: boolean;
  }
): Promise<void> {
  const hayCambios = Object.values(cambios).some((v) => v !== undefined);
  if (!hayCambios) return;
  const datos = {
    cuentaReceptoraId: cambios.cuentaReceptoraId === undefined ? undefined : cambios.cuentaReceptoraId || null,
    comprobanteRef: cambios.comprobanteRef === undefined ? undefined : cambios.comprobanteRef || null,
    comprobanteNombre: cambios.comprobanteNombre === undefined ? undefined : cambios.comprobanteNombre || null,
    facturaEsperada: cambios.facturaEsperada,
  };
  await tx.ingreso.upsert({
    where: { movimientoFinancieroClienteId: ctx.movimientoFinancieroClienteId },
    update: datos,
    create: {
      empresaId: ctx.empresaId,
      movimientoFinancieroClienteId: ctx.movimientoFinancieroClienteId,
      registradoPorId: ctx.registradoPorId,
      cuentaReceptoraId: datos.cuentaReceptoraId ?? null,
      comprobanteRef: datos.comprobanteRef ?? null,
      comprobanteNombre: datos.comprobanteNombre ?? null,
      facturaEsperada: datos.facturaEsperada ?? false,
    },
  });
}

// Metadata de un PAGO_ESTIMACION — fecha/referencia/notas/decoración fiscal.
// Nunca el monto (ver editarMontoPagoEstimacion).
export async function editarPagoEstimacion(usuario: UsuarioSesion, movimientoId: string, datosCrudos: unknown) {
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosEditarMetadataSchema.parse(datosCrudos);

  const movimiento = await db.movimientoFinancieroCliente.findFirst({
    where: { id: movimientoId, empresaId, tipo: "PAGO_ESTIMACION" },
    include: { estimacionClienteCapa: { select: { capa: true } } },
  });
  if (!movimiento || !movimiento.estimacionClienteCapa) throw new RegistroNoEncontradoError("El pago");
  if (movimiento.estatus === "CANCELADO") throw new ValidacionError("Este pago está cancelado — no se puede editar.");
  if (!puedeRegistrarParaCapa(usuario, movimiento.estimacionClienteCapa.capa)) throw new SinPermisoError();

  const anterior = { fecha: movimiento.fecha.toISOString(), referencia: movimiento.referencia, notas: movimiento.notas };

  await db.$transaction(async (tx) => {
    await tx.movimientoFinancieroCliente.update({
      where: { id: movimientoId },
      data: {
        ...(datos.fecha !== undefined && { fecha: datos.fecha }),
        ...(datos.referencia !== undefined && { referencia: datos.referencia || null }),
        ...(datos.notas !== undefined && { notas: datos.notas || null }),
      },
    });
    await actualizarDecoracionIngresoParcial(tx, { empresaId, movimientoFinancieroClienteId: movimientoId, registradoPorId: usuario.id }, datos);
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimientoId,
      accion: "EDITAR",
      valorAnterior: anterior,
      valorNuevo: {
        fecha: (datos.fecha ?? movimiento.fecha).toISOString(),
        referencia: datos.referencia !== undefined ? datos.referencia || null : anterior.referencia,
        notas: datos.notas !== undefined ? datos.notas || null : anterior.notas,
      },
    });
  });
}

// Monto de un PAGO_ESTIMACION — se re-valida exactamente como al registrar
// (nunca puede superar el saldo de la capa, calculado excluyendo este mismo
// movimiento).
export async function editarMontoPagoEstimacion(usuario: UsuarioSesion, movimientoId: string, montoCrudo: unknown) {
  const empresaId = requerirEmpresa(usuario);
  const nuevoMonto = z.coerce.number().positive("El monto debe ser mayor a cero.").parse(montoCrudo);

  const movimiento = await db.movimientoFinancieroCliente.findFirst({
    where: { id: movimientoId, empresaId, tipo: "PAGO_ESTIMACION" },
    include: { estimacionClienteCapa: { select: { capa: true } } },
  });
  if (!movimiento || !movimiento.estimacionClienteCapaId || !movimiento.estimacionClienteCapa) {
    throw new RegistroNoEncontradoError("El pago");
  }
  if (movimiento.estatus === "CANCELADO") throw new ValidacionError("Este pago está cancelado — no se puede editar.");
  if (!puedeRegistrarParaCapa(usuario, movimiento.estimacionClienteCapa.capa)) throw new SinPermisoError();

  return db.$transaction(async (tx) => {
    // Mismo orden de bloqueo que registrar/aplicar fondo (proyecto primero,
    // luego la capa): un cobro de Operativo histórico y uno nuevo en Privado
    // de la misma estimación nunca validan a la vez contra el mismo saldo.
    await tx.$queryRaw`SELECT id FROM proyectos WHERE id = ${movimiento.proyectoId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM estimacion_cliente_capas WHERE id = ${movimiento.estimacionClienteCapaId} FOR UPDATE`;
    const vigente = await tx.movimientoFinancieroCliente.findFirst({ where: { id: movimientoId, estatus: "VIGENTE" } });
    if (!vigente) throw new ValidacionError("Este pago está cancelado — no se puede editar.");
    const capaRow = await tx.estimacionClienteCapa.findFirstOrThrow({ where: { id: movimiento.estimacionClienteCapaId! } });

    // Saldo REAL de la estimación sin este movimiento (ambas capas).
    const situacion = await situacionCobroRealTx(tx, capaRow.estimacionClienteId);
    const saldoSinEste = saldoDisponible(situacion.totalReal, situacion.movimientos, movimientoId);
    // Reducir un cobro siempre se permite (nunca agrega dinero, aunque la
    // estimación ya tenga un sobrecobro histórico).
    if (nuevoMonto > saldoSinEste && nuevoMonto > Number(vigente.monto)) {
      // Si el saldo se mide contra la capa Privado y el usuario no tiene
      // acceso a ella (p. ej. corrige un cobro histórico de Operativo), el
      // mensaje nunca incluye el monto: lo revelaría.
      const puedeVerSaldo = situacion.capaReal === "OPERATIVO" || puedeRegistrarParaCapa(usuario, "PRIVADO");
      throw new ValidacionError(
        puedeVerSaldo
          ? `El nuevo monto excede el saldo disponible (${formatMoney(Math.max(0, saldoSinEste))}). Cancela este pago y registra uno nuevo si necesitas otra cifra.`
          : "El nuevo monto excede el saldo disponible de la estimación. Cancela este pago y registra uno nuevo si necesitas otra cifra."
      );
    }
    await tx.movimientoFinancieroCliente.update({ where: { id: movimientoId }, data: { monto: nuevoMonto } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimientoId,
      accion: "EDITAR",
      valorAnterior: { monto: Number(movimiento.monto) },
      valorNuevo: { monto: nuevoMonto },
    });
  });
}

// Metadata de una APORTACION_FONDO.
export async function editarAportacionFondo(usuario: UsuarioSesion, movimientoId: string, datosCrudos: unknown) {
  if (!puedeRegistrarMovimientoFinancieroCliente(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosEditarMetadataSchema.parse(datosCrudos);

  const movimiento = await db.movimientoFinancieroCliente.findFirst({
    where: { id: movimientoId, empresaId, tipo: "APORTACION_FONDO" },
  });
  if (!movimiento) throw new RegistroNoEncontradoError("La aportación");
  if (movimiento.estatus === "CANCELADO") throw new ValidacionError("Esta aportación está cancelada — no se puede editar.");

  const anterior = { fecha: movimiento.fecha.toISOString(), referencia: movimiento.referencia, notas: movimiento.notas };

  await db.$transaction(async (tx) => {
    await tx.movimientoFinancieroCliente.update({
      where: { id: movimientoId },
      data: {
        ...(datos.fecha !== undefined && { fecha: datos.fecha }),
        ...(datos.referencia !== undefined && { referencia: datos.referencia || null }),
        ...(datos.notas !== undefined && { notas: datos.notas || null }),
      },
    });
    await actualizarDecoracionIngresoParcial(tx, { empresaId, movimientoFinancieroClienteId: movimientoId, registradoPorId: usuario.id }, datos);
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimientoId,
      accion: "EDITAR",
      valorAnterior: anterior,
      valorNuevo: {
        fecha: (datos.fecha ?? movimiento.fecha).toISOString(),
        referencia: datos.referencia !== undefined ? datos.referencia || null : anterior.referencia,
        notas: datos.notas !== undefined ? datos.notas || null : anterior.notas,
      },
    });
  });
}

// Monto de una APORTACION_FONDO — el fondo es compartido por ambas capas
// (ver aplicarFondoAEstimacionTx); reducirlo por debajo de lo ya aplicado
// dejaría aplicaciones sin respaldo real, así que se BLOQUEA en ese caso.
export async function editarMontoAportacionFondo(usuario: UsuarioSesion, movimientoId: string, montoCrudo: unknown) {
  if (!puedeRegistrarMovimientoFinancieroCliente(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const nuevoMonto = z.coerce.number().positive("El monto debe ser mayor a cero.").parse(montoCrudo);

  const movimiento = await db.movimientoFinancieroCliente.findFirst({
    where: { id: movimientoId, empresaId, tipo: "APORTACION_FONDO" },
  });
  if (!movimiento) throw new RegistroNoEncontradoError("La aportación");
  if (movimiento.estatus === "CANCELADO") throw new ValidacionError("Esta aportación está cancelada — no se puede editar.");

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM proyectos WHERE id = ${movimiento.proyectoId} FOR UPDATE`;
    const movimientosProyecto = await tx.movimientoFinancieroCliente.findMany({
      where: { proyectoId: movimiento.proyectoId, estatus: "VIGENTE" },
      select: { id: true, tipo: true, monto: true },
    });
    const aportadoSinEste = suma(movimientosProyecto.filter((m) => m.id !== movimientoId), "APORTACION_FONDO");
    const aplicadoTotal = suma(movimientosProyecto, "APLICACION_ESTIMACION");
    const nuevoDisponible = aportadoSinEste + nuevoMonto - aplicadoTotal;
    if (nuevoDisponible < 0) {
      throw new ValidacionError(
        "Esta aportación ya tiene aplicaciones de fondo hechas contra ella — cancela esas aplicaciones o registra la corrección como un nuevo movimiento en vez de reducir esta aportación."
      );
    }
    await tx.movimientoFinancieroCliente.update({ where: { id: movimientoId }, data: { monto: nuevoMonto } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimientoId,
      accion: "EDITAR",
      valorAnterior: { monto: Number(movimiento.monto) },
      valorNuevo: { monto: nuevoMonto },
    });
  });
}

const DatosCancelacionSchema = z.object({
  motivo: z.string().trim().min(3, "Indica un motivo para cancelar este movimiento."),
});

// Cancela cualquiera de los 3 tipos de movimiento — nunca DELETE. Bloquea
// cancelar una APORTACION_FONDO que ya tiene aplicaciones de fondo hechas
// contra ella (las dejaría sin respaldo real); PAGO_ESTIMACION y
// APLICACION_ESTIMACION nunca tienen dependientes (nada más los referencia),
// así que siempre pueden cancelarse.
export async function cancelarMovimientoFinancieroCliente(
  usuario: UsuarioSesion,
  movimientoId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosCancelacionSchema.parse(datosCrudos);

  const movimiento = await db.movimientoFinancieroCliente.findFirst({
    where: { id: movimientoId, empresaId },
    include: { estimacionClienteCapa: { select: { capa: true } } },
  });
  if (!movimiento) throw new RegistroNoEncontradoError("El movimiento");
  if (movimiento.estatus === "CANCELADO") throw new ValidacionError("Este movimiento ya está cancelado.");

  const puedeGestionar =
    movimiento.tipo === "APORTACION_FONDO"
      ? puedeRegistrarMovimientoFinancieroCliente(usuario)
      : puedeRegistrarParaCapa(usuario, movimiento.estimacionClienteCapa!.capa);
  if (!puedeGestionar) throw new SinPermisoError();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM proyectos WHERE id = ${movimiento.proyectoId} FOR UPDATE`;

    if (movimiento.tipo === "APORTACION_FONDO") {
      const movimientosProyecto = await tx.movimientoFinancieroCliente.findMany({
        where: { proyectoId: movimiento.proyectoId, estatus: "VIGENTE" },
        select: { id: true, tipo: true, monto: true },
      });
      const aportadoSinEste = suma(movimientosProyecto.filter((m) => m.id !== movimientoId), "APORTACION_FONDO");
      const aplicadoTotal = suma(movimientosProyecto, "APLICACION_ESTIMACION");
      if (aportadoSinEste - aplicadoTotal < 0) {
        throw new ValidacionError("Esta aportación ya tiene aplicaciones de fondo hechas contra ella — cancela primero esas aplicaciones.");
      }
    }

    await tx.movimientoFinancieroCliente.update({
      where: { id: movimientoId },
      data: { estatus: "CANCELADO", motivoCancelacion: datos.motivo, canceladoPorId: usuario.id, canceladoEn: new Date() },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "MovimientoFinancieroCliente",
      entidadId: movimientoId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "VIGENTE" },
      valorNuevo: { estatus: "CANCELADO", motivo: datos.motivo, tipo: movimiento.tipo, monto: Number(movimiento.monto) },
    });
  });
}

// ---------------------------------------------------------------------------
// Listado individual de pagos/aplicaciones de UNA capa — para poder
// editar/cancelar cada movimiento (el historial semanal solo trae el
// agregado por estimación, ver FilaHistorialEstimacion).
// ---------------------------------------------------------------------------

export type FilaMovimientoCapa = {
  id: string;
  tipo: "PAGO_ESTIMACION" | "APLICACION_ESTIMACION";
  fecha: string;
  monto: number;
  referencia: string | null;
  notas: string | null;
  estatus: "VIGENTE" | "CANCELADO";
  motivoCancelacion: string | null;
  registradoPorNombre: string;
};

export async function obtenerMovimientosCapa(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string
): Promise<FilaMovimientoCapa[]> {
  // Aislamiento multiempresa (C1, octubre 2026) — la capa se busca SIEMPRE
  // dentro de la Empresa del usuario; una capa de otra Empresa responde
  // igual que una inexistente (no revela que el id existe). Además se valida
  // el acceso al proyecto con el mismo mecanismo que el resto del módulo.
  const empresaId = requerirEmpresa(usuario);
  const capaRow = await db.estimacionClienteCapa.findFirst({
    where: { id: estimacionClienteCapaId, estimacionCliente: { empresaId } },
    select: { capa: true, estimacionCliente: { select: { proyectoId: true } } },
  });
  if (!capaRow) throw new RegistroNoEncontradoError("La estimación");
  await obtenerProyecto(usuario, capaRow.estimacionCliente.proyectoId);
  const puedeVer = capaRow.capa === "PRIVADO" ? puedeVerFinancieroCliente(usuario) : puedeVerFinancieroClienteOperativo(usuario);
  if (!puedeVer) throw new SinPermisoError();

  const movimientos = await db.movimientoFinancieroCliente.findMany({
    where: { estimacionClienteCapaId, empresaId, tipo: { in: ["PAGO_ESTIMACION", "APLICACION_ESTIMACION"] } },
    include: { registradoPor: { select: { nombre: true } } },
    orderBy: { fecha: "desc" },
  });

  return movimientos.map((m) => ({
    id: m.id,
    tipo: m.tipo as "PAGO_ESTIMACION" | "APLICACION_ESTIMACION",
    fecha: m.fecha.toISOString(),
    monto: Number(m.monto),
    referencia: m.referencia,
    notas: m.notas,
    estatus: m.estatus,
    motivoCancelacion: m.motivoCancelacion,
    registradoPorNombre: m.registradoPor.nombre,
  }));
}

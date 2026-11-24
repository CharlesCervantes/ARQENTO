import "server-only";
import { puedeVerContratoGeneralPrivado } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";
import { formatearRangoSemana } from "@/lib/server/semanas";
import { db } from "@/lib/server/db";
import { brandingDesdeEmpresa, type BrandingEmpresa } from "@/lib/server/branding";
import { obtenerArchivo } from "@/lib/server/archivos";
import {
  obtenerOFijarCorteDocumento,
  obtenerControlContractual,
  obtenerHistorialEstimacionesCliente,
  type CapaValorizacion,
  type ControlContractual,
  type FilaHistorialEstimacion,
} from "./financiero-cliente";
import {
  obtenerEstimacionCliente,
  type FilaEstimacionCapa,
  type FilaGastoEstimacion,
} from "./estimacion-cliente";
import { SinPermisoError, obtenerProyecto } from "./proyectos";

// Orquestador del documento histórico (Control Contractual al corte +
// Estimación semanal) — solo obtención de datos, cero cálculo propio y cero
// render. Reutiliza obtenerOFijarCorteDocumento (fija el corte de ESTA capa,
// independiente de la otra), y las mismas funciones ya usadas por las
// pantallas en vivo — una sola fuente de verdad para la realidad financiera
// y el avance contractual, nunca un segundo cálculo para el PDF. Una vez que
// una capa está EMITIDA, el documento se reconstruye EXCLUSIVAMENTE desde
// snapshots congelados (EstimacionClienteConcepto, EstimacionClienteCapaConcepto,
// EstimacionClienteGasto/detalle, montoContratoCongelado) — nunca depende de
// valores actuales de Concepto/Partida/Proyecto (arquitectura por capas,
// agosto 2026).

export type FilaEstimacionDocumento = {
  partidaNombre: string;
  descripcionConcepto: string;
  unidad: string;
  cantidadContratada: number;
  precioUnitario: number;
  importeContratado: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  importeEstaSemana: number;
  importeAcumulado: number;
  cantidadPorEjercer: number;
  importePorEjercer: number;
};

export type DatosDocumentoEstimacion = {
  branding: BrandingEmpresa;
  // Bytes ya resueltos del logo (o null) — igual criterio que
  // DatosPdfRecibo.logoBuffer (recibos.ts): el PDF nunca recibe una
  // URL/ref cruda.
  logoBuffer: Buffer | null;
  proyectoNombre: string;
  capa: CapaValorizacion;
  numero: number;
  semanaLabel: string;
  emitidoEn: string | null;
  fechaCorteDocumento: string;
  controlContractual: ControlContractual;
  historial: FilaHistorialEstimacion[];
  estimacionSemanal: {
    esquemaContractual: EsquemaContractual | null;
    subtotalTrabajos: number;
    administracion: number;
    administracionTrabajos: number;
    administracionGastos: number;
    porcentajeAdministracionGastos: number | null;
    gastosCobrables: number;
    aplicaIVA: boolean;
    porcentajeIVA: number | null;
    montoIVA: number;
    total: number;
    filas: FilaEstimacionDocumento[];
    gastos: FilaGastoEstimacion[];
  };
};

function aFilaDocumento(f: FilaEstimacionCapa): FilaEstimacionDocumento {
  return {
    partidaNombre: f.partidaNombre,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    precioUnitario: f.precioUnitarioBase,
    importeContratado: f.importeContratado,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    importeEstaSemana: f.importeEstaSemana,
    importeAcumulado: f.importeAcumulado,
    cantidadPorEjercer: f.cantidadPorEjercer,
    importePorEjercer: f.importePorEjercer,
  };
}

export async function obtenerDatosDocumentoEstimacion(
  usuario: UsuarioSesion,
  estimacionClienteCapaId: string,
  capa: CapaValorizacion
): Promise<DatosDocumentoEstimacion> {
  // Cliente Priv. exige el permiso completo de capa privada antes de
  // calcular nada — mismo gate que la página, para que la ruta PDF nunca sea
  // una forma de evadirlo.
  if (capa === "privado" && !puedeVerContratoGeneralPrivado(usuario)) throw new SinPermisoError();

  const estimacionCorte = await obtenerOFijarCorteDocumento(usuario, estimacionClienteCapaId);
  const [proyecto, semana, congelado, controlContractual, historial] = await Promise.all([
    obtenerProyecto(usuario, estimacionCorte.proyectoId),
    db.semana.findUniqueOrThrow({
      where: { id: estimacionCorte.semanaId },
      select: { numero: true, anio: true, fechaInicio: true, fechaFin: true },
    }),
    obtenerEstimacionCliente(usuario, estimacionCorte.proyectoId, estimacionCorte.semanaId, estimacionCorte.capa),
    obtenerControlContractual(usuario, estimacionCorte.proyectoId, capa, estimacionCorte.corte),
    obtenerHistorialEstimacionesCliente(usuario, estimacionCorte.proyectoId, capa, estimacionCorte.corte),
  ]);

  // Una capa EMITIDA siempre tiene snapshot congelado — obtenerOFijarCorteDocumento
  // ya validó estatus === EMITIDA, así que esto nunca debería ser null.
  if (!congelado) throw new Error("Estimación emitida sin snapshot congelado — estado inconsistente.");

  // estimacionCorte.branding solo es null para una capa que ya tenía su
  // corte fijado ANTES de que este campo existiera (documento histórico
  // previo a este cambio) — se completa con el branding actual como mejor
  // aproximación disponible, nunca se reintenta congelar retroactivamente.
  const branding =
    estimacionCorte.branding ??
    brandingDesdeEmpresa({
      nombre: usuario.empresa?.nombre ?? "",
      razonSocial: usuario.empresa?.razonSocial ?? null,
      logoRef: usuario.empresa?.logoRef ?? null,
      colorPrimario: usuario.empresa?.colorPrimario ?? "#0f172a",
      colorSecundario: usuario.empresa?.colorSecundario ?? "#64748b",
    });
  const logoBuffer = branding.logoRef ? await obtenerArchivo(branding.logoRef).catch(() => null) : null;

  return {
    branding,
    logoBuffer,
    proyectoNombre: proyecto.nombre,
    capa,
    numero: estimacionCorte.numero,
    semanaLabel: formatearRangoSemana(semana),
    emitidoEn: estimacionCorte.emitidoEn?.toISOString() ?? null,
    fechaCorteDocumento: estimacionCorte.corte.fechaCorte.toISOString(),
    controlContractual,
    historial,
    estimacionSemanal: {
      esquemaContractual: congelado.estimacion.esquemaContractualUsado ?? proyecto.esquemaContractual,
      subtotalTrabajos: congelado.estimacion.subtotal,
      administracion: congelado.estimacion.montoAdministracionTotal,
      administracionTrabajos: congelado.estimacion.montoAdministracionTrabajos,
      administracionGastos: congelado.estimacion.montoAdministracionGastos,
      porcentajeAdministracionGastos: congelado.estimacion.porcentajeAdministracionGastos,
      gastosCobrables: congelado.estimacion.subtotalGastosCobrables,
      aplicaIVA: congelado.estimacion.aplicaIVA,
      porcentajeIVA: congelado.estimacion.porcentajeIVA,
      montoIVA: congelado.estimacion.montoIVA,
      total: congelado.estimacion.total,
      filas: congelado.filas.map(aFilaDocumento),
      gastos: congelado.gastos,
    },
  };
}

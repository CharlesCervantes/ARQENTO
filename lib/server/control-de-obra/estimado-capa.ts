import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { CapaEstimacion } from "@/lib/generated/prisma/enums";

type Cliente = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Cantidad estimada por capa (noviembre 2026) — ver EstimadoCapaConcepto en
// schema.prisma. Regla, por concepto + semana + capa:
//   - semana histórica importada: estimado = fila (sin fila = 0);
//   - semana normal:              estimado = fila ?? avance físico aprobado.
// Una obra sin semanas históricas y sin filas devuelve un mapa vacío: la capa
// estima exactamente el avance físico, igual que antes de este cambio.
// Nunca toca el avance físico, lo asignable, los cortes ni los contratistas.
// ---------------------------------------------------------------------------

export type AjusteCapaConcepto = {
  // Diferencia (estimado − físico) acumulada en semanas ANTERIORES.
  deltaAnterior: number;
  // Parte de la cantidad anterior cuyo importe quedó fijado por fila.
  cantidadAnteriorConImporte: number;
  importeBaseAnteriorFijo: number;
  // Estimado de la semana consultada cuando difiere de la regla por defecto
  // (hay fila, o la semana es histórica). null = estima el físico.
  estaSemana: { cantidad: number; importeBase: number | null } | null;
};

export async function ajustesEstimadoCapa(
  cliente: Cliente,
  params: { proyectoId: string; capa: CapaEstimacion; semana: { id: string; fechaInicio: Date } }
): Promise<Map<string, AjusteCapaConcepto>> {
  const { proyectoId, capa, semana } = params;

  const [historicas, filas] = await Promise.all([
    cliente.cierreSemanaProyecto.findMany({
      where: { proyectoId, historicoImportado: true, semana: { fechaInicio: { lte: semana.fechaInicio } } },
      select: { semanaId: true },
    }),
    cliente.estimadoCapaConcepto.findMany({
      where: { proyectoId, capa, semana: { fechaInicio: { lte: semana.fechaInicio } } },
      select: { conceptoId: true, semanaId: true, cantidad: true, importeBase: true },
    }),
  ]);
  const ajustes = new Map<string, AjusteCapaConcepto>();
  if (historicas.length === 0 && filas.length === 0) return ajustes;

  const semanasHistoricas = new Set(historicas.map((h) => h.semanaId));
  const semanasAfectadas = new Set([...semanasHistoricas, ...filas.map((f) => f.semanaId)]);

  const fisicos = await cliente.avanceConcepto.findMany({
    where: {
      semanaId: { in: [...semanasAfectadas] },
      estatusAprobacion: "APROBADO",
      concepto: { partida: { proyectoId } },
    },
    select: { conceptoId: true, semanaId: true, cantidadEjecutada: true },
  });

  const clave = (conceptoId: string, semanaId: string) => `${conceptoId}|${semanaId}`;
  const fisicoPor = new Map(fisicos.map((a) => [clave(a.conceptoId, a.semanaId), Number(a.cantidadEjecutada)]));
  const filaPor = new Map(filas.map((f) => [clave(f.conceptoId, f.semanaId), f]));
  const pares = new Set([...fisicoPor.keys(), ...filaPor.keys()]);

  for (const par of pares) {
    const [conceptoId, semanaId] = par.split("|");
    const fisico = fisicoPor.get(par) ?? 0;
    const fila = filaPor.get(par);
    const esHistorica = semanasHistoricas.has(semanaId);
    if (!fila && !esHistorica) continue; // semana normal sin fila: estima el físico

    const estimado = fila ? Number(fila.cantidad) : 0;
    const importeBase = fila?.importeBase != null ? Number(fila.importeBase) : null;
    const a = ajustes.get(conceptoId) ?? {
      deltaAnterior: 0,
      cantidadAnteriorConImporte: 0,
      importeBaseAnteriorFijo: 0,
      estaSemana: null,
    };
    if (semanaId === semana.id) {
      a.estaSemana = { cantidad: estimado, importeBase };
    } else {
      a.deltaAnterior += estimado - fisico;
      if (importeBase !== null) {
        a.cantidadAnteriorConImporte += estimado;
        a.importeBaseAnteriorFijo += importeBase;
      }
    }
    ajustes.set(conceptoId, a);
  }
  return ajustes;
}

export type ValorCapaConcepto = {
  cantidadContratada: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  cantidadPorEjercer: number;
  avancePorcentaje: number;
  importeContratadoBase: number;
  importeAnteriorBase: number;
  importeEstaSemanaBase: number;
  importeAcumuladoBase: number;
  importePorEjercerBase: number;
  // Con administración/utilidad
  importeContratado: number;
  importeEstaSemana: number;
  importeAcumulado: number;
  importePorEjercer: number;
  montoPorcentajeEstaSemana: number;
};

// Valoriza un concepto en una capa a partir de su físico y su ajuste. Sin
// ajuste da exactamente precio × cantidad física (comportamiento anterior).
export function valorarConceptoEnCapa(p: {
  cantidadContratada: number;
  fisicoAnterior: number;
  fisicoEstaSemana: number;
  ajuste: AjusteCapaConcepto | undefined;
  precioUnitarioBase: number;
  montoPorcentajePorUnidad: number;
}): ValorCapaConcepto {
  const a = p.ajuste;
  const cantidadAnterior = p.fisicoAnterior + (a?.deltaAnterior ?? 0);
  const cantidadEstaSemana = a?.estaSemana ? a.estaSemana.cantidad : p.fisicoEstaSemana;
  const cantidadAcumulada = cantidadAnterior + cantidadEstaSemana;
  const cantidadPorEjercer = p.cantidadContratada - cantidadAcumulada;

  const base = p.precioUnitarioBase;
  const tasa = base > 0 ? p.montoPorcentajePorUnidad / base : 0;

  const importeAnteriorBase =
    (cantidadAnterior - (a?.cantidadAnteriorConImporte ?? 0)) * base + (a?.importeBaseAnteriorFijo ?? 0);
  const importeEstaSemanaBase = a?.estaSemana?.importeBase ?? cantidadEstaSemana * base;
  const importeAcumuladoBase = importeAnteriorBase + importeEstaSemanaBase;
  const importeContratadoBase = p.cantidadContratada * base;

  return {
    cantidadContratada: p.cantidadContratada,
    cantidadAnterior,
    cantidadEstaSemana,
    cantidadAcumulada,
    cantidadPorEjercer,
    avancePorcentaje: p.cantidadContratada > 0 ? (cantidadAcumulada / p.cantidadContratada) * 100 : 0,
    importeContratadoBase,
    importeAnteriorBase,
    importeEstaSemanaBase,
    importeAcumuladoBase,
    importePorEjercerBase: importeContratadoBase - importeAcumuladoBase,
    importeContratado: importeContratadoBase * (1 + tasa),
    importeEstaSemana: importeEstaSemanaBase * (1 + tasa),
    importeAcumulado: importeAcumuladoBase * (1 + tasa),
    importePorEjercer: (importeContratadoBase - importeAcumuladoBase) * (1 + tasa),
    montoPorcentajeEstaSemana: importeEstaSemanaBase * tasa,
  };
}

// La semana tiene algo que estimar en esta capa aunque no haya avance físico.
export function estimaAlgoEstaSemana(a: AjusteCapaConcepto | undefined): boolean {
  return !!a?.estaSemana && (a.estaSemana.cantidad !== 0 || (a.estaSemana.importeBase ?? 0) !== 0);
}

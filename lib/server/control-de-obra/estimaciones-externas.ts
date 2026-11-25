import "server-only";
import { db } from "@/lib/server/db";
import { puedeVerContratoGeneralPrivado, puedeVerFinancieroCliente, puedeVerFinancieroClienteOperativo } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, obtenerProyecto } from "./proyectos";

// Estimaciones emitidas antes de ARQENTO — solo lectura. Ver EstimacionExterna.

type Capa = "operativo" | "privado";
const enumCapa = (c: Capa) => (c === "privado" ? ("PRIVADO" as const) : ("OPERATIVO" as const));

/** Suma antes de IVA, para el avance contractual (misma base que el contrato). */
export async function totalEstimadoExterno(proyectoId: string, capa: "OPERATIVO" | "PRIVADO", hasta?: Date): Promise<number> {
  const r = await db.estimacionExterna.aggregate({
    where: { proyectoId, capa, ...(hasta && { semana: { fechaInicio: { lte: hasta } } }) },
    _sum: { importe: true },
  });
  return Number(r._sum.importe ?? 0);
}

export type FilaEstimacionExterna = {
  id: string;
  numero: number;
  semanaNumero: number;
  semanaAnio: number;
  importe: number;
  iva: number;
  importeNeto: number;
  concepto: string | null;
  fechaRecepcion: string | null;
  // Dato de la hoja, no un cobro registrado. null sin permiso financiero.
  fechaPago: string | null;
};

export async function obtenerEstimacionesExternas(
  usuario: UsuarioSesion,
  proyectoId: string,
  capa: Capa,
  opciones: { hasta?: Date; semanaId?: string } = {}
): Promise<FilaEstimacionExterna[]> {
  await obtenerProyecto(usuario, proyectoId);
  if (capa === "privado" && !puedeVerContratoGeneralPrivado(usuario)) throw new SinPermisoError();
  const verPago = capa === "privado" ? puedeVerFinancieroCliente(usuario) : puedeVerFinancieroClienteOperativo(usuario);
  const filas = await db.estimacionExterna.findMany({
    where: {
      proyectoId,
      capa: enumCapa(capa),
      ...(opciones.semanaId && { semanaId: opciones.semanaId }),
      ...(opciones.hasta && { semana: { fechaInicio: { lte: opciones.hasta } } }),
    },
    include: { semana: { select: { numero: true, anio: true } } },
    orderBy: { numero: "asc" },
  });
  return filas.map((f) => ({
    id: f.id,
    numero: f.numero,
    semanaNumero: f.semana.numero,
    semanaAnio: f.semana.anio,
    importe: Number(f.importe),
    iva: Number(f.iva),
    importeNeto: Number(f.importeNeto),
    concepto: f.concepto,
    fechaRecepcion: f.fechaRecepcion,
    fechaPago: verPago ? f.fechaPago : null,
  }));
}

export type DetalleEstimacionExterna = FilaEstimacionExterna & {
  partidas: { nombre: string; conceptos: { id: string; descripcion: string; unidad: string; cantidad: number; importeBase: number }[] }[];
  subtotalConceptos: number;
};

/** Estimación externa de una semana con los conceptos cargados (antes de administración). */
export async function obtenerDetalleEstimacionExterna(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  capa: Capa
): Promise<DetalleEstimacionExterna | null> {
  const [fila] = await obtenerEstimacionesExternas(usuario, proyectoId, capa, { semanaId });
  if (!fila) return null;
  const estimados = await db.estimadoCapaConcepto.findMany({
    where: { proyectoId, semanaId, capa: enumCapa(capa), historicoImportado: true },
    include: {
      concepto: {
        select: {
          id: true, descripcion: true, descripcionPrivado: true, unidad: true, unidadPrivado: true, orden: true,
          partida: { select: { nombre: true, orden: true } },
        },
      },
    },
  });
  const orden = [...estimados].sort((a, b) => a.concepto.partida.orden - b.concepto.partida.orden || a.concepto.orden - b.concepto.orden);
  const partidas: DetalleEstimacionExterna["partidas"] = [];
  let subtotalConceptos = 0;
  for (const e of orden) {
    const c = e.concepto;
    const importeBase = Number(e.importeBase ?? 0);
    subtotalConceptos += importeBase;
    if (partidas.at(-1)?.nombre !== c.partida.nombre) partidas.push({ nombre: c.partida.nombre, conceptos: [] });
    partidas.at(-1)!.conceptos.push({
      id: c.id,
      descripcion: capa === "privado" ? (c.descripcionPrivado ?? c.descripcion) : c.descripcion,
      unidad: capa === "privado" ? (c.unidadPrivado ?? c.unidad) : c.unidad,
      cantidad: Number(e.cantidad),
      importeBase,
    });
  }
  return { ...fila, partidas, subtotalConceptos };
}

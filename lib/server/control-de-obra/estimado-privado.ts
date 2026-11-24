import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeCapturarEstimadoPrivado } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";

// ---------------------------------------------------------------------------
// Captura de cantidad estimada PRIVADA por semana (noviembre 2026). Cambia lo
// que Cliente Priv. estima esa semana para un concepto; nunca toca el avance
// físico, lo disponible para asignar, los cortes ni los saldos de
// contratistas. Ver EstimadoCapaConcepto en schema.prisma.
// ---------------------------------------------------------------------------

export type EstimadoPrivadoSemana = {
  id: string;
  conceptoId: string;
  descripcionConcepto: string;
  unidad: string;
  cantidad: number;
  importeBase: number | null;
  fisicoEstaSemana: number;
  origen: string;
};

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// Solo se captura donde la capa privada todavía puede cambiar: semana no
// histórica y sin estimación privada emitida.
async function validarSemanaEditable(
  tx: Pick<typeof db, "cierreSemanaProyecto" | "estimacionClienteCapa">,
  proyectoId: string,
  semanaId: string
) {
  const cierre = await tx.cierreSemanaProyecto.findUnique({
    where: { proyectoId_semanaId: { proyectoId, semanaId } },
    select: { estatus: true, historicoImportado: true },
  });
  if (cierre?.historicoImportado) {
    throw new ValidacionError("Esta semana es histórica (migrada desde Excel); su estimado no se modifica.");
  }
  const capa = await tx.estimacionClienteCapa.findFirst({
    where: { capa: "PRIVADO", estimacionCliente: { proyectoId, semanaId } },
    select: { estatus: true },
  });
  if (capa?.estatus === "EMITIDA") {
    throw new ValidacionError("La estimación privada de esta semana ya fue emitida; su cantidad estimada no se modifica.");
  }
  if (cierre?.estatus === "CERRADA" && !capa) {
    throw new ValidacionError("Esta semana ya está cerrada sin estimación privada; reábrela para capturar el estimado privado.");
  }
}

export async function obtenerEstimadosPrivadosSemana(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<EstimadoPrivadoSemana[]> {
  if (!puedeCapturarEstimadoPrivado(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const filas = await db.estimadoCapaConcepto.findMany({
    where: { empresaId, proyectoId, semanaId, capa: "PRIVADO" },
    include: { concepto: { select: { descripcion: true, unidad: true } } },
    orderBy: { createdAt: "asc" },
  });
  const fisicos = await db.avanceConcepto.findMany({
    where: { semanaId, conceptoId: { in: filas.map((f) => f.conceptoId) }, estatusAprobacion: "APROBADO" },
    select: { conceptoId: true, cantidadEjecutada: true },
  });
  const fisicoPor = new Map(fisicos.map((a) => [a.conceptoId, Number(a.cantidadEjecutada)]));
  return filas.map((f) => ({
    id: f.id,
    conceptoId: f.conceptoId,
    descripcionConcepto: f.concepto.descripcion,
    unidad: f.concepto.unidad,
    cantidad: Number(f.cantidad),
    importeBase: f.importeBase === null ? null : Number(f.importeBase),
    fisicoEstaSemana: fisicoPor.get(f.conceptoId) ?? 0,
    origen: f.origen,
  }));
}

export async function listarConceptosParaEstimadoPrivado(usuario: UsuarioSesion, proyectoId: string) {
  if (!puedeCapturarEstimadoPrivado(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const conceptos = await db.concepto.findMany({
    where: { estatus: "ACTIVO", partida: { proyectoId, proyecto: { empresaId } } },
    select: { id: true, descripcion: true, descripcionPrivado: true, unidad: true, unidadPrivado: true, orden: true, partida: { select: { orden: true } } },
  });
  return conceptos
    .sort((a, b) => a.partida.orden - b.partida.orden || a.orden - b.orden)
    .map((c) => ({ id: c.id, descripcion: c.descripcionPrivado ?? c.descripcion, unidad: c.unidadPrivado ?? c.unidad }));
}

const DatosEstimadoSchema = z.object({
  conceptoId: z.string().min(1),
  cantidad: z.number().nonnegative().max(1e11),
  importeBase: z.number().nonnegative().max(1e11).nullable(),
  motivo: z.string().trim().min(3, "Indica el motivo de la cantidad privada."),
});

export async function guardarEstimadoPrivado(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  datosCrudos: unknown
) {
  if (!puedeCapturarEstimadoPrivado(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosEstimadoSchema.parse(datosCrudos);

  const concepto = await db.concepto.findFirst({
    where: { id: datos.conceptoId, partida: { proyectoId, proyecto: { empresaId } } },
    select: { id: true },
  });
  if (!concepto) throw new RegistroNoEncontradoError("El concepto");
  const semana = await db.semana.findFirst({ where: { id: semanaId, empresaId }, select: { id: true } });
  if (!semana) throw new RegistroNoEncontradoError("La semana");

  const cantidad = Math.round(datos.cantidad * 1e6) / 1e6;
  const importeBase = datos.importeBase === null ? null : Math.round(datos.importeBase * 100) / 100;

  return db.$transaction(async (tx) => {
    await validarSemanaEditable(tx, proyectoId, semanaId);
    const anterior = await tx.estimadoCapaConcepto.findUnique({
      where: { conceptoId_semanaId_capa: { conceptoId: concepto.id, semanaId, capa: "PRIVADO" } },
    });
    const fila = await tx.estimadoCapaConcepto.upsert({
      where: { conceptoId_semanaId_capa: { conceptoId: concepto.id, semanaId, capa: "PRIVADO" } },
      create: {
        empresaId,
        proyectoId,
        conceptoId: concepto.id,
        semanaId,
        capa: "PRIVADO",
        cantidad,
        importeBase,
        origen: datos.motivo,
        registradoPorId: usuario.id,
      },
      update: { cantidad, importeBase, origen: datos.motivo, registradoPorId: usuario.id },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "EstimadoCapaConcepto",
      entidadId: fila.id,
      accion: anterior ? "EDITAR" : "CREAR",
      valorAnterior: anterior
        ? { cantidad: Number(anterior.cantidad), importeBase: anterior.importeBase === null ? null : Number(anterior.importeBase), origen: anterior.origen }
        : undefined,
      valorNuevo: { capa: "PRIVADO", conceptoId: concepto.id, semanaId, cantidad, importeBase, origen: datos.motivo },
    });
    return fila;
  });
}

export async function eliminarEstimadoPrivado(usuario: UsuarioSesion, proyectoId: string, estimadoId: string) {
  if (!puedeCapturarEstimadoPrivado(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const fila = await db.estimadoCapaConcepto.findFirst({
    where: { id: estimadoId, empresaId, proyectoId, capa: "PRIVADO" },
  });
  if (!fila) throw new RegistroNoEncontradoError("El estimado privado");
  if (fila.historicoImportado) throw new ValidacionError("Este estimado es histórico (migrado desde Excel) y no se elimina.");

  await db.$transaction(async (tx) => {
    await validarSemanaEditable(tx, proyectoId, fila.semanaId);
    await tx.estimadoCapaConcepto.delete({ where: { id: fila.id } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "EstimadoCapaConcepto",
      entidadId: fila.id,
      accion: "ELIMINAR",
      valorAnterior: {
        capa: "PRIVADO",
        conceptoId: fila.conceptoId,
        semanaId: fila.semanaId,
        cantidad: Number(fila.cantidad),
        importeBase: fila.importeBase === null ? null : Number(fila.importeBase),
        origen: fila.origen,
      },
    });
  });
}

import "server-only";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { sumaEjecutadaPorConcepto, sumaHistoricaImportadaPorConcepto } from "./avance-calculo";
import { ajustesEstimadoCapa } from "./estimado-capa";

// Excedente aprobado (noviembre 2026): al aprobar un avance cuyo acumulado
// rebasa lo contratado, lo contratado sube hasta lo ejecutado. Solo aumenta,
// nunca reduce, y nunca toca P.U., estimaciones emitidas ni cortes.

const d = (v: Prisma.Decimal | number) => new Prisma.Decimal(v).toDecimalPlaces(3);

/** Cantidad contratada que resultaría de aprobar; null si no excede. */
export function contratadoConExcedente(contratado: Prisma.Decimal | number, aprobadoOtrasSemanas: number, estaSemana: number): number | null {
  const acumulado = d(new Prisma.Decimal(aprobadoOtrasSemanas).plus(estaSemana));
  return acumulado.gt(d(contratado)) ? acumulado.toNumber() : null;
}

/** Aumenta lo contratado en General, en Privado si tiene cantidad propia y en el contrato del contratista. */
export async function ampliarContratadoTx(
  tx: Prisma.TransactionClient,
  p: { empresaId: string; usuarioId: string; proyectoId: string; conceptoId: string; semana: { id: string; fechaInicio: Date }; estaSemana: number; nuevoContratado: number }
) {
  const { empresaId, usuarioId, conceptoId } = p;
  const concepto = await tx.concepto.findUniqueOrThrow({
    where: { id: conceptoId },
    select: { cantidadContratada: true, cantidadContratadaPrivado: true, asignaciones: { select: { id: true, cantidad: true } } },
  });
  const motivo = "Excedente de avance aprobado";
  const auditar = (entidad: string, entidadId: string, valorAnterior: Record<string, unknown>, valorNuevo: Record<string, unknown>) =>
    registrarAuditoriaTx(tx, { empresaId, usuarioId, entidad, entidadId, accion: "EDITAR", valorAnterior, valorNuevo: { ...valorNuevo, motivo, semanaId: p.semana.id } });

  await tx.concepto.update({ where: { id: conceptoId }, data: { cantidadContratada: p.nuevoContratado } });
  await auditar("Concepto", conceptoId, { cantidadContratada: Number(concepto.cantidadContratada) }, { cantidadContratada: p.nuevoContratado });

  // Privado sin cantidad propia sigue a General solo.
  if (concepto.cantidadContratadaPrivado !== null) {
    const a = (await ajustesEstimadoCapa(tx, { proyectoId: p.proyectoId, capa: "PRIVADO", semana: p.semana })).get(conceptoId);
    const estimado = d(p.nuevoContratado + (a?.deltaAnterior ?? 0) + (a?.estaSemana ? a.estaSemana.cantidad - p.estaSemana : 0));
    if (estimado.gt(concepto.cantidadContratadaPrivado)) {
      await tx.concepto.update({ where: { id: conceptoId }, data: { cantidadContratadaPrivado: estimado } });
      await auditar("ConceptoPrivado", conceptoId, { cantidadContratadaPrivado: Number(concepto.cantidadContratadaPrivado) }, { cantidadContratadaPrivado: estimado.toNumber() });
    }
  }

  // El histórico importado no es del contratista: no entra a su contrato.
  const asignacion = concepto.asignaciones[0];
  if (asignacion) {
    const historico = (await sumaHistoricaImportadaPorConcepto(p.proyectoId, [conceptoId], tx)).get(conceptoId) ?? 0;
    const cantidad = d(new Prisma.Decimal(p.nuevoContratado).minus(historico));
    if (cantidad.gt(asignacion.cantidad)) {
      await tx.contratoConcepto.update({ where: { id: asignacion.id }, data: { cantidad } });
      await auditar("ContratoConcepto", asignacion.id, { cantidad: Number(asignacion.cantidad) }, { cantidad: cantidad.toNumber() });
    }
  }
}

/** Aprobado del concepto en todas las semanas menos la indicada. */
export async function aprobadoEnOtrasSemanas(tx: Prisma.TransactionClient, conceptoId: string, semanaId: string): Promise<number> {
  const total = (await sumaEjecutadaPorConcepto([conceptoId], undefined, tx)).get(conceptoId) ?? 0;
  const propia = await tx.avanceConcepto.findFirst({ where: { conceptoId, semanaId, estatusAprobacion: "APROBADO" }, select: { cantidadEjecutada: true } });
  return total - Number(propia?.cantidadEjecutada ?? 0);
}

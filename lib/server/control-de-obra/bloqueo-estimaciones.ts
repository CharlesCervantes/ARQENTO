import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import { ValidacionError } from "./proyectos";

// Bloqueo de cierre y estimaciones por obra (noviembre 2026). Se usa cuando
// cerrar o estimar duplicaría cargos ya resueltos fuera de ARQENTO. Cada
// obra tiene su propio motivo; null = opera normal.

type Cliente = Pick<Prisma.TransactionClient, "proyecto">;

export async function motivoBloqueoEstimaciones(cliente: Cliente, proyectoId: string): Promise<string | null> {
  const p = await cliente.proyecto.findUnique({
    where: { id: proyectoId },
    select: { motivoBloqueoEstimaciones: true },
  });
  return p?.motivoBloqueoEstimaciones?.trim() || null;
}

export async function exigirEstimacionesPermitidas(cliente: Cliente, proyectoId: string): Promise<void> {
  const motivo = await motivoBloqueoEstimaciones(cliente, proyectoId);
  if (motivo) {
    throw new ValidacionError(`El cierre de semanas y las estimaciones de esta obra están bloqueados: ${motivo}`);
  }
}

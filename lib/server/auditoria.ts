import "server-only";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { AccionAuditoria } from "@/lib/generated/prisma/enums";

// Json de Prisma solo acepta valores JSON planos — las fechas (Date) hay que
// pasarlas por JSON.stringify/parse para que se conviertan a ISO string, igual
// que cualquier otro tipo no serializable directamente (Decimal, etc.).
function aJson(valor: Record<string, unknown> | null | undefined) {
  if (!valor) return undefined;
  return JSON.parse(JSON.stringify(valor));
}

type ParametrosAuditoria = {
  empresaId?: string | null;
  // null = acción del sistema (p. ej. depuración programada o revocación
  // automática sin un usuario que la origine) — la columna ya lo admite.
  usuarioId: string | null;
  entidad: string;
  entidadId: string;
  accion: AccionAuditoria;
  valorAnterior?: Record<string, unknown> | null;
  valorNuevo?: Record<string, unknown> | null;
};

export async function registrarAuditoria(params: ParametrosAuditoria) {
  await db.registroAuditoria.create({
    data: {
      empresaId: params.empresaId ?? null,
      usuarioId: params.usuarioId,
      entidad: params.entidad,
      entidadId: params.entidadId,
      accion: params.accion,
      valorAnterior: aJson(params.valorAnterior),
      valorNuevo: aJson(params.valorNuevo),
    },
  });
}

// Igual que registrarAuditoria, pero atado a un cliente de transacción (`tx`)
// en vez del `db` global — necesario dentro de cualquier `db.$transaction`:
// si el registro fuera vía `db`, sobreviviría aunque la transacción completa
// se revirtiera, rompiendo la atomicidad de la operación.
export async function registrarAuditoriaTx(
  tx: Prisma.TransactionClient,
  params: ParametrosAuditoria
) {
  await tx.registroAuditoria.create({
    data: {
      empresaId: params.empresaId ?? null,
      usuarioId: params.usuarioId,
      entidad: params.entidad,
      entidadId: params.entidadId,
      accion: params.accion,
      valorAnterior: aJson(params.valorAnterior),
      valorNuevo: aJson(params.valorNuevo),
    },
  });
}

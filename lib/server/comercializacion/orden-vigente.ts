import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";

// B8B — una orden de venta CANCELADA no admite compras, gastos, entregas,
// vínculos de surtido, cobros ni cambios de condiciones. Esta comprobación va
// DENTRO de la transacción y bloquea la OV (orden de B8A: OV → compra/entrega
// → cuenta); la base lo vuelve a exigir con triggers.

export const MENSAJE_ORDEN_CANCELADA = "La orden de venta está cancelada: no admite nuevas compras, gastos, entregas, vínculos ni cobros.";

export async function exigirOrdenVigenteTx(tx: Prisma.TransactionClient, empresaId: string, ordenVentaId: string): Promise<void> {
  const [fila] = await tx.$queryRaw<{ estatus: string }[]>`
    SELECT estatus::text AS estatus FROM ordenes_venta WHERE id = ${ordenVentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
  if (!fila) throw new RegistroNoEncontradoError("La orden de venta");
  if (fila.estatus === "CANCELADA") throw new ValidacionError(MENSAJE_ORDEN_CANCELADA);
}

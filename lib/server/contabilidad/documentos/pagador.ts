import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";

// Quién pagó un gasto registrado desde un documento de Captura Inteligente
// (R3 corregido — Fase 0 WhatsApp + ARQENTO IA, octubre 2026). Antes, la
// confirmación fijaba siempre "pagó la Empresa" y la reposición de quien
// había pagado de su bolsa se perdía. Reglas:
// - siempre explícito: nunca se asume EMPRESA por omisión;
// - YO = el REMITENTE original del documento (DocumentoEgreso.subidoPorId),
//   resuelto con el Beneficiario vinculado a ese usuario — nunca con un id
//   que mande el cliente ni con el usuario que confirma;
// - OTRO = un Beneficiario activo de la misma Empresa, elegido por quien
//   confirma.
// Con pagador YO u OTRO, el gasto genera su reposición al aprobarse
// (aprobarGasto → asignarGastoAReposicionTx, R2, sin cambios).

export const MODOS_PAGADOR = ["EMPRESA", "YO", "OTRO"] as const;
export type ModoPagador = (typeof MODOS_PAGADOR)[number];

export async function resolverPagadorDeDocumentoTx(
  tx: Prisma.TransactionClient,
  args: { empresaId: string; remitenteId: string; modo: ModoPagador; beneficiarioId?: string | null }
): Promise<{ pagadorBeneficiarioId: string | null }> {
  if (args.modo === "EMPRESA") return { pagadorBeneficiarioId: null };

  if (args.modo === "YO") {
    const remitente = await tx.usuario.findFirst({
      where: { id: args.remitenteId, empresaId: args.empresaId },
      select: { nombre: true, beneficiario: { select: { id: true, activo: true, empresaId: true } } },
    });
    if (!remitente) throw new RegistroNoEncontradoError("El remitente del documento");
    const beneficiario = remitente.beneficiario;
    if (!beneficiario || !beneficiario.activo || beneficiario.empresaId !== args.empresaId) {
      throw new ValidacionError(
        `${remitente.nombre} no tiene un beneficiario de pago activo vinculado. Vincúlalo en Catálogos antes de confirmar, para que se genere su reposición.`
      );
    }
    return { pagadorBeneficiarioId: beneficiario.id };
  }

  if (!args.beneficiarioId) throw new ValidacionError("Selecciona a la persona que pagó.");
  const beneficiario = await tx.beneficiario.findFirst({
    where: { id: args.beneficiarioId, empresaId: args.empresaId, activo: true },
    select: { id: true },
  });
  if (!beneficiario) throw new RegistroNoEncontradoError("El beneficiario seleccionado");
  return { pagadorBeneficiarioId: beneficiario.id };
}

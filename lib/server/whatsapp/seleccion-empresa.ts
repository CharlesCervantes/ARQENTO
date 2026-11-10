import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import { vinculosUtilizablesTx } from "./vinculos";

// Selección explícita de Empresa para un número vinculado a VARIAS Empresas
// (Fase 1 WhatsApp + ARQENTO IA, D5): solo se ofrecen las Empresas con un
// vínculo verificado y utilizable de ese número; la selección caduca a los
// 30 minutos y se revalida en cada uso — nunca da acceso a una Empresa sin
// vínculo vigente. La usará la recepción de documentos (Fase 2).

type Cliente = Prisma.TransactionClient;
export const VIGENCIA_SELECCION_MINUTOS = 30;

type Vinculo = Awaited<ReturnType<typeof vinculosUtilizablesTx>>[number];

export async function seleccionarEmpresaTx(
  tx: Cliente,
  args: { remitenteHash: string; vinculoId: string; vinculos: Vinculo[]; ahora: Date }
): Promise<Vinculo | null> {
  const elegido = args.vinculos.find((v) => v.id === args.vinculoId);
  if (!elegido) return null;
  const expiraEn = new Date(args.ahora.getTime() + VIGENCIA_SELECCION_MINUTOS * 60_000);
  await tx.sesionWhatsapp.upsert({
    where: { remitenteHash: args.remitenteHash },
    update: { vinculoId: elegido.id, expiraEn },
    create: { remitenteHash: args.remitenteHash, vinculoId: elegido.id, expiraEn },
  });
  return elegido;
}

// Empresa con la que trabaja un remitente AHORA: la única si solo tiene un
// vínculo utilizable; si tiene varios, la selección vigente (no caducada y
// todavía utilizable); si no, null (hay que pedirle que elija).
export async function empresaActivaDelRemitenteTx(
  tx: Cliente,
  args: { remitenteHash: string; telefonoE164: string; ahora: Date }
): Promise<Vinculo | null> {
  const vinculos = await vinculosUtilizablesTx(tx, args.telefonoE164);
  if (vinculos.length === 0) return null;
  if (vinculos.length === 1) return vinculos[0];
  const sesion = await tx.sesionWhatsapp.findUnique({ where: { remitenteHash: args.remitenteHash } });
  if (!sesion || sesion.expiraEn <= args.ahora) return null;
  return vinculos.find((v) => v.id === sesion.vinculoId) ?? null;
}

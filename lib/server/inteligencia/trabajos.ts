import "server-only";
import { createHash } from "crypto";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";

// Infraestructura genérica de cola — nunca referencia Egreso/GastoObra ni
// ningún modelo de dominio; "referenciaModulo" es un id opaco que el módulo
// dueño interpreta por su cuenta (Carga inteligente de documentos, V1 —
// octubre 2026).

export function calcularHashArchivo(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Detección de duplicados — SIEMPRE scoped por empresaId, nunca una
// búsqueda global. Dos empresas con el mismo hash (ej. la misma plantilla
// de factura de un proveedor compartido) nunca deben enterarse una de la
// otra a través de esta función — ni compartir acceso, ni compartir
// documentos, ni siquiera saber que el otro existe.
export async function buscarDocumentoPorHash(
  empresaId: string,
  hashArchivo: string,
  cliente: Prisma.TransactionClient = db
): Promise<{ id: string; createdAt: Date; loteId: string; contextoUsuario: string | null; contextosAdicionales: unknown } | null> {
  return cliente.documentoEgreso.findFirst({
    where: { empresaId, hashArchivo },
    select: { id: true, createdAt: true, loteId: true, contextoUsuario: true, contextosAdicionales: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function encolarTrabajo(args: {
  empresaId: string;
  modulo: string;
  operacion: string;
  referenciaModulo: string;
  archivoRef: string;
  tipoMime: string;
  creadoPorId: string;
  extractorVersion?: string;
  modeloIA?: string;
  promptVersion?: string;
}, cliente: Prisma.TransactionClient = db) {
  return cliente.trabajoProcesamientoDocumento.create({
    data: {
      empresaId: args.empresaId,
      modulo: args.modulo,
      operacion: args.operacion,
      referenciaModulo: args.referenciaModulo,
      archivoRef: args.archivoRef,
      tipoMime: args.tipoMime,
      creadoPorId: args.creadoPorId,
      extractorVersion: args.extractorVersion ?? null,
      modeloIA: args.modeloIA ?? null,
      promptVersion: args.promptVersion ?? null,
    },
  });
}

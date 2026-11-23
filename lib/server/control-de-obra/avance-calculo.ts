import "server-only";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";

type Cliente = Prisma.TransactionClient;

// Separado de avance.ts (que importa de cierre-semana.ts) para que
// estimacion-cliente.ts pueda reutilizar esta agregación sin crear un
// import circular (cierre-semana.ts → estimacion-cliente.ts → avance.ts →
// cierre-semana.ts). Este módulo no depende de ningún otro de Control de
// Obra a propósito.

// Suma cantidadEjecutada por concepto — solo lo APROBADO cuenta como oficial
// (lo PENDIENTE/RECHAZADO no suma hasta que un Director/Administrador lo
// apruebe explícitamente; decisión de sesión, agosto 2026, ver 49.9). Si
// `antesDe` se indica, solo cuenta semanas anteriores a esa fecha (para
// calcular "Anterior"); sin `antesDe`, suma todo el histórico aprobado (para
// el acumulado a la fecha que usa Contratistas). `cliente` opcional para
// poder llamarse dentro de una transacción (p. ej. al cerrar semana).
export async function sumaEjecutadaPorConcepto(
  conceptoIds: string[],
  antesDe?: Date,
  cliente: Cliente = db
): Promise<Map<string, number>> {
  if (conceptoIds.length === 0) return new Map();

  const filas = await cliente.avanceConcepto.groupBy({
    by: ["conceptoId"],
    where: {
      conceptoId: { in: conceptoIds },
      estatusAprobacion: "APROBADO",
      ...(antesDe ? { semana: { fechaInicio: { lt: antesDe } } } : {}),
    },
    _sum: { cantidadEjecutada: true },
  });

  return new Map(filas.map((f) => [f.conceptoId, Number(f._sum.cantidadEjecutada ?? 0)]));
}

// Avance aprobado en semanas HISTÓRICAS IMPORTADAS de este proyecto
// (CierreSemanaProyecto.historicoImportado). Es obra ejecutada antes de
// operar en ARQENTO y no está atribuida a ningún contratista: asignar
// después un concepto no la vuelve del contratista nuevo ni la convierte en
// cantidad por pagar (migración de obras desde Excel, noviembre 2026).
// Proyecto sin semanas históricas → mapa vacío (comportamiento sin cambios).
export async function sumaHistoricaImportadaPorConcepto(
  proyectoId: string,
  conceptoIds: string[],
  cliente: Cliente = db
): Promise<Map<string, number>> {
  if (conceptoIds.length === 0) return new Map();

  const filas = await cliente.avanceConcepto.groupBy({
    by: ["conceptoId"],
    where: {
      conceptoId: { in: conceptoIds },
      estatusAprobacion: "APROBADO",
      semana: { cierresSemana: { some: { proyectoId, historicoImportado: true } } },
    },
    _sum: { cantidadEjecutada: true },
  });

  return new Map(filas.map((f) => [f.conceptoId, Number(f._sum.cantidadEjecutada ?? 0)]));
}

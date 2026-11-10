import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { categoriasOcultasPara } from "@/lib/server/control-de-obra/gastos";

// Posibles duplicados al registrar un documento de Captura Inteligente (Fase
// 0 WhatsApp + ARQENTO IA, octubre 2026). El MISMO archivo ya se bloquea al
// subir (huella por Empresa); aquí se detecta la misma compra capturada por
// otra vía o con otro archivo (foto y PDF, ticket y comprobante…). Nunca
// bloquea por sí solo: un gasto legítimo puede repetir proveedor, fecha e
// importe — quien confirma revisa la lista y acepta explícitamente.
//
// Niveles:
// - FUERTE: UUID fiscal ya ligado a un egreso, o referencia bancaria ya
//   registrada en un pago.
// - MEDIO: mismo proveedor, mismo importe y fecha a ±3 días.
// - DEBIL: mismo importe y misma obra, fecha a ±1 día.
//
// Privacidad: solo se busca dentro de la Empresa del usuario, nunca se
// muestran gastos de categorías que el usuario no puede ver, y cada aviso
// lleva solo fecha, importe, descripción y obra — nada de datos de pago,
// cuentas ni capas del cliente.

export type NivelDuplicado = "FUERTE" | "MEDIO" | "DEBIL";

export type PosibleDuplicado = {
  nivel: NivelDuplicado;
  motivo: string;
  tipo: "GASTO" | "EGRESO";
  id: string;
  fecha: string | null;
  monto: number;
  descripcion: string;
  proyectoNombre: string | null;
};

export class PosiblesDuplicadosError extends ValidacionError {
  constructor(public readonly candidatos: PosibleDuplicado[]) {
    super("Encontramos posibles duplicados. Revísalos y confirma que se trata de un registro distinto para continuar.");
  }
}

const DIA_MS = 86_400_000;
const PATRON_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ORDEN_NIVEL: Record<NivelDuplicado, number> = { FUERTE: 0, MEDIO: 1, DEBIL: 2 };

// Identificadores del documento tal como los dejó la propuesta reconciliada
// (UUID fiscal en cualquier campo de texto, referencia bancaria).
export function identificadoresDePropuesta(propuesta: unknown): { uuids: string[]; referencias: string[] } {
  const campos = (propuesta as { campos?: { campo: string; valor: unknown }[] } | null)?.campos ?? [];
  const uuids = new Set<string>();
  const referencias = new Set<string>();
  for (const c of campos) {
    if (typeof c.valor !== "string") continue;
    for (const u of c.valor.match(PATRON_UUID) ?? []) uuids.add(u.toUpperCase());
    if (c.campo === "referenciaBancaria" && c.valor.trim().length >= 4) referencias.add(c.valor.trim());
  }
  return { uuids: [...uuids], referencias: [...referencias] };
}

const rangoMonto = (monto: number) => ({ gte: monto - 0.005, lte: monto + 0.005 });
const rangoFecha = (fecha: Date, dias: number) => ({ gte: new Date(fecha.getTime() - dias * DIA_MS), lte: new Date(fecha.getTime() + dias * DIA_MS) });

export async function buscarPosiblesDuplicadosTx(
  tx: Prisma.TransactionClient,
  usuario: UsuarioSesion,
  criterio: {
    empresaId: string;
    monto: number;
    fecha: Date;
    proyectoId?: string | null;
    // Gasto o egreso de la EMPRESA (no de una obra): se compara contra ambos
    // caminos que la representan — gastos del Proyecto de Oficina y egresos
    // de empresa sin obra — para que el mismo movimiento no quede registrado
    // dos veces por vías distintas. Solo afecta los avisos.
    esGastoDeEmpresa?: boolean;
    proyectoOficinaId?: string | null;
    proveedorBeneficiarioId?: string | null;
    uuids?: string[];
    referencias?: string[];
  }
): Promise<PosibleDuplicado[]> {
  const { empresaId, monto, fecha } = criterio;
  const ocultas = categoriasOcultasPara(usuario);
  const gastoVisible = {
    empresaId,
    estatus: { notIn: ["RECHAZADO", "CANCELADO"] as ("RECHAZADO" | "CANCELADO")[] },
    ...(ocultas.length > 0 ? { categoria: { notIn: ocultas } } : {}),
  };
  const selectGasto = { id: true, fecha: true, monto: true, descripcion: true, categoria: true, proyecto: { select: { nombre: true } } } as const;
  const candidatos: PosibleDuplicado[] = [];
  const deGasto = (g: { id: string; fecha: Date; monto: unknown; descripcion: string; proyecto: { nombre: string } | null }, nivel: NivelDuplicado, motivo: string): PosibleDuplicado => ({
    nivel,
    motivo,
    tipo: "GASTO",
    id: g.id,
    fecha: g.fecha.toISOString(),
    monto: Number(g.monto),
    descripcion: g.descripcion,
    proyectoNombre: g.proyecto?.nombre ?? null,
  });

  // FUERTE — UUID fiscal o referencia bancaria ya registrados en un egreso
  // vigente (de gasto o manual).
  const uuids = (criterio.uuids ?? []).flatMap((u) => [u.toUpperCase(), u.toLowerCase()]);
  const referencias = criterio.referencias ?? [];
  if (uuids.length > 0 || referencias.length > 0) {
    const egresos = await tx.egreso.findMany({
      where: {
        empresaId,
        estatus: "VIGENTE",
        OR: [
          ...(uuids.length > 0 ? [{ factura: { uuid: { in: uuids } } }] : []),
          ...(referencias.length > 0 ? [{ referenciaPago: { in: referencias } }] : []),
        ],
      },
      select: {
        id: true,
        fecha: true,
        monto: true,
        concepto: true,
        referenciaPago: true,
        proyecto: { select: { nombre: true } },
        gastoObra: { select: selectGasto },
      },
      take: 20,
    });
    for (const e of egresos) {
      const motivo = e.referenciaPago && referencias.includes(e.referenciaPago) ? "Misma referencia bancaria" : "Mismo UUID fiscal";
      if (e.gastoObra) {
        if (ocultas.includes(e.gastoObra.categoria)) continue;
        candidatos.push(deGasto(e.gastoObra, "FUERTE", motivo));
      } else {
        candidatos.push({
          nivel: "FUERTE",
          motivo,
          tipo: "EGRESO",
          id: e.id,
          fecha: e.fecha ? e.fecha.toISOString() : null,
          monto: Number(e.monto ?? 0),
          descripcion: e.concepto ?? "Egreso manual",
          proyectoNombre: e.proyecto?.nombre ?? null,
        });
      }
    }
  }

  // MEDIO — mismo proveedor, mismo importe, ±3 días.
  if (criterio.proveedorBeneficiarioId) {
    const gastos = await tx.gastoObra.findMany({
      where: { ...gastoVisible, proveedorBeneficiarioId: criterio.proveedorBeneficiarioId, monto: rangoMonto(monto), fecha: rangoFecha(fecha, 3) },
      select: selectGasto,
      take: 20,
    });
    for (const g of gastos) candidatos.push(deGasto(g, "MEDIO", "Mismo proveedor, importe y fecha cercana"));
  }

  // DEBIL — mismo importe y misma obra (o ambos de la Empresa), ±1 día.
  const proyectoId = criterio.proyectoId ?? null;
  const oficinaId = criterio.proyectoOficinaId ?? null;
  const proyectosDeGasto = [...new Set([proyectoId, ...(criterio.esGastoDeEmpresa ? [oficinaId] : [])].filter((x): x is string => Boolean(x)))];
  const proyectoDeEgreso = criterio.esGastoDeEmpresa
    ? { OR: [{ proyectoId: null }, ...(oficinaId ? [{ proyectoId: oficinaId }] : [])] }
    : { proyectoId };
  const [gastosDebiles, egresosDebiles] = await Promise.all([
    proyectosDeGasto.length > 0
      ? tx.gastoObra.findMany({
          where: { ...gastoVisible, proyectoId: { in: proyectosDeGasto }, monto: rangoMonto(monto), fecha: rangoFecha(fecha, 1) },
          select: selectGasto,
          take: 20,
        })
      : Promise.resolve([]),
    tx.egreso.findMany({
      where: { empresaId, estatus: "VIGENTE", gastoObraId: null, ...proyectoDeEgreso, monto: rangoMonto(monto), fecha: rangoFecha(fecha, 1) },
      select: { id: true, fecha: true, monto: true, concepto: true, proyecto: { select: { nombre: true } } },
      take: 20,
    }),
  ]);
  for (const g of gastosDebiles) candidatos.push(deGasto(g, "DEBIL", "Mismo importe y obra en fecha cercana"));
  for (const e of egresosDebiles) {
    candidatos.push({
      nivel: "DEBIL",
      motivo: "Mismo importe en fecha cercana",
      tipo: "EGRESO",
      id: e.id,
      fecha: e.fecha ? e.fecha.toISOString() : null,
      monto: Number(e.monto ?? 0),
      descripcion: e.concepto ?? "Egreso manual",
      proyectoNombre: e.proyecto?.nombre ?? null,
    });
  }

  // Un mismo registro solo una vez, con su nivel más fuerte.
  const porId = new Map<string, PosibleDuplicado>();
  for (const c of candidatos) {
    const clave = `${c.tipo}:${c.id}`;
    const previo = porId.get(clave);
    if (!previo || ORDEN_NIVEL[c.nivel] < ORDEN_NIVEL[previo.nivel]) porId.set(clave, c);
  }
  return [...porId.values()].sort((a, b) => ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel]);
}

// Serializa la revisión de duplicados y la creación del registro por
// (Empresa, importe): dos personas que confirman al mismo tiempo dos
// documentos de la misma compra nunca pasan ambas la revisión sin verse.
export async function bloquearRevisionDeDuplicadosTx(tx: Prisma.TransactionClient, empresaId: string, monto: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`duplicados:${empresaId}:${Math.round(monto * 100)}`}, 0))`;
}

// Revisa duplicados y, si hay candidatos que no se aceptaron
// explícitamente, detiene la operación sin escribir nada. Devuelve los
// candidatos aceptados (para dejarlos en la auditoría).
export async function exigirRevisionDeDuplicadosTx(
  tx: Prisma.TransactionClient,
  usuario: UsuarioSesion,
  criterio: Parameters<typeof buscarPosiblesDuplicadosTx>[2],
  aceptaPosiblesDuplicados: boolean
): Promise<PosibleDuplicado[]> {
  await bloquearRevisionDeDuplicadosTx(tx, criterio.empresaId, criterio.monto);
  const candidatos = await buscarPosiblesDuplicadosTx(tx, usuario, criterio);
  if (candidatos.length > 0 && !aceptaPosiblesDuplicados) throw new PosiblesDuplicadosError(candidatos);
  return candidatos;
}

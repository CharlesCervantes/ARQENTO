import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { requerirAdministracionComercial } from "@/lib/server/comercializacion/acceso";
import { aMilesimas, formatearCantidad, normalizarCantidad } from "@/lib/comercializacion/importes";
import { milesimasATexto } from "@/lib/comercializacion/entregas";
import { dateAFecha } from "@/lib/comercializacion/fechas";

// Surtido directo a obra — B8A (noviembre 2026). docs/negocio/
// comercializacion.md §20 (B8A). SOLO Administrador/Director.
// - Un vínculo dice qué partida de compra CONFIRMADA (proveedor) surtió una
//   cantidad de una partida ENTREGADA al cliente (B6A). Misma Empresa, OV y
//   partida de venta; nunca por coincidencia de nombre.
// - Cuenta solo si el vínculo está VIGENTE, su entrega CONFIRMADA y su compra
//   CONFIRMADA. Límites: Σ vinculado ≤ entregado (por partida de entrega) y
//   Σ vinculado ≤ comprado (por partida de compra).
// - No es inventario ni recepción en almacén; no cambia cantidades, importes,
//   cuentas, cobros, pagos ni el resultado (B7).
// - Orden de bloqueos: OV primero (igual que registrar/anular entrega y
//   confirmar/anular compra), así las operaciones de una OV se serializan.

export const ENTIDAD_VINCULO = "VinculoSurtidoComercial";
const MAX_LINEAS = 200;

type Tx = Prisma.TransactionClient;
type Cliente = Tx | typeof db;

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

const dec3 = (d: Prisma.Decimal) => d.toFixed(3);
const proveedorDe = (c: { proveedorConfirmado: Prisma.JsonValue; proveedor: { nombre: string } | null }) =>
  (c.proveedorConfirmado as { nombre?: string } | null)?.nombre ?? c.proveedor?.nombre ?? "Proveedor";

// Vínculos que cuentan: vigentes, con entrega y compra confirmadas.
const cuenta = (v: { estatus: string; compraConfirmada: boolean; entregaConfirmada: boolean }) =>
  v.estatus === "VIGENTE" && v.compraConfirmada && v.entregaConfirmada;

// ---------------------------------------------------------------------------
// Consulta desde la OV (bloque «Entregas y documentos», solo administración)
// ---------------------------------------------------------------------------

export type VinculoDetalle = {
  id: string;
  compraId: string;
  compraFolio: string;
  proveedorNombre: string;
  cantidad: string;
  vigente: boolean; // cuenta hoy (vínculo vigente de documentos vigentes)
  estatus: "VIGENTE" | "ANULADO";
  registradoPorNombre: string;
  registradoEn: string;
  anulado: { en: string; porNombre: string; motivo: string } | null;
};

export type CompraElegible = { partidaCompraId: string; compraId: string; folio: string; proveedorNombre: string; comprado: string; vinculado: string; disponible: string };

export type SurtidoPartidaEntrega = {
  partidaEntregaId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  entregado: string;
  vinculado: string;
  pendiente: string;
  vinculos: VinculoDetalle[];
  elegibles: CompraElegible[];
};

export type SurtidoEntrega = { entregaId: string; vigente: boolean; partidas: SurtidoPartidaEntrega[]; pendienteTotal: boolean };

async function cargarSurtidoDeOrden(cliente: Cliente, empresaId: string, ordenVentaId: string) {
  const [partidasEntrega, partidasCompra] = await Promise.all([
    cliente.partidaEntregaComercial.findMany({
      where: { empresaId, entrega: { ordenVentaId, empresaId } },
      select: {
        id: true,
        cantidad: true,
        entregaId: true,
        partidaVentaId: true,
        entrega: { select: { estatus: true } },
        partidaVenta: { select: { codigo: true, descripcion: true, unidad: true, orden: true } },
        vinculosSurtido: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            cantidad: true,
            estatus: true,
            createdAt: true,
            anuladoEn: true,
            motivoAnulacion: true,
            registradoPor: { select: { nombre: true } },
            anuladoPor: { select: { nombre: true } },
            partidaCompra: { select: { compra: { select: { id: true, folio: true, estatus: true, proveedorConfirmado: true, proveedor: { select: { nombre: true } } } } } },
          },
        },
      },
    }),
    cliente.partidaCompraComercial.findMany({
      where: { empresaId, compra: { ordenVentaId, empresaId, estatus: "CONFIRMADA" } },
      orderBy: [{ compra: { numeroFolio: "asc" } }],
      select: {
        id: true,
        cantidad: true,
        partidaVentaId: true,
        compra: { select: { id: true, folio: true, proveedorConfirmado: true, proveedor: { select: { nombre: true } } } },
        vinculosSurtido: { where: { estatus: "VIGENTE" }, select: { cantidad: true, partidaEntrega: { select: { entrega: { select: { estatus: true } } } } } },
      },
    }),
  ]);
  return { partidasEntrega, partidasCompra };
}

/** Surtido por entrega de una OV (Map por entregaId). Solo administración. */
export async function surtidoDeOrden(usuario: UsuarioSesion, ordenVentaId: string): Promise<Record<string, SurtidoEntrega>> {
  const empresaId = requerirAdministracionComercial(usuario);
  const ov = await db.ordenVenta.findFirst({ where: { id: ordenVentaId, empresaId }, select: { id: true } });
  if (!ov) throw new RegistroNoEncontradoError("La orden de venta");
  const { partidasEntrega, partidasCompra } = await cargarSurtidoDeOrden(db, empresaId, ov.id);

  const disponiblePorCompra = new Map(
    partidasCompra.map((pc) => {
      const vinculado = pc.vinculosSurtido.filter((v) => v.partidaEntrega.entrega.estatus === "CONFIRMADA").reduce((s, v) => s + aMilesimas(dec3(v.cantidad)), BigInt(0));
      return [pc.id, { pc, vinculado, disponible: aMilesimas(dec3(pc.cantidad)) - vinculado }];
    })
  );

  const res: Record<string, SurtidoEntrega> = {};
  for (const pe of [...partidasEntrega].sort((a, b) => a.partidaVenta.orden - b.partidaVenta.orden)) {
    const entregaVigente = pe.entrega.estatus === "CONFIRMADA";
    const vinculos: VinculoDetalle[] = pe.vinculosSurtido.map((v) => {
      const c = v.partidaCompra.compra;
      return {
        id: v.id,
        compraId: c.id,
        compraFolio: c.folio,
        proveedorNombre: proveedorDe(c),
        cantidad: dec3(v.cantidad),
        vigente: cuenta({ estatus: v.estatus, compraConfirmada: c.estatus === "CONFIRMADA", entregaConfirmada: entregaVigente }),
        estatus: v.estatus,
        registradoPorNombre: v.registradoPor.nombre,
        registradoEn: v.createdAt.toISOString(),
        anulado: v.anuladoEn ? { en: v.anuladoEn.toISOString(), porNombre: v.anuladoPor?.nombre ?? "—", motivo: v.motivoAnulacion ?? "" } : null,
      };
    });
    const vinculado = vinculos.filter((v) => v.vigente).reduce((s, v) => s + aMilesimas(v.cantidad), BigInt(0));
    const entregado = aMilesimas(dec3(pe.cantidad));
    const elegibles: CompraElegible[] = entregaVigente
      ? [...disponiblePorCompra.values()]
          .filter(({ pc }) => pc.partidaVentaId === pe.partidaVentaId)
          .map(({ pc, vinculado: vc, disponible }) => ({
            partidaCompraId: pc.id,
            compraId: pc.compra.id,
            folio: pc.compra.folio,
            proveedorNombre: proveedorDe(pc.compra),
            comprado: dec3(pc.cantidad),
            vinculado: milesimasATexto(vc),
            disponible: milesimasATexto(disponible),
          }))
      : [];
    const partida: SurtidoPartidaEntrega = {
      partidaEntregaId: pe.id,
      codigo: pe.partidaVenta.codigo,
      descripcion: pe.partidaVenta.descripcion,
      unidad: pe.partidaVenta.unidad,
      entregado: dec3(pe.cantidad),
      vinculado: milesimasATexto(vinculado),
      pendiente: milesimasATexto(entregaVigente ? entregado - vinculado : BigInt(0)),
      vinculos,
      elegibles,
    };
    const e = (res[pe.entregaId] ??= { entregaId: pe.entregaId, vigente: entregaVigente, partidas: [], pendienteTotal: false });
    e.partidas.push(partida);
    if (entregaVigente && entregado > vinculado) e.pendienteTotal = true;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Consulta desde la compra (solo administración)
// ---------------------------------------------------------------------------

export type SurtidoPartidaCompra = {
  partidaCompraId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  comprado: string;
  vinculado: string;
  sinVincular: string;
  entregas: { entregaId: string; numero: number; fechaEntrega: string; cantidad: string }[];
};

export type SurtidoCompra = { ordenFolio: string; cotizacionId: string; partidas: SurtidoPartidaCompra[] };

export async function surtidoDeCompra(usuario: UsuarioSesion, compraId: string): Promise<SurtidoCompra> {
  const empresaId = requerirAdministracionComercial(usuario);
  const compra = await db.compraComercial.findFirst({
    where: { id: compraId, empresaId },
    select: {
      ordenVenta: { select: { folio: true, cotizacionId: true } },
      partidas: {
        orderBy: { orden: "asc" },
        select: {
          id: true,
          codigo: true,
          descripcion: true,
          unidad: true,
          cantidad: true,
          vinculosSurtido: {
            where: { estatus: "VIGENTE", partidaEntrega: { entrega: { estatus: "CONFIRMADA" } } },
            select: { cantidad: true, partidaEntrega: { select: { entrega: { select: { id: true, numero: true, fechaEntrega: true } } } } },
          },
        },
      },
    },
  });
  if (!compra) throw new RegistroNoEncontradoError("La compra");
  return {
    ordenFolio: compra.ordenVenta.folio,
    cotizacionId: compra.ordenVenta.cotizacionId,
    partidas: compra.partidas.map((p) => {
      const vinculado = p.vinculosSurtido.reduce((s, v) => s + aMilesimas(dec3(v.cantidad)), BigInt(0));
      const porEntrega = new Map<string, { entregaId: string; numero: number; fechaEntrega: string; m: bigint }>();
      for (const v of p.vinculosSurtido) {
        const e = v.partidaEntrega.entrega;
        const actual = porEntrega.get(e.id) ?? { entregaId: e.id, numero: e.numero, fechaEntrega: dateAFecha(e.fechaEntrega), m: BigInt(0) };
        actual.m += aMilesimas(dec3(v.cantidad));
        porEntrega.set(e.id, actual);
      }
      return {
        partidaCompraId: p.id,
        codigo: p.codigo,
        descripcion: p.descripcion,
        unidad: p.unidad,
        comprado: dec3(p.cantidad),
        vinculado: milesimasATexto(vinculado),
        sinVincular: milesimasATexto(aMilesimas(dec3(p.cantidad)) - vinculado),
        entregas: [...porEntrega.values()].sort((a, b) => a.numero - b.numero).map(({ m, ...e }) => ({ ...e, cantidad: milesimasATexto(m) })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Bloqueos de la anulación simple de una compra (B8A)
// ---------------------------------------------------------------------------

export type BloqueoSurtido = { texto: string; entregas: { entregaId: string; numero: number }[] };

/**
 * Motivos de surtido que impiden anular una compra (la base los vuelve a
 * exigir). Llamar con la OV ya bloqueada para que el estado no cambie:
 * (a) cantidades vinculadas a entregas vigentes; (b) cantidades entregadas
 * sin vincular en las partidas de venta que abastece la compra.
 */
export async function bloqueosSurtidoDeCompraTx(cliente: Cliente, compraId: string): Promise<BloqueoSurtido[]> {
  const compra = await cliente.compraComercial.findUnique({ where: { id: compraId }, select: { empresaId: true, partidas: { select: { partidaVentaId: true } } } });
  if (!compra) return [];
  const bloqueos: BloqueoSurtido[] = [];
  const vinculados = await cliente.vinculoSurtidoComercial.findMany({
    where: { compraId, estatus: "VIGENTE", partidaEntrega: { entrega: { estatus: "CONFIRMADA" } } },
    select: { partidaEntrega: { select: { entrega: { select: { id: true, numero: true } } } } },
  });
  if (vinculados.length > 0) {
    const entregas = [...new Map(vinculados.map((v) => [v.partidaEntrega.entrega.id, { entregaId: v.partidaEntrega.entrega.id, numero: v.partidaEntrega.entrega.numero }])).values()];
    bloqueos.push({ texto: "la compra tiene cantidades vinculadas a entregas vigentes", entregas });
  }
  const partidasVenta = compra.partidas.map((p) => p.partidaVentaId);
  if (partidasVenta.length > 0) {
    const entregadas = await cliente.partidaEntregaComercial.findMany({
      where: { empresaId: compra.empresaId, partidaVentaId: { in: partidasVenta }, entrega: { estatus: "CONFIRMADA" } },
      select: {
        cantidad: true,
        entrega: { select: { id: true, numero: true } },
        vinculosSurtido: { where: { estatus: "VIGENTE", partidaCompra: { compra: { estatus: "CONFIRMADA" } } }, select: { cantidad: true } },
      },
    });
    const pendientes = entregadas.filter((pe) => aMilesimas(dec3(pe.cantidad)) > pe.vinculosSurtido.reduce((s, v) => s + aMilesimas(dec3(v.cantidad)), BigInt(0)));
    if (pendientes.length > 0) {
      const entregas = [...new Map(pendientes.map((pe) => [pe.entrega.id, { entregaId: pe.entrega.id, numero: pe.entrega.numero }])).values()].sort((a, b) => a.numero - b.numero);
      bloqueos.push({
        texto: "hay entregas vigentes de estos materiales con cantidades sin vincular a una compra; primero identifica qué compra las surtió",
        entregas,
      });
    }
  }
  return bloqueos;
}

/** Para la pantalla de la compra (solo administración). */
export async function bloqueosSurtidoDeCompra(usuario: UsuarioSesion, compraId: string): Promise<BloqueoSurtido[]> {
  const empresaId = requerirAdministracionComercial(usuario);
  const c = await db.compraComercial.findFirst({ where: { id: compraId, empresaId }, select: { id: true, estatus: true } });
  if (!c) throw new RegistroNoEncontradoError("La compra");
  return c.estatus === "CONFIRMADA" ? bloqueosSurtidoDeCompraTx(db, c.id) : [];
}

// ---------------------------------------------------------------------------
// Vincular
// ---------------------------------------------------------------------------

const esquemaLineas = z
  .array(z.object({ partidaEntregaId: z.string().min(1), partidaCompraId: z.string().min(1), cantidad: z.unknown() }), { error: "Indica las cantidades a vincular." })
  .min(1, "Indica al menos una cantidad a vincular.")
  .max(MAX_LINEAS, "Demasiadas líneas.");

export type ResultadoVinculo = { vinculos: number; existente: boolean };

export async function vincularSurtido(usuario: UsuarioSesion, entregaId: unknown, lineasCrudas: unknown, claveCruda: unknown): Promise<ResultadoVinculo> {
  const empresaId = requerirAdministracionComercial(usuario);
  const clave = z.string({ error: "Clave de registro inválida. Recarga la página." }).trim().min(8).max(100).parse(claveCruda);
  if (typeof entregaId !== "string" || !entregaId) throw new RegistroNoEncontradoError("La entrega");
  const base = await db.entregaComercial.findFirst({ where: { id: entregaId, empresaId }, select: { id: true, numero: true, ordenVentaId: true, ordenVenta: { select: { folio: true } } } });
  if (!base) throw new RegistroNoEncontradoError("La entrega");

  // Idempotencia: una captura = una clave; sus vínculos llevan «clave#n».
  const previa = async (): Promise<ResultadoVinculo | null> => {
    const vs = await db.vinculoSurtidoComercial.findMany({ where: { empresaId, claveRegistro: { startsWith: `${clave}#` } }, select: { entregaId: true } });
    if (vs.length === 0) return null;
    if (vs.some((v) => v.entregaId !== entregaId)) throw new ValidacionError("Clave de registro inválida. Recarga la página.");
    return { vinculos: vs.length, existente: true };
  };
  const repetida = await previa();
  if (repetida) return repetida;

  const lineas: { partidaEntregaId: string; partidaCompraId: string; cantidad: string }[] = [];
  for (const l of esquemaLineas.parse(lineasCrudas)) {
    if (l.cantidad === undefined || l.cantidad === null || (typeof l.cantidad === "string" && /^\s*0*(\.0*)?\s*$/.test(l.cantidad))) continue;
    const cantidad = normalizarCantidad(l.cantidad);
    if (!cantidad) throw new ValidacionError("Las cantidades deben ser positivas, con máximo 3 decimales.");
    if (lineas.some((x) => x.partidaEntregaId === l.partidaEntregaId && x.partidaCompraId === l.partidaCompraId)) {
      throw new ValidacionError("Cada compra aparece una sola vez por material en la misma captura.");
    }
    lineas.push({ partidaEntregaId: l.partidaEntregaId, partidaCompraId: l.partidaCompraId, cantidad });
  }
  if (lineas.length === 0) throw new ValidacionError("Indica al menos una cantidad a vincular.");

  try {
    return await db.$transaction(async (tx) => {
      // OV primero (mismo orden que entregas y compras), después validaciones.
      await tx.$queryRaw`SELECT id FROM ordenes_venta WHERE id = ${base.ordenVentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
      const entrega = await tx.entregaComercial.findFirstOrThrow({ where: { id: entregaId }, select: { estatus: true } });
      if (entrega.estatus !== "CONFIRMADA") throw new ValidacionError("La entrega está anulada: no se le vinculan compras.");
      const { partidasEntrega, partidasCompra } = await cargarSurtidoDeOrden(tx, empresaId, base.ordenVentaId);
      const pes = new Map(partidasEntrega.filter((pe) => pe.entregaId === entregaId).map((pe) => [pe.id, pe]));
      const pcs = new Map(partidasCompra.map((pc) => [pc.id, pc]));
      const usadoEntrega = new Map<string, bigint>();
      const usadoCompra = new Map<string, bigint>();
      for (const pe of pes.values()) {
        usadoEntrega.set(pe.id, pe.vinculosSurtido.filter((v) => v.estatus === "VIGENTE" && v.partidaCompra.compra.estatus === "CONFIRMADA").reduce((s, v) => s + aMilesimas(dec3(v.cantidad)), BigInt(0)));
      }
      for (const pc of pcs.values()) {
        usadoCompra.set(pc.id, pc.vinculosSurtido.filter((v) => v.partidaEntrega.entrega.estatus === "CONFIRMADA").reduce((s, v) => s + aMilesimas(dec3(v.cantidad)), BigInt(0)));
      }
      const inicialEntrega = new Map(usadoEntrega);
      const inicialCompra = new Map(usadoCompra);
      const capturadoEntrega = new Map<string, bigint>();
      const capturadoCompra = new Map<string, bigint>();
      const datos = lineas.map((l, i) => {
        const pe = pes.get(l.partidaEntregaId);
        if (!pe) throw new ValidacionError("Uno de los materiales no pertenece a esta entrega.");
        const pc = pcs.get(l.partidaCompraId);
        // Compra confirmada de la misma OV (cargarSurtidoDeOrden ya filtra) y misma partida de venta.
        if (!pc) throw new ValidacionError("Solo se vinculan compras confirmadas y vigentes de esta orden de venta.");
        if (pc.partidaVentaId !== pe.partidaVentaId) throw new ValidacionError(`${pe.partidaVenta.codigo}: la compra elegida no corresponde a este material.`);
        const m = aMilesimas(l.cantidad);
        const unidad = pe.partidaVenta.unidad;
        const ue = usadoEntrega.get(pe.id)! + m;
        const entregado = aMilesimas(dec3(pe.cantidad));
        capturadoEntrega.set(pe.id, (capturadoEntrega.get(pe.id) ?? BigInt(0)) + m);
        if (ue > entregado) {
          const disponible = formatearCantidad(milesimasATexto(entregado - inicialEntrega.get(pe.id)!));
          throw new ValidacionError(
            `${pe.partidaVenta.codigo}: la captura suma ${formatearCantidad(milesimasATexto(capturadoEntrega.get(pe.id)!))} ${unidad} y supera lo entregado sin vincular (${disponible} ${unidad}).`
          );
        }
        const uc = usadoCompra.get(pc.id)! + m;
        const comprado = aMilesimas(dec3(pc.cantidad));
        capturadoCompra.set(pc.id, (capturadoCompra.get(pc.id) ?? BigInt(0)) + m);
        if (uc > comprado) {
          throw new ValidacionError(
            `${pe.partidaVenta.codigo}: ${pc.compra.folio} solo tiene ${formatearCantidad(milesimasATexto(comprado - inicialCompra.get(pc.id)!))} ${unidad} sin vincular (la captura pide ${formatearCantidad(milesimasATexto(capturadoCompra.get(pc.id)!))}).`
          );
        }
        usadoEntrega.set(pe.id, ue);
        usadoCompra.set(pc.id, uc);
        return {
          empresaId,
          partidaEntregaId: pe.id,
          partidaCompraId: pc.id,
          ordenVentaId: base.ordenVentaId,
          entregaId,
          compraId: pc.compra.id,
          partidaVentaId: pe.partidaVentaId,
          cantidad: l.cantidad,
          claveRegistro: `${clave}#${i}`,
          registradoPorId: usuario.id,
        };
      });
      await tx.vinculoSurtidoComercial.createMany({ data: datos });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_VINCULO,
        entidadId: entregaId,
        accion: "CREAR",
        valorNuevo: { ordenVenta: base.ordenVenta.folio, entrega: base.numero, vinculos: datos.map((d) => ({ material: pes.get(d.partidaEntregaId)!.partidaVenta.codigo, compra: pcs.get(d.partidaCompraId)!.compra.folio, cantidad: d.cantidad })) },
      });
      return { vinculos: datos.length, existente: false };
    });
  } catch (error) {
    if (esUnica(error)) {
      const ganadora = await previa().catch(() => null);
      if (ganadora) return ganadora;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Anular un vínculo capturado por error
// ---------------------------------------------------------------------------

export async function anularVinculoSurtido(usuario: UsuarioSesion, vinculoId: unknown, motivoCrudo: unknown): Promise<{ existente: boolean }> {
  const empresaId = requerirAdministracionComercial(usuario);
  if (typeof vinculoId !== "string" || !vinculoId) throw new RegistroNoEncontradoError("El vínculo");
  const motivo = z
    .string({ error: "Indica el motivo de la anulación." })
    .trim()
    .min(3, "Indica el motivo de la anulación (mínimo 3 caracteres).")
    .max(500, "El motivo admite máximo 500 caracteres.")
    .parse(motivoCrudo);
  const base = await db.vinculoSurtidoComercial.findFirst({ where: { id: vinculoId, empresaId }, select: { ordenVentaId: true } });
  if (!base) throw new RegistroNoEncontradoError("El vínculo");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ordenes_venta WHERE id = ${base.ordenVentaId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    const [v] = await tx.$queryRaw<{ estatus: string; cantidad: string; entregaId: string; compraId: string }[]>`
      SELECT estatus::text AS estatus, cantidad::text AS cantidad, "entregaId", "compraId" FROM vinculos_surtido_comercial WHERE id = ${vinculoId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    if (!v) throw new RegistroNoEncontradoError("El vínculo");
    if (v.estatus === "ANULADO") return { existente: true }; // idempotente
    await tx.vinculoSurtidoComercial.update({ where: { id: vinculoId }, data: { estatus: "ANULADO", anuladoEn: new Date(), anuladoPorId: usuario.id, motivoAnulacion: motivo } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_VINCULO,
      entidadId: vinculoId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: "VIGENTE" },
      valorNuevo: { estatus: "ANULADO", cantidad: v.cantidad, entregaId: v.entregaId, compraId: v.compraId, motivo },
    });
    return { existente: false };
  });
}

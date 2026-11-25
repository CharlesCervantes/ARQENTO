import "server-only";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeProponerContrato, puedeResolverPropuestas } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { DatosConceptoSchema, DatosPartidaSchema, RegistroNoEncontradoError, normalizarCostosParaCreacion } from "./estructura-contractual";

// Partidas y conceptos que propone un Supervisor. Mientras están pendientes no
// existen para contrato, avance, asignaciones ni estimaciones; al aprobarse
// crean la Partida o el Concepto real con los mismos datos.

type Tx = Prisma.TransactionClient;

function requerirProponente(usuario: UsuarioSesion): string {
  if (!puedeProponerContrato(usuario) || !usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

async function crear(usuario: UsuarioSesion, data: Prisma.PropuestaContratoUncheckedCreateInput) {
  return db.$transaction(async (tx) => {
    const p = await tx.propuestaContrato.create({ data });
    await registrarAuditoriaTx(tx, { empresaId: p.empresaId, usuarioId: usuario.id, entidad: "PropuestaContrato", entidadId: p.id, accion: "CREAR", valorNuevo: p });
    return p;
  });
}

export async function proponerPartida(usuario: UsuarioSesion, proyectoId: string, datosCrudos: unknown) {
  const empresaId = requerirProponente(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosPartidaSchema.parse(datosCrudos);
  return crear(usuario, { empresaId, proyectoId, tipo: "PARTIDA", descripcion: datos.nombre, icono: datos.icono, color: datos.color, solicitadoPorId: usuario.id });
}

/** `destino`: una partida ya existente o una propuesta de partida pendiente. */
export async function proponerConcepto(
  usuario: UsuarioSesion,
  proyectoId: string,
  destino: { partidaId: string } | { propuestaPartidaId: string },
  datosCrudos: unknown
) {
  const empresaId = requerirProponente(usuario);
  const proyecto = await obtenerProyecto(usuario, proyectoId);
  const datos = normalizarCostosParaCreacion(DatosConceptoSchema.parse(datosCrudos), proyecto.esquemaContractual);

  let partidaId: string | null = null;
  let padreId: string | null = null;
  if ("partidaId" in destino) {
    const partida = await db.partida.findFirst({ where: { id: destino.partidaId, proyectoId, estatus: "ACTIVA" }, select: { id: true } });
    if (!partida) throw new RegistroNoEncontradoError("La partida");
    partidaId = partida.id;
  } else {
    const padre = await db.propuestaContrato.findFirst({ where: { id: destino.propuestaPartidaId, proyectoId, tipo: "PARTIDA", estatus: "PENDIENTE" }, select: { id: true } });
    if (!padre) throw new ValidacionError("Esa partida ya no está pendiente. Actualiza la página.");
    padreId = padre.id;
  }
  return crear(usuario, {
    empresaId, proyectoId, tipo: "CONCEPTO", partidaId, padreId,
    descripcion: datos.descripcion, unidad: datos.unidad, cantidad: datos.cantidadContratada,
    precioUnitarioContratista: datos.precioUnitarioContratista, precioUnitarioMateriales: datos.precioUnitarioMateriales,
    solicitadoPorId: usuario.id,
  });
}

// Candado por proyecto: aprobar/rechazar/retirar una partida y sus conceptos
// nunca se cruza con otra decisión a la vez.
async function bloquear(tx: Tx, proyectoId: string, empresaId: string, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"propuestas:" + proyectoId}))`;
  const p = await tx.propuestaContrato.findFirst({ where: { id, proyectoId, empresaId } });
  if (!p) throw new RegistroNoEncontradoError("La propuesta");
  if (p.estatus !== "PENDIENTE") throw new ValidacionError("Esta propuesta ya fue resuelta. Actualiza la página.");
  return p;
}

type Propuesta = Awaited<ReturnType<typeof bloquear>>;

async function resolver(tx: Tx, usuario: UsuarioSesion, p: Propuesta, estatus: "APROBADA" | "RECHAZADA" | "RETIRADA", extra: { motivo?: string; resultadoId?: string } = {}) {
  await tx.propuestaContrato.update({ where: { id: p.id }, data: { estatus, resueltoPorId: usuario.id, resueltoEn: new Date(), ...extra } });
  await registrarAuditoriaTx(tx, {
    empresaId: p.empresaId, usuarioId: usuario.id, entidad: "PropuestaContrato", entidadId: p.id,
    accion: estatus === "APROBADA" ? "CONFIRMAR" : estatus === "RECHAZADA" ? "RECHAZAR" : "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: "PENDIENTE" }, valorNuevo: { estatus, ...extra },
  });
}

async function crearPartidaReal(tx: Tx, usuario: UsuarioSesion, p: Propuesta): Promise<string> {
  const partida = await tx.partida.create({ data: { proyectoId: p.proyectoId, nombre: p.descripcion, icono: p.icono, color: p.color } });
  await registrarAuditoriaTx(tx, { empresaId: p.empresaId, usuarioId: usuario.id, entidad: "Partida", entidadId: partida.id, accion: "CREAR", valorNuevo: { ...partida, propuestaId: p.id, solicitadoPorId: p.solicitadoPorId } });
  await tx.propuestaContrato.updateMany({ where: { padreId: p.id }, data: { partidaId: partida.id } });
  await resolver(tx, usuario, p, "APROBADA", { resultadoId: partida.id });
  return partida.id;
}

/** Aprobar un concepto de una partida todavía pendiente aprueba también la partida. */
export async function aprobarPropuesta(usuario: UsuarioSesion, proyectoId: string, id: string) {
  if (!puedeResolverPropuestas(usuario) || !usuario.empresa) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;
  await obtenerProyecto(usuario, proyectoId);

  return db.$transaction(async (tx) => {
    const p = await bloquear(tx, proyectoId, empresaId, id);
    if (p.tipo === "PARTIDA") return { id: await crearPartidaReal(tx, usuario, p) };

    let partidaId = p.partidaId;
    if (!partidaId && p.padreId) {
      const padre = await tx.propuestaContrato.findUniqueOrThrow({ where: { id: p.padreId } });
      if (padre.estatus === "PENDIENTE") partidaId = await crearPartidaReal(tx, usuario, padre);
    }
    const partida = partidaId ? await tx.partida.findFirst({ where: { id: partidaId, proyectoId, estatus: "ACTIVA" } }) : null;
    if (!partida) throw new ValidacionError("La partida de este concepto ya no existe. Recházalo o pide que lo propongan en otra.");

    const concepto = await tx.concepto.create({
      data: {
        partidaId: partida.id, descripcion: p.descripcion, unidad: p.unidad!, cantidadContratada: p.cantidad!,
        precioUnitarioContratista: p.precioUnitarioContratista, precioUnitarioMateriales: p.precioUnitarioMateriales,
      },
    });
    await registrarAuditoriaTx(tx, { empresaId, usuarioId: usuario.id, entidad: "Concepto", entidadId: concepto.id, accion: "CREAR", valorNuevo: { ...concepto, propuestaId: p.id, solicitadoPorId: p.solicitadoPorId } });
    await resolver(tx, usuario, p, "APROBADA", { resultadoId: concepto.id });
    return { id: concepto.id };
  });
}

async function descartar(usuario: UsuarioSesion, p: { proyectoId: string; empresaId: string; id: string }, estatus: "RECHAZADA" | "RETIRADA", motivo?: string) {
  await db.$transaction(async (tx) => {
    const propuesta = await bloquear(tx, p.proyectoId, p.empresaId, p.id);
    if (estatus === "RETIRADA" && propuesta.solicitadoPorId !== usuario.id) throw new SinPermisoError();
    const hijas = await tx.propuestaContrato.findMany({ where: { padreId: propuesta.id, estatus: "PENDIENTE" } });
    if (estatus === "RETIRADA" && hijas.some((h) => h.solicitadoPorId !== usuario.id)) {
      throw new ValidacionError("Otra persona propuso conceptos en esta partida; no se puede retirar.");
    }
    for (const x of [propuesta, ...hijas]) await resolver(tx, usuario, x, estatus, motivo ? { motivo } : {});
  });
}

/** Rechazar una partida rechaza también los conceptos pendientes que traía. */
export async function rechazarPropuesta(usuario: UsuarioSesion, proyectoId: string, id: string, motivoCrudo: unknown) {
  if (!puedeResolverPropuestas(usuario) || !usuario.empresa) throw new SinPermisoError();
  await obtenerProyecto(usuario, proyectoId);
  const motivo = typeof motivoCrudo === "string" ? motivoCrudo.trim() : "";
  if (!motivo) throw new ValidacionError("El motivo es obligatorio.");
  await descartar(usuario, { proyectoId, empresaId: usuario.empresa.id, id }, "RECHAZADA", motivo);
}

/** El Supervisor retira lo que él propuso, mientras siga pendiente. */
export async function retirarPropuesta(usuario: UsuarioSesion, proyectoId: string, id: string) {
  const empresaId = requerirProponente(usuario);
  await obtenerProyecto(usuario, proyectoId);
  await descartar(usuario, { proyectoId, empresaId, id }, "RETIRADA");
}

export type FilaPropuesta = {
  id: string;
  tipo: "PARTIDA" | "CONCEPTO";
  estatus: "PENDIENTE" | "RECHAZADA";
  partidaId: string | null;
  padreId: string | null;
  descripcion: string;
  unidad: string | null;
  cantidad: number | null;
  precioUnitarioContratista: number | null;
  precioUnitarioMateriales: number | null;
  solicitadoPorNombre: string;
  esMia: boolean;
  motivo: string | null;
};

const DIAS_RECHAZADAS = 30;

/** Pendientes de la obra y, para quien propuso, lo que le rechazaron hace poco. */
export async function obtenerPropuestas(usuario: UsuarioSesion, proyectoId: string): Promise<FilaPropuesta[]> {
  await obtenerProyecto(usuario, proyectoId);
  const filas = await db.propuestaContrato.findMany({
    where: {
      proyectoId,
      OR: [
        { estatus: "PENDIENTE" },
        { estatus: "RECHAZADA", solicitadoPorId: usuario.id, resueltoEn: { gte: new Date(Date.now() - DIAS_RECHAZADAS * 86_400_000) } },
      ],
    },
    include: { solicitadoPor: { select: { nombre: true } } },
    orderBy: { createdAt: "asc" },
  });
  const num = (v: { toNumber(): number } | null) => (v === null ? null : v.toNumber());
  return filas.map((f) => ({
    id: f.id, tipo: f.tipo, estatus: f.estatus as FilaPropuesta["estatus"], partidaId: f.partidaId, padreId: f.padreId,
    descripcion: f.descripcion, unidad: f.unidad, cantidad: num(f.cantidad),
    precioUnitarioContratista: num(f.precioUnitarioContratista), precioUnitarioMateriales: num(f.precioUnitarioMateriales),
    solicitadoPorNombre: f.solicitadoPor.nombre, esMia: f.solicitadoPorId === usuario.id, motivo: f.motivo,
  }));
}

/** Aviso del menú; `proyectoId` para una obra, o toda la empresa. */
export async function hayPropuestasPendientes(filtro: { proyectoId: string } | { empresaId: string }): Promise<boolean> {
  return (await db.propuestaContrato.count({ where: { ...filtro, estatus: "PENDIENTE" } })) > 0;
}

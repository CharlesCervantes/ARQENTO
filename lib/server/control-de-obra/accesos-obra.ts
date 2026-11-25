import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeAsignarObras } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";

function requerirAsignar(usuario: UsuarioSesion): string {
  if (!puedeAsignarObras(usuario) || !usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

export type SupervisorConAccesos = { id: string; nombre: string; activo: boolean; obraIds: string[] };
export type ObraAsignable = { id: string; nombre: string; estatus: string };

export async function obtenerAccesosSupervisores(
  usuario: UsuarioSesion
): Promise<{ supervisores: SupervisorConAccesos[]; obras: ObraAsignable[] }> {
  const empresaId = requerirAsignar(usuario);
  const [supervisores, obras] = await Promise.all([
    db.usuario.findMany({
      where: { empresaId, rol: "SUPERVISOR" },
      select: { id: true, nombre: true, activo: true, accesosObra: { select: { proyectoId: true } } },
      orderBy: [{ activo: "desc" }, { nombre: "asc" }],
    }),
    db.proyecto.findMany({
      where: { empresaId, tipo: { not: "OFICINA" } },
      select: { id: true, nombre: true, estatus: true },
      orderBy: [{ estatus: "asc" }, { nombre: "asc" }],
    }),
  ]);
  return {
    supervisores: supervisores.map((s) => ({
      id: s.id,
      nombre: s.nombre,
      activo: s.activo,
      obraIds: s.accesosObra.map((a) => a.proyectoId),
    })),
    obras,
  };
}

const DatosSchema = z.object({ supervisorId: z.string().min(1), obraIds: z.array(z.string().min(1)).max(1000) });

/** Reemplaza las obras que puede ver un Supervisor, con bitácora. */
export async function guardarAccesosSupervisor(usuario: UsuarioSesion, datosCrudos: unknown): Promise<{ cambios: boolean }> {
  const empresaId = requerirAsignar(usuario);
  const datos = DatosSchema.parse(datosCrudos);
  const obraIds = [...new Set(datos.obraIds)];

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${datos.supervisorId} FOR UPDATE`;
    const supervisor = await tx.usuario.findFirst({
      where: { id: datos.supervisorId, empresaId, rol: "SUPERVISOR" },
      select: { id: true, accesosObra: { select: { proyectoId: true } } },
    });
    if (!supervisor) throw new RegistroNoEncontradoError("El supervisor");
    const validas = await tx.proyecto.count({ where: { id: { in: obraIds }, empresaId, tipo: { not: "OFICINA" } } });
    if (validas !== obraIds.length) throw new ValidacionError("Alguna obra seleccionada no es válida.");

    const antes = supervisor.accesosObra.map((a) => a.proyectoId);
    const agregar = obraIds.filter((id) => !antes.includes(id));
    const quitar = antes.filter((id) => !obraIds.includes(id));
    if (agregar.length === 0 && quitar.length === 0) return { cambios: false };

    if (quitar.length > 0) await tx.accesoObra.deleteMany({ where: { usuarioId: supervisor.id, proyectoId: { in: quitar } } });
    if (agregar.length > 0) await tx.accesoObra.createMany({ data: agregar.map((proyectoId) => ({ usuarioId: supervisor.id, proyectoId })) });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "AccesoObra",
      entidadId: supervisor.id,
      accion: "EDITAR",
      valorAnterior: { obraIds: antes },
      valorNuevo: { obraIds, agregadas: agregar, retiradas: quitar },
    });
    return { cambios: true };
  });
}

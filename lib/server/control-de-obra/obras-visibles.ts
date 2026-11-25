import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";

// Alcance por obra del Supervisor (noviembre 2026). Único punto que decide qué
// obras ve: toda lectura o escritura por obra, o por id de algo de la obra,
// pasa por aquí. Los demás roles no tienen este límite.

/** Solo el Supervisor está limitado a sus obras asignadas. */
export function limitadoASusObras(usuario: UsuarioSesion): boolean {
  return usuario.rol === "SUPERVISOR";
}

/** Filtro de Proyecto. Gastos de Empresa (OFICINA) no es una obra asignable. */
export function filtroObrasVisibles(usuario: UsuarioSesion): Prisma.ProyectoWhereInput {
  if (!limitadoASusObras(usuario)) return {};
  return { tipo: { not: "OFICINA" }, accesosObra: { some: { usuarioId: usuario.id } } };
}

/**
 * Filtro de GastoObra: los de sus obras y, de Gastos de Empresa, solo los que
 * él mismo capturó.
 */
export function filtroGastosVisibles(usuario: UsuarioSesion): Prisma.GastoObraWhereInput {
  if (!limitadoASusObras(usuario)) return {};
  return {
    OR: [{ proyecto: filtroObrasVisibles(usuario) }, { proyecto: { tipo: "OFICINA" }, capturadoPorId: usuario.id }],
  };
}

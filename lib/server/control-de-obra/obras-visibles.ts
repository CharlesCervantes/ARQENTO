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
    AND: [
      { OR: [{ proyecto: filtroObrasVisibles(usuario) }, { proyecto: { tipo: "OFICINA" }, capturadoPorId: usuario.id }] },
      {
        OR: [
          { tratamientoCliente: { not: "COBRABLE_SOLO_PRIVADO" } },
          { capturadoPorId: usuario.id },
          { pagador: { usuarioId: usuario.id } },
        ],
      },
    ],
  };
}

// Lo «Cobrable solo en Privado» no existe para el Supervisor: ni el gasto, ni
// su orden de compra, requisición o reposición. Conserva lo que él mismo
// capturó, solicitó o pagó, para no ocultarle lo que se le debe.

export function filtroOrdenesVisibles(usuario: UsuarioSesion): Prisma.OrdenCompraWhereInput {
  if (!limitadoASusObras(usuario)) return {};
  return {
    proyecto: filtroObrasVisibles(usuario),
    AND: [
      {
        OR: [
          {
            tratamientoCliente: { not: "COBRABLE_SOLO_PRIVADO" },
            gastosGenerados: { none: { tratamientoCliente: "COBRABLE_SOLO_PRIVADO" } },
          },
          { creadoPorId: usuario.id },
        ],
      },
    ],
  };
}

export function filtroRequisicionesVisibles(usuario: UsuarioSesion): Prisma.RequisicionWhereInput {
  if (!limitadoASusObras(usuario)) return {};
  return {
    proyecto: filtroObrasVisibles(usuario),
    AND: [{ OR: [{ ordenCompra: { is: null } }, { ordenCompra: { is: filtroOrdenesVisibles(usuario) } }, { solicitantePorId: usuario.id }] }],
  };
}

export function filtroReposicionesVisibles(usuario: UsuarioSesion): Prisma.ReposicionGastosWhereInput {
  if (!limitadoASusObras(usuario)) return {};
  return {
    proyecto: filtroObrasVisibles(usuario),
    AND: [{ OR: [{ gastos: { none: { tratamientoCliente: "COBRABLE_SOLO_PRIVADO", capturadoPorId: { not: usuario.id } } } }, { beneficiario: { usuarioId: usuario.id } }] }],
  };
}

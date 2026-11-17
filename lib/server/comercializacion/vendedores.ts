import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { requerirAdministracionComercial } from "@/lib/server/comercializacion/acceso";

// Función Vendedor de Comercialización — B1 (noviembre 2026). Administrador/
// Director de una Empresa activan o retiran la marca vendedorComercial a
// SUS Supervisores. Esta acción solo escribe ese campo: nunca cambia rol,
// Empresa, estado de la cuenta ni ningún otro permiso. Un usuario de otra
// Empresa "no existe" para quien la ejecuta.

export type UsuarioElegibleVendedor = {
  id: string;
  nombre: string;
  email: string;
  activo: boolean;
  vendedorComercial: boolean;
};

/** Supervisores de la Empresa del administrador (únicos elegibles). */
export async function listarUsuariosElegiblesVendedor(usuario: UsuarioSesion): Promise<UsuarioElegibleVendedor[]> {
  const empresaId = requerirAdministracionComercial(usuario);
  return db.usuario.findMany({
    where: { empresaId, rol: "SUPERVISOR" },
    select: { id: true, nombre: true, email: true, activo: true, vendedorComercial: true },
    orderBy: [{ activo: "desc" }, { nombre: "asc" }],
  });
}

const esquema = z.object({
  usuarioId: z.string().min(1, "Usuario inválido."),
  vendedor: z.boolean({ error: "Valor inválido." }),
});

export async function cambiarMarcaVendedorComercial(usuario: UsuarioSesion, datosCrudos: unknown): Promise<void> {
  const empresaId = requerirAdministracionComercial(usuario);
  const { usuarioId, vendedor } = esquema.parse(datosCrudos);

  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND "empresaId" = ${empresaId} FOR UPDATE`;
    const objetivo = await tx.usuario.findFirst({
      where: { id: usuarioId, empresaId },
      select: { id: true, rol: true, activo: true, vendedorComercial: true },
    });
    if (!objetivo) throw new RegistroNoEncontradoError("El usuario");
    // Retirar la marca siempre se permite (también a una cuenta desactivada,
    // o a quien ya no es Supervisor); otorgarla solo a Supervisores activos.
    if (vendedor && objetivo.rol !== "SUPERVISOR") {
      throw new ValidacionError("Solo un Supervisor puede tener la función Vendedor.");
    }
    if (vendedor && !objetivo.activo) throw new ValidacionError("El usuario está desactivado.");
    if (objetivo.vendedorComercial === vendedor) return;

    await tx.usuario.update({ where: { id: objetivo.id }, data: { vendedorComercial: vendedor } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "Usuario",
      entidadId: objetivo.id,
      accion: vendedor ? "ACTIVAR" : "DESACTIVAR",
      valorAnterior: { vendedorComercial: objetivo.vendedorComercial },
      valorNuevo: { vendedorComercial: vendedor },
    });
  });
}

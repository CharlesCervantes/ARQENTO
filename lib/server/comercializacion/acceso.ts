import "server-only";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError } from "@/lib/server/control-de-obra/proyectos";
import {
  MODULO_COMERCIALIZACION,
  empresaTieneModulo,
  esAdministradorComercial,
  puedeUsarComercializacion,
} from "@/lib/server/permisos";

// Puertas de servidor de Comercialización. TODO servicio del módulo empieza
// por una de estas funciones y obtiene de aquí el empresaId — nunca de un
// parámetro enviado por el cliente (aislamiento por Empresa en un solo lugar).

// Hereda de SinPermisoError para que manejarErrorApi y las acciones
// existentes lo traten como 403/permiso, pero con un mensaje propio del
// módulo (el de la clase base habla de "administrar proyectos").
export class SinPermisoComercialError extends SinPermisoError {
  constructor(mensaje = "No tienes permiso para esta acción de Comercialización.") {
    super();
    this.message = mensaje;
    this.name = "SinPermisoComercialError";
  }
}

export type MotivoSinAcceso = "SIN_EMPRESA" | "SIN_MODULO" | "SIN_PERMISO";

/** Para pantallas: decide qué mensaje mostrar sin lanzar. */
export function evaluarAccesoComercial(usuario: UsuarioSesion): { permitido: true } | { permitido: false; motivo: MotivoSinAcceso } {
  if (!usuario.empresa) return { permitido: false, motivo: "SIN_EMPRESA" };
  if (!empresaTieneModulo(usuario, MODULO_COMERCIALIZACION) || usuario.rol === "MASTER") {
    return { permitido: false, motivo: "SIN_MODULO" };
  }
  if (!puedeUsarComercializacion(usuario)) return { permitido: false, motivo: "SIN_PERMISO" };
  return { permitido: true };
}

/** Administrador/Director o vendedor marcado, con el módulo habilitado. */
export function requerirUsoComercial(usuario: UsuarioSesion): string {
  if (!usuario.empresa || !puedeUsarComercializacion(usuario)) {
    throw new SinPermisoComercialError("No tienes acceso a Comercialización.");
  }
  return usuario.empresa.id;
}

/** Solo Administrador/Director de la Empresa, con el módulo habilitado. */
export function requerirAdministracionComercial(usuario: UsuarioSesion): string {
  if (!usuario.empresa || !esAdministradorComercial(usuario)) {
    throw new SinPermisoComercialError("Solo administración puede realizar esta acción en Comercialización.");
  }
  return usuario.empresa.id;
}

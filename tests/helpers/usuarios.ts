import type { UsuarioSesion } from "@/lib/server/session";

type Rol = UsuarioSesion["rol"];

// Usuario de sesión ficticio — misma forma que devuelve getUsuarioActual().
export function usuarioDePrueba(opciones: {
  rol: Rol;
  vistaPrivadaActiva?: boolean;
  privadoHabilitado?: boolean;
  // Otra Empresa (pruebas de aislamiento multiempresa).
  empresaId?: string;
  // Comercialización: marca de vendedor y módulos concedidos por override
  // de Empresa (sin Plan). Por omisión: sin marca y sin módulos.
  vendedorComercial?: boolean;
  modulos?: string[];
}): UsuarioSesion {
  const {
    rol,
    vistaPrivadaActiva = true,
    privadoHabilitado = true,
    empresaId = "empresa-prueba",
    vendedorComercial = false,
    modulos = [],
  } = opciones;
  const esMaster = rol === "MASTER";
  return {
    id: `usuario-${rol.toLowerCase()}`,
    nombre: "Usuario Prueba",
    email: `${rol.toLowerCase()}@prueba.invalid`,
    rol,
    activo: true,
    empresaId: esMaster ? null : empresaId,
    vistaPrivadaActiva,
    debeCambiarPassword: false,
    vendedorComercial,
    empresa: esMaster
      ? null
      : {
          id: empresaId,
          nombre: "Constructora Prueba",
          razonSocial: "Constructora Prueba SA de CV",
          colorPrimario: null,
          colorSecundario: null,
          logoRef: null,
          activa: true,
          privadoHabilitado,
          plan: null,
          modulosOverride: modulos.map((clave) => ({ habilitado: true, modulo: { clave, nombre: clave } })),
        },
  } as UsuarioSesion;
}

// Todas las combinaciones de rol × switch personal × Empresa habilitada
// (3 × 2 × 2 = 12), cada una se prueba con vista pedida General y Privado.
export const ROLES_CON_EMPRESA: Rol[] = ["DIRECTOR", "ADMINISTRADOR", "SUPERVISOR"];

export function combinacionesDeAcceso() {
  const casos: { rol: Rol; vistaPrivadaActiva: boolean; privadoHabilitado: boolean }[] = [];
  for (const rol of ROLES_CON_EMPRESA) {
    for (const vistaPrivadaActiva of [true, false]) {
      for (const privadoHabilitado of [true, false]) {
        casos.push({ rol, vistaPrivadaActiva, privadoHabilitado });
      }
    }
  }
  return casos;
}

import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { esMaster } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import { MOTIVOS_REVOCACION, revocarVinculosDeUsuarioTx } from "@/lib/server/whatsapp/vinculos";
import { hashPassword } from "@/lib/server/password";
import {
  crearUsuario,
  generarPasswordTemporal,
  regenerarPasswordTemporal,
} from "@/lib/server/auth/service";

// Capa de lectura/escritura exclusiva del Portal Master — todo aquí exige
// esMaster(usuario) explícitamente (nunca se asume desde el llamador) y
// nunca expone datos financieros de un tenant (montos, movimientos,
// contratos) — solo identidad, estatus, módulos y usuarios (decisión de
// sesión, Portal Master).

export class SinPermisoMasterError extends Error {
  constructor() {
    super("No tienes permiso para administrar la plataforma.");
    this.name = "SinPermisoMasterError";
  }
}

export class EmpresaNoEncontradaError extends Error {
  constructor() {
    super("La empresa no existe.");
    this.name = "EmpresaNoEncontradaError";
  }
}

export class UsuarioNoEncontradoError extends Error {
  constructor() {
    super("El usuario no existe o no pertenece a esta empresa.");
    this.name = "UsuarioNoEncontradoError";
  }
}

export class ValidacionMasterError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ValidacionMasterError";
  }
}

function requerirMaster(usuario: UsuarioSesion): void {
  if (!esMaster(usuario)) throw new SinPermisoMasterError();
}

// Roles asignables a un usuario DENTRO de una Empresa desde el Portal
// Master — MASTER nunca es un valor aceptable aquí, sin importar que
// crearUsuario() (auth/service.ts) siga aceptándolo genéricamente para el
// caso de un usuario de plataforma (decisión de sesión, Portal Master/C.4).
export const RolTenantSchema = z.enum(["DIRECTOR", "ADMINISTRADOR", "SUPERVISOR"]);
export type RolTenant = z.infer<typeof RolTenantSchema>;

// ---------------------------------------------------------------------------
// Resolución de módulos efectivos (Plan + override) — misma lógica que
// empresaTieneModulo (lib/server/permisos.ts), aquí en forma de listado para
// mostrar los tres estados en la pestaña Módulos (Portal Master/C.3).
// ---------------------------------------------------------------------------

export type EstadoModulo = "heredado" | "habilitado_adicional" | "deshabilitado_especifico";

export type FilaModuloEmpresa = {
  id: string;
  clave: string;
  nombre: string;
  estado: EstadoModulo;
  efectivo: boolean;
};

function resolverModulosEfectivos(
  catalogo: { id: string; clave: string; nombre: string }[],
  modulosPlan: { clave: string }[],
  overrides: { moduloId: string; habilitado: boolean }[]
): FilaModuloEmpresa[] {
  const clavesPlan = new Set(modulosPlan.map((m) => m.clave));
  const overridePorId = new Map(overrides.map((o) => [o.moduloId, o.habilitado]));

  return catalogo.map((modulo) => {
    const override = overridePorId.get(modulo.id);
    if (override === true) {
      return { id: modulo.id, clave: modulo.clave, nombre: modulo.nombre, estado: "habilitado_adicional", efectivo: true };
    }
    if (override === false) {
      return { id: modulo.id, clave: modulo.clave, nombre: modulo.nombre, estado: "deshabilitado_especifico", efectivo: false };
    }
    const enPlan = clavesPlan.has(modulo.clave);
    return { id: modulo.id, clave: modulo.clave, nombre: modulo.nombre, estado: "heredado", efectivo: enPlan };
  });
}

// ---------------------------------------------------------------------------
// Listado / detalle
// ---------------------------------------------------------------------------

export type FilaEmpresaMaster = {
  id: string;
  nombre: string;
  logoRef: string | null;
  activa: boolean;
  privadoHabilitado: boolean;
  planNombre: string | null;
  modulosHabilitados: number;
  usuarios: number;
  proyectosActivos: number;
  createdAt: Date;
};

export async function listarEmpresas(usuario: UsuarioSesion): Promise<FilaEmpresaMaster[]> {
  requerirMaster(usuario);

  const [empresas, catalogo] = await Promise.all([
    db.empresa.findMany({
      select: {
        id: true,
        nombre: true,
        logoRef: true,
        activa: true,
        privadoHabilitado: true,
        createdAt: true,
        plan: { select: { nombre: true, modulos: { select: { modulo: { select: { clave: true } } } } } },
        modulosOverride: { select: { moduloId: true, habilitado: true } },
        _count: { select: { usuarios: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.modulo.findMany({ select: { id: true, clave: true, nombre: true } }),
  ]);

  const proyectosActivosPorEmpresa = await db.proyecto.groupBy({
    by: ["empresaId"],
    // tipo != OFICINA — el vehículo interno de Gastos de Empresa no es una
    // obra real, no debe distorsionar este conteo (Gastos transversal,
    // septiembre 2026).
    where: { estatus: "ACTIVO", tipo: { not: "OFICINA" } },
    _count: { _all: true },
  });
  const conteoProyectos = new Map(proyectosActivosPorEmpresa.map((p) => [p.empresaId, p._count._all]));

  return empresas.map((e) => {
    const filas = resolverModulosEfectivos(
      catalogo,
      e.plan?.modulos.map((pm) => ({ clave: pm.modulo.clave })) ?? [],
      e.modulosOverride
    );
    return {
      id: e.id,
      nombre: e.nombre,
      logoRef: e.logoRef,
      activa: e.activa,
      privadoHabilitado: e.privadoHabilitado,
      planNombre: e.plan?.nombre ?? null,
      modulosHabilitados: filas.filter((f) => f.efectivo).length,
      usuarios: e._count.usuarios,
      proyectosActivos: conteoProyectos.get(e.id) ?? 0,
      createdAt: e.createdAt,
    };
  });
}

export type UsuarioEmpresaMaster = {
  id: string;
  nombre: string;
  email: string;
  rol: string;
  activo: boolean;
  debeCambiarPassword: boolean;
};

export type DetalleEmpresaMaster = {
  id: string;
  nombre: string;
  razonSocial: string | null;
  rfc: string | null;
  logoRef: string | null;
  colorPrimario: string;
  colorSecundario: string;
  activa: boolean;
  privadoHabilitado: boolean;
  planId: string | null;
  planNombre: string | null;
  createdAt: Date;
  modulos: FilaModuloEmpresa[];
  usuarios: UsuarioEmpresaMaster[];
  reciboMostrarLeyenda: boolean;
  reciboTituloLeyenda: string;
  reciboLeyenda: string | null;
};

export async function obtenerEmpresa(usuario: UsuarioSesion, empresaId: string): Promise<DetalleEmpresaMaster> {
  requerirMaster(usuario);

  const [empresa, catalogo] = await Promise.all([
    db.empresa.findUnique({
      where: { id: empresaId },
      select: {
        id: true,
        nombre: true,
        razonSocial: true,
        rfc: true,
        logoRef: true,
        colorPrimario: true,
        colorSecundario: true,
        activa: true,
        privadoHabilitado: true,
        planId: true,
        createdAt: true,
        reciboMostrarLeyenda: true,
        reciboTituloLeyenda: true,
        reciboLeyenda: true,
        plan: { select: { nombre: true, modulos: { select: { modulo: { select: { clave: true } } } } } },
        modulosOverride: { select: { moduloId: true, habilitado: true } },
        usuarios: {
          select: { id: true, nombre: true, email: true, rol: true, activo: true, debeCambiarPassword: true },
          orderBy: { nombre: "asc" },
        },
      },
    }),
    db.modulo.findMany({ select: { id: true, clave: true, nombre: true } }),
  ]);
  if (!empresa) throw new EmpresaNoEncontradaError();

  return {
    id: empresa.id,
    nombre: empresa.nombre,
    razonSocial: empresa.razonSocial,
    rfc: empresa.rfc,
    logoRef: empresa.logoRef,
    colorPrimario: empresa.colorPrimario,
    colorSecundario: empresa.colorSecundario,
    activa: empresa.activa,
    privadoHabilitado: empresa.privadoHabilitado,
    planId: empresa.planId,
    planNombre: empresa.plan?.nombre ?? null,
    createdAt: empresa.createdAt,
    modulos: resolverModulosEfectivos(
      catalogo,
      empresa.plan?.modulos.map((pm) => ({ clave: pm.modulo.clave })) ?? [],
      empresa.modulosOverride
    ),
    usuarios: empresa.usuarios,
    reciboMostrarLeyenda: empresa.reciboMostrarLeyenda,
    reciboTituloLeyenda: empresa.reciboTituloLeyenda,
    reciboLeyenda: empresa.reciboLeyenda,
  };
}

export async function listarPlanesCatalogo(usuario: UsuarioSesion) {
  requerirMaster(usuario);
  return db.plan.findMany({ select: { id: true, nombre: true }, orderBy: { nombre: "asc" } });
}

// ---------------------------------------------------------------------------
// Alta de Empresa
// ---------------------------------------------------------------------------

const CrearEmpresaSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio."),
  razonSocial: z.string().trim().optional().nullable(),
  rfc: z.string().trim().optional().nullable(),
  planId: z.string().trim().min(1, "Selecciona un plan."),
  usuarioInicial: z.object({
    nombre: z.string().trim().min(1, "El nombre del usuario inicial es obligatorio."),
    email: z.email("Correo inválido."),
    rol: RolTenantSchema,
  }),
});

export type DatosCrearEmpresa = z.infer<typeof CrearEmpresaSchema>;

export async function crearEmpresa(
  usuario: UsuarioSesion,
  datosCrudos: unknown
): Promise<{ empresaId: string; usuarioId: string; passwordTemporal: string }> {
  requerirMaster(usuario);
  const datos = CrearEmpresaSchema.parse(datosCrudos);

  const plan = await db.plan.findUnique({ where: { id: datos.planId } });
  if (!plan) throw new ValidacionMasterError("El plan seleccionado no existe.");

  const passwordTemporal = generarPasswordTemporal();

  const resultado = await db.$transaction(async (tx) => {
    const empresa = await tx.empresa.create({
      data: {
        nombre: datos.nombre,
        razonSocial: datos.razonSocial || null,
        rfc: datos.rfc || null,
        planId: datos.planId,
        // Seguro por defecto (default false en schema) — Master la habilita
        // explícitamente después desde la pestaña General si corresponde.
      },
    });

    const nuevoUsuario = await tx.usuario.create({
      data: {
        nombre: datos.usuarioInicial.nombre,
        email: datos.usuarioInicial.email.trim().toLowerCase(),
        passwordHash: await hashPassword(passwordTemporal),
        rol: datos.usuarioInicial.rol,
        empresaId: empresa.id,
        debeCambiarPassword: true,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId: empresa.id,
      usuarioId: usuario.id,
      entidad: "Empresa",
      entidadId: empresa.id,
      accion: "CREAR",
      valorNuevo: { nombre: empresa.nombre, planId: empresa.planId },
    });
    await registrarAuditoriaTx(tx, {
      empresaId: empresa.id,
      usuarioId: usuario.id,
      entidad: "Usuario",
      entidadId: nuevoUsuario.id,
      accion: "CREAR",
      valorNuevo: { nombre: nuevoUsuario.nombre, email: nuevoUsuario.email, rol: nuevoUsuario.rol },
    });

    return { empresaId: empresa.id, usuarioId: nuevoUsuario.id };
  });

  return { ...resultado, passwordTemporal };
}

// ---------------------------------------------------------------------------
// Edición — General / Módulos / Branding
// ---------------------------------------------------------------------------

const EditarEmpresaGeneralSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio."),
  razonSocial: z.string().trim().optional().nullable(),
  rfc: z.string().trim().optional().nullable(),
  planId: z.string().trim().min(1, "Selecciona un plan."),
});

export async function editarEmpresaGeneral(usuario: UsuarioSesion, empresaId: string, datosCrudos: unknown) {
  requerirMaster(usuario);
  const datos = EditarEmpresaGeneralSchema.parse(datosCrudos);

  const anterior = await db.empresa.findUnique({ where: { id: empresaId } });
  if (!anterior) throw new EmpresaNoEncontradaError();

  const actualizada = await db.empresa.update({
    where: { id: empresaId },
    data: {
      nombre: datos.nombre,
      razonSocial: datos.razonSocial || null,
      rfc: datos.rfc || null,
      planId: datos.planId,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: "EDITAR",
    valorAnterior: { nombre: anterior.nombre, razonSocial: anterior.razonSocial, rfc: anterior.rfc, planId: anterior.planId },
    valorNuevo: { nombre: actualizada.nombre, razonSocial: actualizada.razonSocial, rfc: actualizada.rfc, planId: actualizada.planId },
  });

  return actualizada;
}

export async function cambiarEstatusEmpresa(usuario: UsuarioSesion, empresaId: string, activa: boolean) {
  requerirMaster(usuario);
  const anterior = await db.empresa.findUnique({ where: { id: empresaId }, select: { activa: true } });
  if (!anterior) throw new EmpresaNoEncontradaError();

  await db.empresa.update({ where: { id: empresaId }, data: { activa } });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: activa ? "ACTIVAR" : "DESACTIVAR",
    valorAnterior: { activa: anterior.activa },
    valorNuevo: { activa },
  });
}

export async function cambiarPrivadoEmpresa(usuario: UsuarioSesion, empresaId: string, privadoHabilitado: boolean) {
  requerirMaster(usuario);
  const anterior = await db.empresa.findUnique({ where: { id: empresaId }, select: { privadoHabilitado: true } });
  if (!anterior) throw new EmpresaNoEncontradaError();

  await db.empresa.update({ where: { id: empresaId }, data: { privadoHabilitado } });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { privadoHabilitado: anterior.privadoHabilitado },
    valorNuevo: { privadoHabilitado },
  });
}

// estado: "heredado" borra el override (vuelve a heredar el Plan tal cual);
// "habilitado"/"deshabilitado" upsertan la fila con habilitado=true/false.
export async function actualizarModuloEmpresa(
  usuario: UsuarioSesion,
  empresaId: string,
  moduloId: string,
  estado: "heredado" | "habilitado" | "deshabilitado"
) {
  requerirMaster(usuario);
  const empresa = await db.empresa.findUnique({ where: { id: empresaId }, select: { id: true } });
  if (!empresa) throw new EmpresaNoEncontradaError();

  if (estado === "heredado") {
    await db.empresaModulo.deleteMany({ where: { empresaId, moduloId } });
  } else {
    await db.empresaModulo.upsert({
      where: { empresaId_moduloId: { empresaId, moduloId } },
      create: { empresaId, moduloId, habilitado: estado === "habilitado" },
      update: { habilitado: estado === "habilitado" },
    });
  }

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: "EDITAR",
    valorNuevo: { moduloId, estado },
  });
}

// Solo persiste la URL — la subida a Vercel Blob ya ocurrió en la Server
// Action (subirArchivo). Nunca borra el logo anterior en Blob: puede seguir
// referenciado por un configuracionSnapshot/brandingSnapshot histórico (ver
// plan "Portal Master", regla de logos históricos).
export async function actualizarLogoEmpresa(usuario: UsuarioSesion, empresaId: string, logoRef: string | null) {
  requerirMaster(usuario);
  const anterior = await db.empresa.findUnique({ where: { id: empresaId }, select: { logoRef: true } });
  if (!anterior) throw new EmpresaNoEncontradaError();

  await db.empresa.update({ where: { id: empresaId }, data: { logoRef } });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: "EDITAR",
    valorAnterior: { logoRef: anterior.logoRef },
    valorNuevo: { logoRef },
  });
}

// Config del bloque de declaraciones/conformidad de los recibos de
// contratista — mismo criterio que el resto de config de Empresa (Master-
// only, congelada por generarRecibo en configuracionSnapshot; un cambio
// aquí solo afecta recibos generados DESPUÉS, nunca los ya emitidos).
const EditarConfiguracionRecibosSchema = z.object({
  reciboMostrarLeyenda: z.boolean(),
  reciboTituloLeyenda: z.string().trim().min(1, "El título del bloque es obligatorio."),
  reciboLeyenda: z.string().trim().optional().nullable(),
});

export async function actualizarConfiguracionRecibosEmpresa(
  usuario: UsuarioSesion,
  empresaId: string,
  datosCrudos: unknown
) {
  requerirMaster(usuario);
  const datos = EditarConfiguracionRecibosSchema.parse(datosCrudos);

  const anterior = await db.empresa.findUnique({
    where: { id: empresaId },
    select: { reciboMostrarLeyenda: true, reciboTituloLeyenda: true, reciboLeyenda: true },
  });
  if (!anterior) throw new EmpresaNoEncontradaError();

  const actualizada = await db.empresa.update({
    where: { id: empresaId },
    data: {
      reciboMostrarLeyenda: datos.reciboMostrarLeyenda,
      reciboTituloLeyenda: datos.reciboTituloLeyenda,
      reciboLeyenda: datos.reciboLeyenda || null,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: "EDITAR",
    valorAnterior: anterior,
    valorNuevo: {
      reciboMostrarLeyenda: actualizada.reciboMostrarLeyenda,
      reciboTituloLeyenda: actualizada.reciboTituloLeyenda,
      reciboLeyenda: actualizada.reciboLeyenda,
    },
  });

  return actualizada;
}

// ---------------------------------------------------------------------------
// Usuarios de la Empresa (desde Master, sin entrar al portal operativo)
// ---------------------------------------------------------------------------

const CrearUsuarioEmpresaSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio."),
  email: z.email("Correo inválido."),
  rol: RolTenantSchema,
});

export async function crearUsuarioEmpresa(
  usuario: UsuarioSesion,
  empresaId: string,
  datosCrudos: unknown
): Promise<{ usuarioId: string; passwordTemporal: string }> {
  requerirMaster(usuario);
  const datos = CrearUsuarioEmpresaSchema.parse(datosCrudos);

  const empresa = await db.empresa.findUnique({ where: { id: empresaId }, select: { id: true } });
  if (!empresa) throw new EmpresaNoEncontradaError();

  const passwordTemporal = generarPasswordTemporal();
  const nuevoUsuario = await crearUsuario({
    nombre: datos.nombre,
    email: datos.email,
    password: passwordTemporal,
    rol: datos.rol,
    empresaId,
    debeCambiarPassword: true,
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Usuario",
    entidadId: nuevoUsuario.id,
    accion: "CREAR",
    valorNuevo: { nombre: nuevoUsuario.nombre, email: nuevoUsuario.email, rol: nuevoUsuario.rol },
  });

  return { usuarioId: nuevoUsuario.id, passwordTemporal };
}

export async function cambiarEstatusUsuarioEmpresa(
  usuario: UsuarioSesion,
  empresaId: string,
  usuarioObjetivoId: string,
  activo: boolean
) {
  requerirMaster(usuario);
  const objetivo = await db.usuario.findFirst({ where: { id: usuarioObjetivoId, empresaId }, select: { activo: true } });
  if (!objetivo) throw new UsuarioNoEncontradoError();

  // D2 (WhatsApp + ARQENTO IA, Fase 1): desactivar al usuario revoca en la
  // MISMA transacción sus vínculos de WhatsApp (queda el historial); si se
  // reactiva, tendrá que vincularse de nuevo.
  await db.$transaction(async (tx) => {
    await tx.usuario.update({ where: { id: usuarioObjetivoId }, data: { activo } });
    if (!activo) {
      await revocarVinculosDeUsuarioTx(tx, { usuarioId: usuarioObjetivoId, revocadoPorId: usuario.id, motivo: MOTIVOS_REVOCACION.DESACTIVACION });
    }
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "Usuario",
      entidadId: usuarioObjetivoId,
      accion: activo ? "ACTIVAR" : "DESACTIVAR",
      valorAnterior: { activo: objetivo.activo },
      valorNuevo: { activo },
    });
  });
}

// Regenerar, nunca consultar: no existe (ni existirá) una forma de leer la
// contraseña temporal anterior — solo se persiste su hash. Esta acción
// invalida la anterior de inmediato al sobrescribir el hash (C.4.6 del plan).
export async function regenerarPasswordUsuarioEmpresa(
  usuario: UsuarioSesion,
  empresaId: string,
  usuarioObjetivoId: string
): Promise<string> {
  requerirMaster(usuario);
  const objetivo = await db.usuario.findFirst({ where: { id: usuarioObjetivoId, empresaId }, select: { id: true } });
  if (!objetivo) throw new UsuarioNoEncontradoError();

  const passwordTemporal = await regenerarPasswordTemporal(usuarioObjetivoId);

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Usuario",
    entidadId: usuarioObjetivoId,
    accion: "EDITAR",
    valorNuevo: { accion: "password_temporal_regenerada" },
  });

  return passwordTemporal;
}

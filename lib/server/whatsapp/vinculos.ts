import "server-only";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { puedeAdministrarWhatsappEmpresa, rolPuedeVincularWhatsapp } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { enmascararTelefono, normalizarTelefono } from "@/lib/whatsapp/telefono";
import {
  MAX_CODIGOS_POR_HORA,
  MAX_INTENTOS_CODIGO,
  VIGENCIA_CODIGO_MINUTOS,
  generarCodigoVinculacion,
  hashCodigoVinculacion,
} from "@/lib/whatsapp/codigo";
import { configuracionWhatsapp, secretoWhatsapp } from "./config";

// Vinculación de usuarios de ARQENTO con su WhatsApp (Fase 1 WhatsApp +
// ARQENTO IA, octubre 2026). Reglas:
// - Master habilita WhatsApp por Empresa; Administrador/Director autorizan a
//   usuarios de SU Empresa; cada usuario autorizado (Director, Administrador
//   o Supervisor) vincula o revoca SU propio teléfono.
// - Un vínculo nace PENDIENTE con un código de un solo uso (15 min, solo su
//   HMAC en la base) y pasa a VERIFICADO cuando ese código llega desde el
//   mismo número por WhatsApp (verificarCodigoTx, desde el webhook).
// - Revocar nunca borra: REVOCADO con quién/cuándo/por qué; volver a
//   vincular crea un vínculo nuevo. Desactivar al usuario o retirarle el
//   acceso revoca sus vínculos (D2).
// - Orden de bloqueo único: usuario → vínculo → código.
// - Los teléfonos de OTROS usuarios siempre salen enmascarados del servidor.

type Cliente = Prisma.TransactionClient;
const MINUTO = 60_000;

export const MOTIVOS_REVOCACION = {
  USUARIO: "Revocado por el usuario",
  ADMINISTRADOR: "Revocado por un administrador de la Empresa",
  MASTER: "Revocado por Master",
  ACCESO_RETIRADO: "Acceso a WhatsApp retirado",
  DESACTIVACION: "Usuario desactivado",
  REEMPLAZO: "Reemplazado por una nueva vinculación",
} as const;

const NO_DISPONIBLE = "WhatsApp no está disponible para tu usuario. Consulta con el administrador de tu Empresa.";

function esUnicoDuplicado(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------
// El propio usuario
// ---------------------------------------------------------------------------

export type MiWhatsapp = {
  empresaHabilitada: boolean;
  autorizado: boolean;
  vinculo: { estado: "PENDIENTE" | "VERIFICADO"; telefono: string; verificadoEn: string | null } | null;
  ultimaRevocacion: { revocadoEn: string | null; motivo: string | null } | null;
  numeroOficialConfigurado: boolean;
};

export async function obtenerMiWhatsapp(usuario: UsuarioSesion): Promise<MiWhatsapp | null> {
  if (!usuario.empresa || !rolPuedeVincularWhatsapp(usuario.rol)) return null;
  const [empresa, yo, vinculo, revocado] = await Promise.all([
    db.empresa.findUnique({ where: { id: usuario.empresa.id }, select: { whatsappHabilitado: true, activa: true } }),
    db.usuario.findUnique({ where: { id: usuario.id }, select: { whatsappAutorizado: true } }),
    db.vinculoWhatsapp.findFirst({
      where: { usuarioId: usuario.id, estado: { not: "REVOCADO" } },
      select: { estado: true, telefonoE164: true, verificadoEn: true },
    }),
    db.vinculoWhatsapp.findFirst({
      where: { usuarioId: usuario.id, estado: "REVOCADO" },
      orderBy: { revocadoEn: "desc" },
      select: { revocadoEn: true, motivoRevocacion: true },
    }),
  ]);
  return {
    empresaHabilitada: Boolean(empresa?.whatsappHabilitado && empresa.activa),
    autorizado: Boolean(yo?.whatsappAutorizado),
    // El propio número sí se muestra completo a su dueño.
    vinculo: vinculo
      ? { estado: vinculo.estado as "PENDIENTE" | "VERIFICADO", telefono: vinculo.telefonoE164, verificadoEn: vinculo.verificadoEn?.toISOString() ?? null }
      : null,
    ultimaRevocacion: revocado ? { revocadoEn: revocado.revocadoEn?.toISOString() ?? null, motivo: revocado.motivoRevocacion } : null,
    numeroOficialConfigurado: Boolean(configuracionWhatsapp().numeroOficial),
  };
}

// Releída SIEMPRE de la base (nunca de la sesión): rol, usuario activo,
// autorizado, Empresa activa y con WhatsApp habilitado.
async function requerirPuedeVincularTx(tx: Cliente, usuario: UsuarioSesion): Promise<string> {
  if (!usuario.empresa || !rolPuedeVincularWhatsapp(usuario.rol)) throw new SinPermisoError();
  const yo = await tx.usuario.findUnique({
    where: { id: usuario.id },
    select: { activo: true, whatsappAutorizado: true, empresaId: true, empresa: { select: { activa: true, whatsappHabilitado: true } } },
  });
  if (!yo || !yo.activo || !yo.whatsappAutorizado || yo.empresaId !== usuario.empresa.id || !yo.empresa?.activa || !yo.empresa.whatsappHabilitado) {
    throw new ValidacionError(NO_DISPONIBLE);
  }
  return yo.empresaId;
}

export type InicioVinculacion = { codigo: string; expiraEn: string; telefono: string; enlace: string | null };

// Inicia (o reinicia) la vinculación del propio usuario: registra el número
// y genera un código nuevo — el código solo se devuelve aquí, una vez, a su
// dueño; nunca se guarda en claro ni se muestra a nadie más.
export async function iniciarVinculacionWhatsapp(usuario: UsuarioSesion, telefonoCrudo: unknown): Promise<InicioVinculacion> {
  const telefono = normalizarTelefono(typeof telefonoCrudo === "string" ? telefonoCrudo : "");
  if (!telefono.ok) throw new ValidacionError(telefono.error);
  const secreto = secretoWhatsapp();
  const ahora = new Date();

  try {
    const resultado = await db.$transaction(async (tx) => {
      // Serializa las vinculaciones del mismo usuario (doble clic, dos pestañas).
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuario.id} FOR UPDATE`;
      const empresaId = await requerirPuedeVincularTx(tx, usuario);

      const recientes = await tx.codigoVinculacionWhatsapp.count({
        where: { vinculo: { usuarioId: usuario.id }, createdAt: { gte: new Date(ahora.getTime() - 60 * MINUTO) } },
      });
      if (recientes >= MAX_CODIGOS_POR_HORA) {
        throw new ValidacionError("Generaste demasiados códigos. Intenta de nuevo dentro de una hora.");
      }

      let vinculo = await tx.vinculoWhatsapp.findFirst({ where: { usuarioId: usuario.id, estado: { not: "REVOCADO" } } });
      if (vinculo?.estado === "VERIFICADO") {
        throw new ValidacionError("Ya tienes un WhatsApp vinculado. Revócalo antes de vincular otro número.");
      }
      if (vinculo && vinculo.telefonoE164 !== telefono.e164) {
        await revocarVinculoTx(tx, vinculo.id, { revocadoPorId: usuario.id, motivo: MOTIVOS_REVOCACION.REEMPLAZO });
        vinculo = null;
      }
      if (!vinculo) {
        vinculo = await tx.vinculoWhatsapp.create({ data: { empresaId, usuarioId: usuario.id, telefonoE164: telefono.e164 } });
      } else {
        await tx.$queryRaw`SELECT id FROM vinculos_whatsapp WHERE id = ${vinculo.id} FOR UPDATE`;
      }

      await tx.codigoVinculacionWhatsapp.updateMany({
        where: { vinculoId: vinculo.id, usadoEn: null, invalidadoEn: null },
        data: { invalidadoEn: ahora },
      });
      const codigo = generarCodigoVinculacion();
      const expiraEn = new Date(ahora.getTime() + VIGENCIA_CODIGO_MINUTOS * MINUTO);
      await tx.codigoVinculacionWhatsapp.create({ data: { vinculoId: vinculo.id, codigoHash: hashCodigoVinculacion(codigo, secreto), expiraEn } });

      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: "VinculoWhatsapp",
        entidadId: vinculo.id,
        accion: "CREAR",
        // Nunca el código: solo que se generó uno y hasta cuándo vale.
        valorNuevo: { estado: "PENDIENTE", telefono: enmascararTelefono(telefono.e164), codigoGenerado: true, expiraEn: expiraEn.toISOString() },
      });
      return { codigo, expiraEn: expiraEn.toISOString(), telefono: telefono.e164 };
    });
    const numero = configuracionWhatsapp().numeroOficial?.replace(/\D/g, "") || null;
    return { ...resultado, enlace: numero ? `https://wa.me/${numero}?text=${encodeURIComponent(resultado.codigo)}` : null };
  } catch (error) {
    // Índice único parcial: ese número ya está vinculado (o en proceso) a
    // otro usuario de la misma Empresa. Mensaje genérico (sin revelar a quién).
    if (esUnicoDuplicado(error)) {
      throw new ValidacionError("No se pudo registrar ese número. Verifica que sea correcto o consulta con el administrador de tu Empresa.");
    }
    throw error;
  }
}

// Revocar el propio WhatsApp — siempre permitido (reduce acceso).
export async function revocarMiWhatsapp(usuario: UsuarioSesion): Promise<number> {
  if (!usuario.empresa || !rolPuedeVincularWhatsapp(usuario.rol)) throw new SinPermisoError();
  return db.$transaction((tx) =>
    revocarVinculosDeUsuarioTx(tx, { usuarioId: usuario.id, revocadoPorId: usuario.id, motivo: MOTIVOS_REVOCACION.USUARIO })
  );
}

// ---------------------------------------------------------------------------
// Revocación (núcleo compartido)
// ---------------------------------------------------------------------------

export async function revocarVinculoTx(tx: Cliente, vinculoId: string, args: { revocadoPorId: string | null; motivo: string }): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM vinculos_whatsapp WHERE id = ${vinculoId} FOR UPDATE`;
  const vinculo = await tx.vinculoWhatsapp.findUnique({ where: { id: vinculoId }, select: { estado: true, empresaId: true } });
  if (!vinculo || vinculo.estado === "REVOCADO") return false;
  const ahora = new Date();
  await tx.vinculoWhatsapp.update({
    where: { id: vinculoId },
    data: { estado: "REVOCADO", revocadoEn: ahora, revocadoPorId: args.revocadoPorId, motivoRevocacion: args.motivo },
  });
  await tx.codigoVinculacionWhatsapp.updateMany({ where: { vinculoId, usadoEn: null, invalidadoEn: null }, data: { invalidadoEn: ahora } });
  await tx.sesionWhatsapp.deleteMany({ where: { vinculoId } });
  await registrarAuditoriaTx(tx, {
    empresaId: vinculo.empresaId,
    usuarioId: args.revocadoPorId,
    entidad: "VinculoWhatsapp",
    entidadId: vinculoId,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estado: vinculo.estado },
    valorNuevo: { estado: "REVOCADO", motivo: args.motivo },
  });
  return true;
}

export async function revocarVinculosDeUsuarioTx(
  tx: Cliente,
  args: { usuarioId: string; revocadoPorId: string | null; motivo: string }
): Promise<number> {
  const vigentes = await tx.vinculoWhatsapp.findMany({ where: { usuarioId: args.usuarioId, estado: { not: "REVOCADO" } }, select: { id: true } });
  let revocados = 0;
  for (const v of vigentes) if (await revocarVinculoTx(tx, v.id, args)) revocados++;
  return revocados;
}

// ---------------------------------------------------------------------------
// Administración dentro de la Empresa (Administrador / Director — D1)
// ---------------------------------------------------------------------------

export type FilaWhatsappUsuario = {
  usuarioId: string;
  nombre: string;
  rol: string;
  activo: boolean;
  autorizado: boolean;
  vinculo: { estado: "PENDIENTE" | "VERIFICADO"; telefono: string; verificadoEn: string | null } | null;
};

function requerirAdministradorWhatsapp(usuario: UsuarioSesion): string {
  if (!puedeAdministrarWhatsappEmpresa(usuario) || !usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

export async function listarWhatsappDeMiEmpresa(usuario: UsuarioSesion): Promise<{ empresaHabilitada: boolean; usuarios: FilaWhatsappUsuario[] }> {
  const empresaId = requerirAdministradorWhatsapp(usuario);
  const [empresa, usuarios] = await Promise.all([
    db.empresa.findUnique({ where: { id: empresaId }, select: { whatsappHabilitado: true } }),
    db.usuario.findMany({
      where: { empresaId, rol: { in: ["DIRECTOR", "ADMINISTRADOR", "SUPERVISOR"] } },
      orderBy: { nombre: "asc" },
      select: {
        id: true,
        nombre: true,
        rol: true,
        activo: true,
        whatsappAutorizado: true,
        vinculosWhatsapp: { where: { estado: { not: "REVOCADO" } }, select: { estado: true, telefonoE164: true, verificadoEn: true }, take: 1 },
      },
    }),
  ]);
  return {
    empresaHabilitada: Boolean(empresa?.whatsappHabilitado),
    usuarios: usuarios.map((u) => {
      const v = u.vinculosWhatsapp[0];
      return {
        usuarioId: u.id,
        nombre: u.nombre,
        rol: u.rol,
        activo: u.activo,
        autorizado: u.whatsappAutorizado,
        // D3: enmascarado desde el servidor — salvo el propio número.
        vinculo: v
          ? {
              estado: v.estado as "PENDIENTE" | "VERIFICADO",
              telefono: u.id === usuario.id ? v.telefonoE164 : enmascararTelefono(v.telefonoE164),
              verificadoEn: v.verificadoEn?.toISOString() ?? null,
            }
          : null,
      };
    }),
  };
}

async function usuarioDeMiEmpresaTx(tx: Cliente, empresaId: string, usuarioId: string) {
  await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} FOR UPDATE`;
  const objetivo = await tx.usuario.findFirst({
    where: { id: usuarioId, empresaId },
    select: { id: true, rol: true, activo: true, whatsappAutorizado: true },
  });
  // Un usuario de otra Empresa "no existe" para este administrador.
  if (!objetivo) throw new RegistroNoEncontradoError("El usuario");
  return objetivo;
}

export async function autorizarWhatsappUsuario(usuario: UsuarioSesion, usuarioId: string, autorizado: boolean) {
  const empresaId = requerirAdministradorWhatsapp(usuario);
  await db.$transaction(async (tx) => {
    const objetivo = await usuarioDeMiEmpresaTx(tx, empresaId, usuarioId);
    if (!rolPuedeVincularWhatsapp(objetivo.rol)) throw new ValidacionError("Ese rol no puede usar WhatsApp.");
    if (autorizado && !objetivo.activo) throw new ValidacionError("El usuario está desactivado.");
    if (objetivo.whatsappAutorizado === autorizado) return;
    await tx.usuario.update({ where: { id: usuarioId }, data: { whatsappAutorizado: autorizado } });
    if (!autorizado) {
      await revocarVinculosDeUsuarioTx(tx, { usuarioId, revocadoPorId: usuario.id, motivo: MOTIVOS_REVOCACION.ACCESO_RETIRADO });
    }
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "Usuario",
      entidadId: usuarioId,
      accion: autorizado ? "ACTIVAR" : "DESACTIVAR",
      valorAnterior: { whatsappAutorizado: objetivo.whatsappAutorizado },
      valorNuevo: { whatsappAutorizado: autorizado },
    });
  });
}

export async function revocarWhatsappDeUsuario(usuario: UsuarioSesion, usuarioId: string): Promise<number> {
  const empresaId = requerirAdministradorWhatsapp(usuario);
  return db.$transaction(async (tx) => {
    await usuarioDeMiEmpresaTx(tx, empresaId, usuarioId);
    return revocarVinculosDeUsuarioTx(tx, { usuarioId, revocadoPorId: usuario.id, motivo: MOTIVOS_REVOCACION.ADMINISTRADOR });
  });
}

// ---------------------------------------------------------------------------
// Verificación del código (desde el webhook) — dentro de la transacción del
// mensaje. Devuelve solo si se vinculó o no: el motivo de una falla nunca se
// comunica al remitente (sin enumeración).
// ---------------------------------------------------------------------------

export type ResultadoVerificacion =
  | { vinculado: true; vinculoId: string; empresaId: string; usuarioId: string }
  | { vinculado: false };

export async function verificarCodigoTx(
  tx: Cliente,
  args: { codigo: string; telefonoE164: string | null; waId: string; ahora: Date }
): Promise<ResultadoVerificacion> {
  const secreto = secretoWhatsapp();
  const codigoHash = hashCodigoVinculacion(args.codigo, secreto);
  const candidato = await tx.codigoVinculacionWhatsapp.findUnique({ where: { codigoHash }, select: { id: true, vinculoId: true } });

  if (!candidato || !args.telefonoE164) {
    if (args.telefonoE164) await contarIntentoFallidoDelTelefonoTx(tx, args.telefonoE164, args.ahora);
    return { vinculado: false };
  }

  // Orden de bloqueo: vínculo → código (mismo que revocar e iniciar).
  await tx.$queryRaw`SELECT id FROM vinculos_whatsapp WHERE id = ${candidato.vinculoId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM codigos_vinculacion_whatsapp WHERE id = ${candidato.id} FOR UPDATE`;
  const codigo = await tx.codigoVinculacionWhatsapp.findUniqueOrThrow({
    where: { id: candidato.id },
    include: {
      vinculo: {
        include: {
          usuario: { select: { activo: true, whatsappAutorizado: true, empresaId: true } },
          empresa: { select: { activa: true, whatsappHabilitado: true } },
        },
      },
    },
  });
  const v = codigo.vinculo;
  const codigoUsable = !codigo.usadoEn && !codigo.invalidadoEn && codigo.expiraEn > args.ahora && codigo.intentosFallidos < MAX_INTENTOS_CODIGO;
  const valido =
    codigoUsable &&
    v.estado === "PENDIENTE" &&
    v.telefonoE164 === args.telefonoE164 &&
    v.usuario.activo &&
    v.usuario.whatsappAutorizado &&
    v.usuario.empresaId === v.empresaId &&
    v.empresa.activa &&
    v.empresa.whatsappHabilitado;

  if (!valido) {
    if (codigoUsable) await sumarIntentoTx(tx, codigo.id, codigo.intentosFallidos, args.ahora);
    return { vinculado: false };
  }

  await tx.codigoVinculacionWhatsapp.update({ where: { id: codigo.id }, data: { usadoEn: args.ahora } });
  await tx.codigoVinculacionWhatsapp.updateMany({
    where: { vinculoId: v.id, id: { not: codigo.id }, usadoEn: null, invalidadoEn: null },
    data: { invalidadoEn: args.ahora },
  });
  await tx.vinculoWhatsapp.update({ where: { id: v.id }, data: { estado: "VERIFICADO", waId: args.waId, verificadoEn: args.ahora } });
  await registrarAuditoriaTx(tx, {
    empresaId: v.empresaId,
    usuarioId: v.usuarioId,
    entidad: "VinculoWhatsapp",
    entidadId: v.id,
    accion: "CONFIRMAR",
    valorAnterior: { estado: "PENDIENTE" },
    valorNuevo: { estado: "VERIFICADO", telefono: enmascararTelefono(v.telefonoE164) },
  });
  return { vinculado: true, vinculoId: v.id, empresaId: v.empresaId, usuarioId: v.usuarioId };
}

async function sumarIntentoTx(tx: Cliente, codigoId: string, intentosPrevios: number, ahora: Date) {
  const intentos = intentosPrevios + 1;
  await tx.codigoVinculacionWhatsapp.update({
    where: { id: codigoId },
    data: { intentosFallidos: intentos, ...(intentos >= MAX_INTENTOS_CODIGO ? { invalidadoEn: ahora } : {}) },
  });
}

// Un código incorrecto enviado desde un número con una vinculación
// pendiente cuenta como intento contra el código vigente de ese número —
// así nadie puede probar códigos sin límite desde su teléfono.
async function contarIntentoFallidoDelTelefonoTx(tx: Cliente, telefonoE164: string, ahora: Date) {
  const pendientes = await tx.vinculoWhatsapp.findMany({ where: { telefonoE164, estado: "PENDIENTE" }, select: { id: true } });
  for (const v of pendientes) {
    await tx.$queryRaw`SELECT id FROM vinculos_whatsapp WHERE id = ${v.id} FOR UPDATE`;
    const vigente = await tx.codigoVinculacionWhatsapp.findFirst({
      where: { vinculoId: v.id, usadoEn: null, invalidadoEn: null, expiraEn: { gt: ahora } },
      orderBy: { createdAt: "desc" },
      select: { id: true, intentosFallidos: true },
    });
    if (vigente) {
      await tx.$queryRaw`SELECT id FROM codigos_vinculacion_whatsapp WHERE id = ${vigente.id} FOR UPDATE`;
      await sumarIntentoTx(tx, vigente.id, vigente.intentosFallidos, ahora);
    }
  }
}

// Vínculos de un número que HOY pueden usarse (verificado + usuario activo y
// autorizado + Empresa activa con WhatsApp habilitado). Se evalúa en cada
// mensaje — apagar WhatsApp, desactivar o desautorizar corta de inmediato.
export async function vinculosUtilizablesTx(tx: Cliente, telefonoE164: string) {
  return tx.vinculoWhatsapp.findMany({
    where: {
      telefonoE164,
      estado: "VERIFICADO",
      usuario: { activo: true, whatsappAutorizado: true },
      empresa: { activa: true, whatsappHabilitado: true },
    },
    select: { id: true, empresaId: true, usuarioId: true, usuario: { select: { empresaId: true } }, empresa: { select: { nombre: true } } },
    orderBy: { verificadoEn: "asc" },
  }).then((filas) => filas.filter((f) => f.usuario.empresaId === f.empresaId));
}

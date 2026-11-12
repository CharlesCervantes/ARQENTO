import "server-only";
import { db } from "@/lib/server/db";
import { registrarAuditoria } from "@/lib/server/auditoria";
import { puedeConfigurarWhatsappEmpresa } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { enmascararTelefono } from "@/lib/whatsapp/telefono";
import { MOTIVOS_REVOCACION, revocarVinculoTx } from "@/lib/server/whatsapp/vinculos";
import { estadoMensajesWhatsapp, procesarMensajesPendientes, type ResumenReproceso } from "@/lib/server/whatsapp/mensajes";

// Master → Empresa → WhatsApp (Fase 1 WhatsApp + ARQENTO IA, octubre 2026).
// Master solo habilita/deshabilita el canal por Empresa (independiente de
// ARQENTO IA) y puede revocar vínculos. Los teléfonos SIEMPRE salen
// enmascarados del servidor (D3); nunca se exponen códigos ni secretos.

function requerirMaster(usuario: UsuarioSesion) {
  if (!puedeConfigurarWhatsappEmpresa(usuario)) throw new SinPermisoError();
}

export type FilaVinculoMaster = {
  vinculoId: string;
  usuarioNombre: string;
  usuarioRol: string;
  telefono: string;
  estado: "PENDIENTE" | "VERIFICADO" | "REVOCADO";
  verificadoEn: string | null;
  revocadoEn: string | null;
  motivoRevocacion: string | null;
};

// `canal`: conteos de mensajes de TODO el canal (los mensajes de números
// desconocidos no pertenecen a ninguna Empresa) — nunca números ni textos.
export type EstadoCanalWhatsapp = { pendientes: number; reintentables: number; detenidos: number; definitivos: number };
export type WhatsappEmpresaMaster = { whatsappHabilitado: boolean; vinculos: FilaVinculoMaster[]; canal: EstadoCanalWhatsapp };

export async function obtenerWhatsappEmpresaMaster(usuario: UsuarioSesion, empresaId: string): Promise<WhatsappEmpresaMaster> {
  requerirMaster(usuario);
  const empresa = await db.empresa.findUnique({ where: { id: empresaId }, select: { whatsappHabilitado: true } });
  if (!empresa) throw new RegistroNoEncontradoError("La empresa");
  const vinculos = await db.vinculoWhatsapp.findMany({
    where: { empresaId },
    orderBy: [{ estado: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      telefonoE164: true,
      estado: true,
      verificadoEn: true,
      revocadoEn: true,
      motivoRevocacion: true,
      usuario: { select: { nombre: true, rol: true } },
    },
  });
  return {
    whatsappHabilitado: empresa.whatsappHabilitado,
    vinculos: vinculos.map((v) => ({
      vinculoId: v.id,
      usuarioNombre: v.usuario.nombre,
      usuarioRol: v.usuario.rol,
      telefono: enmascararTelefono(v.telefonoE164),
      estado: v.estado,
      verificadoEn: v.verificadoEn?.toISOString() ?? null,
      revocadoEn: v.revocadoEn?.toISOString() ?? null,
      motivoRevocacion: v.motivoRevocacion,
    })),
    canal: await estadoMensajesWhatsapp(),
  };
}

// Apagarlo conserva los vínculos, pero impide usarlos mientras esté apagado
// (D2) — el webhook lo revalida en cada mensaje. No toca inteligenciaHabilitada.
export async function cambiarWhatsappEmpresa(usuario: UsuarioSesion, empresaId: string, habilitado: boolean) {
  requerirMaster(usuario);
  const anterior = await db.empresa.findUnique({ where: { id: empresaId }, select: { whatsappHabilitado: true } });
  if (!anterior) throw new RegistroNoEncontradoError("La empresa");
  if (anterior.whatsappHabilitado === habilitado) return;
  await db.empresa.update({ where: { id: empresaId }, data: { whatsappHabilitado: habilitado } });
  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Empresa",
    entidadId: empresaId,
    accion: "EDITAR",
    valorAnterior: { whatsappHabilitado: anterior.whatsappHabilitado },
    valorNuevo: { whatsappHabilitado: habilitado },
  });
}

export async function revocarVinculoWhatsappMaster(usuario: UsuarioSesion, empresaId: string, vinculoId: string) {
  requerirMaster(usuario);
  await db.$transaction(async (tx) => {
    const vinculo = await tx.vinculoWhatsapp.findFirst({ where: { id: vinculoId, empresaId }, select: { id: true } });
    if (!vinculo) throw new RegistroNoEncontradoError("El vínculo");
    await revocarVinculoTx(tx, vinculo.id, { revocadoPorId: usuario.id, motivo: MOTIVOS_REVOCACION.MASTER });
  });
}

// Recuperación EXPLÍCITA de mensajes (noviembre 2026): respaldo de la
// reentrega de Meta (que reintenta hasta 7 días cuando el webhook responde
// 500). Master ve solo conteos del canal — nunca números ni textos — y puede
// reprocesar los pendientes; cada ejecución queda en la auditoría.
export async function obtenerEstadoMensajesMaster(usuario: UsuarioSesion) {
  requerirMaster(usuario);
  return estadoMensajesWhatsapp();
}

export async function reprocesarMensajesPendientesMaster(usuario: UsuarioSesion): Promise<ResumenReproceso> {
  requerirMaster(usuario);
  // Acción explícita: incluye los mensajes con archivo detenidos. Acotada en
  // tiempo; lo que falte sigue pendiente para la siguiente ejecución.
  const resumen = await procesarMensajesPendientes(50, [], { manual: true, presupuestoMs: 40_000 });
  await registrarAuditoria({
    empresaId: null,
    usuarioId: usuario.id,
    entidad: "MensajesWhatsapp",
    entidadId: "reproceso",
    accion: "CONFIRMAR",
    valorNuevo: resumen,
  });
  return resumen;
}

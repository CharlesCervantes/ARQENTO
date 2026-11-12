import "server-only";
import { db } from "@/lib/server/db";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";

// Retención de registros OPERATIVOS de WhatsApp (D4, Fase 1 — octubre 2026):
// 90 días. Depuración segura y verificable:
// - Por defecto es una SIMULACIÓN (solo cuenta); borrar exige ejecutar: true.
// - Solo borra registros operativos ya terminados: mensajes PROCESADOS o en
//   ERROR definitivo con más de 90 días, códigos de vinculación (solo hashes)
//   con más de 90 días y selecciones de Empresa ya caducadas.
// - NUNCA borra: vínculos (son el historial de vinculación/revocación),
//   registros de auditoría, ni mensajes pendientes. En esta fase ningún
//   mensaje da origen a un registro contable; cuando la Fase 2 ligue
//   mensajes con documentos, esos mensajes deberán excluirse aquí.
// - Cada ejecución real deja un registro de auditoría con el corte y los
//   conteos.
// No hay tarea programada: la invoca quien la necesite (no activada en PRD).

export const DIAS_RETENCION_MENSAJES_WHATSAPP = 90;

export type ResultadoDepuracion = { corte: string; mensajes: number; codigos: number; sesiones: number; ejecutado: boolean };

export async function depurarRegistrosWhatsapp(
  opciones: { ahora?: Date; ejecutar?: boolean; usuarioId?: string | null } = {}
): Promise<ResultadoDepuracion> {
  const ahora = opciones.ahora ?? new Date();
  const corte = new Date(ahora.getTime() - DIAS_RETENCION_MENSAJES_WHATSAPP * 86_400_000);
  const filtroMensajes = {
    createdAt: { lt: corte },
    // Fase 2A: el mensaje que dio origen a un documento se conserva (es su
    // trazabilidad; ya no guarda número, texto ni archivo).
    documentoEgresoId: null,
    OR: [{ estadoProceso: "PROCESADO" as const }, { estadoProceso: "ERROR" as const, remitentePendiente: null }],
  };
  const filtroCodigos = { createdAt: { lt: corte } };
  const filtroSesiones = { expiraEn: { lt: ahora } };

  if (!opciones.ejecutar) {
    const [mensajes, codigos, sesiones] = await Promise.all([
      db.mensajeWhatsapp.count({ where: filtroMensajes }),
      db.codigoVinculacionWhatsapp.count({ where: filtroCodigos }),
      db.sesionWhatsapp.count({ where: filtroSesiones }),
    ]);
    return { corte: corte.toISOString(), mensajes, codigos, sesiones, ejecutado: false };
  }

  return db.$transaction(async (tx) => {
    const mensajes = (await tx.mensajeWhatsapp.deleteMany({ where: filtroMensajes })).count;
    const codigos = (await tx.codigoVinculacionWhatsapp.deleteMany({ where: filtroCodigos })).count;
    const sesiones = (await tx.sesionWhatsapp.deleteMany({ where: filtroSesiones })).count;
    await registrarAuditoriaTx(tx, {
      empresaId: null,
      usuarioId: opciones.usuarioId ?? null,
      entidad: "RetencionWhatsapp",
      entidadId: corte.toISOString(),
      accion: "ELIMINAR",
      valorNuevo: { corte: corte.toISOString(), diasRetencion: DIAS_RETENCION_MENSAJES_WHATSAPP, mensajes, codigos, sesiones },
    });
    return { corte: corte.toISOString(), mensajes, codigos, sesiones, ejecutado: true };
  });
}

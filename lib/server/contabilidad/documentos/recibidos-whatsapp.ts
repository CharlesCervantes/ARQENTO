import "server-only";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { eliminarArchivo, esReferenciaRemota } from "@/lib/server/archivos";
import { puedeVerContabilidad } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { procesarMensajesPendientes } from "@/lib/server/whatsapp/mensajes";
import { archivosLimitadosDesde, recepcionesPendientes } from "@/lib/server/whatsapp/archivos-recibidos";
import { bloquearHuellaDeDocumentoTx } from "./recepcion";

// Bandeja «Recibidos por WhatsApp» (Contabilidad → Egresos) — Fase 2A,
// noviembre 2026. Comprobantes que los usuarios vinculados enviaron al número
// oficial, pendientes de revisión humana. Reglas:
// - Funciona con ARQENTO IA APAGADA: depende de que WhatsApp esté habilitado
//   para la Empresa, no del interruptor de IA. Por ahora permite consultar,
//   ver el archivo y descartar; registrar el gasto llegará con la Fase 2B.
// - Solo Administrador y Director (quienes ven Contabilidad). Que un
//   Supervisor pueda ENVIAR comprobantes no le da acceso a esta bandeja.
// - Siempre acotada a la Empresa de la sesión, verificada en el servidor.
// - Descartar un archivo recibido por error ELIMINA el objeto privado y
//   conserva solo la auditoría mínima (sin nombre de archivo ni pie de foto).
// - Abrir la bandeja NO procesa nada (no descarga ni sube archivos durante
//   la carga de la página): solo muestra las recepciones sin terminar.
//   Reanudarlas es una acción explícita (reanudarRecepcionesRecibidas).

export const MENSAJE_BANDEJA_NO_DISPONIBLE = "La recepción de comprobantes por WhatsApp no está habilitada para tu Empresa.";

function empresaDeContabilidad(usuario: UsuarioSesion): string {
  if (!puedeVerContabilidad(usuario) || !usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// Releído SIEMPRE de la base: Empresa activa y con WhatsApp habilitado.
async function whatsappHabilitado(empresaId: string): Promise<boolean> {
  const empresa = await db.empresa.findUnique({ where: { id: empresaId }, select: { activa: true, whatsappHabilitado: true } });
  return Boolean(empresa?.activa && empresa.whatsappHabilitado);
}

async function requerirBandeja(usuario: UsuarioSesion): Promise<string> {
  const empresaId = empresaDeContabilidad(usuario);
  if (!(await whatsappHabilitado(empresaId))) throw new ValidacionError(MENSAJE_BANDEJA_NO_DISPONIBLE);
  return empresaId;
}

export type DocumentoRecibidoFila = {
  id: string;
  nombre: string;
  tipoMime: string;
  recibidoEn: string;
  enviadoPor: string;
  contexto: string | null;
  // El documento ya se descartó, pero su archivo todavía no se pudo eliminar.
  eliminacionPendiente: boolean;
};

// Recepción que todavía no produce un documento: sigue identificable (quién
// la envió y cuándo) hasta que se guarda o se rechaza.
export type RecepcionPendienteFila = { id: string; recibidoEn: string; enviadoPor: string; estado: "EN_CURSO" | "DETENIDA"; almacenado: boolean };

export type BandejaRecibidos = {
  documentos: DocumentoRecibidoFila[];
  recepciones: RecepcionPendienteFila[];
  // Comprobantes no guardados en las últimas 24 horas por el límite de
  // archivos por número (su remitente ya fue avisado).
  limitados: number;
};

// null = la bandeja no aplica (WhatsApp apagado para la Empresa): la pantalla
// simplemente no la muestra.
export async function obtenerBandejaRecibidos(usuario: UsuarioSesion): Promise<BandejaRecibidos | null> {
  const empresaId = empresaDeContabilidad(usuario);
  if (!(await whatsappHabilitado(empresaId))) return null;

  const [documentos, recepciones, limitados] = await Promise.all([
    db.documentoEgreso.findMany({
      where: {
        empresaId,
        origen: "WHATSAPP",
        OR: [{ estatus: "PENDIENTE" }, { estatus: "DESCARTADO", archivoEliminadoEn: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, archivoNombre: true, tipoMime: true, createdAt: true, contextoUsuario: true, estatus: true, subidoPor: { select: { nombre: true } } },
    }),
    recepcionesPendientes(empresaId),
    archivosLimitadosDesde(empresaId, new Date(Date.now() - 24 * 3_600_000)),
  ]);
  const idsDeUsuarios = [...new Set(recepciones.map((r) => r.usuarioId).filter((id): id is string => id !== null))];
  const usuarios = idsDeUsuarios.length > 0 ? await db.usuario.findMany({ where: { id: { in: idsDeUsuarios }, empresaId }, select: { id: true, nombre: true } }) : [];
  const nombreDe = new Map(usuarios.map((u) => [u.id, u.nombre]));
  return {
    limitados,
    recepciones: recepciones.map((r) => ({
      id: r.id,
      recibidoEn: r.recibidoEn.toISOString(),
      enviadoPor: (r.usuarioId && nombreDe.get(r.usuarioId)) || "Usuario",
      estado: r.estado,
      almacenado: r.almacenado,
    })),
    documentos: documentos.map((d) => ({
      id: d.id,
      nombre: d.archivoNombre,
      tipoMime: d.tipoMime,
      recibidoEn: d.createdAt.toISOString(),
      enviadoPor: d.subidoPor.nombre,
      contexto: d.contextoUsuario,
      eliminacionPendiente: d.estatus === "DESCARTADO",
    })),
  };
}

export type ResultadoReanudacion = { revisadas: number; guardadas: number; pendientes: number };

// Acción EXPLÍCITA: reintenta las recepciones sin terminar de la Empresa de
// la sesión (nunca de otra), incluidas las detenidas. Acotada en cantidad y
// en tiempo; lo que falte sigue en la bandeja para otro intento.
export async function reanudarRecepcionesRecibidas(usuario: UsuarioSesion): Promise<ResultadoReanudacion> {
  const empresaId = await requerirBandeja(usuario);
  const resumen = await procesarMensajesPendientes(3, [], { empresaId, manual: true, presupuestoMs: 20_000 });
  const pendientes = (await recepcionesPendientes(empresaId)).length;
  return { revisadas: resumen.revisados, guardadas: resumen.procesados, pendientes };
}

// Referencia privada del archivo de un documento recibido — solo pendientes
// de la propia Empresa. La ruta que la usa responde con una URL temporal.
export async function obtenerRefDocumentoRecibido(usuario: UsuarioSesion, documentoEgresoId: string): Promise<string> {
  const empresaId = await requerirBandeja(usuario);
  const documento = await db.documentoEgreso.findFirst({
    where: { id: documentoEgresoId, empresaId, origen: "WHATSAPP", estatus: "PENDIENTE", archivoEliminadoEn: null },
    select: { archivoRef: true },
  });
  // Uno de otra Empresa "no existe" para este usuario.
  if (!documento) throw new RegistroNoEncontradoError("El documento");
  return documento.archivoRef;
}

export type ResultadoDescarte = { archivoEliminado: boolean };

// Descartar un comprobante recibido por error. Idempotente:
// 1) En una transacción (bloqueo de huella y de fila) pasa a DESCARTADO —
//    desde ese momento no se muestra, no se abre y no se reutiliza si el
//    mismo archivo vuelve a llegar.
// 2) Se elimina el objeto privado, SOLO si ningún otro registro lo usa.
// 3) Se anota la eliminación y se borran el nombre del archivo y el pie de
//    foto. Queda la auditoría mínima.
// Si el paso 2 falla, el documento queda DESCARTADO con eliminación
// pendiente y se puede reintentar desde la bandeja.
export async function descartarDocumentoRecibido(usuario: UsuarioSesion, documentoEgresoId: string): Promise<ResultadoDescarte> {
  const empresaId = await requerirBandeja(usuario);
  const filtro = { id: documentoEgresoId, empresaId, origen: "WHATSAPP" as const };
  const previo = await db.documentoEgreso.findFirst({ where: filtro, select: { hashArchivo: true } });
  if (!previo) throw new RegistroNoEncontradoError("El documento");

  const documento = await db.$transaction(async (tx) => {
    // Mismo orden de bloqueo que la recepción: huella → fila del documento.
    await bloquearHuellaDeDocumentoTx(tx, empresaId, previo.hashArchivo);
    await tx.$queryRaw`SELECT id FROM documentos_egreso WHERE id = ${documentoEgresoId} FOR UPDATE`;
    const actual = await tx.documentoEgreso.findFirst({ where: filtro });
    if (!actual) throw new RegistroNoEncontradoError("El documento");
    if (actual.estatus === "CONVERTIDO" || actual.estatus === "VINCULADO" || actual.egresoId) {
      throw new ValidacionError("Este documento ya fue registrado — no se puede descartar.");
    }
    if (actual.estatus !== "DESCARTADO") {
      await tx.documentoEgreso.update({ where: { id: actual.id }, data: { estatus: "DESCARTADO" } });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: "DocumentoEgreso",
        entidadId: actual.id,
        accion: "CAMBIAR_ESTATUS",
        valorAnterior: { estatus: actual.estatus },
        valorNuevo: { estatus: "DESCARTADO", origen: "WHATSAPP" },
      });
    }
    return actual;
  });
  if (documento.archivoEliminadoEn) return { archivoEliminado: true };

  // Nunca se elimina un objeto compartido: otro documento (de cualquier
  // Empresa) o un trabajo de análisis que use la misma referencia lo impide.
  const [otrosDocumentos, trabajos] = await Promise.all([
    db.documentoEgreso.count({ where: { archivoRef: documento.archivoRef, id: { not: documento.id } } }),
    db.trabajoProcesamientoDocumento.count({ where: { archivoRef: documento.archivoRef } }),
  ]);
  if (otrosDocumentos > 0 || trabajos > 0 || esReferenciaRemota(documento.archivoRef)) return { archivoEliminado: false };

  try {
    await eliminarArchivo(documento.archivoRef);
  } catch {
    throw new ValidacionError("El documento se descartó, pero su archivo todavía no se pudo eliminar. Vuelve a intentarlo desde la bandeja.");
  }
  await db.$transaction(async (tx) => {
    await tx.documentoEgreso.update({
      where: { id: documento.id },
      data: { archivoEliminadoEn: new Date(), archivoNombre: "(archivo eliminado)", contextoUsuario: null, contextosAdicionales: Prisma.DbNull },
    });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "DocumentoEgreso",
      entidadId: documento.id,
      accion: "ELIMINAR",
      valorNuevo: { archivoEliminado: true },
    });
  });
  return { archivoEliminado: true };
}

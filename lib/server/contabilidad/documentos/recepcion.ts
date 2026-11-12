import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { buscarDocumentoPorHash } from "@/lib/server/inteligencia/trabajos";
import { extraerTextoPdfNativo } from "@/lib/server/inteligencia/extractor-pdf-nativo";
import { MAX_BYTES_POR_DOCUMENTO, MAX_PAGINAS_POR_DOCUMENTO, tipoArchivoDetectado, type MimeSoportado } from "@/lib/contabilidad/tipo-archivo";
import { reutilizarDocumento } from "./documento-egreso";

// Recepción de un comprobante que NO sube una persona desde la web (Fase 2A
// WhatsApp, noviembre 2026). Reutiliza DocumentoEgreso, su huella SHA-256 y
// el mismo bloqueo de duplicados de la subida web. Diferencias deliberadas:
// - No exige ARQENTO IA ni crea trabajo de análisis: el documento queda
//   PENDIENTE para revisión humana en la bandeja «Recibidos por WhatsApp».
// - Quien lo envía (subidoPorId) puede ser un Supervisor: enviar no le da
//   acceso a Contabilidad. La autorización del remitente la resuelve quien
//   llama (lib/server/whatsapp/archivos-recibidos.ts), siempre en el servidor.

export type MotivoRechazoArchivo = "TIPO" | "TAMANO" | "CONTENIDO" | "PAGINAS";

// El archivo no se puede aceptar. `code` es un diagnóstico técnico sin datos
// personales (nunca el nombre ni el contenido del archivo).
export class ArchivoRechazadoError extends Error {
  readonly motivo: MotivoRechazoArchivo;
  readonly code: string;
  constructor(motivo: MotivoRechazoArchivo) {
    super(`Archivo no aceptado (${motivo}).`);
    this.name = "ArchivoRechazado";
    this.motivo = motivo;
    this.code = motivo;
  }
}

// Valida tamaño, tipo REAL (por contenido, nunca por lo que declare el
// remitente) y, en un PDF, que se pueda leer y no exceda las páginas
// permitidas. Si el tipo declarado no coincide con el real, se rechaza.
export async function validarArchivoRecibido(bytes: Buffer, tipoDeclarado: string | null): Promise<MimeSoportado> {
  if (bytes.length === 0) throw new ArchivoRechazadoError("CONTENIDO");
  if (bytes.length > MAX_BYTES_POR_DOCUMENTO) throw new ArchivoRechazadoError("TAMANO");
  const real = tipoArchivoDetectado(bytes);
  if (!real) throw new ArchivoRechazadoError("TIPO");
  if (tipoDeclaradoContradice(tipoDeclarado, real)) throw new ArchivoRechazadoError("CONTENIDO");
  if (real === "application/pdf") {
    let paginas: number;
    try {
      ({ paginas } = await extraerTextoPdfNativo(bytes));
    } catch {
      throw new ArchivoRechazadoError("CONTENIDO");
    }
    if (paginas < 1) throw new ArchivoRechazadoError("CONTENIDO");
    if (paginas > MAX_PAGINAS_POR_DOCUMENTO) throw new ArchivoRechazadoError("PAGINAS");
  }
  return real;
}

// El tipo que declara el remitente solo sirve para detectar un archivo
// disfrazado; el que manda es el REAL. No contradice: no declarar nada, un
// tipo genérico ("application/octet-stream", como llegan algunos documentos)
// o el alias "image/jpg".
function tipoDeclaradoContradice(tipoDeclarado: string | null, real: MimeSoportado): boolean {
  const declarado = tipoDeclarado?.split(";")[0].trim().toLowerCase() || null;
  if (!declarado || declarado === "application/octet-stream" || declarado === "binary/octet-stream") return false;
  return (declarado === "image/jpg" ? "image/jpeg" : declarado) !== real;
}

// El archivo se detectó como repetido ANTES de subirlo, pero el documento
// original ya no está disponible al guardar: hay que reintentar la recepción
// completa (ahora sí subirá el archivo).
export class ArchivoSinAlmacenarError extends Error {
  readonly code = "sin-archivo";
  constructor() {
    super("El archivo todavía no está almacenado.");
    this.name = "ArchivoSinAlmacenar";
  }
}

// Bloqueo por (Empresa, huella): el mismo de la subida web. Serializa las
// recepciones simultáneas del mismo archivo y su descarte.
export async function bloquearHuellaDeDocumentoTx(tx: Prisma.TransactionClient, empresaId: string, hashArchivo: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`documento-egreso:${empresaId}:${hashArchivo}`}, 0))`;
}

export type DocumentoRecibido = { documentoEgresoId: string; duplicado: boolean };

// Crea el documento recibido o reutiliza el que ya existe con la misma huella
// EN ESA EMPRESA (nunca entre Empresas). El archivo ya debe estar almacenado.
// Sin trabajo de análisis: no se llama a ninguna IA.
export async function guardarDocumentoRecibidoTx(
  tx: Prisma.TransactionClient,
  args: {
    empresaId: string;
    usuarioId: string;
    // null = se detectó como repetido antes de subirlo (no hay copia nueva).
    archivoRef: string | null;
    archivoNombre: string;
    tipoMime: MimeSoportado;
    hashArchivo: string;
    contexto: string | null;
  }
): Promise<DocumentoRecibido> {
  await bloquearHuellaDeDocumentoTx(tx, args.empresaId, args.hashArchivo);
  const previo = await buscarDocumentoPorHash(args.empresaId, args.hashArchivo, tx, { excluirDescartados: true });
  if (previo) {
    // Mismo archivo, misma Empresa: no se crea otro registro. El pie de foto
    // nuevo, si lo hay y es distinto, se agrega como anotación; el documento
    // se queda en su lote.
    await reutilizarDocumento(tx, previo, { loteId: previo.loteId, contexto: args.contexto, usuarioId: args.usuarioId });
    // La recepción repetida queda identificada (quién y por qué canal), sin
    // crear otro documento financiero.
    await registrarAuditoriaTx(tx, {
      empresaId: args.empresaId,
      usuarioId: args.usuarioId,
      entidad: "DocumentoEgreso",
      entidadId: previo.id,
      accion: "EDITAR",
      valorNuevo: { recepcionRepetida: "WHATSAPP" },
    });
    return { documentoEgresoId: previo.id, duplicado: true };
  }
  if (!args.archivoRef) throw new ArchivoSinAlmacenarError();
  const documento = await tx.documentoEgreso.create({
    data: {
      empresaId: args.empresaId,
      archivoRef: args.archivoRef,
      archivoNombre: args.archivoNombre,
      tipoMime: args.tipoMime,
      hashArchivo: args.hashArchivo,
      loteId: crypto.randomUUID(),
      contextoUsuario: args.contexto,
      origen: "WHATSAPP",
      subidoPorId: args.usuarioId,
    },
    select: { id: true },
  });
  await registrarAuditoriaTx(tx, {
    empresaId: args.empresaId,
    usuarioId: args.usuarioId,
    entidad: "DocumentoEgreso",
    entidadId: documento.id,
    accion: "CREAR",
    // Sin nombre de archivo, pie de foto ni teléfono.
    valorNuevo: { origen: "WHATSAPP", tipoMime: args.tipoMime, estatus: "PENDIENTE" },
  });
  return { documentoEgresoId: documento.id, duplicado: false };
}

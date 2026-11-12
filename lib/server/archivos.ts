import "server-only";
import { randomBytes } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Único punto de acceso a almacenamiento de archivos de todo el sistema —
// Proyectos, Empresas (logo), Recibos, Gastos de Obra y Órdenes de Compra lo
// comparten. NINGÚN otro módulo debe importar `@aws-sdk/*` directamente: si
// el proveedor cambia (ej. de R2 a S3 real), solo este archivo se toca.
//
// El bucket es privado (Cloudflare R2, API compatible con S3) — nunca se
// guarda ni se sirve una URL pública permanente. Lo que persisten los
// modelos de negocio es una "referencia" (`ref`) opaca: hoy es un objectKey
// de R2, pero durante la transición desde Vercel Blob (proveedor anterior,
// bucket público) algunas filas ya existentes siguen teniendo una URL
// http(s) real de ese proveedor. Esta capa es la única que distingue los dos
// casos (`esReferenciaRemota`) — todo lo demás en el sistema solo pide
// "dame una URL para ver esto" o "dame los bytes", sin saber de dónde viene.

const BUCKET = process.env.R2_BUCKET_NAME;
const ENDPOINT = process.env.R2_ENDPOINT;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

const EXPIRACION_URL_TEMPORAL_SEGUNDOS = 5 * 60;

function cliente(): S3Client {
  if (!BUCKET || !ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
    throw new Error(
      "Almacenamiento no configurado: faltan R2_BUCKET_NAME/R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY en el entorno."
    );
  }
  // R2 solo tiene una región lógica ("auto") — la exige el SDK de S3 aunque
  // R2 no la use realmente.
  return new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  });
}

// true = el almacenamiento tiene su configuración completa. Quien recibe
// archivos sin intervención de una persona (WhatsApp) lo consulta ANTES de
// descargar nada, para fallar de forma controlada si falta.
export function almacenamientoConfigurado(): boolean {
  return Boolean(BUCKET && ENDPOINT && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

// Sube bytes a una clave EXACTA, decidida por quien llama (Fase 2A WhatsApp,
// noviembre 2026). Repetir la subida a la misma clave la sobrescribe con el
// mismo contenido: así una recepción interrumpida se reanuda sin dejar
// objetos huérfanos. La clave debe venir ya saneada.
export async function subirBytes(ref: string, bytes: Uint8Array, tipoMime: string): Promise<void> {
  if (esReferenciaRemota(ref) || !/^[A-Za-z0-9_\-./]+$/.test(ref) || ref.includes("..")) {
    throw new Error("Referencia de archivo no válida.");
  }
  await cliente().send(new PutObjectCommand({ Bucket: BUCKET, Key: ref, Body: bytes, ContentType: tipoMime }));
}

// true = el objeto existe en el almacenamiento privado.
export async function existeArchivo(ref: string): Promise<boolean> {
  if (esReferenciaRemota(ref)) return false;
  try {
    await cliente().send(new HeadObjectCommand({ Bucket: BUCKET, Key: ref }));
    return true;
  } catch (error) {
    const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.message === "NotFound" || e?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

// Elimina un objeto privado. Idempotente (eliminar uno que ya no existe no
// falla). Nunca toca referencias históricas remotas. Quien llama es
// responsable de haber verificado que ningún otro registro lo usa.
export async function eliminarArchivo(ref: string): Promise<void> {
  if (esReferenciaRemota(ref)) throw new Error("Una referencia remota histórica no se puede eliminar.");
  await cliente().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: ref }));
}

function sufijoAleatorio(): string {
  return randomBytes(6).toString("base64url");
}

// Sube un archivo nuevo y devuelve su `ref` (objectKey de R2) — nunca una
// URL, porque en un bucket privado no existe tal cosa.
export async function subirArchivo(
  carpeta: string,
  archivo: File
): Promise<{ ref: string; nombre: string }> {
  const key = `${carpeta}/${sufijoAleatorio()}-${archivo.name}`;
  const bytes = new Uint8Array(await archivo.arrayBuffer());

  await cliente().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: archivo.type || undefined,
    })
  );

  return { ref: key, nombre: archivo.name };
}

// true = `ref` es en realidad una URL http(s) real de un proveedor anterior
// (Vercel Blob, bucket público) guardada antes de esta migración — sigue
// siendo válida y descargable tal cual, nunca se reescribe retroactivamente.
export function esReferenciaRemota(ref: string): boolean {
  return ref.startsWith("http://") || ref.startsWith("https://");
}

// URL de corta duración para que el navegador descargue/visualice un
// archivo privado — SIEMPRE detrás de un endpoint que ya verificó sesión +
// empresa + permiso antes de llamar a esto (ver rutas /api/.../[archivo]).
export async function obtenerUrlTemporal(
  ref: string,
  expiraSegundos: number = EXPIRACION_URL_TEMPORAL_SEGUNDOS
): Promise<string> {
  if (esReferenciaRemota(ref)) return ref;

  return getSignedUrl(
    cliente(),
    new GetObjectCommand({ Bucket: BUCKET, Key: ref }),
    { expiresIn: expiraSegundos }
  );
}

// Bytes completos de un archivo — lo usan los generadores de PDF (logo en
// el encabezado) para pasárselos directo a <Image src={buffer}> en vez de
// depender de que @react-pdf/renderer resuelva una URL firmada antes de que
// expire.
export async function obtenerArchivo(ref: string): Promise<Buffer> {
  if (esReferenciaRemota(ref)) {
    const respuesta = await fetch(ref);
    if (!respuesta.ok) {
      throw new Error(`No se pudo descargar el archivo histórico (${respuesta.status}).`);
    }
    return Buffer.from(await respuesta.arrayBuffer());
  }

  const objeto = await cliente().send(new GetObjectCommand({ Bucket: BUCKET, Key: ref }));
  const bytes = await objeto.Body?.transformToByteArray();
  if (!bytes) throw new Error("El archivo no tiene contenido.");
  return Buffer.from(bytes);
}

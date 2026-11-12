// Verificación de SOLO LECTURA de la migración de la Fase 2A (WhatsApp:
// recepción de comprobantes) en ARQENTO Preview (Neon arqento-preview).
// Se ejecuta ANTES y DESPUÉS de `npm run preview:preparar` y se comparan las
// dos salidas: los conteos por tabla deben ser idénticos y, después, deben
// existir las columnas, tipos e índices nuevos.
//
//   node --import tsx scripts/preview/verificar-fase2a-preview.ts
//
// Usa las MISMAS variables y validaciones que preparar-base-preview.ts
// (PREVIEW_DIRECT_URL, PREVIEW_NEON_ENDPOINT, PREVIEW_DATABASE_NAME; nunca
// DATABASE_URL ni archivos .env*). Todo corre en una transacción READ ONLY.
// Nunca imprime URLs, usuarios, contraseñas ni contenido de registros: solo
// nombres de tablas y columnas, y conteos.
import { createHash } from "node:crypto";
import pg from "pg";
import { mensajeSeguro } from "../../tests/helpers/base-de-pruebas";
import { ESQUEMA_MARCADOR, PROYECTO_PREVIEW, VALOR_MARCADOR, validarConfiguracionPreview, type Consultar } from "./base-preview";

const SCRIPT = "verificar-fase2a-preview";
const MIGRACION = "20261110120000_whatsapp_fase2a_recepcion_documentos";
const imprimir = (linea: string) => console.log(`[${SCRIPT}] ${linea}`);

const COLUMNAS = [
  { tabla: "documentos_egreso", columna: "origen", tipo: "OrigenDocumentoEgreso", anulable: false },
  { tabla: "documentos_egreso", columna: "archivoEliminadoEn", tipo: "timestamp", anulable: true },
  { tabla: "mensajes_whatsapp", columna: "etapaArchivo", tipo: "EtapaArchivoWhatsapp", anulable: true },
  { tabla: "mensajes_whatsapp", columna: "archivoPendiente", tipo: "jsonb", anulable: true },
  { tabla: "mensajes_whatsapp", columna: "documentoEgresoId", tipo: "text", anulable: true },
];
const ENUMS: Record<string, string[]> = {
  OrigenDocumentoEgreso: ["WEB", "WHATSAPP"],
  EtapaArchivoWhatsapp: ["ASIGNADO", "ALMACENADO", "GUARDADO", "RECHAZADO"],
};
const INDICES = ["documentos_egreso_empresaId_origen_estatus_idx", "mensajes_whatsapp_documentoEgresoId_idx"];

export async function verificarFase2a(consultar: Consultar, esperado: { endpoint: string; base: string }, linea: (l: string) => void): Promise<boolean> {
  // Identidad de la base: nombre real y marcador exclusivo de arqento-preview.
  const [{ base }] = await consultar(`SELECT current_database() AS base`);
  if (base !== esperado.base) throw new Error("La base conectada no es la esperada.");
  const marcadores = await consultar(`SELECT valor, proyecto, endpoint, base, estado FROM ${ESQUEMA_MARCADOR}.marcador`);
  const m = marcadores[0];
  if (marcadores.length !== 1 || m.valor !== VALOR_MARCADOR || m.proyecto !== PROYECTO_PREVIEW || m.endpoint !== esperado.endpoint || m.base !== esperado.base) {
    throw new Error("La base no tiene el marcador de arqento-preview para este endpoint.");
  }
  linea(`Identidad confirmada: marcador ${PROYECTO_PREVIEW}, estado ${m.estado}.`);

  const migraciones = await consultar(
    `SELECT migration_name AS nombre, finished_at IS NOT NULL AS terminada, rolled_back_at IS NOT NULL AS revertida FROM _prisma_migrations ORDER BY migration_name`
  );
  const incompletas = migraciones.filter((x) => !x.terminada || x.revertida).length;
  const aplicada = migraciones.some((x) => x.nombre === MIGRACION && x.terminada && !x.revertida);
  linea(`Migraciones registradas: ${migraciones.length}; fallidas o revertidas: ${incompletas}; Fase 2A aplicada: ${aplicada ? "sí" : "no"}.`);

  // Conteo exacto de TODAS las tablas de negocio (sin el historial de Prisma).
  const tablas = (await consultar(`SELECT table_name AS tabla FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`))
    .map((t) => String(t.tabla))
    .filter((t) => t !== "_prisma_migrations");
  const conteos: string[] = [];
  let total = 0;
  for (const tabla of tablas) {
    const [{ n }] = await consultar(`SELECT count(*)::int AS n FROM public."${tabla.replace(/"/g, '""')}"`);
    conteos.push(`${tabla}=${n}`);
    total += Number(n);
  }
  const de = (tabla: string) => conteos.find((c) => c.startsWith(`${tabla}=`))?.split("=")[1] ?? "no existe";
  linea(`Tablas: ${tablas.length}; registros en total: ${total}.`);
  linea(`documentos_egreso: ${de("documentos_egreso")}; mensajes_whatsapp: ${de("mensajes_whatsapp")}; usuarios: ${de("usuarios")}; empresas: ${de("empresas")}; vinculos_whatsapp: ${de("vinculos_whatsapp")}.`);
  linea(`Huella de conteos (debe ser IGUAL antes y después): ${createHash("sha256").update(conteos.join("|")).digest("hex").slice(0, 16)}`);

  if (!aplicada) {
    linea("La migración de la Fase 2A todavía no está aplicada: guarda la huella de arriba y compárala después.");
    return incompletas === 0;
  }

  // Estructura nueva.
  let correcto = incompletas === 0;
  const revisar = (ok: boolean, texto: string) => {
    if (!ok) correcto = false;
    linea(`${ok ? "correcto " : "FALTA    "} ${texto}`);
  };
  const columnas = await consultar(
    `SELECT table_name AS tabla, column_name AS columna, data_type AS tipo, udt_name AS udt, is_nullable AS anulable, column_default AS omision
     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...new Set(COLUMNAS.map((c) => c.tabla))]]
  );
  for (const c of COLUMNAS) {
    const real = columnas.find((x) => x.tabla === c.tabla && x.columna === c.columna);
    const tipoOk = real !== undefined && (real.udt === c.tipo || String(real.tipo).startsWith(c.tipo));
    revisar(tipoOk && (real?.anulable === "YES") === c.anulable, `columna ${c.tabla}.${c.columna} (${c.tipo}${c.anulable ? ", anulable" : ", obligatoria"})`);
    if (c.columna === "origen") revisar(String(real?.omision ?? "").startsWith("'WEB'"), "valor por omisión de documentos_egreso.origen = WEB");
  }
  for (const [nombre, valores] of Object.entries(ENUMS)) {
    const reales = (await consultar(`SELECT e.enumlabel AS valor FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder`, [nombre])).map((v) => String(v.valor));
    revisar(reales.join(",") === valores.join(","), `tipo ${nombre} (${valores.join(", ")})`);
  }
  const indices = (await consultar(`SELECT indexname AS nombre FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`, [INDICES])).map((i) => String(i.nombre));
  for (const indice of INDICES) revisar(indices.includes(indice), `índice ${indice}`);

  // Los registros que ya existían no cambian de significado.
  const [d] = await consultar(`SELECT count(*) FILTER (WHERE origen <> 'WEB')::int AS no_web, count(*) FILTER (WHERE "archivoEliminadoEn" IS NOT NULL)::int AS eliminados FROM documentos_egreso`);
  const [w] = await consultar(
    `SELECT count(*) FILTER (WHERE "etapaArchivo" IS NOT NULL OR "archivoPendiente" IS NOT NULL OR "documentoEgresoId" IS NOT NULL)::int AS con_archivo FROM mensajes_whatsapp`
  );
  linea(`Documentos con origen distinto de WEB: ${d.no_web}; con archivo eliminado: ${d.eliminados}; mensajes con datos de archivo: ${w.con_archivo}.`);
  linea("(Justo después de migrar, y antes de desplegar el código nuevo, los tres deben ser 0.)");
  return correcto;
}

async function main() {
  const config = validarConfiguracionPreview(process.env, process.cwd());
  imprimir(`Destino validado sin conexión: ${config.destino} (conexión directa, TLS).`);
  const cliente = new pg.Client({ connectionString: config.url, connectionTimeoutMillis: 15000, application_name: SCRIPT });
  await cliente.connect();
  try {
    await cliente.query("BEGIN READ ONLY");
    const ok = await verificarFase2a(async (sql, parametros) => (await cliente.query(sql, parametros as unknown[] | undefined)).rows, config, imprimir);
    await cliente.query("ROLLBACK");
    imprimir(ok ? "Verificación terminada sin problemas. No se escribió nada." : "Verificación terminada CON PROBLEMAS. No se escribió nada.");
    if (!ok) process.exitCode = 1;
  } finally {
    await cliente.end();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/preview/verificar-fase2a-preview.ts")) {
  main().catch((error) => {
    console.error(`[${SCRIPT}] CANCELADO: ${mensajeSeguro(error, process.env.PREVIEW_DIRECT_URL)}`);
    process.exit(1);
  });
}

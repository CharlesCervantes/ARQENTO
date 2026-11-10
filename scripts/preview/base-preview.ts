import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Preparación protegida de la base de ARQENTO Preview (proyecto Neon
// "arqento-preview") — noviembre 2026, Fase 1 WhatsApp + ARQENTO IA.
//
// 1. SIN CONEXIÓN (validarConfiguracionPreview): la conexión solo se toma de
//    PREVIEW_DIRECT_URL — nunca de DATABASE_URL/DIRECT_URL ni de un archivo
//    .env*. Debe ser la conexión DIRECTA (sin -pooler) de Neon, con TLS, al
//    endpoint PREVIEW_NEON_ENDPOINT y a la base PREVIEW_DATABASE_NAME. Se
//    rechazan los endpoints conocidos de desarrollo y producción y cualquier
//    endpoint que aparezca en el entorno o en un archivo .env* de la raíz.
// 2. CONECTADO, SOLO LECTURA (leerEstado + clasificarEstado): nombre real de
//    la base, tablas, marcador e historial de migraciones. Solo hay tres
//    estados válidos; cualquier otro detiene el proceso SIN repararlo:
//    - NUEVA: base completamente vacía y sin marcador.
//    - EN_PREPARACION: marcador correcto en estado PREPARANDO (una ejecución
//      anterior se interrumpió) — se reanuda.
//    - LISTA: marcador correcto en estado LISTA.
// 3. Marcador (arqento_preview.marcador): se crea ANTES de la primera
//    migración, en estado PREPARANDO, para que una interrupción deje una
//    base identificable y reanudable. Solo pasa a LISTA cuando terminaron
//    las migraciones y la semilla y se verificaron.
// 4. Semilla ficticia en UNA transacción: Master, Empresa Demo,
//    Administrador y Supervisor, con contraseñas aleatorias y cambio
//    obligatorio. Nada de Conkuali.
//
// Nunca imprime URLs, usuarios ni contraseñas de conexión.
// ---------------------------------------------------------------------------

export class PreparacionPreviewCancelada extends Error {}

export type Entorno = Record<string, string | undefined>;
export type Consultar = (sql: string, parametros?: unknown[]) => Promise<Record<string, unknown>[]>;

export const PROYECTO_PREVIEW = "arqento-preview";
export const ESQUEMA_MARCADOR = "arqento_preview";
export const VALOR_MARCADOR = "ARQENTO-PREVIEW-NEON";
// Endpoints de Neon conocidos que NUNCA son Preview — desarrollo (proyecto
// conkuali) y producción —, guardados solo como SHA-256 del ep-… en
// minúsculas, para no dejar los identificadores en el repositorio. Se
// comparan además con los endpoints de los archivos .env* y del entorno
// (endpointsDeOtrosEntornos).
export const ENDPOINTS_PROHIBIDOS_SHA256 = [
  "d1b767a72c509374cb7444ee4b8ff8d161964f1159d608c9793ba3103835ff3c", // desarrollo
  "07e76139560f0069a4d9615a05478f7f6879df3346f93697a96b0dcd51c6da5b", // producción
];

export const hashEndpoint = (endpoint: string) => createHash("sha256").update(endpoint.trim().toLowerCase()).digest("hex");

const PARAMETROS_PERMITIDOS = new Set(["sslmode", "channel_binding", "connect_timeout", "application_name"]);
const SSL_ACEPTADO = new Set(["require", "verify-ca", "verify-full"]);
const PATRON_URL_POSTGRES = /postgres(?:ql)?:\/\/[^\s"'<>`]+/gi;
const PATRON_ENDPOINT = /^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function cancelar(mensaje: string): never {
  throw new PreparacionPreviewCancelada(mensaje);
}

// ---------------------------------------------------------------------------
// 1. Validación sin conexión
// ---------------------------------------------------------------------------

export type ConfiguracionPreview = { url: string; endpoint: string; base: string; destino: string };

const endpointDeHost = (host: string) => host.split(".")[0].replace(/-pooler$/, "");

// Endpoints de Neon de cualquier OTRA conexión conocida: variables del
// entorno (salvo PREVIEW_*) y todos los archivos .env* de la raíz. Solo se
// comparan en memoria; nunca se usan para conectarse ni se imprimen.
export function endpointsDeOtrosEntornos(raiz: string, env: Entorno): Set<string> {
  const textos: string[] = [];
  for (const [clave, valor] of Object.entries(env)) if (valor && !clave.startsWith("PREVIEW_")) textos.push(valor);
  const archivos = existsSync(raiz) ? readdirSync(raiz).filter((n) => n.startsWith(".env")) : [];
  for (const archivo of archivos) {
    try {
      textos.push(readFileSync(join(raiz, archivo), "utf8"));
    } catch {
      // Ilegible: no aporta endpoints.
    }
  }
  const endpoints = new Set<string>();
  for (const texto of textos) {
    for (const encontrada of texto.match(PATRON_URL_POSTGRES) ?? []) {
      try {
        endpoints.add(endpointDeHost(new URL(encontrada).hostname.toLowerCase()));
      } catch {
        // No es una URL: se ignora.
      }
    }
  }
  return endpoints;
}

export function validarConfiguracionPreview(env: Entorno, raiz: string, hashesProhibidos: string[] = ENDPOINTS_PROHIBIDOS_SHA256): ConfiguracionPreview {
  if (env.VERCEL || env.VERCEL_ENV) cancelar("Este script solo se ejecuta en un equipo local, nunca dentro de Vercel.");
  const url = env.PREVIEW_DIRECT_URL;
  const endpoint = (env.PREVIEW_NEON_ENDPOINT ?? "").trim().toLowerCase();
  const base = (env.PREVIEW_DATABASE_NAME ?? "").trim();
  if (!url) cancelar("Falta PREVIEW_DIRECT_URL (conexión DIRECTA de arqento-preview). No se usa ninguna otra variable.");
  if (!endpoint) cancelar("Falta PREVIEW_NEON_ENDPOINT (el ep-… del proyecto arqento-preview en la consola de Neon).");
  if (!base) cancelar("Falta PREVIEW_DATABASE_NAME (nombre de la base de arqento-preview).");
  if (!PATRON_ENDPOINT.test(endpoint) || endpoint.endsWith("-pooler")) cancelar("PREVIEW_NEON_ENDPOINT no tiene el formato ep-… de Neon (sin -pooler).");

  let u: URL;
  try {
    u = new URL(url!);
  } catch {
    return cancelar("PREVIEW_DIRECT_URL no es una URL válida.");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") cancelar("PREVIEW_DIRECT_URL debe ser postgres:// o postgresql://.");
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".neon.tech")) cancelar("PREVIEW_DIRECT_URL no apunta a Neon.");
  const primerSegmento = host.split(".")[0];
  if (primerSegmento.endsWith("-pooler")) cancelar("PREVIEW_DIRECT_URL usa el pooler: se requiere la conexión DIRECTA.");
  if (primerSegmento !== endpoint) cancelar("El host de PREVIEW_DIRECT_URL no corresponde a PREVIEW_NEON_ENDPOINT.");
  if (u.port && u.port !== "5432") cancelar("Puerto inesperado en PREVIEW_DIRECT_URL.");
  if (!u.username || !u.password) cancelar("PREVIEW_DIRECT_URL debe incluir usuario y contraseña.");
  for (const clave of u.searchParams.keys()) {
    if (!PARAMETROS_PERMITIDOS.has(clave)) cancelar(`Parámetro no permitido en PREVIEW_DIRECT_URL: ${clave}.`);
  }
  if (!SSL_ACEPTADO.has(u.searchParams.get("sslmode") ?? "")) cancelar("PREVIEW_DIRECT_URL debe exigir TLS (sslmode=require).");
  const baseUrl = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (baseUrl !== base) cancelar("La base de PREVIEW_DIRECT_URL no coincide con PREVIEW_DATABASE_NAME.");

  if (hashesProhibidos.includes(hashEndpoint(endpoint))) cancelar("Ese endpoint es de DESARROLLO o PRODUCCIÓN: nunca es Preview.");
  if (endpointsDeOtrosEntornos(raiz, env).has(endpoint)) {
    cancelar("Ese endpoint aparece en otra conexión conocida (entorno o archivo .env*): no es exclusivo de Preview.");
  }
  return { url: url!, endpoint, base, destino: `${endpoint}/${base}` };
}

// ---------------------------------------------------------------------------
// 2. Estado de la base (solo lectura)
// ---------------------------------------------------------------------------

export type Marcador = { valor: string; proyecto: string; endpoint: string; base: string; estado: string; instalacion: string };
export type MigracionAplicada = { nombre: string; terminada: boolean; revertida: boolean };

export type EstadoObservado = {
  base: string;
  tablasPublicas: string[];
  // Tablas en esquemas que no son public ni el del marcador (desconocidas).
  tablasOtrosEsquemas: number;
  esquemaMarcador: boolean;
  tablaMarcador: boolean;
  marcadores: Marcador[];
  migraciones: MigracionAplicada[];
};

const SQL_TABLAS = `SELECT table_schema AS esquema, table_name AS tabla FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'`;

export async function leerEstado(consultar: Consultar): Promise<EstadoObservado> {
  const [{ base }] = await consultar(`SELECT current_database() AS base`);
  const tablas = await consultar(SQL_TABLAS);
  const esquemas = await consultar(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [ESQUEMA_MARCADOR]);
  const tablaMarcador = tablas.some((t) => t.esquema === ESQUEMA_MARCADOR && t.tabla === "marcador");
  const tablasPublicas = tablas.filter((t) => t.esquema === "public").map((t) => String(t.tabla));
  const marcadores = tablaMarcador
    ? ((await consultar(`SELECT valor, proyecto, endpoint, base, estado, instalacion FROM ${ESQUEMA_MARCADOR}.marcador`)) as Marcador[])
    : [];
  const migraciones = tablasPublicas.includes("_prisma_migrations")
    ? (
        await consultar(
          `SELECT migration_name AS nombre, finished_at IS NOT NULL AS terminada, rolled_back_at IS NOT NULL AS revertida FROM _prisma_migrations ORDER BY started_at, migration_name`
        )
      ).map((m) => ({ nombre: String(m.nombre), terminada: Boolean(m.terminada), revertida: Boolean(m.revertida) }))
    : [];
  return {
    base: String(base),
    tablasPublicas,
    tablasOtrosEsquemas: tablas.filter((t) => t.esquema !== "public" && t.esquema !== ESQUEMA_MARCADOR).length,
    esquemaMarcador: esquemas.length > 0,
    tablaMarcador,
    marcadores,
    migraciones,
  };
}

export type Clasificacion =
  | { tipo: "NUEVA" }
  | { tipo: "EN_PREPARACION" | "LISTA"; aplicadas: number; pendientes: string[]; instalacion: string };

// Estado observado → uno de los tres estados válidos, o cancelación con la
// lista de problemas. Nunca intenta reparar nada.
export function clasificarEstado(obs: EstadoObservado, esperado: { endpoint: string; base: string }, migracionesLocales: string[]): Clasificacion {
  const problemas: string[] = [];
  if (obs.base !== esperado.base) problemas.push("La base conectada no es la esperada (current_database distinto).");
  if (obs.tablasOtrosEsquemas > 0) problemas.push("Hay tablas en esquemas desconocidos.");

  if (!obs.esquemaMarcador && !obs.tablaMarcador) {
    if (obs.tablasPublicas.length > 0) problemas.push("La base NO está vacía y no tiene el marcador de arqento-preview.");
    if (problemas.length > 0) return cancelar(problemas.join(" "));
    return { tipo: "NUEVA" };
  }

  if (!obs.tablaMarcador) problemas.push("Existe el esquema del marcador pero no su tabla (estado desconocido).");
  if (obs.marcadores.length !== 1) problemas.push("El marcador debe tener exactamente un registro.");
  const m = obs.marcadores[0];
  if (m) {
    if (m.valor !== VALOR_MARCADOR || m.proyecto !== PROYECTO_PREVIEW) problemas.push("El marcador no es de arqento-preview.");
    if (m.endpoint !== esperado.endpoint) problemas.push("El marcador pertenece a otro endpoint de Neon.");
    if (m.base !== esperado.base) problemas.push("El marcador pertenece a otra base.");
    if (m.estado !== "PREPARANDO" && m.estado !== "LISTA") problemas.push("El marcador tiene un estado desconocido.");
  }

  const incompletas = obs.migraciones.filter((x) => !x.terminada || x.revertida);
  if (incompletas.length > 0) problemas.push(`Hay ${incompletas.length} migración(es) fallida(s) o revertida(s): requiere revisión manual.`);
  const nombres = obs.migraciones.map((x) => x.nombre);
  if (new Set(nombres).size !== nombres.length) problemas.push("El historial de migraciones tiene registros repetidos.");
  const desconocidas = nombres.filter((n) => !migracionesLocales.includes(n));
  if (desconocidas.length > 0) problemas.push("La base tiene migraciones que no existen en este repositorio.");
  // Prisma aplica en orden: lo aplicado debe ser un prefijo de lo local.
  if (desconocidas.length === 0 && nombres.some((n, i) => migracionesLocales[i] !== n)) problemas.push("Las migraciones aplicadas no siguen el orden del repositorio.");
  // Prisma crea _prisma_migrations antes de la primera migración: vacía es
  // una interrupción reanudable; otras tablas sin historial, no.
  if (obs.migraciones.length === 0 && obs.tablasPublicas.some((t) => t !== "_prisma_migrations")) problemas.push("Hay tablas sin historial de migraciones.");
  if (m?.estado === "LISTA" && obs.migraciones.length === 0) problemas.push("Marcador LISTA sin migraciones aplicadas.");

  if (problemas.length > 0) return cancelar(problemas.join(" "));
  return {
    tipo: m.estado === "LISTA" ? "LISTA" : "EN_PREPARACION",
    aplicadas: nombres.length,
    pendientes: migracionesLocales.slice(nombres.length),
    instalacion: m.instalacion,
  };
}

export function migracionesDelRepositorio(raiz: string): string[] {
  const carpeta = join(raiz, "prisma", "migrations");
  return readdirSync(carpeta, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(d.name) && existsSync(join(carpeta, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// 3. Semilla ficticia
// ---------------------------------------------------------------------------

export const EMPRESA_DEMO = { id: "empresa-demo-preview", nombre: "Constructora Demo (ficticia)" };
export const PLAN_COMPLETO = "Completo";
export const MODULOS = [
  { clave: "reporte_general", nombre: "Reporte General" },
  { clave: "control_de_obra", nombre: "Control de Obra" },
  { clave: "control_prestamos", nombre: "Control de Préstamos" },
  { clave: "catalogos", nombre: "Catálogos" },
  { clave: "gastos", nombre: "Gastos" },
  { clave: "contabilidad", nombre: "Contabilidad" },
  { clave: "compras", nombre: "Compras" },
];
export const USUARIOS_DEMO = [
  { id: "usuario-master-preview", nombre: "Master Preview", email: "master@arqento-preview.invalid", rol: "MASTER", empresaId: null },
  { id: "usuario-admin-demo", nombre: "Administrador Demo", email: "admin@arqento-preview.invalid", rol: "ADMINISTRADOR", empresaId: EMPRESA_DEMO.id },
  { id: "usuario-supervisor-demo", nombre: "Supervisor Demo", email: "supervisor@arqento-preview.invalid", rol: "SUPERVISOR", empresaId: EMPRESA_DEMO.id },
] as const;

export type Credencial = { rol: string; email: string; password: string };

export const passwordAleatoria = () => randomBytes(12).toString("base64url");

// Idempotente y SIN reparar: lo que ya existe debe coincidir exactamente con
// lo esperado; si no, se cancela. Corre dentro de la transacción del llamador.
export async function sembrarDemo(consultar: Consultar, hashear: (p: string) => Promise<string>): Promise<Credencial[]> {
  const planExistente = await consultar(`SELECT id FROM planes WHERE nombre = $1`, [PLAN_COMPLETO]);
  const planId = planExistente[0] ? String(planExistente[0].id) : "plan-completo-preview";
  if (!planExistente[0]) await consultar(`INSERT INTO planes (id, nombre) VALUES ($1, $2)`, [planId, PLAN_COMPLETO]);
  for (const m of MODULOS) {
    await consultar(`INSERT INTO modulos (id, clave, nombre) VALUES ($1, $2, $3) ON CONFLICT (clave) DO NOTHING`, [`modulo-${m.clave}`, m.clave, m.nombre]);
    const [{ id }] = await consultar(`SELECT id FROM modulos WHERE clave = $1`, [m.clave]);
    await consultar(`INSERT INTO plan_modulos ("planId", "moduloId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [planId, id]);
  }

  const empresas = await consultar(`SELECT id, nombre FROM empresas`);
  const ajenas = empresas.filter((e) => e.id !== EMPRESA_DEMO.id);
  if (ajenas.length > 0) cancelar("La base tiene Empresas que no son la Empresa Demo.");
  if (empresas.length === 0) {
    await consultar(
      `INSERT INTO empresas (id, nombre, "planId", "whatsappHabilitado", "inteligenciaHabilitada", "privadoHabilitado", "updatedAt")
       VALUES ($1, $2, $3, false, false, false, now())`,
      [EMPRESA_DEMO.id, EMPRESA_DEMO.nombre, planId]
    );
  } else if (empresas[0].nombre !== EMPRESA_DEMO.nombre) {
    cancelar("La Empresa Demo existente no coincide con la esperada.");
  }

  const credenciales: Credencial[] = [];
  for (const u of USUARIOS_DEMO) {
    const existentes = await consultar(`SELECT id, rol::text AS rol, "empresaId" FROM usuarios WHERE email = $1 OR id = $2`, [u.email, u.id]);
    if (existentes.length > 1) cancelar(`Usuarios inconsistentes para ${u.email}.`);
    const e = existentes[0];
    if (e) {
      if (e.id !== u.id || e.rol !== u.rol || (e.empresaId ?? null) !== u.empresaId) cancelar(`El usuario existente ${u.email} no coincide con la semilla.`);
      continue;
    }
    const password = passwordAleatoria();
    await consultar(
      `INSERT INTO usuarios (id, nombre, email, "passwordHash", rol, "empresaId", "debeCambiarPassword", "whatsappAutorizado", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"RolUsuario", $6, true, false, now())`,
      [u.id, u.nombre, u.email, await hashear(password), u.rol, u.empresaId]
    );
    credenciales.push({ rol: u.rol, email: u.email, password });
  }
  return credenciales;
}

export async function verificarSemilla(consultar: Consultar): Promise<void> {
  const [r] = await consultar(
    `SELECT (SELECT count(*) FROM empresas WHERE id = $1)::int AS empresas,
            (SELECT count(*) FROM usuarios WHERE id = ANY($2::text[]))::int AS usuarios,
            (SELECT count(*) FROM plan_modulos pm JOIN planes p ON p.id = pm."planId" WHERE p.nombre = $3)::int AS modulos`,
    [EMPRESA_DEMO.id, USUARIOS_DEMO.map((u) => u.id), PLAN_COMPLETO]
  );
  if (Number(r.empresas) !== 1 || Number(r.usuarios) !== USUARIOS_DEMO.length || Number(r.modulos) < MODULOS.length) {
    cancelar("La semilla no quedó completa.");
  }
}

// ---------------------------------------------------------------------------
// 4. Orquestación
// ---------------------------------------------------------------------------

export type Dependencias = {
  consultar: Consultar;
  migrar: () => Promise<void>; // prisma migrate deploy contra la MISMA base
  hashear: (password: string) => Promise<string>;
  imprimir: (linea: string) => void;
  migracionesLocales: string[];
  esperado: { endpoint: string; base: string };
};

export type Resultado = { modo: "VERIFICACION" | "PREPARACION"; estadoInicial: Clasificacion["tipo"]; estadoFinal: Clasificacion["tipo"]; pendientes: number };

const CLAVE_BLOQUEO = "arqento-preview:preparacion";

async function enTransaccion<T>(consultar: Consultar, fn: () => Promise<T>, soloLectura = false): Promise<T> {
  await consultar(soloLectura ? "BEGIN READ ONLY" : "BEGIN");
  try {
    const r = await fn();
    await consultar("COMMIT");
    return r;
  } catch (error) {
    await consultar("ROLLBACK").catch(() => {});
    throw error;
  }
}

const leerYClasificar = (d: Dependencias) =>
  enTransaccion(d.consultar, async () => clasificarEstado(await leerEstado(d.consultar), d.esperado, d.migracionesLocales), true);

// Verificación (dry-run): SOLO lectura, dentro de una transacción READ ONLY.
export async function verificarBasePreview(d: Dependencias): Promise<Resultado> {
  const c = await leerYClasificar(d);
  const pendientes = c.tipo === "NUEVA" ? d.migracionesLocales.length : c.pendientes.length;
  d.imprimir(`Estado: ${c.tipo}. Migraciones en el repositorio: ${d.migracionesLocales.length}; pendientes en esta base: ${pendientes}.`);
  d.imprimir("Verificación terminada. No se escribió nada.");
  return { modo: "VERIFICACION", estadoInicial: c.tipo, estadoFinal: c.tipo, pendientes };
}

export async function prepararBasePreview(d: Dependencias): Promise<Resultado> {
  // Una sola preparación a la vez (bloqueo de sesión, se libera al final o al
  // cerrar la conexión).
  const [{ ok }] = await d.consultar(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [CLAVE_BLOQUEO]);
  if (!ok) cancelar("Otra preparación de arqento-preview está en curso.");
  try {
    const inicial = await leerYClasificar(d);
    d.imprimir(`Estado inicial: ${inicial.tipo}.`);

    // a) Marcador ANTES de cualquier migración (estado PREPARANDO).
    if (inicial.tipo === "NUEVA") {
      await enTransaccion(d.consultar, async () => {
        // Revalida dentro de la transacción que la base sigue vacía.
        const c = clasificarEstado(await leerEstado(d.consultar), d.esperado, d.migracionesLocales);
        if (c.tipo !== "NUEVA") cancelar("La base cambió durante la verificación.");
        await d.consultar(`CREATE SCHEMA ${ESQUEMA_MARCADOR}`);
        await d.consultar(`CREATE TABLE ${ESQUEMA_MARCADOR}.marcador (
          id int PRIMARY KEY CHECK (id = 1),
          valor text NOT NULL, proyecto text NOT NULL, endpoint text NOT NULL, base text NOT NULL,
          estado text NOT NULL CHECK (estado IN ('PREPARANDO', 'LISTA')),
          instalacion text NOT NULL,
          creado_en timestamptz NOT NULL DEFAULT now(), actualizado_en timestamptz NOT NULL DEFAULT now(), completado_en timestamptz)`);
        await d.consultar(
          `INSERT INTO ${ESQUEMA_MARCADOR}.marcador (id, valor, proyecto, endpoint, base, estado, instalacion) VALUES (1, $1, $2, $3, $4, 'PREPARANDO', $5)`,
          [VALOR_MARCADOR, PROYECTO_PREVIEW, d.esperado.endpoint, d.esperado.base, randomUUID()]
        );
      });
      d.imprimir("Marcador creado (PREPARANDO).");
    } else {
      await d.consultar(`UPDATE ${ESQUEMA_MARCADOR}.marcador SET estado = 'PREPARANDO', actualizado_en = now() WHERE id = 1`);
    }
    const marcada = await leerYClasificar(d);
    if (marcada.tipo !== "EN_PREPARACION") cancelar("El marcador no quedó en PREPARANDO.");

    // b) Migraciones (prisma migrate deploy). Si se interrumpe, el marcador
    //    queda en PREPARANDO y la siguiente ejecución lo detecta.
    if (marcada.pendientes.length > 0) {
      d.imprimir(`Aplicando ${marcada.pendientes.length} migración(es)…`);
      await d.migrar();
    }
    const migrada = await leerYClasificar(d);
    if (migrada.tipo !== "EN_PREPARACION" || migrada.pendientes.length > 0) cancelar("Las migraciones no quedaron completas.");
    if (migrada.instalacion !== marcada.instalacion) cancelar("El marcador cambió durante las migraciones.");

    // c) Semilla en una transacción. Las contraseñas se muestran ANTES del
    //    COMMIT: si el COMMIT falla, se anuncian anuladas; nunca puede quedar
    //    un usuario creado cuya contraseña no se mostró.
    //    En una base que ya estaba LISTA la semilla no se repite (solo se
    //    verifica): los datos de prueba creados después desde la aplicación
    //    no deben bloquear una migración futura.
    let credenciales: Credencial[] = [];
    if (inicial.tipo !== "LISTA") try {
      await enTransaccion(d.consultar, async () => {
        credenciales = await sembrarDemo(d.consultar, d.hashear);
        if (credenciales.length > 0) {
          d.imprimir("Usuarios ficticios creados. Contraseñas temporales (VÁLIDAS SOLO si abajo aparece «Semilla confirmada»):");
          for (const c of credenciales) d.imprimir(`  ${c.rol.padEnd(14)} ${c.email.padEnd(38)} ${c.password}`);
        } else {
          d.imprimir("La semilla ya existía; no se creó ni se modificó ningún usuario.");
        }
      });
    } catch (error) {
      if (credenciales.length > 0) d.imprimir("Las contraseñas mostradas arriba quedaron ANULADAS (la semilla no se guardó).");
      throw error;
    }
    if (credenciales.length > 0) d.imprimir("Semilla confirmada.");
    await verificarSemilla(d.consultar);

    // d) Solo ahora: LISTA.
    await d.consultar(`UPDATE ${ESQUEMA_MARCADOR}.marcador SET estado = 'LISTA', actualizado_en = now(), completado_en = now() WHERE id = 1 AND estado = 'PREPARANDO'`);
    const final = await leerYClasificar(d);
    if (final.tipo !== "LISTA" || final.pendientes.length > 0) cancelar("La base no quedó LISTA.");
    d.imprimir(`Preparación completa: ${final.aplicadas} migraciones aplicadas, marcador LISTA.`);
    return { modo: "PREPARACION", estadoInicial: inicial.tipo, estadoFinal: final.tipo, pendientes: 0 };
  } finally {
    await d.consultar(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [CLAVE_BLOQUEO]).catch(() => {});
  }
}

// Entorno mínimo para el CLI de Prisma: solo lo necesario para que Node
// funcione + la conexión de Preview. Nada de DATABASE_URL/DIRECT_URL
// heredadas; DOTENV_CONFIG_PATH a un archivo inexistente impide que
// prisma.config.ts (`import "dotenv/config"`) cargue el .env de desarrollo.
const VARIABLES_DE_SISTEMA = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"];

export function entornoParaPrisma(env: Entorno, url: string, raiz: string): Entorno {
  const limpio: Entorno = {};
  for (const clave of VARIABLES_DE_SISTEMA) if (env[clave]) limpio[clave] = env[clave];
  limpio.DATABASE_URL = url;
  limpio.DIRECT_URL = url;
  limpio.DOTENV_CONFIG_PATH = join(raiz, ".env.preview-inexistente");
  limpio.PRISMA_HIDE_UPDATE_MESSAGE = "1";
  return limpio;
}

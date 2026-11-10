import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

// ---------------------------------------------------------------------------
// Protección SIN CONEXIÓN de la base de pruebas de integración (versión 2,
// octubre 2026). Se ejecuta antes de abrir cualquier conexión; si una regla
// falla, el proceso se detiene. Reglas (todas obligatorias):
//
// 1. TEST_DATABASE_URL debe existir — nunca hay respaldo a DATABASE_URL.
// 2. URL postgres:// o postgresql:// válida, sin parámetros que redirijan la
//    conexión (host, hostaddr, port, dbname, user, options…).
// 3. El nombre de la base termina en "_test".
// 4. El host es local (localhost, 127.0.0.1 o ::1). Cualquier otro —
//    incluido Neon — se rechaza.
// 5. No coincide con ninguna conexión conocida: ni con las variables del
//    entorno ni con las de CUALQUIER archivo ".env*" de la raíz (desarrollo,
//    producción, credenciales temporales). Si una conexión conocida usa el
//    mismo servidor local, también se rechaza: la base de pruebas debe vivir
//    en un servidor dedicado.
// 6. Nunca con NODE_ENV=production ni dentro de Vercel.
//
// Nunca imprime URLs, usuarios ni contraseñas: los errores solo dicen qué
// regla falló, y describirDestino() solo muestra host:puerto/base.
// La identidad real de la base (current_database, marcador) se verifica
// después, ya conectado — ver identidad-base-pruebas.ts.
// ---------------------------------------------------------------------------

export class BaseDePruebasNoPermitida extends Error {}

// Variables de entorno (process.env o un objeto de prueba).
export type Entorno = Record<string, string | undefined>;

const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Únicos parámetros aceptados en la URL: ninguno puede cambiar a dónde se
// conecta el cliente.
const PARAMETROS_PERMITIDOS = new Set(["sslmode", "connect_timeout", "application_name", "schema"]);
const MARCA_SANEADO = "ARQENTO_PRUEBAS_ENTORNO_SANEADO";
const PATRON_URL_POSTGRES = /postgres(?:ql)?:\/\/[^\s"'<>`]+/gi;

type Destino = { host: string; puerto: string; base: string };

function destinoDe(url: string): Destino | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    return {
      // El pooler de Neon es el mismo servidor que su conexión directa.
      host: u.hostname.toLowerCase().replace("-pooler", ""),
      puerto: u.port || "5432",
      base: decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase(),
    };
  } catch {
    return null;
  }
}

const esLocal = (host: string) => HOSTS_LOCALES.has(host);

// Descripción segura para mensajes: sin usuario ni contraseña.
export function describirDestino(url: string): string {
  const d = destinoDe(url);
  return d ? `${d.host}:${d.puerto}/${d.base}` : "(URL no válida)";
}

// Todas las conexiones PostgreSQL conocidas fuera de la de pruebas: valores
// del entorno y de todos los archivos ".env*" de la raíz, se llamen como se
// llamen las variables (DATABASE_URL, DIRECT_URL, *_PRODUCTION…). Los
// archivos que no tienen formato dotenv también se revisan como texto.
// Solo se usan para comparar en memoria; nunca se imprimen.
export function urlsDeOtrosEntornos(raiz: string, env: Entorno): string[] {
  const urls: string[] = [];
  // Un proceso hijo de `node --test` hereda el entorno ya saneado por su
  // padre (DATABASE_URL/DIRECT_URL = la base de pruebas): esas dos no son
  // "otra conexión". Los archivos .env* se revisan siempre.
  const heredadas = env[MARCA_SANEADO] === "1" ? new Set(["DATABASE_URL", "DIRECT_URL"]) : new Set<string>();
  for (const [clave, valor] of Object.entries(env)) {
    if (clave === "TEST_DATABASE_URL" || !valor) continue;
    if (heredadas.has(clave) && valor === env.TEST_DATABASE_URL) continue;
    for (const encontrada of valor.match(PATRON_URL_POSTGRES) ?? []) urls.push(encontrada);
  }
  const archivos = existsSync(raiz) ? readdirSync(raiz).filter((nombre) => nombre.startsWith(".env")) : [];
  for (const archivo of archivos) {
    let texto: string;
    try {
      texto = readFileSync(join(raiz, archivo), "utf8");
    } catch {
      continue;
    }
    for (const [clave, valor] of Object.entries(parse(texto))) {
      if (clave === "TEST_DATABASE_URL") continue;
      for (const encontrada of valor.match(PATRON_URL_POSTGRES) ?? []) urls.push(encontrada);
    }
    for (const linea of texto.split(/\r?\n/)) {
      if (/^\s*(export\s+)?TEST_DATABASE_URL\s*=/.test(linea)) continue;
      for (const encontrada of linea.match(PATRON_URL_POSTGRES) ?? []) urls.push(encontrada);
    }
  }
  return urls;
}

export function validarEntornoDeEjecucion(env: Entorno): void {
  if (env.NODE_ENV === "production") {
    throw new BaseDePruebasNoPermitida("NODE_ENV=production: las pruebas de integración no se ejecutan en producción.");
  }
  if (env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL) {
    throw new BaseDePruebasNoPermitida("Entorno Vercel detectado: las pruebas de integración solo se ejecutan localmente.");
  }
}

export function validarBaseDePruebas(testUrl: string | undefined, otrasUrls: string[]): string {
  if (!testUrl) throw new BaseDePruebasNoPermitida("Falta TEST_DATABASE_URL.");

  let u: URL;
  try {
    u = new URL(testUrl);
  } catch {
    throw new BaseDePruebasNoPermitida("TEST_DATABASE_URL no es una URL válida.");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new BaseDePruebasNoPermitida("TEST_DATABASE_URL debe ser una URL postgresql://.");
  }
  for (const parametro of u.searchParams.keys()) {
    if (!PARAMETROS_PERMITIDOS.has(parametro.toLowerCase())) {
      throw new BaseDePruebasNoPermitida(`TEST_DATABASE_URL tiene un parámetro no permitido ("${parametro}").`);
    }
  }

  const destino = destinoDe(testUrl)!;
  if (!/^[a-z0-9_]+_test$/.test(destino.base)) {
    throw new BaseDePruebasNoPermitida('El nombre de la base de pruebas debe terminar en "_test" (solo minúsculas, números y "_").');
  }
  if (destino.host.endsWith("neon.tech")) {
    throw new BaseDePruebasNoPermitida("TEST_DATABASE_URL apunta a Neon: la base de pruebas debe ser PostgreSQL local.");
  }
  if (!esLocal(destino.host)) {
    throw new BaseDePruebasNoPermitida("TEST_DATABASE_URL debe apuntar a localhost o 127.0.0.1 (PostgreSQL local dedicado).");
  }

  for (const otra of otrasUrls) {
    const conocida = destinoDe(otra);
    if (!conocida) continue;
    if (conocida.host === destino.host && conocida.puerto === destino.puerto && conocida.base === destino.base) {
      throw new BaseDePruebasNoPermitida("TEST_DATABASE_URL apunta a la misma base que una conexión ya configurada.");
    }
    if (esLocal(conocida.host) && conocida.puerto === destino.puerto) {
      throw new BaseDePruebasNoPermitida(
        "TEST_DATABASE_URL usa el mismo servidor local que otra conexión configurada: la base de pruebas debe tener un servidor dedicado."
      );
    }
  }
  return testUrl;
}

// Variables que nunca deben llegar al proceso de pruebas: proveedores de IA,
// almacenamiento (R2/S3) y cualquier conexión o secreto de producción. Se
// devuelven solo los NOMBRES eliminados.
const VARIABLES_PROHIBIDAS = [/^OPENAI_/i, /^ANTHROPIC_/i, /^R2_/i, /^AWS_/i, /^WHATSAPP_/i, /_PRODUCTION$/i, /^CRON_SECRET$/i];

export function sanitizarEntornoDePruebas(env: Entorno, testUrl: string): string[] {
  const eliminadas: string[] = [];
  for (const clave of Object.keys(env)) {
    if (VARIABLES_PROHIBIDAS.some((patron) => patron.test(clave))) {
      delete env[clave];
      eliminadas.push(clave);
    }
  }
  // Toda conexión del proceso — cliente de la app y CLI de Prisma — apunta a
  // la base de pruebas validada. dotenv nunca sobrescribe una variable ya
  // definida, y DOTENV_CONFIG_PATH a un archivo inexistente evita además que
  // `import "dotenv/config"` (prisma.config.ts) cargue el .env de Neon.
  env.DATABASE_URL = testUrl;
  env.DIRECT_URL = testUrl;
  env.DOTENV_CONFIG_PATH = join(process.cwd(), ".env.pruebas-integracion-inexistente");
  env.ARQENTO_VISION_HABILITADA = "false";
  env[MARCA_SANEADO] = "1";
  return eliminadas;
}

// Punto único para scripts y setup: valida todo lo que no requiere conexión
// y deja el entorno del proceso listo. Lanza BaseDePruebasNoPermitida.
export function prepararEntornoDePruebas(env: Entorno = process.env, raiz = process.cwd()) {
  validarEntornoDeEjecucion(env);
  const url = validarBaseDePruebas(env.TEST_DATABASE_URL, urlsDeOtrosEntornos(raiz, env));
  const eliminadas = sanitizarEntornoDePruebas(env, url);
  return { url, destino: describirDestino(url), eliminadas };
}

// Mensaje de error apto para la consola: nunca incluye la URL, el usuario ni
// la contraseña de la conexión (los errores del driver podrían citarlos).
export function mensajeSeguro(error: unknown, url: string | undefined): string {
  let mensaje = error instanceof Error ? error.message : String(error);
  mensaje = mensaje.replace(PATRON_URL_POSTGRES, "[conexión oculta]");
  if (url) {
    try {
      const u = new URL(url);
      for (const secreto of [u.password, decodeURIComponent(u.password), u.username]) {
        if (secreto && secreto.length >= 3) mensaje = mensaje.split(secreto).join("[oculto]");
      }
    } catch {
      // URL inválida: ya no hay nada que ocultar aparte del patrón general.
    }
  }
  return mensaje;
}

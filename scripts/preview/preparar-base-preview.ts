// Preparación protegida de la base de ARQENTO Preview (proyecto Neon
// arqento-preview). Ver scripts/preview/base-preview.ts para las reglas.
//
//   Verificación (dry-run, por omisión, sin escrituras):
//     npm run preview:verificar
//   Preparación (migraciones + semilla ficticia), con confirmación escrita:
//     npm run preview:preparar -- --confirmar=<PREVIEW_NEON_ENDPOINT>
//
// Variables (solo en la terminal de quien lo ejecuta, nunca en archivos):
//   PREVIEW_DIRECT_URL      conexión DIRECTA (sin -pooler) de arqento-preview
//   PREVIEW_NEON_ENDPOINT   ep-… del proyecto arqento-preview (consola Neon)
//   PREVIEW_DATABASE_NAME   nombre de la base (p. ej. neondb)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { hashPassword } from "../../lib/crypto/password";
import { mensajeSeguro } from "../../tests/helpers/base-de-pruebas";
import {
  entornoParaPrisma,
  migracionesDelRepositorio,
  prepararBasePreview,
  validarConfiguracionPreview,
  verificarBasePreview,
  type Dependencias,
} from "./base-preview";

const SCRIPT = "preparar-base-preview";
const imprimir = (linea: string) => console.log(`[${SCRIPT}] ${linea}`);

async function main() {
  const raiz = process.cwd();
  const preparar = process.argv.includes("--preparar");
  const confirmacion = process.argv.find((a) => a.startsWith("--confirmar="))?.slice("--confirmar=".length);

  // 1) Sin conexión.
  const config = validarConfiguracionPreview(process.env, raiz);
  imprimir(`Destino validado sin conexión: ${config.destino} (conexión directa, TLS).`);
  if (preparar && confirmacion !== config.endpoint) {
    throw new Error("Para preparar, confirma el endpoint con --confirmar=<PREVIEW_NEON_ENDPOINT>.");
  }
  const cli = join(raiz, "node_modules", "prisma", "build", "index.js");
  if (preparar && !existsSync(cli)) throw new Error("No se encontró el CLI de Prisma en node_modules.");

  // 2) Conectado.
  const cliente = new pg.Client({ connectionString: config.url, connectionTimeoutMillis: 15000, application_name: SCRIPT });
  await cliente.connect();
  try {
    const d: Dependencias = {
      consultar: async (sql, parametros) => (await cliente.query(sql, parametros as unknown[] | undefined)).rows,
      migrar: async () => {
        const r = spawnSync(process.execPath, [cli, "migrate", "deploy"], { cwd: raiz, env: entornoParaPrisma(process.env, config.url, raiz) as NodeJS.ProcessEnv, stdio: "inherit" });
        if (r.status !== 0) throw new Error(`prisma migrate deploy terminó con código ${r.status}. El marcador queda en PREPARANDO.`);
      },
      hashear: hashPassword,
      imprimir,
      migracionesLocales: migracionesDelRepositorio(raiz),
      esperado: { endpoint: config.endpoint, base: config.base },
    };
    if (preparar) await prepararBasePreview(d);
    else await verificarBasePreview(d);
  } finally {
    await cliente.end();
  }
}

main().catch((error) => {
  console.error(`[${SCRIPT}] CANCELADO: ${mensajeSeguro(error, process.env.PREVIEW_DIRECT_URL)}`);
  process.exit(1);
});

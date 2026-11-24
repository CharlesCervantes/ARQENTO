// Restablece la contraseña temporal del Master FICTICIO de ARQENTO Preview
// (proyecto Neon arqento-preview). Mismas protecciones que
// preparar-base-preview.ts (ver scripts/preview/base-preview.ts): la
// conexión solo se toma de PREVIEW_DIRECT_URL y la base debe estar LISTA.
// No ejecuta migraciones ni semilla y no toca a ningún otro usuario.
//
//   Verificación (por omisión, sin escrituras):
//     npm run preview:password
//   Restablecer, con confirmación escrita del endpoint:
//     npm run preview:password -- --restablecer --confirmar=<PREVIEW_NEON_ENDPOINT>
//
// La contraseña nueva se muestra UNA vez en la terminal; nunca se guarda en
// archivos ni registros (en la base solo queda su hash).
import pg from "pg";
import { hashPassword } from "../../lib/crypto/password";
import { mensajeSeguro } from "../../tests/helpers/base-de-pruebas";
import { migracionesDelRepositorio, restablecerPasswordMaster, validarConfiguracionPreview, verificarRestablecerPassword } from "./base-preview";

const SCRIPT = "restablecer-password-preview";
const imprimir = (linea: string) => console.log(`[${SCRIPT}] ${linea}`);

async function main() {
  const raiz = process.cwd();
  const restablecer = process.argv.includes("--restablecer");
  const confirmacion = process.argv.find((a) => a.startsWith("--confirmar="))?.slice("--confirmar=".length);

  // 1) Sin conexión.
  const config = validarConfiguracionPreview(process.env, raiz);
  imprimir(`Destino validado sin conexión: ${config.destino} (conexión directa, TLS).`);
  if (restablecer && confirmacion !== config.endpoint) {
    throw new Error("Para restablecer, confirma el endpoint con --confirmar=<PREVIEW_NEON_ENDPOINT>.");
  }

  // 2) Conectado.
  const cliente = new pg.Client({ connectionString: config.url, connectionTimeoutMillis: 15000, application_name: SCRIPT });
  await cliente.connect();
  try {
    const d = {
      consultar: async (sql: string, parametros?: unknown[]) => (await cliente.query(sql, parametros)).rows,
      hashear: hashPassword,
      imprimir,
      migracionesLocales: migracionesDelRepositorio(raiz),
      esperado: { endpoint: config.endpoint, base: config.base },
    };
    if (restablecer) await restablecerPasswordMaster(d);
    else await verificarRestablecerPassword(d);
  } finally {
    await cliente.end();
  }
}

main().catch((error) => {
  console.error(`[${SCRIPT}] CANCELADO: ${mensajeSeguro(error, process.env.PREVIEW_DIRECT_URL)}`);
  process.exit(1);
});

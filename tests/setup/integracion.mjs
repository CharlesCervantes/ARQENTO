// Preparación de las pruebas de INTEGRACIÓN (npm run test:integracion) — se
// carga con --import antes de cualquier módulo del proyecto, en el proceso
// principal y en cada proceso hijo de `node --test`.
//
// 1) Sin conexión: valida TEST_DATABASE_URL y el entorno (ver
//    tests/helpers/base-de-pruebas.ts), retira del proceso las credenciales
//    de OpenAI/R2/producción y apunta DATABASE_URL/DIRECT_URL a la base de
//    pruebas.
// 2) Conectado, solo lectura: verifica la identidad de la base (nombre,
//    servidor local, marcador exclusivo de ARQENTO) ANTES de que cualquier
//    prueba escriba (ver tests/helpers/identidad-base-pruebas.ts).
// 3) Sustituye OpenAI, S3/R2 y lucide-react por módulos simulados.
// Si algo falla, el proceso termina con código 1 sin escribir nada.
import { registerHooks } from "node:module";

const stubLucide = new URL("./lucide-stub.cjs", import.meta.url).href;
const stubServicios = new URL("./servicios-externos-stub.cjs", import.meta.url).href;
const SIMULADOS = new Set(["openai", "openai/helpers/zod", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lucide-react") return { url: stubLucide, shortCircuit: true };
    if (SIMULADOS.has(specifier)) return { url: stubServicios, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { prepararEntornoDePruebas, mensajeSeguro } = await import("../helpers/base-de-pruebas.ts");
const { verificarIdentidadOAbortar, baseDeUrl } = await import("../helpers/identidad-base-pruebas.ts");
const { default: pg } = await import("pg");

let url;
try {
  ({ url } = prepararEntornoDePruebas(process.env, process.cwd()));
  // Almacenamiento R2 SIMULADO: cualquier credencial real de R2 ya se retiró
  // del proceso (prepararEntornoDePruebas); estos valores son ficticios y
  // solo satisfacen la configuración de lib/server/archivos.ts — el cliente
  // S3 está sustituido por un bucket en memoria (servicios-externos-stub.cjs)
  // y nunca abre una conexión.
  process.env.R2_BUCKET_NAME = "arqento-pruebas-simulado";
  process.env.R2_ENDPOINT = "http://r2-simulado.invalid";
  process.env.R2_ACCESS_KEY_ID = "simulado";
  process.env.R2_SECRET_ACCESS_KEY = "simulado";
  // WhatsApp SIMULADO: secretos ficticios para firmar webhooks de prueba y
  // calcular HMAC; SIN token de acceso, así que ningún mensaje sale a Meta
  // (lib/server/whatsapp/cliente.ts los registra en memoria).
  process.env.WHATSAPP_APP_SECRET = "secreto-webhook-de-prueba";
  process.env.WHATSAPP_VERIFY_TOKEN = "token-verificacion-de-prueba";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-number-id-simulado";
  process.env.WHATSAPP_CODIGO_PEPPER = "pimienta-de-prueba-0123456789";
  process.env.WHATSAPP_NUMERO_OFICIAL = "+15550001111";
  const cliente = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await cliente.connect();
  try {
    await verificarIdentidadOAbortar(async (sql, parametros) => (await cliente.query(sql, parametros)).rows, baseDeUrl(url));
  } finally {
    await cliente.end();
  }
} catch (error) {
  console.error(`Pruebas de integración canceladas: ${mensajeSeguro(error, url ?? process.env.TEST_DATABASE_URL)}`);
  process.exit(1);
}

// Candado de despliegue: un build de PRODUCCIÓN nunca sale si la base de
// producción tiene migraciones pendientes o fallidas (incidente nov-2026:
// el código usaba empresas.inteligenciaHabilitada y PRD tenía 6 migraciones
// sin aplicar). Este script NO aplica migraciones ni escribe nada: solo
// consulta `prisma migrate status`. Las migraciones de PRD se aplican antes,
// a mano, con `prisma migrate deploy` (ver docs/arquitectura/01-despliegue.md).
//
// Solo actúa cuando VERCEL_ENV=production; en local y en Preview no hace nada.
// Nunca imprime cadenas de conexión: solo el endpoint de Neon (ep-…).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const P = "[verificar-migraciones]";

if (process.env.VERCEL_ENV !== "production") {
  console.log(`${P} VERCEL_ENV=${process.env.VERCEL_ENV ?? "(sin definir)"}: se omite (solo aplica a producción).`);
  process.exit(0);
}

function fallar(mensaje) {
  console.error(`${P} BUILD DETENIDO: ${mensaje}`);
  process.exit(1);
}

function destino(nombre) {
  const valor = process.env[nombre]?.trim();
  if (!valor) fallar(`${nombre} no está definida en las variables de Production de Vercel.`);
  let url;
  try {
    url = new URL(valor);
  } catch {
    fallar(`${nombre} no es una URL válida.`);
  }
  const endpoint = url.hostname.split(".")[0].replace(/-pooler$/, "");
  return { endpoint, base: url.pathname.replace(/^\//, ""), pooler: url.hostname.split(".")[0].endsWith("-pooler") };
}

const app = destino("DATABASE_URL");
const cli = destino("DIRECT_URL");
if (cli.pooler) fallar("DIRECT_URL debe ser la conexión directa (sin -pooler).");
if (app.endpoint !== cli.endpoint || app.base !== cli.base) {
  fallar(
    `DATABASE_URL (${app.endpoint}/${app.base}) y DIRECT_URL (${cli.endpoint}/${cli.base}) apuntan a bases distintas: ` +
      "las migraciones se verificarían en una base y la app usaría otra."
  );
}
console.log(`${P} Base de producción: ${cli.endpoint}/${cli.base}. Consultando estado de migraciones…`);

const prisma = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
const r = spawnSync(process.execPath, [prisma, "migrate", "status"], { encoding: "utf8", env: process.env });
const ocultar = (s) => (s ?? "").replace(/postgres(ql)?:\/\/\S+/gi, "<conexión oculta>");
process.stdout.write(ocultar(r.stdout));
process.stderr.write(ocultar(r.stderr));

if (r.status !== 0) {
  fallar(
    "la base de producción tiene migraciones pendientes/fallidas o no se pudo consultar. " +
      "Aplica primero `prisma migrate deploy` contra PRD y vuelve a desplegar."
  );
}
console.log(`${P} OK: la base de producción está al día con prisma/migrations.`);

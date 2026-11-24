// Script de siembra inicial — SOLO configuración estructural para levantar
// una Empresa nueva de forma segura: catálogo de Módulos, Plan "Completo"
// (con todos los módulos existentes hasta ahora) y los usuarios base
// (Master/Director/Administrador/Supervisor). Idempotente — correrlo varias
// veces nunca duplica nada (upsert/"si ya existe, sáltalo").
//
// Deliberadamente NO crea proyectos/obras — el catálogo operativo real
// (proyectos, contratistas, proveedores, contratos, avances, gastos, etc.)
// se captura manualmente desde la aplicación una vez que el sistema está en
// producción, nunca desde este script (Preparación de Producción — Etapa 1,
// septiembre 2026). Antes de este cambio, un OBRAS[] hardcodeado recreaba en
// silencio 6 proyectos reales de Conkuali si el seed volvía a correrse
// después de borrarlos — justo lo que este cambio evita.
//
// Cada persona se crea solo si su variable de entorno SEED_EMAIL_* está
// definida (correo real, nunca inventado aquí) — se puede correr de forma
// incremental conforme se van teniendo los correos de cada quien.
// Ejecutar con: npm run db:seed

import "dotenv/config";
import { randomBytes } from "crypto";
import { PrismaClient } from "../lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/crypto/password";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter });

// Catálogo completo de módulos existentes hasta ahora — mantener esta lista
// al día conforme se agreguen módulos nuevos (mismo criterio que las
// migraciones que dan de alta un Modulo, ver 20260910120000_gastos_transversal,
// 20260915090000_contabilidad, 20260920100000_modulo_compras).
const MODULOS = [
  { clave: "inicio", nombre: "Inicio" },
  { clave: "reporte_general", nombre: "Reporte General" },
  { clave: "control_de_obra", nombre: "Control de Obra" },
  { clave: "control_prestamos", nombre: "Control de Préstamos" },
  { clave: "catalogos", nombre: "Catálogos" },
  { clave: "gastos", nombre: "Gastos" },
  { clave: "contabilidad", nombre: "Contabilidad" },
  { clave: "compras", nombre: "Compras" },
];

// Módulos que existen en el catálogo pero NUNCA se agregan al Plan
// "Completo" desde el seed: se habilitan explícitamente por Empresa desde
// Portal Master (ver 20261116120000_comercializacion_b1_catalogo). Así una
// base nueva no concede Comercialización a Conkuali por accidente.
const MODULOS_FUERA_DE_PLAN = [{ clave: "comercializacion", nombre: "Comercialización" }];

function leerEmail(varEnv: string): string | undefined {
  const valor = process.env[varEnv];
  return valor ? valor.trim().toLowerCase() : undefined;
}

function generarPasswordTemporal(): string {
  return randomBytes(9).toString("base64url");
}

async function main() {
  const personas = [
    // Rol de plataforma — sin Empresa (empresaId null), fuera del ciclo
    // normal de tenants. Igual que los demás, solo se crea si tiene correo
    // real definido; es el único punto de entrada al Portal Master (/master)
    // mientras no exista otra forma de dar de alta al primer Master.
    {
      nombre: "Master",
      email: leerEmail("SEED_EMAIL_MASTER"),
      rol: "MASTER" as const,
    },
    {
      nombre: "Sergio",
      email: leerEmail("SEED_EMAIL_SERGIO"),
      rol: "DIRECTOR" as const,
    },
    {
      nombre: "Charles",
      email: leerEmail("SEED_EMAIL_CHARLES"),
      rol: "ADMINISTRADOR" as const,
    },
    {
      nombre: "Andrés",
      email: leerEmail("SEED_EMAIL_ANDRES"),
      rol: "SUPERVISOR" as const,
    },
  ];

  const pendientes = personas.filter((p) => !p.email).map((p) => p.nombre);

  const plan = await db.plan.upsert({
    where: { nombre: "Completo" },
    update: {},
    create: { nombre: "Completo" },
  });

  for (const m of MODULOS_FUERA_DE_PLAN) {
    await db.modulo.upsert({ where: { clave: m.clave }, update: {}, create: m });
  }

  // Reconcilia los módulos del plan también cuando el Plan ya existía —
  // el upsert de arriba, con `update: {}`, no agregaría un módulo nuevo
  // (como "catalogos") a un Plan "Completo" que ya está en base de datos.
  for (const m of MODULOS) {
    const modulo = await db.modulo.upsert({
      where: { clave: m.clave },
      update: {},
      create: m,
    });
    await db.planModulo.upsert({
      where: { planId_moduloId: { planId: plan.id, moduloId: modulo.id } },
      update: {},
      create: { planId: plan.id, moduloId: modulo.id },
    });
  }

  const empresa = await db.empresa.upsert({
    where: { id: "conkuali" },
    update: {},
    create: {
      id: "conkuali",
      nombre: "Grupo Conkuali",
      planId: plan.id,
    },
  });

  const credencialesNuevas: { rol: string; email: string; password: string }[] =
    [];
  const yaExistian: string[] = [];

  for (const persona of personas) {
    if (!persona.email) continue;

    const existente = await db.usuario.findUnique({
      where: { email: persona.email },
    });

    if (existente) {
      yaExistian.push(persona.email);
      continue;
    }

    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await hashPassword(passwordTemporal);

    await db.usuario.create({
      data: {
        nombre: persona.nombre,
        email: persona.email,
        passwordHash,
        rol: persona.rol,
        // MASTER es un rol de plataforma, sin Empresa (ver enum RolUsuario,
        // prisma/schema.prisma) — todos los demás roles sí pertenecen a Conkuali.
        empresaId: persona.rol === "MASTER" ? null : empresa.id,
        // Mismo criterio que Portal Master al dar de alta un usuario nuevo
        // con contraseña temporal (lib/server/master/empresas.ts) — nadie se
        // queda usándola indefinidamente (Preflight Seed Production, septiembre 2026).
        debeCambiarPassword: true,
      },
    });

    credencialesNuevas.push({
      rol: persona.rol,
      email: persona.email,
      password: passwordTemporal,
    });
  }

  if (credencialesNuevas.length > 0) {
    console.log(
      "\nUsuarios creados. Contraseñas temporales (cámbialas al primer login):\n"
    );
    for (const c of credencialesNuevas) {
      console.log(`  ${c.rol.padEnd(14)} ${c.email.padEnd(30)} ${c.password}`);
    }
  }
  if (yaExistian.length > 0) {
    console.log(`\nYa existían (sin cambios): ${yaExistian.join(", ")}`);
  }
  if (pendientes.length > 0) {
    console.log(
      `\nPendientes (sin correo aún, no se crearon): ${pendientes.join(", ")}`
    );
    console.log(
      "Cuando tengas su correo, define la variable SEED_EMAIL_<NOMBRE> en .env y vuelve a correr `npm run db:seed`."
    );
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

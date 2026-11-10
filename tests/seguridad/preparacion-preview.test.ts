import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENDPOINTS_PROHIBIDOS_SHA256,
  endpointsDeOtrosEntornos,
  hashEndpoint,
  PreparacionPreviewCancelada,
  VALOR_MARCADOR,
  entornoParaPrisma,
  migracionesDelRepositorio,
  prepararBasePreview,
  validarConfiguracionPreview,
  verificarBasePreview,
  type Consultar,
  type Dependencias,
} from "@/scripts/preview/base-preview";

// Preparación protegida de ARQENTO Preview (noviembre 2026): validación sin
// conexión y flujo completo sobre una base SIMULADA en memoria que
// interpreta solo las sentencias del script. Nunca se conecta a Neon ni a
// ninguna otra base. Endpoints, usuarios y contraseñas ficticios.

const EP = "ep-preview-ficticio-a1b2c3";
const BASE = "neondb";
const URL_OK = `postgresql://usuario_ficticio:clave-ficticia-123@${EP}.c-9.us-east-2.aws.neon.tech/${BASE}?sslmode=require&channel_binding=require`;
const raizVacia = () => mkdtempSync(join(tmpdir(), "arqento-preview-"));
const entorno = (extra: Record<string, string | undefined> = {}) => ({
  PREVIEW_DIRECT_URL: URL_OK,
  PREVIEW_NEON_ENDPOINT: EP,
  PREVIEW_DATABASE_NAME: BASE,
  ...extra,
});
const cancela = (fn: () => unknown, patron: RegExp) =>
  assert.throws(fn, (e: Error) => e instanceof PreparacionPreviewCancelada && patron.test(e.message));

describe("Preview — validación sin conexión", () => {
  test("Configuración correcta: describe el destino sin usuario ni contraseña", () => {
    const c = validarConfiguracionPreview(entorno(), raizVacia());
    assert.equal(c.destino, `${EP}/${BASE}`);
    assert.ok(!c.destino.includes("usuario_ficticio") && !c.destino.includes("clave-ficticia"));
  });

  test("Nunca usa DATABASE_URL/DIRECT_URL como alternativa", () => {
    cancela(() => validarConfiguracionPreview({ DATABASE_URL: URL_OK, DIRECT_URL: URL_OK, PREVIEW_NEON_ENDPOINT: EP, PREVIEW_DATABASE_NAME: BASE }, raizVacia()), /Falta PREVIEW_DIRECT_URL/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_NEON_ENDPOINT: undefined }), raizVacia()), /Falta PREVIEW_NEON_ENDPOINT/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DATABASE_NAME: undefined }), raizVacia()), /Falta PREVIEW_DATABASE_NAME/);
  });

  test("Rechaza el pooler, hosts que no son Neon y endpoints que no coinciden", () => {
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace(EP, `${EP}-pooler`) }), raizVacia()), /pooler/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: `postgresql://u:p@127.0.0.1:5432/${BASE}?sslmode=require` }), raizVacia()), /no apunta a Neon/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace(EP, "ep-otro-endpoint-zz9") }), raizVacia()), /no corresponde/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace("neon.tech", "neon.tech.evil.example") }), raizVacia()), /no apunta a Neon/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_NEON_ENDPOINT: `${EP}-pooler` }), raizVacia()), /formato/);
  });

  test("Rechaza un endpoint cuyo SHA-256 está en la lista prohibida, aunque todo lo demás coincida (sin importar mayúsculas)", () => {
    const prohibidos = [hashEndpoint(EP)];
    cancela(() => validarConfiguracionPreview(entorno(), raizVacia(), prohibidos), /DESARROLLO o PRODUCCIÓN/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_NEON_ENDPOINT: EP.toUpperCase() }), raizVacia(), prohibidos), /DESARROLLO o PRODUCCIÓN/);
    assert.equal(hashEndpoint(` ${EP.toUpperCase()} `), hashEndpoint(EP));
  });

  test("La lista real: 2 hashes SHA-256 válidos, por omisión, y ningún endpoint en claro en el código", () => {
    assert.equal(ENDPOINTS_PROHIBIDOS_SHA256.length, 2);
    for (const h of ENDPOINTS_PROHIBIDOS_SHA256) assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!ENDPOINTS_PROHIBIDOS_SHA256.includes(hashEndpoint(EP)));
    // Sin el tercer argumento se usa la lista real: el endpoint ficticio pasa.
    assert.equal(validarConfiguracionPreview(entorno(), raizVacia()).endpoint, EP);
    const fuente = readFileSync(join(process.cwd(), "scripts", "preview", "base-preview.ts"), "utf8");
    assert.ok(!/\bep-[a-z]+-[a-z]+-[a-z0-9]{8}\b/.test(fuente), "no debe haber endpoints reales escritos");
  });

  test("Cada hash de la lista corresponde a un endpoint real de los .env* de este equipo (si existen)", (t) => {
    // Se leen solo en memoria y nunca se imprimen.
    const raiz = process.cwd();
    if (!existsSync(join(raiz, ".env")) || !existsSync(join(raiz, ".env.production.local"))) return t.skip("Sin .env y .env.production.local en este equipo.");
    const locales = new Set([...endpointsDeOtrosEntornos(raiz, {})].filter((e) => e.startsWith("ep-")).map(hashEndpoint));
    for (const h of ENDPOINTS_PROHIBIDOS_SHA256) assert.ok(locales.has(h), "un hash de la lista no corresponde a ningún endpoint local");
  });

  test("Rechaza un endpoint que aparece en un .env* local o en otra variable del entorno", () => {
    const raiz = raizVacia();
    writeFileSync(join(raiz, ".env.production.local"), `DATABASE_URL_PRODUCTION="postgresql://x:y@${EP}-pooler.c-9.us-east-2.aws.neon.tech/neondb"\n`);
    cancela(() => validarConfiguracionPreview(entorno(), raiz), /otra conexión conocida/);
    cancela(() => validarConfiguracionPreview(entorno({ DATABASE_URL: URL_OK }), raizVacia()), /otra conexión conocida/);
  });

  test("Exige TLS y no acepta parámetros que redirijan la conexión", () => {
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace("sslmode=require", "sslmode=disable") }), raizVacia()), /TLS/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace("?sslmode=require&", "?") }), raizVacia()), /TLS/);
    for (const p of ["host=127.0.0.1", "options=-c%20search_path%3Dx", "dbname=otra", "hostaddr=1.2.3.4"]) {
      cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: `${URL_OK}&${p}` }), raizVacia()), /no permitido/);
    }
  });

  test("Rechaza otra base, otro puerto, URL sin credenciales y la ejecución dentro de Vercel", () => {
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DATABASE_NAME: "otra" }), raizVacia()), /no coincide/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace(".tech/", ".tech:6543/") }), raizVacia()), /Puerto/);
    cancela(() => validarConfiguracionPreview(entorno({ PREVIEW_DIRECT_URL: URL_OK.replace("usuario_ficticio:clave-ficticia-123@", "") }), raizVacia()), /usuario y contraseña/);
    cancela(() => validarConfiguracionPreview(entorno({ VERCEL: "1" }), raizVacia()), /Vercel/);
  });

  test("El CLI de Prisma recibe solo la conexión de Preview, sin heredar otras conexiones ni secretos", () => {
    const e = entornoParaPrisma({ PATH: "/bin", DATABASE_URL: "postgresql://dev", DIRECT_URL: "postgresql://dev", OPENAI_API_KEY: "sk", DATABASE_URL_PRODUCTION: "p" }, URL_OK, "/repo");
    assert.equal(e.DATABASE_URL, URL_OK);
    assert.equal(e.DIRECT_URL, URL_OK);
    assert.match(e.DOTENV_CONFIG_PATH!, /inexistente/);
    assert.equal(e.PATH, "/bin");
    assert.equal(e.OPENAI_API_KEY, undefined);
    assert.equal(e.DATABASE_URL_PRODUCTION, undefined);
  });

  test("El script real se cancela ANTES de conectarse (sin variables, endpoint prohibido, sin confirmación)", () => {
    // Entorno sin ninguna conexión heredada; el proceso nunca llega a abrir una.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/URL|PREVIEW_|_PRODUCTION$|SECRET|TOKEN|KEY|PEPPER/i.test(k)));
    const correr = (env: Record<string, string>, args: string[] = []) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/preview/preparar-base-preview.ts", ...args], {
        cwd: process.cwd(),
        env: { ...base, ...env } as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 60000,
      });
    const casos: [Record<string, string>, string[], RegExp][] = [
      [{}, [], /Falta PREVIEW_DIRECT_URL/],
      [{ DATABASE_URL: URL_OK, DIRECT_URL: URL_OK }, [], /Falta PREVIEW_DIRECT_URL/],
      [{ ...(entorno() as Record<string, string>), DATABASE_URL: URL_OK }, [], /otra conexión conocida/],
      [entorno() as Record<string, string>, ["--preparar"], /--confirmar/],
      [entorno() as Record<string, string>, ["--preparar", "--confirmar=ep-otro"], /--confirmar/],
    ];
    for (const [env, args, patron] of casos) {
      const r = correr(env, args);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /CANCELADO/);
      assert.match(r.stderr, patron);
      assert.ok(!/clave-ficticia|usuario_ficticio|postgresql:\/\//.test(r.stdout + r.stderr), "nunca imprime la conexión");
    }
  });

  test("Lee las migraciones reales del repositorio, en orden", () => {
    const m = migracionesDelRepositorio(process.cwd());
    assert.ok(m.length >= 50);
    assert.equal(m[0], "20260813011422_init");
    assert.deepEqual([...m].sort(), m);
    assert.ok(m.includes("20261020120000_whatsapp_v1_vinculacion"));
  });
});

// ---------------------------------------------------------------------------
// Base simulada
// ---------------------------------------------------------------------------

type Fila = Record<string, unknown>;
const MIGRACIONES = ["20260101000000_a", "20260102000000_b", "20260103000000_c"];

function baseSimulada(opciones: { base?: string } = {}) {
  let s = {
    tablas: [] as { esquema: string; tabla: string }[],
    esquemas: [] as string[],
    marcador: [] as Fila[],
    migraciones: [] as { nombre: string; terminada: boolean; revertida: boolean }[],
    planes: [] as Fila[],
    modulos: [] as Fila[],
    planModulos: [] as Fila[],
    empresas: [] as Fila[],
    usuarios: [] as Fila[],
  };
  let respaldo: typeof s | null = null;
  let soloLectura = false;
  let bloqueo = false;
  const escrituras: string[] = [];
  const inicios: string[] = [];
  let fallarEn: RegExp | null = null;
  const copiar = () => JSON.parse(JSON.stringify(s)) as typeof s;
  const escribir = (sql: string) => {
    if (soloLectura) throw new Error("cannot execute in a read-only transaction");
    escrituras.push(sql.split(/\s+/).slice(0, 3).join(" "));
  };

  const consultar: Consultar = async (sql, p = []) => {
    if (fallarEn?.test(sql)) {
      fallarEn = null;
      throw new Error("Conexión interrumpida (simulada)");
    }
    const t = sql.trim();
    if (t === "BEGIN" || t === "BEGIN READ ONLY") {
      respaldo = copiar();
      soloLectura = t.endsWith("READ ONLY");
      inicios.push(t);
      return [];
    }
    if (t === "COMMIT") return (respaldo = null), (soloLectura = false), [];
    if (t === "ROLLBACK") return respaldo && (s = respaldo), (respaldo = null), (soloLectura = false), [];
    if (t.includes("pg_try_advisory_lock")) return bloqueo ? [{ ok: false }] : ((bloqueo = true), [{ ok: true }]);
    if (t.includes("pg_advisory_unlock")) return (bloqueo = false), [];
    if (t.startsWith("SELECT current_database()")) return [{ base: opciones.base ?? BASE }];
    if (t.startsWith("SELECT table_schema AS esquema")) return s.tablas.map((x) => ({ ...x }));
    if (t.includes("information_schema.schemata")) return s.esquemas.includes(String(p[0])) ? [{ "?column?": 1 }] : [];
    if (t.startsWith("SELECT valor, proyecto")) return s.marcador.map((m) => ({ ...m }));
    if (t.includes("FROM _prisma_migrations")) return s.migraciones.map((m) => ({ ...m }));
    if (t.startsWith("CREATE SCHEMA")) return escribir(t), s.esquemas.push("arqento_preview"), [];
    if (t.startsWith("CREATE TABLE arqento_preview.marcador")) return escribir(t), s.tablas.push({ esquema: "arqento_preview", tabla: "marcador" }), [];
    if (t.startsWith("INSERT INTO arqento_preview.marcador")) {
      escribir(t);
      s.marcador.push({ valor: p[0], proyecto: p[1], endpoint: p[2], base: p[3], estado: "PREPARANDO", instalacion: p[4] });
      return [];
    }
    if (t.startsWith("UPDATE arqento_preview.marcador")) {
      escribir(t);
      const nuevo = t.includes("'LISTA'") ? "LISTA" : "PREPARANDO";
      for (const m of s.marcador) if (!t.includes("AND estado = 'PREPARANDO'") || m.estado === "PREPARANDO") m.estado = nuevo;
      return [];
    }
    // Semilla
    if (t.startsWith("SELECT id FROM planes")) return s.planes.filter((x) => x.nombre === p[0]);
    if (t.startsWith("INSERT INTO planes")) return escribir(t), s.planes.push({ id: p[0], nombre: p[1] }), [];
    if (t.startsWith("INSERT INTO modulos")) return escribir(t), s.modulos.some((m) => m.clave === p[1]) || s.modulos.push({ id: p[0], clave: p[1], nombre: p[2] }), [];
    if (t.startsWith("SELECT id FROM modulos")) return s.modulos.filter((m) => m.clave === p[0]);
    if (t.startsWith("INSERT INTO plan_modulos")) {
      escribir(t);
      if (!s.planModulos.some((x) => x.planId === p[0] && x.moduloId === p[1])) s.planModulos.push({ planId: p[0], moduloId: p[1] });
      return [];
    }
    if (t.startsWith("SELECT id, nombre FROM empresas")) return s.empresas.map((e) => ({ id: e.id, nombre: e.nombre }));
    if (t.startsWith("INSERT INTO empresas")) {
      escribir(t);
      s.empresas.push({ id: p[0], nombre: p[1], planId: p[2], whatsappHabilitado: false, inteligenciaHabilitada: false, privadoHabilitado: false });
      return [];
    }
    if (t.startsWith("SELECT id, rol::text")) return s.usuarios.filter((u) => u.email === p[0] || u.id === p[1]).map((u) => ({ id: u.id, rol: u.rol, empresaId: u.empresaId }));
    if (t.startsWith("INSERT INTO usuarios")) {
      escribir(t);
      s.usuarios.push({ id: p[0], nombre: p[1], email: p[2], passwordHash: p[3], rol: p[4], empresaId: p[5], debeCambiarPassword: true, whatsappAutorizado: false });
      return [];
    }
    if (t.startsWith("SELECT (SELECT count(*) FROM empresas")) {
      const plan = s.planes.find((x) => x.nombre === p[2]);
      return [
        {
          empresas: s.empresas.filter((e) => e.id === p[0]).length,
          usuarios: s.usuarios.filter((u) => (p[1] as string[]).includes(String(u.id))).length,
          modulos: s.planModulos.filter((x) => x.planId === plan?.id).length,
        },
      ];
    }
    throw new Error(`SQL no simulado: ${t.slice(0, 60)}`);
  };

  // `prisma migrate deploy` simulado: aplica las pendientes en orden. Puede
  // interrumpirse antes de empezar, después de N migraciones, o dejar una
  // migración a medias (fila sin terminar, como Prisma).
  let interrupcion: { despuesDe: number; aMedias?: boolean; sinError?: boolean } | null = null;
  let llamadasMigrar = 0;
  const migrar = async (locales: string[]) => {
    llamadasMigrar++;
    if (!s.tablas.some((x) => x.tabla === "_prisma_migrations")) s.tablas.push({ esquema: "public", tabla: "_prisma_migrations" });
    let aplicadas = 0;
    for (const nombre of locales) {
      if (s.migraciones.some((m) => m.nombre === nombre)) continue;
      if (interrupcion && aplicadas === interrupcion.despuesDe) {
        const i = interrupcion;
        interrupcion = null;
        if (i.aMedias) s.migraciones.push({ nombre, terminada: false, revertida: false });
        if (i.sinError) return;
        throw new Error("prisma migrate deploy interrumpido (simulado)");
      }
      s.migraciones.push({ nombre, terminada: true, revertida: false });
      if (nombre === MIGRACIONES[0]) for (const tabla of ["planes", "modulos", "plan_modulos", "empresas", "usuarios"]) s.tablas.push({ esquema: "public", tabla });
      aplicadas++;
    }
  };

  const salida: string[] = [];
  const deps = (migracionesLocales = MIGRACIONES): Dependencias => ({
    consultar,
    migrar: () => migrar(migracionesLocales),
    hashear: async (pw) => `hash-de-${pw.length}`,
    imprimir: (l) => salida.push(l),
    migracionesLocales,
    esperado: { endpoint: EP, base: BASE },
  });
  return {
    get s() {
      return s;
    },
    escrituras,
    inicios,
    salida,
    deps,
    interrumpirMigracion: (i: { despuesDe: number; aMedias?: boolean; sinError?: boolean }) => (interrupcion = i),
    fallarEn: (r: RegExp) => (fallarEn = r),
    tomarBloqueo: () => (bloqueo = true),
    llamadasMigrar: () => llamadasMigrar,
  };
}

const rechaza = (p: Promise<unknown>, patron: RegExp) => assert.rejects(p, (e: Error) => patron.test(e.message));
const estado = (b: ReturnType<typeof baseSimulada>) => b.s.marcador[0]?.estado;

describe("Preview — verificación (dry-run)", () => {
  test("Base vacía: NUEVA, con todas las migraciones pendientes y CERO escrituras", async () => {
    const b = baseSimulada();
    const r = await verificarBasePreview(b.deps());
    assert.deepEqual([r.estadoInicial, r.pendientes], ["NUEVA", 3]);
    assert.deepEqual(b.escrituras, []);
    assert.equal(b.llamadasMigrar(), 0);
    assert.ok(b.inicios.length > 0 && b.inicios.every((x) => x === "BEGIN READ ONLY"), "el dry-run solo abre transacciones de solo lectura");
    assert.ok(b.salida.some((l) => l.includes("No se escribió nada")));
  });

  test("Base con datos y sin marcador (como desarrollo o producción): se detiene sin escribir", async () => {
    const b = baseSimulada();
    b.s.tablas.push({ esquema: "public", tabla: "usuarios" }, { esquema: "public", tabla: "_prisma_migrations" });
    await rechaza(verificarBasePreview(b.deps()), /NO está vacía/);
    await rechaza(prepararBasePreview(b.deps()), /NO está vacía/);
    assert.deepEqual(b.escrituras, []);
    assert.equal(b.llamadasMigrar(), 0);
  });

  test("Otra base conectada o tablas en esquemas desconocidos: se detiene", async () => {
    await rechaza(verificarBasePreview(baseSimulada({ base: "otra" }).deps()), /current_database/);
    const b = baseSimulada();
    b.s.tablas.push({ esquema: "extrano", tabla: "x" });
    await rechaza(verificarBasePreview(b.deps()), /esquemas desconocidos/);
  });
});

describe("Preview — marcador incorrecto o estado inconsistente", () => {
  const conMarcador = (marcador: Fila | Fila[], migraciones = MIGRACIONES) => {
    const b = baseSimulada();
    b.s.esquemas.push("arqento_preview");
    b.s.tablas.push({ esquema: "arqento_preview", tabla: "marcador" }, { esquema: "public", tabla: "_prisma_migrations" });
    const base = { valor: VALOR_MARCADOR, proyecto: "arqento-preview", endpoint: EP, base: BASE, estado: "LISTA", instalacion: "i-1" };
    b.s.marcador.push(...(Array.isArray(marcador) ? marcador : [marcador]).map((m) => ({ ...base, ...m })));
    for (const nombre of migraciones) b.s.migraciones.push({ nombre, terminada: true, revertida: false });
    return b;
  };

  test("Marcador de otro endpoint, otra base, otro valor, estado desconocido o duplicado", async () => {
    await rechaza(verificarBasePreview(conMarcador({ endpoint: "ep-otro-zz" }).deps()), /otro endpoint/);
    await rechaza(verificarBasePreview(conMarcador({ base: "otra" }).deps()), /otra base/);
    await rechaza(verificarBasePreview(conMarcador({ valor: "ARQENTO-BASE-EXCLUSIVA-PRUEBAS-INTEGRACION" }).deps()), /no es de arqento-preview/);
    await rechaza(verificarBasePreview(conMarcador({ estado: "REPARANDO" }).deps()), /estado desconocido/);
    await rechaza(verificarBasePreview(conMarcador([{}, {}]).deps()), /exactamente un registro/);
  });

  test("Esquema del marcador sin su tabla: estado desconocido", async () => {
    const b = baseSimulada();
    b.s.esquemas.push("arqento_preview");
    await rechaza(verificarBasePreview(b.deps()), /estado desconocido/);
  });

  test("Migraciones desconocidas, fuera de orden o LISTA sin migraciones: se detiene sin reparar", async () => {
    await rechaza(verificarBasePreview(conMarcador({}, [...MIGRACIONES, "20990101000000_ajena"]).deps()), /no existen en este repositorio/);
    await rechaza(verificarBasePreview(conMarcador({}, [MIGRACIONES[1], MIGRACIONES[0]]).deps()), /orden/);
    await rechaza(verificarBasePreview(conMarcador({}, []).deps()), /LISTA sin migraciones/);
  });

  test("Tablas de la aplicación sin historial de migraciones: se detiene", async () => {
    const b = conMarcador({ estado: "PREPARANDO" }, []);
    b.s.tablas.push({ esquema: "public", tabla: "usuarios" });
    await rechaza(verificarBasePreview(b.deps()), /sin historial/);
  });

  test("Otra preparación en curso (bloqueo tomado): se detiene", async () => {
    const b = baseSimulada();
    b.tomarBloqueo();
    await rechaza(prepararBasePreview(b.deps()), /en curso/);
    assert.deepEqual(b.escrituras, []);
  });
});

describe("Preview — preparación completa e interrupciones", () => {
  test("Base vacía → marcador PREPARANDO → migraciones → semilla ficticia → LISTA", async () => {
    const b = baseSimulada();
    const r = await prepararBasePreview(b.deps());
    assert.deepEqual([r.estadoInicial, r.estadoFinal], ["NUEVA", "LISTA"]);
    assert.equal(estado(b), "LISTA");
    assert.equal(b.s.migraciones.length, 3);
    // Orden: el marcador se crea ANTES de migrar.
    assert.ok(b.escrituras.findIndex((x) => x.startsWith("CREATE SCHEMA")) === 0);

    assert.deepEqual(b.s.empresas.map((e) => [e.id, e.whatsappHabilitado, e.inteligenciaHabilitada, e.privadoHabilitado]), [["empresa-demo-preview", false, false, false]]);
    assert.deepEqual(b.s.usuarios.map((u) => u.rol).sort(), ["ADMINISTRADOR", "MASTER", "SUPERVISOR"]);
    for (const u of b.s.usuarios) {
      assert.match(String(u.email), /@arqento-preview\.invalid$/);
      assert.equal(u.debeCambiarPassword, true);
      assert.equal(u.whatsappAutorizado, false);
    }
    assert.equal(b.s.usuarios.find((u) => u.rol === "MASTER")!.empresaId, null);
    assert.ok(!/conkuali/i.test(JSON.stringify(b.s)), "ningún dato de Conkuali");
    assert.equal(b.s.planModulos.length, 7);

    // Contraseñas aleatorias, distintas, mostradas una vez y antes de «Semilla confirmada».
    const lineas = b.salida.filter((l) => l.includes("@arqento-preview.invalid"));
    const passwords = lineas.map((l) => l.trim().split(/\s+/).at(-1)!);
    assert.equal(new Set(passwords).size, 3);
    for (const pw of passwords) assert.match(pw, /^[A-Za-z0-9_-]{16}$/);
    assert.ok(b.salida.indexOf("Semilla confirmada.") > b.salida.indexOf(lineas.at(-1)!));
    assert.ok(!JSON.stringify(b.s).includes(passwords[0]), "solo se guarda el hash");
  });

  test("Interrupción ANTES de aplicar migraciones: queda PREPARANDO y la siguiente ejecución reanuda", async () => {
    const b = baseSimulada();
    b.interrumpirMigracion({ despuesDe: 0 });
    await rechaza(prepararBasePreview(b.deps()), /interrumpido/);
    assert.equal(estado(b), "PREPARANDO");
    assert.equal((await verificarBasePreview(b.deps())).estadoInicial, "EN_PREPARACION");
    assert.equal((await prepararBasePreview(b.deps())).estadoFinal, "LISTA");
  });

  test("Interrupción ENTRE migraciones (2 de 3 aplicadas): reanuda y aplica solo las pendientes", async () => {
    const b = baseSimulada();
    b.interrumpirMigracion({ despuesDe: 2 });
    await rechaza(prepararBasePreview(b.deps()), /interrumpido/);
    assert.equal(b.s.migraciones.length, 2);
    const v = await verificarBasePreview(b.deps());
    assert.equal(v.pendientes, 1);
    await prepararBasePreview(b.deps());
    assert.deepEqual(b.s.migraciones.map((m) => m.nombre), MIGRACIONES);
    assert.equal(estado(b), "LISTA");
  });

  test("Prisma termina «sin error» pero deja migraciones pendientes: nunca queda LISTA ni siembra", async () => {
    const b = baseSimulada();
    b.interrumpirMigracion({ despuesDe: 2, sinError: true });
    await rechaza(prepararBasePreview(b.deps()), /no quedaron completas/);
    assert.equal(estado(b), "PREPARANDO");
    assert.equal(b.s.usuarios.length, 0);
  });

  test("Migración a medias (fila sin terminar): queda PREPARANDO y se exige revisión manual, sin reparar", async () => {
    const b = baseSimulada();
    b.interrumpirMigracion({ despuesDe: 1, aMedias: true });
    await rechaza(prepararBasePreview(b.deps()), /interrumpido/);
    assert.equal(estado(b), "PREPARANDO");
    const antes = JSON.stringify(b.s);
    await rechaza(prepararBasePreview(b.deps()), /revisión manual/);
    assert.equal(JSON.stringify(b.s), antes, "no tocó nada");
  });

  test("Falla al confirmar la semilla: contraseñas ANULADAS, sin usuarios, PREPARANDO; luego se completa", async () => {
    const b = baseSimulada();
    let commits = 0;
    const d = b.deps();
    const consultar = d.consultar;
    d.consultar = async (sql, p) => {
      // El primer COMMIT con usuarios en la transacción es el de la semilla.
      if (sql.trim() === "COMMIT" && b.s.usuarios.length > 0 && commits++ === 0) throw new Error("Conexión interrumpida (simulada)");
      return consultar(sql, p);
    };
    await rechaza(prepararBasePreview(d), /interrumpida/);
    assert.ok(b.salida.some((l) => l.includes("ANULADAS")));
    assert.ok(!b.salida.includes("Semilla confirmada."));
    assert.equal(b.s.usuarios.length, 0);
    assert.equal(estado(b), "PREPARANDO");
    b.salida.length = 0;
    await prepararBasePreview(b.deps());
    assert.equal(b.s.usuarios.length, 3);
    assert.ok(b.salida.includes("Semilla confirmada."));
  });

  test("Interrupción después de la semilla y antes de LISTA: reanuda sin duplicar usuarios ni mostrar contraseñas", async () => {
    const b = baseSimulada();
    b.fallarEn(/SET estado = 'LISTA'/);
    await rechaza(prepararBasePreview(b.deps()), /interrumpida/);
    assert.equal(estado(b), "PREPARANDO");
    assert.equal(b.s.usuarios.length, 3);
    b.salida.length = 0;
    await prepararBasePreview(b.deps());
    assert.equal(b.s.usuarios.length, 3);
    assert.ok(!b.salida.some((l) => l.includes("@arqento-preview.invalid")));
    assert.equal(estado(b), "LISTA");
  });

  test("Base LISTA: una nueva ejecución no migra ni siembra; con una migración nueva, solo aplica esa", async () => {
    const b = baseSimulada();
    await prepararBasePreview(b.deps([MIGRACIONES[0], MIGRACIONES[1]]));
    const llamadas = b.llamadasMigrar();
    const usuarios = JSON.stringify(b.s.usuarios);
    await prepararBasePreview(b.deps([MIGRACIONES[0], MIGRACIONES[1]]));
    assert.equal(b.llamadasMigrar(), llamadas, "sin pendientes no llama a Prisma");
    assert.equal(JSON.stringify(b.s.usuarios), usuarios);
    const r = await verificarBasePreview(b.deps());
    assert.deepEqual([r.estadoInicial, r.pendientes], ["LISTA", 1]);
    await prepararBasePreview(b.deps());
    assert.equal(b.s.migraciones.length, 3);
    assert.equal(estado(b), "LISTA");
  });

  test("Semilla que no coincide con lo existente (Empresa ajena o usuario con otro rol): se detiene", async () => {
    const b = baseSimulada();
    b.fallarEn(/SET estado = 'LISTA'/);
    await rechaza(prepararBasePreview(b.deps()), /interrumpida/);
    b.s.usuarios.find((u) => u.rol === "SUPERVISOR")!.rol = "DIRECTOR";
    await rechaza(prepararBasePreview(b.deps()), /no coincide con la semilla/);
    b.s.usuarios.find((u) => u.rol === "DIRECTOR")!.rol = "SUPERVISOR";
    b.s.empresas.push({ id: "conkuali", nombre: "Otra" });
    await rechaza(prepararBasePreview(b.deps()), /no son la Empresa Demo/);
    assert.equal(estado(b), "PREPARANDO");
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BaseDePruebasNoPermitida,
  describirDestino,
  mensajeSeguro,
  prepararEntornoDePruebas,
  sanitizarEntornoDePruebas,
  urlsDeOtrosEntornos,
  validarBaseDePruebas,
  validarEntornoDeEjecucion,
  type Entorno,
} from "../helpers/base-de-pruebas";

// Protección SIN CONEXIÓN de la base de pruebas de integración. Todas las
// URLs y credenciales son ficticias; ninguna prueba abre una conexión.

const LOCAL = "postgresql://arqento_test:clave-local-ficticia@127.0.0.1:54329/arqento_test";
const NEON_DEV = "postgresql://usuario:secreto-dev@ep-desarrollo-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const NEON_PROD = "postgresql://usuario:secreto-prod@ep-produccion-456.us-west-2.aws.neon.tech/neondb?sslmode=require";

const rechaza = (url: string | undefined, otras: string[] = [], patron?: RegExp) =>
  assert.throws(() => validarBaseDePruebas(url, otras), (e: Error) => e instanceof BaseDePruebasNoPermitida && (!patron || patron.test(e.message)));

describe("Validación de TEST_DATABASE_URL (sin conexión)", () => {
  test("Obligatoria: sin TEST_DATABASE_URL se rechaza (nunca usa DATABASE_URL)", () => rechaza(undefined, [NEON_DEV], /Falta/));
  test("URL inválida o de otro protocolo", () => {
    rechaza("no-es-una-url");
    rechaza("mysql://u:p@127.0.0.1:3306/arqento_test", [], /postgresql/);
  });
  test('El nombre de la base debe terminar en "_test"', () => {
    rechaza("postgresql://u:p@127.0.0.1:54329/arqento", [], /_test/);
    rechaza("postgresql://u:p@127.0.0.1:54329/arqento_testing", [], /_test/);
  });
  test("Neon se rechaza aunque la base termine en _test", () => {
    rechaza("postgresql://u:p@ep-algo-789.us-east-2.aws.neon.tech/arqento_test?sslmode=require", [], /Neon/);
    rechaza("postgresql://u:p@ep-algo-789-pooler.us-east-2.aws.neon.tech/neondb_test", [], /Neon/);
  });
  test("Cualquier servidor externo se rechaza (solo localhost / 127.0.0.1 / ::1)", () => {
    rechaza("postgresql://u:p@db.ejemplo.invalid:5432/arqento_test", [], /localhost/);
    rechaza("postgresql://u:p@10.0.0.5:5432/arqento_test", [], /localhost/);
    rechaza("postgresql://u:p@192.168.1.20:5432/arqento_test", [], /localhost/);
  });
  test("Parámetros que redirigen la conexión se rechazan (host, port, dbname, options…)", () => {
    rechaza(`${LOCAL}?host=ep-produccion-456.us-west-2.aws.neon.tech`, [], /parámetro/);
    rechaza(`${LOCAL}?hostaddr=203.0.113.9`, [], /parámetro/);
    rechaza(`${LOCAL}?port=5432`, [], /parámetro/);
    rechaza(`${LOCAL}?dbname=neondb`, [], /parámetro/);
    rechaza(`${LOCAL}?options=-c%20search_path%3Dotro`, [], /parámetro/);
  });
  test("Misma base que una conexión conocida: se rechaza aunque cambien credenciales o mayúsculas", () => {
    rechaza(LOCAL, ["postgresql://otro:otra@127.0.0.1:54329/ARQENTO_TEST"], /misma base/);
  });
  test("Mismo servidor local que otra conexión configurada: se rechaza (servidor dedicado)", () => {
    rechaza(LOCAL, ["postgresql://dev:dev@localhost:54329/arqento_dev"], /servidor dedicado/);
  });
  test("Acepta un PostgreSQL local dedicado *_test distinto de las conexiones conocidas", () => {
    assert.equal(validarBaseDePruebas(LOCAL, [NEON_DEV, NEON_PROD, "postgresql://dev:dev@127.0.0.1:5432/arqento_dev"]), LOCAL);
    assert.equal(validarBaseDePruebas("postgresql://u:p@localhost:54329/arqento_test?sslmode=disable", [NEON_DEV]), "postgresql://u:p@localhost:54329/arqento_test?sslmode=disable");
  });
  test("Los mensajes de error nunca incluyen la URL, el usuario ni la contraseña", () => {
    for (const url of ["postgresql://usuario-x:clave-secreta@127.0.0.1/arqento", NEON_PROD.replace("neondb", "x_test")]) {
      try {
        validarBaseDePruebas(url, []);
        assert.fail("debió rechazar");
      } catch (error) {
        const m = (error as Error).message;
        for (const secreto of ["clave-secreta", "usuario-x", "secreto-prod", "ep-produccion"]) assert.ok(!m.includes(secreto), m);
      }
    }
  });
});

describe("Entorno de ejecución", () => {
  test("NODE_ENV=production se rechaza", () => {
    assert.throws(() => validarEntornoDeEjecucion({ NODE_ENV: "production" }), /production/);
  });
  test("Entorno Vercel se rechaza", () => {
    for (const env of [{ VERCEL: "1" }, { VERCEL_ENV: "preview" }, { VERCEL_URL: "x.vercel.app" }]) {
      assert.throws(() => validarEntornoDeEjecucion(env), /Vercel/);
    }
  });
  test("Local de desarrollo o pruebas se acepta", () => {
    validarEntornoDeEjecucion({ NODE_ENV: "test" });
    validarEntornoDeEjecucion({});
  });
});

describe("Conexiones conocidas (desarrollo, producción, credenciales temporales)", () => {
  function conArchivos(archivos: Record<string, string>, fn: (raiz: string) => void) {
    const raiz = mkdtempSync(join(tmpdir(), "arqento-guardia-"));
    try {
      for (const [nombre, contenido] of Object.entries(archivos)) writeFileSync(join(raiz, nombre), contenido);
      fn(raiz);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  }

  test("Lee TODAS las variables PostgreSQL de TODOS los archivos .env*, se llamen como se llamen", () => {
    conArchivos(
      {
        ".env": `DATABASE_URL="${NEON_DEV}"\nDIRECT_URL="${NEON_DEV.replace("-pooler", "")}"\nOTRA=valor`,
        ".env.production.local": `DATABASE_URL_PRODUCTION="${NEON_PROD}"\nDIRECT_URL_PRODUCTION="${NEON_PROD}"`,
        ".env.production.credenciales-temp.txt": `Conexión de producción (texto libre, no dotenv):\n  ${NEON_PROD.replace("neondb", "otra")}\n`,
        ".env.test": `TEST_DATABASE_URL="${LOCAL}"`,
        "no-es-env.txt": `X=${NEON_DEV.replace("neondb", "ignorada")}`,
      },
      (raiz) => {
        const urls = urlsDeOtrosEntornos(raiz, {});
        assert.ok(urls.some((u) => u.includes("ep-desarrollo-123-pooler")));
        assert.ok(urls.some((u) => u.includes("ep-produccion-456") && u.includes("/neondb")));
        assert.ok(urls.some((u) => u.includes("/otra")), "también revisa archivos .env* sin formato dotenv");
        assert.ok(!urls.some((u) => u.includes("/ignorada")), "solo archivos .env*");
        assert.ok(!urls.includes(LOCAL), "TEST_DATABASE_URL nunca cuenta como otra conexión");
      }
    );
  });

  test("Incluye las variables PostgreSQL del entorno del proceso", () => {
    const urls = urlsDeOtrosEntornos(join(tmpdir(), "no-existe-arqento"), { DATABASE_URL: NEON_DEV, ALGO_PRODUCTION: NEON_PROD, TEST_DATABASE_URL: LOCAL });
    assert.deepEqual(urls.sort(), [NEON_DEV, NEON_PROD].sort());
  });

  test("Un proceso hijo con el entorno ya saneado por su padre no se rechaza a sí mismo", () => {
    const env: Entorno = { TEST_DATABASE_URL: LOCAL };
    sanitizarEntornoDePruebas(env, LOCAL);
    const urls = urlsDeOtrosEntornos(join(tmpdir(), "no-existe-arqento"), env);
    assert.deepEqual(urls, []);
    assert.equal(validarBaseDePruebas(env.TEST_DATABASE_URL, urls), LOCAL);
  });

  test("Sin la marca de saneado, un DATABASE_URL igual a la base de pruebas sí se rechaza", () => {
    const env = { TEST_DATABASE_URL: LOCAL, DATABASE_URL: LOCAL };
    assert.throws(() => validarBaseDePruebas(LOCAL, urlsDeOtrosEntornos(join(tmpdir(), "no-existe-arqento"), env)), /misma base/);
  });
});

describe("Saneamiento del proceso de pruebas", () => {
  test("Retira OpenAI, R2/AWS, WhatsApp, *_PRODUCTION y CRON_SECRET; apunta toda conexión a la base de pruebas", () => {
    const env: Entorno = {
      OPENAI_API_KEY: "sk-ficticia",
      R2_SECRET_ACCESS_KEY: "r2-ficticia",
      R2_BUCKET_NAME: "bucket",
      AWS_ACCESS_KEY_ID: "aws",
      DATABASE_URL_PRODUCTION: NEON_PROD,
      CRON_SECRET: "cron",
      WHATSAPP_ACCESS_TOKEN: "token-ficticio",
      WHATSAPP_APP_SECRET: "secreto-ficticio",
      DATABASE_URL: NEON_DEV,
      DIRECT_URL: NEON_DEV,
      PATH: "/usr/bin",
    };
    const eliminadas = sanitizarEntornoDePruebas(env, LOCAL);
    assert.deepEqual(
      eliminadas.sort(),
      ["AWS_ACCESS_KEY_ID", "CRON_SECRET", "DATABASE_URL_PRODUCTION", "OPENAI_API_KEY", "R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET"].sort()
    );
    assert.equal(env.DATABASE_URL, LOCAL);
    assert.equal(env.DIRECT_URL, LOCAL);
    assert.match(env.DOTENV_CONFIG_PATH!, /inexistente/);
    assert.equal(env.PATH, "/usr/bin");
    for (const valor of Object.values(env)) assert.ok(!String(valor).includes("neon.tech"));
  });

  test("prepararEntornoDePruebas: valida y sanea en un solo paso; no deja pasar Neon", () => {
    const raiz = join(tmpdir(), "no-existe-arqento");
    const env: Entorno = { TEST_DATABASE_URL: LOCAL, OPENAI_API_KEY: "sk-ficticia", DATABASE_URL: NEON_DEV };
    const { destino, eliminadas } = prepararEntornoDePruebas(env, raiz);
    assert.equal(destino, "127.0.0.1:54329/arqento_test");
    assert.deepEqual(eliminadas, ["OPENAI_API_KEY"]);
    assert.throws(() => prepararEntornoDePruebas({ TEST_DATABASE_URL: NEON_PROD.replace("neondb", "neondb_test") }, raiz), /Neon/);
  });

  test("describirDestino y mensajeSeguro nunca revelan usuario ni contraseña", () => {
    assert.equal(describirDestino(LOCAL), "127.0.0.1:54329/arqento_test");
    const mensaje = mensajeSeguro(new Error(`fallo al conectar ${LOCAL} con arqento_test:clave-local-ficticia`), LOCAL);
    assert.ok(!mensaje.includes("clave-local-ficticia"), mensaje);
    assert.ok(!mensaje.includes("postgresql://"), mensaje);
  });
});

describe("Los puntos de entrada abortan ANTES de conectarse", () => {
  // Procesos reales con URLs que la validación rechaza: nunca llegan a abrir
  // una conexión. Se retira cualquier variable sensible del entorno heredado.
  const entornoBase = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(OPENAI_|R2_|AWS_|WHATSAPP_|TEST_DATABASE_URL$)|_PRODUCTION$/.test(k))
  );
  const ejecutar = (args: string[], testUrl?: string) =>
    spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...entornoBase, ...(testUrl ? { TEST_DATABASE_URL: testUrl } : {}) } as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60000,
    });
  const PUNTOS_DE_ENTRADA: [string, string[]][] = [
    ["setup de npm run test:integracion", ["--conditions=react-server", "--import", "tsx", "--import", "./tests/setup/integracion.mjs", "-e", "console.log('NO-DEBIO-CONTINUAR')"]],
    ["preparar-base-pruebas", ["--import", "tsx", "scripts/pruebas/preparar-base-pruebas.ts"]],
    ["migrar-base-pruebas", ["--import", "tsx", "scripts/pruebas/migrar-base-pruebas.ts"]],
    ["limpiar-base-pruebas", ["--import", "tsx", "scripts/pruebas/limpiar-base-pruebas.ts"]],
  ];
  const URLS_RECHAZADAS: [string, string | undefined, RegExp][] = [
    ["sin TEST_DATABASE_URL", undefined, /Falta TEST_DATABASE_URL/],
    ["Neon", NEON_PROD.replace("neondb", "neondb_test"), /Neon/],
    ["base sin _test", "postgresql://u:p@127.0.0.1:54329/arqento", /_test/],
  ];

  for (const [nombre, args] of PUNTOS_DE_ENTRADA) {
    for (const [caso, url, patron] of URLS_RECHAZADAS) {
      test(`${nombre}: ${caso} → aborta con código 1 sin conectarse`, () => {
        const r = ejecutar(args, url);
        const salida = `${r.stdout}${r.stderr}`;
        assert.equal(r.status, 1, salida);
        assert.match(salida, patron);
        assert.ok(!salida.includes("NO-DEBIO-CONTINUAR"));
        assert.ok(!salida.includes("secreto-prod"), "nunca imprime credenciales");
        assert.ok(!/ECONNREFUSED|connect /i.test(salida), "no intentó conectarse");
      });
    }
  }
});

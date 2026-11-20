import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  VALOR_MARCADOR,
  esDireccionLocalOPrivada,
  evaluarBaseVaciaParaMarcar,
  evaluarIdentidad,
  leerIdentidad,
  limpiarDatosDePrueba,
  type Consultar,
  type IdentidadObservada,
} from "../helpers/identidad-base-pruebas";

// Reglas de identidad de la base de pruebas, evaluadas sobre observaciones
// ficticias (sin conexión). Las consultas se simulan.

const BASE = "arqento_test";
const SISTEMA = "7412345678901234567";
const valida = (extra: Partial<IdentidadObservada> = {}): IdentidadObservada => ({
  baseActual: BASE,
  direccionServidor: "172.17.0.2",
  version: "PostgreSQL 17.6 on x86_64-pc-linux-gnu",
  esNeon: false,
  sistemaIdActual: SISTEMA,
  marcador: { valor: VALOR_MARCADOR, base: BASE, sistemaId: SISTEMA },
  objetosDeUsuario: 120,
  esquemasDeUsuario: 1,
  ...extra,
});
const vacia = (extra: Partial<IdentidadObservada> = {}) => valida({ marcador: null, objetosDeUsuario: 0, esquemasDeUsuario: 0, ...extra });

describe("Identidad de la base (ya conectada, antes de escribir)", () => {
  test("Base local con marcador válido: sin errores", () => {
    assert.deepEqual(evaluarIdentidad(valida(), BASE), []);
    assert.deepEqual(evaluarIdentidad(valida({ direccionServidor: null }), BASE), [], "socket local");
    assert.deepEqual(evaluarIdentidad(valida({ direccionServidor: "127.0.0.1/32" }), BASE), []);
  });

  const casos: [string, Partial<IdentidadObservada>, RegExp][] = [
    ["sin marcador", { marcador: null }, /marcador exclusivo/],
    ["marcador con otro valor", { marcador: { valor: "OTRO", base: BASE, sistemaId: SISTEMA } }, /no es válido/],
    ["marcador de otra base", { marcador: { valor: VALOR_MARCADOR, base: "otra_test", sistemaId: SISTEMA } }, /otra base/],
    ["marcador copiado de otro servidor", { marcador: { valor: VALOR_MARCADOR, base: BASE, sistemaId: "999" } }, /otro servidor/],
    ["base distinta a la de la URL", { baseActual: "otra_test" }, /no es la indicada/],
    ["base sin _test", { baseActual: "neondb" }, /_test/],
    ["servidor Neon", { esNeon: true }, /Neon/],
    ["servidor no local", { direccionServidor: "203.0.113.10" }, /no es local/],
    ["sin identificador de servidor", { sistemaIdActual: null }, /identificador del servidor/],
  ];
  for (const [nombre, cambio, patron] of casos) {
    test(`Rechaza: ${nombre}`, () => {
      const errores = evaluarIdentidad(valida(cambio), BASE);
      assert.ok(errores.some((e) => patron.test(e)), JSON.stringify(errores));
    });
  }

  test("Direcciones locales y privadas", () => {
    for (const ip of [null, "127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.10", "fd12:3456::1"]) {
      assert.equal(esDireccionLocalOPrivada(ip), true, String(ip));
    }
    for (const ip of ["172.32.0.1", "8.8.8.8", "203.0.113.10", "2600:1f18::1"]) assert.equal(esDireccionLocalOPrivada(ip), false, ip);
  });
});

describe("Creación del marcador: solo sobre una base vacía y verificada", () => {
  test("Base local nueva y vacía: se permite", () => assert.deepEqual(evaluarBaseVaciaParaMarcar(vacia(), BASE), []));
  test("Base con tablas: se rechaza", () => assert.ok(evaluarBaseVaciaParaMarcar(vacia({ objetosDeUsuario: 3 }), BASE).some((e) => /vacía/.test(e))));
  test("Base con esquemas propios: se rechaza", () => assert.ok(evaluarBaseVaciaParaMarcar(vacia({ esquemasDeUsuario: 1 }), BASE).some((e) => /vacía/.test(e))));
  test("Base que ya tiene marcador: se rechaza", () => assert.ok(evaluarBaseVaciaParaMarcar(valida(), BASE).some((e) => /ya tiene/.test(e))));
  test("Neon, servidor externo o base sin _test: se rechaza aunque esté vacía", () => {
    assert.ok(evaluarBaseVaciaParaMarcar(vacia({ esNeon: true }), BASE).length > 0);
    assert.ok(evaluarBaseVaciaParaMarcar(vacia({ direccionServidor: "8.8.8.8" }), BASE).length > 0);
    assert.ok(evaluarBaseVaciaParaMarcar(vacia({ baseActual: "neondb" }), "neondb").length > 0);
  });
});

// Consultas simuladas con las mismas respuestas que daría PostgreSQL.
function consultasSimuladas(obs: IdentidadObservada, tablas: string[] = ["empresas", "gastos_obra", "_prisma_migrations"]) {
  const ejecutadas: string[] = [];
  const consultar: Consultar = async (sql) => {
    ejecutadas.push(sql);
    if (sql.includes("current_database()")) return [{ base: obs.baseActual, direccion: obs.direccionServidor, version: obs.version }];
    if (sql.includes("pg_settings")) return [{ n: obs.esNeon ? 1 : 0 }];
    if (sql.includes("pg_control_system")) return [{ id: obs.sistemaIdActual }];
    if (sql.includes("to_regclass")) return [{ existe: obs.marcador !== null }];
    if (sql.includes("SELECT valor, base, sistema_id")) return obs.marcador ? [{ valor: obs.marcador.valor, base: obs.marcador.base, sistema_id: obs.marcador.sistemaId }] : [];
    if (sql.includes("pg_class")) return [{ n: obs.objetosDeUsuario }];
    if (sql.includes("pg_namespace")) return [{ n: obs.esquemasDeUsuario }];
    if (sql.includes("pg_tables")) return tablas.filter((t) => t !== "_prisma_migrations").map((tablename) => ({ tablename }));
    throw new Error(`Consulta no esperada: ${sql}`);
  };
  return { consultar, ejecutadas };
}

describe("Lectura de identidad y limpieza (consultas simuladas)", () => {
  test("leerIdentidad solo ejecuta consultas de lectura", async () => {
    const { consultar, ejecutadas } = consultasSimuladas(valida());
    assert.deepEqual(await leerIdentidad(consultar), valida());
    for (const sql of ejecutadas) assert.match(sql.trim(), /^SELECT/i);
  });

  test("La limpieza verifica la identidad ANTES de borrar y conserva migraciones y marcador", async () => {
    const { consultar } = consultasSimuladas(valida());
    const borrados: string[] = [];
    await limpiarDatosDePrueba(consultar, async (sql) => borrados.push(sql), BASE);
    assert.equal(borrados.length, 1);
    assert.match(borrados[0], /^TRUNCATE TABLE "public"\."empresas", "public"\."gastos_obra" RESTART IDENTITY CASCADE$/);
    assert.ok(!borrados[0].includes("_prisma_migrations") && !borrados[0].includes("arqento_pruebas"));
  });

  test("Sin marcador, en Neon o en otra base: la limpieza no ejecuta nada", async () => {
    for (const obs of [valida({ marcador: null }), valida({ esNeon: true }), valida({ baseActual: "neondb" })]) {
      const { consultar } = consultasSimuladas(obs);
      const borrados: string[] = [];
      await assert.rejects(limpiarDatosDePrueba(consultar, async (sql) => borrados.push(sql), BASE));
      assert.deepEqual(borrados, []);
    }
  });

  test("Un nombre de tabla inesperado cancela la limpieza", async () => {
    const { consultar } = consultasSimuladas(valida(), ['empresas"; DROP SCHEMA public; --']);
    const borrados: string[] = [];
    await assert.rejects(limpiarDatosDePrueba(consultar, async (sql) => borrados.push(sql), BASE), /inesperado/);
    assert.deepEqual(borrados, []);
  });
});

describe("Servicios externos simulados", () => {
  test("OpenAI falla al usarse; S3/R2 es un bucket en memoria (sin red); sin URLs firmadas", async () => {
    const stub = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs");
    assert.throws(() => new stub.OpenAI().responses.parse({}), /deshabilitado/);
    const s3 = new stub.S3Client();
    await s3.send(new stub.PutObjectCommand({ Key: "prueba/a.png", Body: new Uint8Array([1, 2, 3]) }));
    const leido = await s3.send(new stub.GetObjectCommand({ Key: "prueba/a.png" }));
    assert.deepEqual([...(await leido.Body.transformToByteArray())], [1, 2, 3]);
    await assert.rejects(s3.send(new stub.GetObjectCommand({ Key: "no-existe" })), /inexistente/);
    await assert.rejects(stub.getSignedUrl(), /deshabilitado/);
  });
});

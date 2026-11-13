import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { aprobarGasto } from "@/lib/server/control-de-obra/gastos";
import { cerrarSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { obtenerEstimacionCliente, obtenerEstimacionSemanalEnVivo } from "@/lib/server/control-de-obra/estimacion-cliente";
import { BENEFICIARIO, EMPRESA, PROYECTO, SEMANA, admin, baseLimpiaConDatos, conFallaSimulada } from "./apoyo/base";

// Gastos cobrables en la Estimación Cliente (noviembre 2026), contra
// PostgreSQL REAL de pruebas:
//  1) Preliminar de semana ABIERTA: muestra los gastos que entrarían al
//     cerrar, con los % de cada capa, sin escribir nada; y coincide con la
//     estimación que genera el cierre real.
//  2) Aprobar un gasto cobrable de una semana CERRADA sin estimación crea
//     las capas BORRADOR y lo liga, sin duplicar ni tocar capas EMITIDAS, y
//     con la reposición independiente.
// Cifras ficticias. SEMANA = semana 41 (5-oct-2026) de apoyo/base.ts.

const SEMANA_ANTERIOR = "semana-int-40";
const SEMANA_SIGUIENTE = "semana-int-42";
const CONCEPTO = "concepto-int";
const PCT_GENERAL = 10;
const PCT_PRIVADO = 15;
const PCT_UTILIDAD = 20;

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.semana.createMany({
    data: [
      { id: SEMANA_ANTERIOR, empresaId: EMPRESA, numero: 40, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 8, 28)), fechaFin: new Date(Date.UTC(2026, 9, 4)) },
      { id: SEMANA_SIGUIENTE, empresaId: EMPRESA, numero: 42, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 9, 12)), fechaFin: new Date(Date.UTC(2026, 9, 18)) },
    ],
  });
  await esquema("ADMINISTRACION");
});

const semana41 = () => db.semana.findUniqueOrThrow({ where: { id: SEMANA }, select: { id: true, fechaInicio: true } });
const cerca = (real: number, esperado: number, msg?: string) =>
  assert.ok(Math.abs(real - esperado) < 0.005, `${msg ?? ""} esperado ${esperado}, real ${real}`);

async function esquema(e: "ADMINISTRACION" | "PRECIO_ALZADO") {
  await db.proyecto.update({
    where: { id: PROYECTO },
    data: {
      esquemaContractual: e,
      porcentajeAdministracionDefault: PCT_GENERAL,
      porcentajeAdministracionPrivadoDefault: PCT_PRIVADO,
      porcentajeUtilidadDefault: PCT_UTILIDAD,
    },
  });
}

// Avance aprobado: 5 × $1,000 en la semana 41.
async function avance() {
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "Albañilería" } });
  await db.concepto.create({
    data: { id: CONCEPTO, partidaId: partida.id, descripcion: "Muro", unidad: "m2", cantidadContratada: 100, precioUnitarioContratista: 1000 },
  });
  await db.avanceConcepto.create({
    data: { empresaId: EMPRESA, conceptoId: CONCEPTO, semanaId: SEMANA, cantidadEjecutada: 5, registradoPorId: admin.id, estatusAprobacion: "APROBADO" },
  });
}

async function gasto(
  id: string,
  monto: string,
  extra: { semanaId?: string; estatus?: "PENDIENTE_REVISION" | "APROBADO"; tratamiento?: "COBRABLE_EN_ESTIMACION" | "NO_COBRABLE"; pagador?: string | null } = {}
) {
  return db.gastoObra.create({
    data: {
      id,
      empresaId: EMPRESA,
      proyectoId: PROYECTO,
      semanaId: extra.semanaId ?? SEMANA,
      fecha: new Date(Date.UTC(2026, 9, 6)),
      descripcion: `Material ficticio ${id}`,
      categoria: "MATERIALES",
      monto,
      metodoPago: "EFECTIVO",
      pagadorBeneficiarioId: extra.pagador === undefined ? BENEFICIARIO : extra.pagador,
      capturadoPorId: admin.id,
      estatus: extra.estatus ?? "APROBADO",
      tratamientoCliente: extra.tratamiento ?? "COBRABLE_EN_ESTIMACION",
    },
  });
}

async function cierre(semanaId: string) {
  await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId, estatus: "CERRADA", cerradoPorId: admin.id } });
}

async function estimacionConCapas(semanaId: string, estatus: "BORRADOR" | "EMITIDA") {
  return db.estimacionCliente.create({
    data: {
      empresaId: EMPRESA,
      proyectoId: PROYECTO,
      semanaId,
      generadoPorId: admin.id,
      capas: {
        create: (["OPERATIVO", "PRIVADO"] as const).map((capa, i) => ({
          capa,
          estatus,
          generadoPorId: admin.id,
          ...(estatus === "EMITIDA" ? { numero: 1, total: 777 + i, emitidoPorId: admin.id, emitidoEn: new Date() } : {}),
        })),
      },
    },
    include: { capas: true },
  });
}

// Huella de todo lo que el preliminar NO debe escribir.
async function huella() {
  const [estimaciones, capas, auditoria, gastos] = await Promise.all([
    db.estimacionCliente.count(),
    db.estimacionClienteCapa.findMany({ select: { id: true, estatus: true, total: true }, orderBy: { id: "asc" } }),
    db.registroAuditoria.count(),
    db.gastoObra.findMany({ select: { id: true, incluidoEnCapaOperativoId: true, incluidoEnCapaPrivadoId: true, updatedAt: true }, orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ estimaciones, capas, auditoria, gastos });
}

const idsGastos = (g: { gastoObraId: string }[]) => g.map((x) => x.gastoObraId).sort();

describe("Preliminar de semana abierta — gastos cobrables", () => {
  test("Avance + gasto: General y Privada suman gasto y administración con su propio %", async () => {
    await avance();
    await gasto("g-cienega", "6350.25");

    const antes = await huella();
    const { preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());
    assert.equal(await huella(), antes, "el preliminar no escribe nada");

    const g = preliminar.OPERATIVO;
    assert.deepEqual(idsGastos(g.gastos), ["g-cienega"]);
    cerca(g.totales.subtotal, 5000, "subtotal trabajos General");
    cerca(g.totales.subtotalGastosCobrables, 6350.25);
    assert.equal(g.totales.porcentajeAdministracionGastos, PCT_GENERAL);
    cerca(g.totales.montoAdministracionGastos, 635.025);
    cerca(g.totales.montoAdministracionTotal, 500 + 635.025);
    cerca(g.totales.total, 5500 + 6350.25 + 635.025, "total General");

    const p = preliminar.PRIVADO;
    assert.deepEqual(idsGastos(p.gastos), ["g-cienega"]);
    assert.equal(p.totales.porcentajeAdministracionGastos, PCT_PRIVADO);
    cerca(p.totales.montoAdministracionGastos, 952.5375);
    cerca(p.totales.total, 5750 + 6350.25 + 952.5375, "total Privado");
    assert.equal(g.aplicaIVA, false);
  });

  test("Semana solo con gastos (sin avance): aparecen y el total es gasto + administración", async () => {
    await gasto("g1", "1000.00");
    const { filas, preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());
    assert.equal(filas.length, 0);
    cerca(preliminar.OPERATIVO.totales.subtotal, 0);
    cerca(preliminar.OPERATIVO.totales.total, 1100);
    cerca(preliminar.PRIVADO.totales.total, 1150);
  });

  test("Precio alzado: General sin % sobre gastos, Privada con utilidad", async () => {
    await esquema("PRECIO_ALZADO");
    await gasto("g1", "1000.00");
    const { preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());
    assert.equal(preliminar.OPERATIVO.totales.porcentajeAdministracionGastos, null);
    cerca(preliminar.OPERATIVO.totales.total, 1000);
    assert.equal(preliminar.PRIVADO.totales.porcentajeAdministracionGastos, PCT_UTILIDAD);
    cerca(preliminar.PRIVADO.totales.total, 1200);
  });

  test("Solo entra lo que el cierre reclamaría: excluye pendientes, no cobrables, futuros y ya ligados a otra capa BORRADOR", async () => {
    await gasto("g-ok", "100.00");
    await gasto("g-pendiente", "200.00", { estatus: "PENDIENTE_REVISION" });
    await gasto("g-no-cobrable", "300.00", { tratamiento: "NO_COBRABLE" });
    await gasto("g-futuro", "400.00", { semanaId: SEMANA_SIGUIENTE });
    // Semana 40 con capas BORRADOR: su gasto le pertenece a ella, no a la 41.
    await estimacionConCapas(SEMANA_ANTERIOR, "BORRADOR");
    await gasto("g-40-borrador", "500.00", { semanaId: SEMANA_ANTERIOR });

    const { preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());
    assert.deepEqual(idsGastos(preliminar.OPERATIVO.gastos), ["g-ok"]);
    assert.deepEqual(idsGastos(preliminar.PRIVADO.gastos), ["g-ok"]);
  });

  test("Gasto de una semana anterior con capas EMITIDAS pasa a la semana abierta (si el cierre la generaría)", async () => {
    await estimacionConCapas(SEMANA_ANTERIOR, "EMITIDA");
    await gasto("g-40", "500.00", { semanaId: SEMANA_ANTERIOR });

    // Sin avance ni gasto propio, el cierre de la 41 no genera estimación
    // (SIN_AVANCE) y no reclama nada — el preliminar debe decir lo mismo.
    let { preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());
    assert.deepEqual(idsGastos(preliminar.OPERATIVO.gastos), []);

    await avance();
    ({ preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41()));
    assert.deepEqual(idsGastos(preliminar.OPERATIVO.gastos), ["g-40"]);
    assert.deepEqual(idsGastos(preliminar.PRIVADO.gastos), ["g-40"]);
  });

  test("Consistencia: el preliminar coincide exactamente con la estimación que genera el cierre", async () => {
    await gasto("g1", "1234.56");
    await gasto("g2", "765.44");
    const { preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());

    await cerrarSemana(admin, PROYECTO, SEMANA);
    for (const capa of ["OPERATIVO", "PRIVADO"] as const) {
      const generada = await obtenerEstimacionCliente(admin, PROYECTO, SEMANA, capa);
      assert.ok(generada, `el cierre generó la capa ${capa}`);
      assert.deepEqual(idsGastos(generada.gastos), idsGastos(preliminar[capa].gastos));
      cerca(generada.estimacion.subtotalGastosCobrables, preliminar[capa].totales.subtotalGastosCobrables);
      cerca(generada.estimacion.montoAdministracionTotal, preliminar[capa].totales.montoAdministracionTotal);
      cerca(generada.estimacion.total, preliminar[capa].totales.total, `total ${capa}`);
    }
  });
});

describe("Aprobar gasto cobrable de semana cerrada sin estimación", () => {
  async function estimacionesDe(semanaId: string) {
    return db.estimacionCliente.findMany({ where: { proyectoId: PROYECTO, semanaId }, include: { capas: true } });
  }

  test("Crea las capas BORRADOR, liga el gasto y la reposición sigue independiente", async () => {
    await cierre(SEMANA);
    await gasto("g1", "6350.25", { estatus: "PENDIENTE_REVISION" });

    await aprobarGasto(admin, "g1");

    const [est] = await estimacionesDe(SEMANA);
    assert.ok(est, "se creó la estimación de la semana cerrada");
    assert.deepEqual(est.capas.map((c) => `${c.capa}:${c.estatus}`).sort(), ["OPERATIVO:BORRADOR", "PRIVADO:BORRADOR"]);
    const g = await db.gastoObra.findUniqueOrThrow({ where: { id: "g1" } });
    assert.equal(g.estatus, "APROBADO");
    assert.equal(g.incluidoEnCapaOperativoId, est.capas.find((c) => c.capa === "OPERATIVO")!.id);
    assert.equal(g.incluidoEnCapaPrivadoId, est.capas.find((c) => c.capa === "PRIVADO")!.id);

    // Reposición: obligación interna con Andrés, sin relación con la estimación.
    assert.ok(g.reposicionGastosId, "generó su reposición");
    const rep = await db.reposicionGastos.findUniqueOrThrow({ where: { id: g.reposicionGastosId! } });
    assert.equal(rep.beneficiarioId, BENEFICIARIO);

    const auditoria = await db.registroAuditoria.findFirstOrThrow({ where: { entidad: "EstimacionCliente", entidadId: est.id, accion: "CREAR" } });
    assert.equal((auditoria.valorNuevo as { origen: string }).origen, "aprobacion_gasto_semana_cerrada");

    const generada = await obtenerEstimacionCliente(admin, PROYECTO, SEMANA, "OPERATIVO");
    cerca(generada!.estimacion.total, 6350.25 * 1.1, "la capa General ya cobra el gasto con su %");
  });

  test("Repetir la operación no duplica: segunda aprobación reutiliza la estimación", async () => {
    await cierre(SEMANA);
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION" });
    await gasto("g2", "200.00", { estatus: "PENDIENTE_REVISION" });
    await aprobarGasto(admin, "g1");
    await aprobarGasto(admin, "g1"); // reintento / doble clic
    await aprobarGasto(admin, "g2");

    const ests = await estimacionesDe(SEMANA);
    assert.equal(ests.length, 1);
    assert.equal(ests[0].capas.length, 2);
    const ligados = await db.gastoObra.count({ where: { incluidoEnCapaOperativoId: { not: null }, incluidoEnCapaPrivadoId: { not: null } } });
    assert.equal(ligados, 2);
  });

  test("Aprobaciones simultáneas de la misma semana: una sola estimación, ambos gastos ligados", async () => {
    await cierre(SEMANA);
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION", pagador: null });
    await gasto("g2", "200.00", { estatus: "PENDIENTE_REVISION", pagador: null });
    const r = await Promise.allSettled([aprobarGasto(admin, "g1"), aprobarGasto(admin, "g2")]);
    assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled"], JSON.stringify(r.filter((x) => x.status === "rejected")));

    const ests = await estimacionesDe(SEMANA);
    assert.equal(ests.length, 1);
    const ligados = await db.gastoObra.count({ where: { incluidoEnCapaOperativoId: { not: null }, incluidoEnCapaPrivadoId: { not: null } } });
    assert.equal(ligados, 2);
  });

  test("Capas EMITIDAS no se tocan ni se duplican: el gasto pasa a la siguiente BORRADOR", async () => {
    await cierre(SEMANA);
    const emitida = await estimacionConCapas(SEMANA, "EMITIDA");
    const siguiente = await estimacionConCapas(SEMANA_SIGUIENTE, "BORRADOR");
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION" });

    await aprobarGasto(admin, "g1");

    assert.equal((await estimacionesDe(SEMANA)).length, 1, "no se creó otra estimación para la semana emitida");
    const capasDespues = await db.estimacionClienteCapa.findMany({ where: { estimacionClienteId: emitida.id }, orderBy: { capa: "asc" } });
    assert.deepEqual(
      capasDespues.map((c) => [c.estatus, c.total.toString(), c.updatedAt.getTime()]),
      emitida.capas.sort((a, b) => a.capa.localeCompare(b.capa)).map((c) => [c.estatus, c.total.toString(), c.updatedAt.getTime()])
    );
    const g = await db.gastoObra.findUniqueOrThrow({ where: { id: "g1" } });
    assert.equal(g.incluidoEnCapaOperativoId, siguiente.capas.find((c) => c.capa === "OPERATIVO")!.id);
    assert.equal(g.incluidoEnCapaPrivadoId, siguiente.capas.find((c) => c.capa === "PRIVADO")!.id);
  });

  test("Capas EMITIDAS y sin BORRADOR posterior: el gasto espera, no se crea nada", async () => {
    await cierre(SEMANA);
    await estimacionConCapas(SEMANA, "EMITIDA");
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION" });
    await aprobarGasto(admin, "g1");
    assert.equal(await db.estimacionCliente.count(), 1);
    const g = await db.gastoObra.findUniqueOrThrow({ where: { id: "g1" } });
    assert.equal(g.incluidoEnCapaOperativoId, null);
    assert.equal(g.incluidoEnCapaPrivadoId, null);
  });

  test("Semana ABIERTA: aprobar no crea estimación (solo aparece en el preliminar)", async () => {
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION" });
    await aprobarGasto(admin, "g1");
    assert.equal(await db.estimacionCliente.count(), 0);
    const { preliminar } = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana41());
    assert.deepEqual(idsGastos(preliminar.OPERATIVO.gastos), ["g1"]);
  });

  test("Gasto NO cobrable en semana cerrada: no crea estimación", async () => {
    await cierre(SEMANA);
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION", tratamiento: "NO_COBRABLE" });
    await aprobarGasto(admin, "g1");
    assert.equal(await db.estimacionCliente.count(), 0);
  });

  test("Rollback real: si falla crear la estimación, la aprobación completa se revierte", async () => {
    await cierre(SEMANA);
    await gasto("g1", "100.00", { estatus: "PENDIENTE_REVISION" });
    await conFallaSimulada("estimaciones_cliente", "TRUE", () => assert.rejects(aprobarGasto(admin, "g1"), /Falla simulada/));
    const g = await db.gastoObra.findUniqueOrThrow({ where: { id: "g1" } });
    assert.equal(g.estatus, "PENDIENTE_REVISION");
    assert.equal(g.reposicionGastosId, null);
    assert.equal(await db.reposicionGastos.count(), 0);
    assert.equal(await db.estimacionCliente.count(), 0);
  });
});

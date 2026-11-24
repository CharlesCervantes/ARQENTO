import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { cerrarSemana, reabrirSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { guardarAvanceSemanal, cambiarEstatusAprobacionAvance, obtenerAvanceAcumuladoPorConcepto, obtenerAvanceSemanal } from "@/lib/server/control-de-obra/avance";
import { asignarConcepto, crearContratoContratista } from "@/lib/server/control-de-obra/estructura-contractual";
import { aprobarGasto } from "@/lib/server/control-de-obra/gastos";
import { materializarEstimacionHistorica } from "@/lib/server/control-de-obra/estimacion-cliente";
import { EMPRESA, PROYECTO, SEMANA, admin, baseLimpiaConDatos, crearGasto } from "./apoyo/base";

// Semanas históricas importadas (migración de obras desde Excel, noviembre
// 2026), contra PostgreSQL REAL de pruebas. Dos obras de la MISMA empresa
// comparten la semana 41: en PROYECTO esa semana es histórica importada; en
// OTRA_OBRA es un cierre normal. Comprueba que el bloqueo y el descuento del
// histórico solo afectan a la obra migrada. Cifras ficticias.

const OTRA_OBRA = "proyecto-int-otra";
const SEMANA_42 = "semana-int-42";
const C_MIGRADO = "concepto-migrado";
const C_COMPLETO = "concepto-migrado-completo";
const C_OTRA = "concepto-otra-obra";

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.create({ data: { id: OTRA_OBRA, empresaId: EMPRESA, nombre: "Otra obra (ficticia)" } });
  await db.semana.create({ data: { id: SEMANA_42, empresaId: EMPRESA, numero: 42, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 9, 12)), fechaFin: new Date(Date.UTC(2026, 9, 17)) } });
  for (const [proyectoId, conceptos] of [
    [PROYECTO, [[C_MIGRADO, 100, 30], [C_COMPLETO, 11, 11]]],
    [OTRA_OBRA, [[C_OTRA, 100, 30]]],
  ] as const) {
    const partida = await db.partida.create({ data: { proyectoId, nombre: "Albañilería" } });
    for (const [id, cantidad] of conceptos)
      await db.concepto.create({ data: { id, partidaId: partida.id, descripcion: `Muro ${id}`, unidad: "m2", cantidadContratada: cantidad, precioUnitarioContratista: 300, precioUnitarioContratistaPrivado: 400 } });
  }
  // Obra migrada: avance histórico de la semana 41 aprobado y cierre marcado como histórico importado (como lo deja el importador).
  for (const [conceptoId, cantidad] of [[C_MIGRADO, 30], [C_COMPLETO, 11]] as const)
    await db.avanceConcepto.create({ data: { empresaId: EMPRESA, conceptoId, semanaId: SEMANA, cantidadEjecutada: cantidad, estatusAprobacion: "APROBADO", registradoPorId: admin.id, aprobadoPorId: admin.id } });
  await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, cerradoPorId: admin.id, historicoImportado: true } });
});

async function contrato(proyectoId: string, nombre: string) {
  return crearContratoContratista(admin, proyectoId, { nombreNuevoContratista: nombre, descripcion: "Contrato de prueba" });
}

// Otra obra, misma semana 41, flujo normal: asignar, capturar 30, aprobar y cerrar.
async function otraObraCerradaNormal() {
  const k = await contrato(OTRA_OBRA, "Contratista otra obra");
  const a = await asignarConcepto(admin, k.id, { conceptoId: C_OTRA });
  await guardarAvanceSemanal(admin, OTRA_OBRA, { semanaId: SEMANA, filas: [{ conceptoId: C_OTRA, cantidadEjecutada: 30 }] });
  await cambiarEstatusAprobacionAvance(admin, C_OTRA, SEMANA, "APROBADO");
  await cerrarSemana(admin, OTRA_OBRA, SEMANA);
  return a;
}

describe("Semana histórica importada", () => {
  test("no se reabre en la obra migrada; la otra obra en la misma semana sí", async () => {
    await otraObraCerradaNormal();
    await assert.rejects(reabrirSemana(admin, PROYECTO, SEMANA, "prueba"), /histórica/);
    await assert.rejects(materializarEstimacionHistorica(admin, PROYECTO, SEMANA), /histórica/);
    const r = await reabrirSemana(admin, OTRA_OBRA, SEMANA, "corrección");
    assert.equal(r.estatus, "ABIERTA");
    const historico = await db.cierreSemanaProyecto.findUniqueOrThrow({ where: { proyectoId_semanaId: { proyectoId: PROYECTO, semanaId: SEMANA } } });
    assert.equal(historico.estatus, "CERRADA");
  });

  test("aprobar un gasto cobrable en la semana histórica no crea estimación; en la otra obra cerrada sí", async () => {
    await otraObraCerradaNormal();
    // La otra obra ya generó su estimación al cerrar; se borra para probar el camino de "semana cerrada sin estimación".
    const est = await db.estimacionCliente.findUniqueOrThrow({ where: { proyectoId_semanaId: { proyectoId: OTRA_OBRA, semanaId: SEMANA } } });
    await db.estimacionClienteCapa.deleteMany({ where: { estimacionClienteId: est.id } });
    await db.estimacionClienteConcepto.deleteMany({ where: { estimacionClienteId: est.id } });
    await db.estimacionCliente.delete({ where: { id: est.id } });

    await crearGasto("gasto-migrado", "1000.00", { pagador: null });
    await db.gastoObra.update({ where: { id: "gasto-migrado" }, data: { tratamientoCliente: "COBRABLE_EN_ESTIMACION" } });
    await aprobarGasto(admin, "gasto-migrado");
    assert.equal(await db.estimacionCliente.count({ where: { proyectoId: PROYECTO } }), 0);

    await crearGasto("gasto-otra", "1000.00", { pagador: null });
    await db.gastoObra.update({ where: { id: "gasto-otra" }, data: { proyectoId: OTRA_OBRA, tratamientoCliente: "COBRABLE_EN_ESTIMACION" } });
    await aprobarGasto(admin, "gasto-otra");
    assert.equal(await db.estimacionCliente.count({ where: { proyectoId: OTRA_OBRA, semanaId: SEMANA } }), 1);
  });

  test("asignar descuenta solo el histórico importado de la obra migrada", async () => {
    const aOtra = await otraObraCerradaNormal();
    assert.equal(Number(aOtra.cantidad), 100, "otra obra: cantidad completa, como siempre");

    const k = await contrato(PROYECTO, "Contratista migrado");
    const a = await asignarConcepto(admin, k.id, { conceptoId: C_MIGRADO });
    assert.equal(Number(a.cantidad), 70);
    assert.equal(Number(a.precioUnitarioContratista), 300);
    await assert.rejects(asignarConcepto(admin, k.id, { conceptoId: C_COMPLETO }), /ejecutó por completo/);

    const conceptos = await db.concepto.findMany({ where: { id: { in: [C_MIGRADO, C_OTRA] } }, orderBy: { id: "asc" } });
    for (const c of conceptos) {
      assert.equal(Number(c.cantidadContratada), 100);
      assert.equal(Number(c.precioUnitarioContratista), 300);
      assert.equal(Number(c.precioUnitarioContratistaPrivado), 400);
    }
  });

  test("Contratistas no atribuye el histórico al contratista asignado; la otra obra se ve igual que antes", async () => {
    await otraObraCerradaNormal();
    const k = await contrato(PROYECTO, "Contratista migrado");
    await asignarConcepto(admin, k.id, { conceptoId: C_MIGRADO });

    const migrado = (await obtenerAvanceAcumuladoPorConcepto(admin, PROYECTO)).get(C_MIGRADO)!;
    assert.deepEqual([migrado.acumulado, migrado.historicoSinAtribuir, migrado.cantidadTotal, migrado.pendiente], [0, 30, 70, 70]);

    const otra = (await obtenerAvanceAcumuladoPorConcepto(admin, OTRA_OBRA)).get(C_OTRA)!;
    assert.deepEqual([otra.acumulado, otra.historicoSinAtribuir, otra.cantidadTotal, otra.pendiente], [30, 0, 100, 70]);
  });

  test("avance nuevo: anterior = histórico, corte solo por lo nuevo, histórico intacto; la otra obra cierra la misma semana sin cambios", async () => {
    await otraObraCerradaNormal();
    const k = await contrato(PROYECTO, "Contratista migrado");
    await asignarConcepto(admin, k.id, { conceptoId: C_MIGRADO });
    const historicoAntes = await db.avanceConcepto.findMany({ where: { semanaId: SEMANA, concepto: { partida: { proyectoId: PROYECTO } } }, orderBy: { id: "asc" } });

    for (const proyectoId of [PROYECTO, OTRA_OBRA]) {
      const conceptoId = proyectoId === PROYECTO ? C_MIGRADO : C_OTRA;
      await guardarAvanceSemanal(admin, proyectoId, { semanaId: SEMANA_42, filas: [{ conceptoId, cantidadEjecutada: 10 }] });
      await cambiarEstatusAprobacionAvance(admin, conceptoId, SEMANA_42, "APROBADO");
      const semana = await db.semana.findUniqueOrThrow({ where: { id: SEMANA_42 } });
      const fila = (await obtenerAvanceSemanal(admin, proyectoId, semana)).flatMap((p) => p.conceptos).find((c) => c.id === conceptoId)!;
      assert.equal(fila.anterior, 30);
      await cerrarSemana(admin, proyectoId, SEMANA_42);
    }

    const cortes = await db.corteSemanal.findMany({ where: { proyectoId: PROYECTO }, include: { detalle: true } });
    assert.equal(cortes.length, 1);
    assert.equal(cortes[0].semanaId, SEMANA_42);
    assert.equal(Number(cortes[0].montoNeto), 3000);
    assert.equal(await db.movimientoSemanal.count({ where: { semanaId: SEMANA, beneficiarioProyecto: { proyectoId: PROYECTO } } }), 0);
    assert.equal(await db.estimacionCliente.count({ where: { proyectoId: PROYECTO, semanaId: SEMANA } }), 0);
    const est42 = await db.estimacionCliente.findUniqueOrThrow({ where: { proyectoId_semanaId: { proyectoId: PROYECTO, semanaId: SEMANA_42 } }, include: { detalle: true } });
    assert.equal(Number(est42.detalle.find((d) => d.conceptoId === C_MIGRADO)!.cantidadAnterior), 30);

    const historicoDespues = await db.avanceConcepto.findMany({ where: { semanaId: SEMANA, concepto: { partida: { proyectoId: PROYECTO } } }, orderBy: { id: "asc" } });
    assert.deepEqual(historicoDespues, historicoAntes);

    const cortesOtra = await db.corteSemanal.findMany({ where: { proyectoId: OTRA_OBRA }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(cortesOtra.map((c) => [c.semanaId, Number(c.montoNeto)]), [[SEMANA, 9000], [SEMANA_42, 3000]]);
  });

  test("cambiar el P.U. de una asignación no toca el concepto, otras asignaciones ni cortes ya generados", async () => {
    await otraObraCerradaNormal();
    const k = await contrato(PROYECTO, "Contratista migrado");
    const a = await asignarConcepto(admin, k.id, { conceptoId: C_MIGRADO });
    const corteOtraAntes = await db.corteSemanalConcepto.findMany({ orderBy: { id: "asc" } });
    const asignacionesAntes = await db.contratoConcepto.findMany({ where: { id: { not: a.id } }, orderBy: { id: "asc" } });

    // Mismo cambio que hace scripts/mantenimiento/ajustar-pu-asignacion.ts (solo P.U.).
    await db.contratoConcepto.update({ where: { id: a.id }, data: { precioUnitarioContratista: 280 } });

    const c = await db.concepto.findUniqueOrThrow({ where: { id: C_MIGRADO } });
    assert.deepEqual([Number(c.precioUnitarioContratista), Number(c.precioUnitarioContratistaPrivado), Number(c.cantidadContratada)], [300, 400, 100]);
    const a2 = await db.contratoConcepto.findUniqueOrThrow({ where: { id: a.id } });
    assert.deepEqual([Number(a2.cantidad), Number(a2.precioUnitarioContratista)], [70, 280]);
    assert.deepEqual(await db.contratoConcepto.findMany({ where: { id: { not: a.id } }, orderBy: { id: "asc" } }), asignacionesAntes);
    assert.deepEqual(await db.corteSemanalConcepto.findMany({ orderBy: { id: "asc" } }), corteOtraAntes);
  });
});

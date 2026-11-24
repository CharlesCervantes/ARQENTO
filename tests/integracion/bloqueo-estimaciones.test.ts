import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { cerrarSemana, obtenerResumenCierreSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { guardarAvanceSemanal, cambiarEstatusAprobacionAvance } from "@/lib/server/control-de-obra/avance";
import { asignarConcepto, crearContratoContratista } from "@/lib/server/control-de-obra/estructura-contractual";
import { aprobarGasto } from "@/lib/server/control-de-obra/gastos";
import { emitirEstimacion, materializarEstimacionHistorica, obtenerEstimacionSemanalEnVivo } from "@/lib/server/control-de-obra/estimacion-cliente";
import { EMPRESA, PROYECTO, SEMANA, admin, baseLimpiaConDatos, crearGasto } from "./apoyo/base";

// Bloqueo de cierre y estimaciones por obra, contra PostgreSQL REAL. Dos obras
// de la misma empresa comparten la semana: solo se bloquea PROYECTO.

const OTRA = "proyecto-int-sin-bloqueo";
const MOTIVO = "conciliación inicial pendiente (prueba)";
const BLOQUEO = /bloqueados: conciliación inicial/;
const concepto = (p: string) => `concepto-${p}`;
const bloquear = (motivo: string | null = MOTIVO) => db.proyecto.update({ where: { id: PROYECTO }, data: { motivoBloqueoEstimaciones: motivo } });
const conteos = async (proyectoId: string) => [
  await db.cierreSemanaProyecto.count({ where: { proyectoId } }),
  await db.estimacionCliente.count({ where: { proyectoId } }),
  await db.corteSemanal.count({ where: { proyectoId } }),
  await db.movimientoSemanal.count({ where: { beneficiarioProyecto: { proyectoId } } }),
];

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.create({ data: { id: OTRA, empresaId: EMPRESA, nombre: "Otra obra (ficticia)" } });
  for (const p of [PROYECTO, OTRA]) {
    const partida = await db.partida.create({ data: { proyectoId: p, nombre: "Albañilería" } });
    await db.concepto.create({ data: { id: concepto(p), partidaId: partida.id, descripcion: "Muro", unidad: "m2", cantidadContratada: 100, precioUnitarioContratista: 300, precioUnitarioContratistaPrivado: 400 } });
    const k = await crearContratoContratista(admin, p, { nombreNuevoContratista: `Contratista ${p}`, descripcion: "Prueba" });
    await asignarConcepto(admin, k.id, { conceptoId: concepto(p) });
  }
});
async function avance(p: string) {
  await guardarAvanceSemanal(admin, p, { semanaId: SEMANA, filas: [{ conceptoId: concepto(p), cantidadEjecutada: 10 }] });
  await cambiarEstatusAprobacionAvance(admin, concepto(p), SEMANA, "APROBADO");
}

describe("Bloqueo de cierre y estimaciones por obra", () => {
  test("no se cierra ni queda rastro; el avance sí se captura; la otra obra cierra normal", async () => {
    await bloquear();
    await avance(PROYECTO);
    await avance(OTRA);
    await assert.rejects(cerrarSemana(admin, PROYECTO, SEMANA), BLOQUEO);
    assert.deepEqual(await conteos(PROYECTO), [0, 0, 0, 0]);
    const r = await obtenerResumenCierreSemana(admin, PROYECTO, SEMANA);
    assert.equal(r.motivoBloqueo, MOTIVO);
    assert.equal(r.puedeCerrar, false);
    const semana = await db.semana.findUniqueOrThrow({ where: { id: SEMANA } });
    assert.equal((await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, semana)).capas.PRIVADO.length, 1, "la vista preliminar sigue disponible");

    await cerrarSemana(admin, OTRA, SEMANA);
    assert.deepEqual((await conteos(OTRA)).slice(0, 3), [1, 1, 1]);
    assert.equal((await obtenerResumenCierreSemana(admin, OTRA, SEMANA)).motivoBloqueo, null);
  });

  test("quitar el bloqueo permite cerrar y emitir", async () => {
    await bloquear();
    await avance(PROYECTO);
    await assert.rejects(cerrarSemana(admin, PROYECTO, SEMANA), BLOQUEO);
    await bloquear(null);
    await cerrarSemana(admin, PROYECTO, SEMANA);
    const capa = await db.estimacionClienteCapa.findFirstOrThrow({ where: { capa: "PRIVADO", estimacionCliente: { proyectoId: PROYECTO } } });
    await emitirEstimacion(admin, capa.id, false);
  });

  test("con borradores ya creados, no se emite ninguna capa ni se consume folio; la otra obra sí emite", async () => {
    for (const p of [PROYECTO, OTRA]) {
      await avance(p);
      await cerrarSemana(admin, p, SEMANA);
    }
    await bloquear();
    for (const capa of await db.estimacionClienteCapa.findMany({ where: { estimacionCliente: { proyectoId: PROYECTO } } })) {
      await assert.rejects(emitirEstimacion(admin, capa.id, false), BLOQUEO);
    }
    const p = await db.proyecto.findUniqueOrThrow({ where: { id: PROYECTO } });
    assert.deepEqual([p.ultimoNumeroEstimacionOperativo, p.ultimoNumeroEstimacionPrivado], [0, 0]);
    const otra = await db.estimacionClienteCapa.findFirstOrThrow({ where: { capa: "OPERATIVO", estimacionCliente: { proyectoId: OTRA } } });
    await emitirEstimacion(admin, otra.id, false);
  });

  test("semana cerrada sin estimación: no se materializa y aprobar un gasto no la crea", async () => {
    await avance(PROYECTO);
    await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, cerradoPorId: admin.id } });
    await bloquear();
    await assert.rejects(materializarEstimacionHistorica(admin, PROYECTO, SEMANA), BLOQUEO);
    const gasto = await crearGasto("gasto-bloqueo", "500");
    await db.gastoObra.update({ where: { id: gasto.id }, data: { tratamientoCliente: "COBRABLE_EN_ESTIMACION" } });
    await aprobarGasto(admin, gasto.id);
    assert.equal((await db.gastoObra.findUniqueOrThrow({ where: { id: gasto.id } })).estatus, "APROBADO");
    assert.equal(await db.estimacionCliente.count({ where: { proyectoId: PROYECTO } }), 0);
  });
});

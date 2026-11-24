import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { cerrarSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { guardarAvanceSemanal, cambiarEstatusAprobacionAvance, obtenerAvanceSemanal } from "@/lib/server/control-de-obra/avance";
import { asignarConcepto, crearContratoContratista } from "@/lib/server/control-de-obra/estructura-contractual";
import { obtenerEstimacionCliente, obtenerEstimacionSemanalEnVivo, emitirEstimacion } from "@/lib/server/control-de-obra/estimacion-cliente";
import { guardarEstimadoPrivado, eliminarEstimadoPrivado } from "@/lib/server/control-de-obra/estimado-privado";
import { calcularMontoContrato } from "@/lib/server/control-de-obra/financiero-cliente";
import { EMPRESA, PROYECTO, SEMANA, admin, supervisor, baseLimpiaConDatos } from "./apoyo/base";

// Cantidad estimada por capa (noviembre 2026), contra PostgreSQL REAL de
// pruebas. La semana 41 es histórica importada (estimado del Excel por capa);
// la 42 es una semana nueva. Una segunda obra sin histórico ni capturas
// comprueba que todo sigue igual que antes. Cifras ficticias.

const OTRA = "proyecto-int-otra";
const S42 = "semana-int-42";
const C = "concepto-estimado";
const C_OTRA = "concepto-otra";

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.create({ data: { id: OTRA, empresaId: EMPRESA, nombre: "Otra obra (ficticia)", esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 10 } });
  await db.proyecto.update({ where: { id: PROYECTO }, data: { esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 10 } });
  await db.semana.create({ data: { id: S42, empresaId: EMPRESA, numero: 42, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 9, 12)), fechaFin: new Date(Date.UTC(2026, 9, 17)) } });
  for (const [proyectoId, id] of [[PROYECTO, C], [OTRA, C_OTRA]] as const) {
    const partida = await db.partida.create({ data: { proyectoId, nombre: "Preliminares" } });
    await db.concepto.create({ data: { id, partidaId: partida.id, descripcion: `Trazo ${id}`, unidad: "m2", cantidadContratada: 100, precioUnitarioContratista: 40, precioUnitarioContratistaPrivado: 50, ...(proyectoId === PROYECTO ? { cantidadContratadaPrivado: 300 } : {}) } });
  }
  // Semana 41 histórica en PROYECTO: físico 10; el Excel estimó General 10 ($400) y Privado 30 ($1,500.50, importe fijo).
  await db.avanceConcepto.create({ data: { empresaId: EMPRESA, conceptoId: C, semanaId: SEMANA, cantidadEjecutada: 10, estatusAprobacion: "APROBADO", registradoPorId: admin.id, aprobadoPorId: admin.id } });
  await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, cerradoPorId: admin.id, historicoImportado: true } });
  for (const [capa, cantidad, importeBase] of [["OPERATIVO", 10, 400], ["PRIVADO", 30, 1500.5]] as const)
    await db.estimadoCapaConcepto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, conceptoId: C, semanaId: SEMANA, capa, cantidad, importeBase, origen: "Excel (ficticio)", historicoImportado: true, registradoPorId: admin.id } });
});

async function operarS42(proyectoId: string, conceptoId: string, cantidad: number) {
  const k = await crearContratoContratista(admin, proyectoId, { nombreNuevoContratista: `Contratista ${proyectoId}`, descripcion: "Contrato de prueba" });
  await asignarConcepto(admin, k.id, { conceptoId });
  await guardarAvanceSemanal(admin, proyectoId, { semanaId: S42, filas: [{ conceptoId, cantidadEjecutada: cantidad }] });
  await cambiarEstatusAprobacionAvance(admin, conceptoId, S42, "APROBADO");
}
const semana42 = () => db.semana.findUniqueOrThrow({ where: { id: S42 } });

describe("Cantidad estimada por capa", () => {
  test("obra sin histórico ni capturas: ambas capas estiman el físico, igual que antes", async () => {
    await operarS42(OTRA, C_OTRA, 20);
    const vivo = await obtenerEstimacionSemanalEnVivo(admin, OTRA, await semana42());
    const [g, p] = [vivo.capas.OPERATIVO[0], vivo.capas.PRIVADO[0]];
    assert.deepEqual([g.cantidadAnterior, g.cantidadEstaSemana, g.cantidadContratada], [0, 20, 100]);
    assert.deepEqual([p.cantidadAnterior, p.cantidadEstaSemana, p.cantidadContratada], [0, 20, 100]);
    assert.equal(Math.round(g.importeEstaSemana * 100) / 100, 880); // 20 × 40 × 1.10
    assert.equal(Math.round(vivo.preliminar.PRIVADO.totales.subtotal * 100) / 100, 1000); // 20 × 50
  });

  test("semana nueva tras el histórico: anterior por capa con importes del Excel; físico y asignación sin cambios", async () => {
    await operarS42(PROYECTO, C, 20);
    const asignacion = await db.contratoConcepto.findFirstOrThrow({ where: { conceptoId: C } });
    assert.equal(Number(asignacion.cantidad), 90, "asignable = 100 − 10 físico histórico");

    const vivo = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana42());
    const [g, p] = [vivo.capas.OPERATIVO[0], vivo.capas.PRIVADO[0]];
    assert.deepEqual([g.cantidadAnterior, g.cantidadEstaSemana, g.cantidadContratada], [10, 20, 100]);
    assert.deepEqual([p.cantidadAnterior, p.cantidadEstaSemana, p.cantidadContratada], [30, 20, 300]);
    assert.equal(Math.round(p.importeAcumuladoBase * 100) / 100, 2500.5, "1,500.50 del Excel + 20 × 50");

    const fisico = (await obtenerAvanceSemanal(admin, PROYECTO, await semana42())).flatMap((x) => x.conceptos).find((x) => x.id === C)!;
    assert.equal(fisico.anterior, 10);
  });

  test("captura privada: cambia solo lo que estima el Privado; no toca físico, cortes ni General", async () => {
    await operarS42(PROYECTO, C, 20);
    await assert.rejects(guardarEstimadoPrivado(supervisor, PROYECTO, S42, { conceptoId: C, cantidad: 25, importeBase: null, motivo: "prueba" }), /permiso/i);
    await assert.rejects(guardarEstimadoPrivado(admin, PROYECTO, SEMANA, { conceptoId: C, cantidad: 25, importeBase: null, motivo: "prueba" }), /histórica/);
    await guardarEstimadoPrivado(admin, PROYECTO, S42, { conceptoId: C, cantidad: 25, importeBase: null, motivo: "Valoración privada" });

    await cerrarSemana(admin, PROYECTO, S42);
    const corte = await db.corteSemanal.findFirstOrThrow({ where: { proyectoId: PROYECTO, semanaId: S42 } });
    assert.equal(Number(corte.montoNeto), 800, "corte = 20 físico × 40");
    assert.equal(Number((await db.avanceConcepto.findFirstOrThrow({ where: { conceptoId: C, semanaId: S42 } })).cantidadEjecutada), 20);

    const general = await obtenerEstimacionCliente(admin, PROYECTO, S42, "OPERATIVO");
    const privado = await obtenerEstimacionCliente(admin, PROYECTO, S42, "PRIVADO");
    assert.equal(general!.filas[0].cantidadEstaSemana, 20);
    assert.equal(privado!.filas[0].cantidadEstaSemana, 25);
    assert.equal(privado!.estimacion.subtotal, 1250);

    for (const capa of await db.estimacionClienteCapa.findMany({ where: { estimacionCliente: { proyectoId: PROYECTO, semanaId: S42 } } }))
      await emitirEstimacion(admin, capa.id, false);
    const emitida = await obtenerEstimacionCliente(admin, PROYECTO, S42, "PRIVADO");
    assert.deepEqual([emitida!.filas[0].cantidadAnterior, emitida!.filas[0].cantidadEstaSemana, emitida!.filas[0].cantidadContratada], [30, 25, 300]);
    const fila = await db.estimadoCapaConcepto.findFirstOrThrow({ where: { conceptoId: C, semanaId: S42 } });
    await assert.rejects(eliminarEstimadoPrivado(admin, PROYECTO, fila.id), /emitida/);
  });

  test("una captura privada en 0 excluye el concepto solo del Privado", async () => {
    await operarS42(PROYECTO, C, 20);
    await guardarEstimadoPrivado(admin, PROYECTO, S42, { conceptoId: C, cantidad: 0, importeBase: null, motivo: "Ya estimado en otro documento" });
    const vivo = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana42());
    assert.equal(vivo.capas.OPERATIVO.length, 1);
    assert.equal(vivo.capas.PRIVADO.length, 0);
  });

  test("monto de contrato privado usa la cantidad presupuestada del Privado", async () => {
    const pct = { utilidad: null, administracion: 10, administracionPrivado: null };
    assert.equal(Math.round(await calcularMontoContrato(PROYECTO, "ADMINISTRACION", pct, "privado")), 16500); // 300 × 50 × 1.10
    assert.equal(Math.round(await calcularMontoContrato(OTRA, "ADMINISTRACION", pct, "privado")), 5500); // 100 × 50 × 1.10
  });
});

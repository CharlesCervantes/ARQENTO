import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { asignarConcepto, crearContratoContratista, quitarConceptoAsignado } from "@/lib/server/control-de-obra/estructura-contractual";
import { cerrarSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { cambiarEstatusAprobacionAvance, guardarAvanceSemanal } from "@/lib/server/control-de-obra/avance";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, PROYECTO, PROYECTO_AJENO, SEMANA, admin, adminAjeno, baseLimpiaConDatos, supervisor } from "./apoyo/base";

const C = "concepto-asig";
const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
let contrato = "";
after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "P" } });
  await db.concepto.create({ data: { id: C, partidaId: partida.id, descripcion: "Muro", unidad: "M2", cantidadContratada: 10, precioUnitarioContratista: 100 } });
  contrato = (await crearContratoContratista(admin, PROYECTO, { nombreNuevoContratista: "K", descripcion: "x" })).id;
});
const avance = async (aprobar: boolean) => {
  await guardarAvanceSemanal(sup, PROYECTO, { semanaId: SEMANA, filas: [{ conceptoId: C, cantidadEjecutada: 1 }] });
  if (aprobar) await cambiarEstatusAprobacionAvance(admin, C, SEMANA, "APROBADO");
};

describe("Supervisor asigna y quita conceptos", () => {
  test("asigna y quita en su obra, conserva el avance y deja bitácora", async () => {
    const a = await asignarConcepto(sup, contrato, { conceptoId: C });
    assert.deepEqual([Number(a.cantidad), Number(a.precioUnitarioContratista)], [10, 100]);
    await avance(false);
    await quitarConceptoAsignado(sup, PROYECTO, a.id);
    assert.equal(await db.contratoConcepto.count(), 0);
    assert.equal(await db.avanceConcepto.count({ where: { conceptoId: C } }), 1);
    const log = await db.registroAuditoria.findMany({ where: { entidad: "ContratoConcepto", entidadId: a.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(log.map((l) => [l.accion, l.usuarioId]), [["CREAR", sup.id], ["ELIMINAR", sup.id]]);
    await asignarConcepto(sup, contrato, { conceptoId: C });
  });

  test("con avance aprobado no lo quita el Supervisor; Administración sí", async () => {
    const a = await asignarConcepto(sup, contrato, { conceptoId: C });
    await avance(true);
    await assert.rejects(quitarConceptoAsignado(sup, PROYECTO, a.id), /avance aprobado/);
    await quitarConceptoAsignado(admin, PROYECTO, a.id);
    await assert.rejects(cerrarSemana(admin, PROYECTO, SEMANA), "sin contratista la semana no cierra");
  });

  test("avance solo histórico importado no impide que el Supervisor lo quite", async () => {
    await avance(true);
    await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, cerradoPorId: admin.id, historicoImportado: true } });
    const a = await asignarConcepto(sup, contrato, { conceptoId: C });
    await quitarConceptoAsignado(sup, PROYECTO, a.id);
  });

  test("ya en un corte no se quita, ni Administración", async () => {
    const a = await asignarConcepto(sup, contrato, { conceptoId: C });
    await avance(true);
    await cerrarSemana(admin, PROYECTO, SEMANA);
    for (const u of [sup, admin]) await assert.rejects(quitarConceptoAsignado(u, PROYECTO, a.id), /corte/);
    assert.equal(await db.contratoConcepto.count(), 1);
  });

  test("sin acceso a la obra, otra empresa u otro proyecto: nada; crear contratos sigue vedado", async () => {
    const a = await asignarConcepto(admin, contrato, { conceptoId: C });
    await assert.rejects(quitarConceptoAsignado(adminAjeno, PROYECTO, a.id));
    await assert.rejects(quitarConceptoAsignado(adminAjeno, PROYECTO_AJENO, a.id));
    await assert.rejects(crearContratoContratista(sup, PROYECTO, { nombreNuevoContratista: "Z" }));
    await db.accesoObra.deleteMany();
    await assert.rejects(quitarConceptoAsignado(sup, PROYECTO, a.id));
    await quitarConceptoAsignado(admin, PROYECTO, a.id);
    await assert.rejects(asignarConcepto(sup, contrato, { conceptoId: C }));
  });
});

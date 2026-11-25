import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { cambiarEstatusAprobacionAvance, guardarAvanceSemanal, obtenerAvanceSemanal } from "@/lib/server/control-de-obra/avance";
import { asignarConcepto, crearContratoContratista } from "@/lib/server/control-de-obra/estructura-contractual";
import { obtenerControlContractual } from "@/lib/server/control-de-obra/financiero-cliente";
import { cerrarSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, PROYECTO, SEMANA, admin, baseLimpiaConDatos, supervisor } from "./apoyo/base";

const C = "concepto-exc", PREVIA = "semana-previa";
const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.update({ where: { id: PROYECTO }, data: { esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 10, porcentajeAdministracionPrivadoDefault: 10 } });
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "P" } });
  await db.concepto.create({ data: { id: C, partidaId: partida.id, descripcion: "Muro", unidad: "M2", cantidadContratada: 10, precioUnitarioContratista: 100 } });
});
const guardar = (q: number) => guardarAvanceSemanal(sup, PROYECTO, { semanaId: SEMANA, filas: [{ conceptoId: C, cantidadEjecutada: q, montoEjecutado: q * 100 }] });
const aprobar = (confirmado?: number, u = admin) => cambiarEstatusAprobacionAvance(u, C, SEMANA, "APROBADO", confirmado);
const concepto = () => db.concepto.findUniqueOrThrow({ where: { id: C } });
const visto = async () => (await obtenerAvanceSemanal(sup, PROYECTO, await db.semana.findUniqueOrThrow({ where: { id: SEMANA } }))).flatMap((p) => p.conceptos).find((x) => x.id === C)!;
const asignar = async () => asignarConcepto(admin, (await crearContratoContratista(admin, PROYECTO, { nombreNuevoContratista: "K", descripcion: "x" })).id, { conceptoId: C });
const historico = async (q: number) => {
  await db.semana.create({ data: { id: PREVIA, empresaId: EMPRESA, numero: 40, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 8, 28)), fechaFin: new Date(Date.UTC(2026, 9, 3)) } });
  await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: PREVIA, cerradoPorId: admin.id, historicoImportado: true } });
  await db.avanceConcepto.create({ data: { empresaId: EMPRESA, conceptoId: C, semanaId: PREVIA, cantidadEjecutada: q, estatusAprobacion: "APROBADO", registradoPorId: admin.id } });
};

describe("Avance que excede lo contratado", () => {
  test("se guarda pendiente sin mover el contrato; rechazar tampoco lo mueve", async () => {
    await guardar(12.5);
    const v = await visto();
    assert.deepEqual([v.estaSemana, v.estatusAprobacion, v.contratadoSiSeAprueba], [12.5, "PENDIENTE", 12.5]);
    await cambiarEstatusAprobacionAvance(admin, C, SEMANA, "RECHAZADO");
    assert.equal(Number((await concepto()).cantidadContratada), 10);
    assert.equal((await visto()).contratadoSiSeAprueba, null);
  });

  test("aprobar exige confirmar la cifra vigente; nunca el Supervisor ni Master", async () => {
    await guardar(12);
    await assert.rejects(aprobar(), /excede/);
    await guardar(13);
    await assert.rejects(aprobar(12), /excede/, "cambió mientras se revisaba");
    await assert.rejects(aprobar(13, sup));
    const master = { ...usuarioDePrueba({ rol: "MASTER", empresaId: EMPRESA }), id: admin.id };
    await assert.rejects(aprobar(13, master));
    assert.equal(Number((await concepto()).cantidadContratada), 10);
    assert.equal((await visto()).estatusAprobacion, "PENDIENTE");
  });

  test("aprobado: sube General, contrato del contratista, control contractual y cierra; con bitácora", async () => {
    const a = await asignar();
    await guardar(12.5);
    await aprobar(12.5);
    assert.equal(Number((await concepto()).cantidadContratada), 12.5);
    assert.equal(Number((await db.contratoConcepto.findUniqueOrThrow({ where: { id: a.id } })).cantidad), 12.5);
    for (const capa of ["operativo", "privado"] as const) {
      assert.equal((await obtenerControlContractual(admin, PROYECTO, capa)).avanceContractual.montoContrato.toFixed(2), "1375.00");
    }
    const v = await visto();
    assert.deepEqual([v.cantidadTotal, v.pendiente, v.avancePorcentaje, v.contratadoSiSeAprueba], [12.5, 0, 100, null]);
    const log = await db.registroAuditoria.findMany({ where: { accion: "EDITAR", entidad: { in: ["Concepto", "ContratoConcepto"] } } });
    assert.deepEqual(log.map((l) => l.entidad).sort(), ["Concepto", "ContratoConcepto"]);
    await cerrarSemana(admin, PROYECTO, SEMANA);
    assert.equal(Number((await db.corteSemanal.findFirstOrThrow()).montoNeto), 1250);
  });

  test("el histórico importado cuenta para el excedente pero no entra al contrato del contratista", async () => {
    await historico(8);
    const a = await asignar();
    assert.equal(Number(a.cantidad), 2);
    await guardar(5);
    assert.equal((await visto()).contratadoSiSeAprueba, 13);
    await aprobar(13);
    assert.equal(Number((await concepto()).cantidadContratada), 13);
    assert.equal(Number((await db.contratoConcepto.findUniqueOrThrow({ where: { id: a.id } })).cantidad), 5);
  });

  test("Privado con cantidad propia: sube solo si su estimado la rebasa y nunca baja", async () => {
    await db.concepto.update({ where: { id: C }, data: { cantidadContratadaPrivado: 20 } });
    await guardar(12);
    await aprobar(12);
    assert.equal(Number((await concepto()).cantidadContratadaPrivado), 20);
    await guardar(25);
    await aprobar(25);
    assert.equal(Number((await concepto()).cantidadContratadaPrivado), 25);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "ConceptoPrivado" } }), 1);
    await guardar(6);
    await aprobar();
    assert.equal(Number((await concepto()).cantidadContratada), 25, "solo aumenta");
  });

  test("sin excedente se aprueba como siempre y el límite exacto no es excedente", async () => {
    await guardar(10);
    assert.equal((await visto()).contratadoSiSeAprueba, null);
    await aprobar();
    assert.equal(Number((await concepto()).cantidadContratada), 10);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "Concepto", accion: "EDITAR" } }), 0);
  });
});

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { asignarConcepto, crearContratoContratista, editarConceptoEstructural } from "@/lib/server/control-de-obra/estructura-contractual";
import { EMPRESA, PROYECTO, admin, baseLimpiaConDatos } from "./apoyo/base";

const C = "concepto-sigue";
const DATOS = { descripcion: "Detalles", unidad: "JOR", precioUnitarioContratista: 850 };
after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.update({ where: { id: PROYECTO }, data: { esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 10 } });
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "P" } });
  await db.concepto.create({ data: { id: C, partidaId: partida.id, ...DATOS, cantidadContratada: 8 } });
});
const editar = (cantidadContratada: number) => editarConceptoEstructural(admin, C, { ...DATOS, cantidadContratada });
const asignar = async () => asignarConcepto(admin, (await crearContratoContratista(admin, PROYECTO, { nombreNuevoContratista: "Nelson", descripcion: "x" })).id, { conceptoId: C });
const contrato = async () => Number((await db.contratoConcepto.findUniqueOrThrow({ where: { conceptoId: C } })).cantidad);

describe("Aumentar cantidad en Contrato General", () => {
  test("el contrato del contratista sube lo mismo, con bitácora", async () => {
    await asignar();
    assert.equal(await contrato(), 8);
    await editar(12);
    assert.equal(await contrato(), 12);
    const cc = await db.contratoConcepto.findUniqueOrThrow({ where: { conceptoId: C } });
    const log = await db.registroAuditoria.findFirstOrThrow({ where: { entidad: "ContratoConcepto", entidadId: cc.id, accion: "EDITAR" } });
    assert.deepEqual([log.valorAnterior, (log.valorNuevo as { cantidad: number }).cantidad, log.empresaId], [{ cantidad: 8 }, 12, EMPRESA]);
    assert.equal(Number(cc.precioUnitarioContratista), 850, "el P.U. no cambia");
  });

  test("conserva la diferencia si el contrato era menor a propósito", async () => {
    await asignar();
    await db.contratoConcepto.update({ where: { conceptoId: C }, data: { cantidad: 5 } });
    await editar(10.5);
    assert.equal(await contrato(), 7.5);
  });

  test("bajar la cantidad o cambiar otro dato no toca el contrato", async () => {
    await asignar();
    await editar(6);
    assert.equal(await contrato(), 8);
    await editarConceptoEstructural(admin, C, { ...DATOS, descripcion: "Otro", cantidadContratada: 6 });
    assert.equal(await contrato(), 8);
  });

  test("sin contratista asignado solo cambia el Contrato General", async () => {
    await editar(12);
    assert.equal(Number((await db.concepto.findUniqueOrThrow({ where: { id: C } })).cantidadContratada), 12);
    assert.equal(await db.contratoConcepto.count(), 0);
  });
});

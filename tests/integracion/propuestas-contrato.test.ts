import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { aprobarPropuesta, hayPropuestasPendientes, obtenerPropuestas, proponerConcepto, proponerPartida, rechazarPropuesta, retirarPropuesta } from "@/lib/server/control-de-obra/propuestas-contrato";
import { crearConcepto, crearPartida, eliminarPartida, obtenerPartidasProyecto } from "@/lib/server/control-de-obra/estructura-contractual";
import { obtenerControlContractual } from "@/lib/server/control-de-obra/financiero-cliente";
import { eliminarProyecto } from "@/lib/server/control-de-obra/proyectos";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, PROYECTO, PROYECTO_AJENO, admin, adminAjeno, baseLimpiaConDatos, supervisor } from "./apoyo/base";

const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
const master = { ...usuarioDePrueba({ rol: "MASTER", empresaId: EMPRESA }), id: admin.id };
const DATOS = { descripcion: "Muro", unidad: "M2", cantidadContratada: 10, precioUnitarioContratista: 100, precioUnitarioMateriales: 50 };
let partida = "";
after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.update({ where: { id: PROYECTO }, data: { esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 10 } });
  partida = (await crearPartida(admin, PROYECTO, { nombre: "Obra civil" })).id;
});
const contrato = async () => (await obtenerControlContractual(admin, PROYECTO, "operativo")).avanceContractual.montoContrato.toFixed(2);
const pendientes = async () => (await obtenerPropuestas(admin, PROYECTO)).map((p) => p.descripcion);

describe("Propuestas de Contrato General", () => {
  test("pendiente no toca el contrato; aprobada crea el concepto con los mismos datos y bitácora", async () => {
    const p = await proponerConcepto(sup, PROYECTO, { partidaId: partida }, DATOS);
    assert.equal(p.precioUnitarioMateriales, null, "materiales no aplica a Administración");
    assert.equal(await contrato(), "0.00");
    assert.equal((await obtenerPartidasProyecto(sup, PROYECTO))[0].conceptos.length, 0);
    assert.equal(await hayPropuestasPendientes({ proyectoId: PROYECTO }), true);
    const { id } = await aprobarPropuesta(admin, PROYECTO, p.id);
    const c = await db.concepto.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([c.partidaId, c.descripcion, c.unidad, Number(c.cantidadContratada), Number(c.precioUnitarioContratista), c.estatus], [partida, "Muro", "M2", 10, 100, "ACTIVO"]);
    assert.equal(await contrato(), "1100.00");
    const log = await db.registroAuditoria.findMany({ where: { entidadId: { in: [p.id, id] } } });
    assert.deepEqual(log.map((l) => l.entidad + l.accion).sort(), ["ConceptoCREAR", "PropuestaContratoCONFIRMAR", "PropuestaContratoCREAR"]);
    await assert.rejects(aprobarPropuesta(admin, PROYECTO, p.id), /ya fue resuelta/);
    assert.equal(await hayPropuestasPendientes({ empresaId: EMPRESA }), false);
  });

  test("dos aprobaciones a la vez crean un solo concepto", async () => {
    const p = await proponerConcepto(sup, PROYECTO, { partidaId: partida }, DATOS);
    const r = await Promise.allSettled([aprobarPropuesta(admin, PROYECTO, p.id), aprobarPropuesta(admin, PROYECTO, p.id)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(await db.concepto.count(), 1);
  });

  test("partida nueva con conceptos: aprobar un concepto aprueba la partida; los demás siguen pendientes", async () => {
    const pa = await proponerPartida(sup, PROYECTO, { nombre: "Jardín" });
    const c1 = await proponerConcepto(sup, PROYECTO, { propuestaPartidaId: pa.id }, DATOS);
    const c2 = await proponerConcepto(sup, PROYECTO, { propuestaPartidaId: pa.id }, { ...DATOS, descripcion: "Pasto" });
    await aprobarPropuesta(admin, PROYECTO, c1.id);
    const jardin = await db.partida.findFirstOrThrow({ where: { nombre: "Jardín" } });
    assert.deepEqual(await pendientes(), ["Pasto"]);
    await aprobarPropuesta(admin, PROYECTO, c2.id);
    assert.equal(await db.concepto.count({ where: { partidaId: jardin.id } }), 2);
    assert.equal(await db.partida.count({ where: { nombre: "Jardín" } }), 1);
  });

  test("rechazar exige motivo, arrastra los conceptos y se lo muestra a quien propuso", async () => {
    const pa = await proponerPartida(sup, PROYECTO, { nombre: "Jardín" });
    const c = await proponerConcepto(sup, PROYECTO, { propuestaPartidaId: pa.id }, DATOS);
    await assert.rejects(rechazarPropuesta(admin, PROYECTO, pa.id, " "), /motivo/);
    await rechazarPropuesta(admin, PROYECTO, pa.id, "No procede");
    assert.deepEqual(await pendientes(), []);
    assert.deepEqual((await obtenerPropuestas(sup, PROYECTO)).map((x) => [x.estatus, x.motivo]), [["RECHAZADA", "No procede"], ["RECHAZADA", "No procede"]]);
    await assert.rejects(aprobarPropuesta(admin, PROYECTO, c.id));
    assert.equal(await db.partida.count(), 1);
  });

  test("retirar: solo lo propio y pendiente", async () => {
    const p = await proponerConcepto(sup, PROYECTO, { partidaId: partida }, DATOS);
    await assert.rejects(retirarPropuesta(admin, PROYECTO, p.id));
    await retirarPropuesta(sup, PROYECTO, p.id);
    await assert.rejects(retirarPropuesta(sup, PROYECTO, p.id), /ya fue resuelta/);
    assert.deepEqual(await obtenerPropuestas(sup, PROYECTO), []);
  });

  test("permisos: Supervisor no aprueba ni crea directo; Master y otra empresa tampoco; sin acceso, nada", async () => {
    const p = await proponerConcepto(sup, PROYECTO, { partidaId: partida }, DATOS);
    for (const u of [sup, master, adminAjeno]) {
      await assert.rejects(aprobarPropuesta(u, PROYECTO, p.id));
      await assert.rejects(rechazarPropuesta(u, PROYECTO, p.id, "x"));
    }
    await assert.rejects(aprobarPropuesta(adminAjeno, PROYECTO_AJENO, p.id));
    await assert.rejects(crearPartida(sup, PROYECTO, { nombre: "x" }));
    await assert.rejects(crearConcepto(sup, partida, DATOS));
    await assert.rejects(proponerConcepto(sup, PROYECTO, { partidaId: "otra" }, DATOS));
    await assert.rejects(proponerConcepto(sup, PROYECTO, { partidaId: partida }, { ...DATOS, cantidadContratada: 0 }));
    await db.accesoObra.deleteMany();
    await assert.rejects(proponerPartida(sup, PROYECTO, { nombre: "x" }));
    await assert.rejects(obtenerPropuestas(sup, PROYECTO));
  });

  test("partida eliminada: el concepto propuesto no se aprueba; eliminar la obra limpia sus propuestas", async () => {
    const p = await proponerConcepto(sup, PROYECTO, { partidaId: partida }, DATOS);
    await eliminarPartida(admin, partida, "prueba");
    await assert.rejects(aprobarPropuesta(admin, PROYECTO, p.id), /ya no existe/);
    await eliminarProyecto(admin, PROYECTO);
    assert.equal(await db.propuestaContrato.count(), 0);
  });
});

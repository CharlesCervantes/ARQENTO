import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProyecto } from "@/lib/server/control-de-obra/proyectos";
import { crearPartida, editarPartida, obtenerPartidasProyecto } from "@/lib/server/control-de-obra/estructura-contractual";
import { aprobarPropuesta, proponerPartida } from "@/lib/server/control-de-obra/propuestas-contrato";
import { ORDEN_PARTIDA_ADITIVAS, esPartidaAditivas, ordenDePartida } from "@/lib/control-de-obra/partida-aditivas";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, PROYECTO, admin, baseLimpiaConDatos, supervisor } from "./apoyo/base";

const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
const nombres = async (proyectoId: string) => (await obtenerPartidasProyecto(admin, proyectoId)).map((p) => p.nombre);

after(() => db.$disconnect());
beforeEach(() => baseLimpiaConDatos());

describe("Partida ADITIVAS", () => {
  test("reconoce Aditiva, Aditivas y ADITIVA 01; no otras palabras", () => {
    for (const n of ["ADITIVAS", "Aditiva", " aditivas ", "ADITIVA 01", "Aditiva-2", "ADITÍVAS"]) assert.equal(esPartidaAditivas(n), true, n);
    for (const n of ["ADITIVO", "Aditivamente", "Obra aditiva", "Deductivas"]) assert.equal(esPartidaAditivas(n), false, n);
    assert.equal(ordenDePartida("Aditivas", 3), ORDEN_PARTIDA_ADITIVAS);
    assert.equal(ordenDePartida("Obra civil", 5_000_000), ORDEN_PARTIDA_ADITIVAS - 1);
  });

  test("la obra nueva nace con ADITIVAS, con bitácora, y queda al final", async () => {
    const obra = await crearProyecto(admin, { nombre: "Obra nueva", tipo: "FORMAL", esquemaContractual: "ADMINISTRACION" });
    assert.deepEqual(await nombres(obra.id), ["ADITIVAS"]);
    await crearPartida(admin, obra.id, { nombre: "Preliminares" });
    await crearPartida(admin, obra.id, { nombre: "Albañilería", orden: 50 });
    assert.deepEqual(await nombres(obra.id), ["Preliminares", "Albañilería", "ADITIVAS"]);
    const aditivas = await db.partida.findFirstOrThrow({ where: { proyectoId: obra.id, nombre: "ADITIVAS" } });
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "Partida", entidadId: aditivas.id, accion: "CREAR" } }), 1);
  });

  test("la obra momentánea también la lleva", async () => {
    const obra = await crearProyecto(admin, { nombre: "Momentánea", tipo: "MOMENTANEA" });
    assert.deepEqual(await nombres(obra.id), ["ADITIVAS"]);
  });

  test("editar no la saca del final; la propuesta aprobada del Supervisor queda arriba", async () => {
    const aditivas = await crearPartida(admin, PROYECTO, { nombre: "ADITIVAS" });
    await editarPartida(admin, aditivas.id, { nombre: "ADITIVAS", orden: 0, icono: null, color: null });
    const p = await proponerPartida(sup, PROYECTO, { nombre: "Jardín" });
    await aprobarPropuesta(admin, PROYECTO, p.id);
    assert.deepEqual(await nombres(PROYECTO), ["Jardín", "ADITIVAS"]);
  });

  test("una partida «Aditiva» creada a mano en una obra existente también va al final", async () => {
    await crearPartida(admin, PROYECTO, { nombre: "Aditiva" });
    await crearPartida(admin, PROYECTO, { nombre: "Acabados" });
    assert.deepEqual(await nombres(PROYECTO), ["Acabados", "Aditiva"]);
  });
});

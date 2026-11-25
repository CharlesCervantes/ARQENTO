import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { guardarAvanceSemanal, obtenerAvanceSemanal } from "@/lib/server/control-de-obra/avance";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, PROYECTO, SEMANA, baseLimpiaConDatos, supervisor } from "./apoyo/base";

const C = "concepto-monto";
const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "P" } });
  await db.concepto.create({ data: { id: C, partidaId: partida.id, descripcion: "Muro", unidad: "M2", cantidadContratada: 2000, precioUnitarioContratista: 280 } });
});
const guardar = (cantidadEjecutada: number, montoEjecutado?: number) => guardarAvanceSemanal(sup, PROYECTO, { semanaId: SEMANA, filas: [{ conceptoId: C, cantidadEjecutada, montoEjecutado }] });

test("el Supervisor captura por monto un concepto sin contratista: monto exacto y pendiente de aprobar", async () => {
  await guardar(35.714, 10000);
  const semana = await db.semana.findUniqueOrThrow({ where: { id: SEMANA } });
  const c = (await obtenerAvanceSemanal(sup, PROYECTO, semana)).flatMap((p) => p.conceptos).find((x) => x.id === C)!;
  assert.deepEqual([c.estaSemana, c.montoEstaSemana, c.estatusAprobacion, c.precioUnitarioContratista, c.precioUnitarioContratistaContratado], [35.714, 10000, "PENDIENTE", 280, null]);
});

test("rechaza montos que dan cantidad cero", async () => {
  await assert.rejects(guardar(0, 0.1), /muy pequeño/);
  assert.equal(await db.avanceConcepto.count({ where: { conceptoId: C } }), 0);
});

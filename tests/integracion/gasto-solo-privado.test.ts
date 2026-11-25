import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { cerrarSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { guardarAvanceSemanal, cambiarEstatusAprobacionAvance } from "@/lib/server/control-de-obra/avance";
import { asignarConcepto, crearContratoContratista } from "@/lib/server/control-de-obra/estructura-contractual";
import { aprobarGasto, crearGasto as crearGastoServicio, editarGasto, obtenerGastos } from "@/lib/server/control-de-obra/gastos";
import { autorizarOrdenCompra, crearOrdenCompra, generarGastoDesdeOrdenCompra, obtenerOrdenesCompra } from "@/lib/server/control-de-obra/ordenes-compra";
import { emitirEstimacion, obtenerEstimacionCliente, obtenerEstimacionSemanalEnVivo } from "@/lib/server/control-de-obra/estimacion-cliente";
import { usuarioDePrueba } from "../helpers/usuarios";
import { BENEFICIARIO, EMPRESA, PROYECTO, SEMANA, admin, baseLimpiaConDatos, crearGasto, supervisor } from "./apoyo/base";

// Gasto cobrable solo en la estimación privada, contra PostgreSQL REAL. Cifras
// de referencia: vigilancia $7,500 en ambas capas y material $69,259.03 solo
// en Privado, administración 12 %.

const VELADOR = "concepto-velador";
const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
const sinVista = { ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA, vistaPrivadaActiva: false }), id: admin.id };
const datosGasto = (extra: Record<string, unknown> = {}) => ({
  fecha: "2026-10-06", descripcion: "Material", categoria: "MATERIAL", monto: 1000, metodoPago: "TRANSFERENCIA", quienPagoModo: "EMPRESA", ...extra,
});
const datosOC = (precioUnitario: number) => ({
  proveedorBeneficiarioId: BENEFICIARIO, fecha: "2026-10-06", metodoPago: "TRANSFERENCIA", tratamientoCliente: "COBRABLE_SOLO_PRIVADO",
  detalle: [{ concepto: "Material", unidad: "lote", cantidad: 1, precioUnitario }],
});
const semana = () => db.semana.findUniqueOrThrow({ where: { id: SEMANA } });

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.update({
    where: { id: PROYECTO },
    data: { esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 12, porcentajeAdministracionPrivadoDefault: 12, ultimoNumeroEstimacionOperativo: 41, ultimoNumeroEstimacionPrivado: 41 },
  });
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "Aditiva" } });
  await db.concepto.create({ data: { id: VELADOR, partidaId: partida.id, descripcion: "Velador", unidad: "SEMANA", cantidadContratada: 19, precioUnitarioContratista: 7500 } });
  const k = await crearContratoContratista(admin, PROYECTO, { nombreNuevoContratista: "Contratista velador", descripcion: "Prueba" });
  await asignarConcepto(admin, k.id, { conceptoId: VELADOR });
});

async function vigilancia() {
  await guardarAvanceSemanal(admin, PROYECTO, { semanaId: SEMANA, filas: [{ conceptoId: VELADOR, cantidadEjecutada: 1 }] });
  await cambiarEstatusAprobacionAvance(admin, VELADOR, SEMANA, "APROBADO");
}
async function cerrarYEmitir() {
  await cerrarSemana(admin, PROYECTO, SEMANA);
  for (const c of await db.estimacionClienteCapa.findMany({ where: { estimacionCliente: { proyectoId: PROYECTO, semanaId: SEMANA } } })) {
    await emitirEstimacion(admin, c.id, false);
  }
  return {
    g: (await obtenerEstimacionCliente(admin, PROYECTO, SEMANA, "OPERATIVO"))!,
    p: (await obtenerEstimacionCliente(admin, PROYECTO, SEMANA, "PRIVADO"))!,
  };
}

describe("Gasto cobrable solo en Privado", () => {
  test("estimación 42: material por OC y vigilancia; General $8,400.00 y Privado $85,970.11", async () => {
    await vigilancia();
    const oc = await crearOrdenCompra(admin, PROYECTO, SEMANA, datosOC(69259.03));
    await autorizarOrdenCompra(admin, oc.id);
    const mov = await db.movimientoSemanal.findMany({ where: { ordenCompra: { id: oc.id } } });
    assert.deepEqual(mov.map((m) => m.estatusPago), ["PENDIENTE_PAGO"], "queda por pagar, una sola vez");
    await generarGastoDesdeOrdenCompra(admin, oc.id, { fecha: "2026-10-06", categoria: "MATERIAL", metodoPago: "TRANSFERENCIA" });

    const vivo = await obtenerEstimacionSemanalEnVivo(admin, PROYECTO, await semana());
    assert.equal(vivo.preliminar.OPERATIVO.gastos.length, 0);
    assert.equal(vivo.preliminar.PRIVADO.gastos.length, 1);
    assert.equal(vivo.preliminar.OPERATIVO.totales.total.toFixed(2), "8400.00");
    assert.equal(vivo.preliminar.PRIVADO.totales.total.toFixed(2), "85970.11");

    const { g, p } = await cerrarYEmitir();
    assert.deepEqual([g.estimacion.numero, p.estimacion.numero], [42, 42]);
    assert.equal(g.estimacion.total, 8400);
    assert.equal(g.gastos.length, 0);
    assert.equal(p.estimacion.total, 85970.11);
    assert.equal(p.gastos[0].monto, 69259.03);
    const gasto = await db.gastoObra.findFirstOrThrow({ where: { ordenCompraId: oc.id } });
    assert.equal(gasto.incluidoEnCapaOperativoId, null);
    const cortes = await db.corteSemanal.findMany({ where: { proyectoId: PROYECTO } });
    assert.deepEqual(cortes.map((c) => Number(c.montoNeto)), [7500], "velador por pagar una sola vez");
    assert.equal(await db.movimientoFinancieroCliente.count({ where: { proyectoId: PROYECTO } }), 0, "emitir no registra cobro");
  });

  test("un gasto cobrable normal sigue entrando a las dos capas", async () => {
    await vigilancia();
    await crearGasto("g-normal", "500");
    await db.gastoObra.update({ where: { id: "g-normal" }, data: { tratamientoCliente: "COBRABLE_EN_ESTIMACION" } });
    await aprobarGasto(admin, "g-normal");
    const { g, p } = await cerrarYEmitir();
    assert.deepEqual([g.gastos.length, p.gastos.length], [1, 1]);
  });

  test("aprobado con las capas ya en borrador: se reclama solo en Privado", async () => {
    await vigilancia();
    await cerrarSemana(admin, PROYECTO, SEMANA);
    const creado = await crearGastoServicio(admin, PROYECTO, SEMANA, datosGasto({ tratamientoCliente: "COBRABLE_SOLO_PRIVADO" }));
    await aprobarGasto(admin, creado.id);
    const r = await db.gastoObra.findUniqueOrThrow({ where: { id: creado.id } });
    assert.equal(r.incluidoEnCapaOperativoId, null);
    assert.ok(r.incluidoEnCapaPrivadoId);
  });

  test("sin acceso a Privado: no se elige, no se ve y editar lo conserva", async () => {
    for (const u of [sup, sinVista]) {
      await assert.rejects(crearGastoServicio(u, PROYECTO, SEMANA, datosGasto({ tratamientoCliente: "COBRABLE_SOLO_PRIVADO" })));
    }
    await assert.rejects(crearOrdenCompra(sup, PROYECTO, SEMANA, datosOC(1)));
    const creado = await crearGastoServicio(admin, PROYECTO, SEMANA, datosGasto({ tratamientoCliente: "COBRABLE_SOLO_PRIVADO" }));
    await crearOrdenCompra(admin, PROYECTO, SEMANA, datosOC(1));
    for (const u of [sup, sinVista]) {
      const visto = JSON.stringify([await obtenerGastos(u, PROYECTO, SEMANA), await obtenerOrdenesCompra(u, PROYECTO, SEMANA)]);
      assert.ok(!visto.includes("SOLO_PRIVADO"));
    }
    await editarGasto(sinVista, creado.id, datosGasto({ descripcion: "Material corregido" }));
    const r = await db.gastoObra.findUniqueOrThrow({ where: { id: creado.id } });
    assert.equal(r.tratamientoCliente, "COBRABLE_SOLO_PRIVADO");
    assert.equal(r.descripcion, "Material corregido");
    await editarGasto(admin, creado.id, datosGasto({ tratamientoCliente: "NO_COBRABLE" }));
    assert.equal((await db.gastoObra.findUniqueOrThrow({ where: { id: creado.id } })).tratamientoCliente, "NO_COBRABLE");
  });
});

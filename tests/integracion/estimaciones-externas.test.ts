import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { obtenerDetalleEstimacionExterna, obtenerEstimacionesExternas } from "@/lib/server/control-de-obra/estimaciones-externas";
import { obtenerControlContractual, obtenerHistorialEstimacionesCliente } from "@/lib/server/control-de-obra/financiero-cliente";
import { obtenerDatosDocumentoEstimacion } from "@/lib/server/control-de-obra/documentos-estimacion";
import { cerrarSemana } from "@/lib/server/control-de-obra/cierre-semana";
import { emitirEstimacion } from "@/lib/server/control-de-obra/estimacion-cliente";
import { guardarAvanceSemanal, cambiarEstatusAprobacionAvance } from "@/lib/server/control-de-obra/avance";
import { asignarConcepto, crearContratoContratista } from "@/lib/server/control-de-obra/estructura-contractual";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, PROYECTO, SEMANA, admin, adminAjeno, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Estimaciones emitidas antes de ARQENTO, contra PostgreSQL REAL. Cifras ficticias.

const S42 = "semana-int-42", C = "concepto-ext";
const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA }), id: supervisor.id };
const sinVista = { ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA, vistaPrivadaActiva: false }), id: admin.id };

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.update({ where: { id: PROYECTO }, data: { esquemaContractual: "ADMINISTRACION", porcentajeAdministracionDefault: 12, porcentajeAdministracionPrivadoDefault: 12, ultimoNumeroEstimacionOperativo: 1, ultimoNumeroEstimacionPrivado: 1 } });
  await db.semana.create({ data: { id: S42, empresaId: EMPRESA, numero: 42, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 9, 12)), fechaFin: new Date(Date.UTC(2026, 9, 17)) } });
  const partida = await db.partida.create({ data: { proyectoId: PROYECTO, nombre: "Aditiva" } });
  await db.concepto.create({ data: { id: C, partidaId: partida.id, descripcion: "Velador", unidad: "SEMANA", cantidadContratada: 10, precioUnitarioContratista: 1000 } });
  await db.cierreSemanaProyecto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, cerradoPorId: admin.id, historicoImportado: true } });
  await db.avanceConcepto.create({ data: { empresaId: EMPRESA, conceptoId: C, semanaId: SEMANA, cantidadEjecutada: 1, estatusAprobacion: "APROBADO", registradoPorId: admin.id } });
  for (const [capa, importe, iva] of [["OPERATIVO", 1500, 240], ["PRIVADO", 2000.55, 0]] as const) {
    await db.estimacionExterna.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, capa, numero: 1, importe, iva, importeNeto: importe + iva, fechaPago: "12 febrero 2026", concepto: "Velador", origen: "prueba" } });
    await db.estimadoCapaConcepto.create({ data: { empresaId: EMPRESA, proyectoId: PROYECTO, conceptoId: C, semanaId: SEMANA, capa, cantidad: 1, importeBase: 1000, origen: "x", historicoImportado: true, registradoPorId: admin.id } });
  }
});

describe("Estimaciones emitidas antes de ARQENTO", () => {
  test("cuentan en estimado, saldo y avance; nunca en cobrado ni por cobrar", async () => {
    const g = await obtenerControlContractual(admin, PROYECTO, "operativo");
    assert.equal(g.avanceContractual.montoContrato.toFixed(2), "11200.00");
    assert.equal(g.avanceContractual.trabajosEstimados, 1500, "antes de IVA, igual que el contrato");
    assert.equal(g.avanceContractual.saldoPorEjercer.toFixed(2), "9700.00");
    assert.deepEqual([g.financiero!.totalCubierto, g.financiero!.pendienteFinancieroReal], [0, 0]);
    const p = await obtenerControlContractual(admin, PROYECTO, "privado");
    assert.equal(p.avanceContractual.trabajosEstimados, 2000.55);
    assert.equal((await obtenerHistorialEstimacionesCliente(admin, PROYECTO, "operativo")).length, 0, "no es una estimación cobrable");
  });

  test("detalle de la semana: importe de la hoja y conceptos cargados", async () => {
    const d = (await obtenerDetalleEstimacionExterna(admin, PROYECTO, SEMANA, "operativo"))!;
    assert.deepEqual([d.numero, d.importe, d.iva, d.importeNeto, d.subtotalConceptos], [1, 1500, 240, 1740, 1000]);
    assert.equal(d.partidas[0].conceptos[0].cantidad, 1);
    assert.equal(await obtenerDetalleEstimacionExterna(admin, PROYECTO, S42, "operativo"), null);
  });

  test("permisos: Privado solo con vista privada; fecha de pago solo con permiso financiero; otra empresa nada", async () => {
    for (const u of [sup, sinVista]) await assert.rejects(obtenerEstimacionesExternas(u, PROYECTO, "privado"));
    const [f] = await obtenerEstimacionesExternas(sup, PROYECTO, "operativo");
    assert.equal(f.fechaPago, null);
    assert.equal((await obtenerEstimacionesExternas(admin, PROYECTO, "operativo"))[0].fechaPago, "12 febrero 2026");
    await assert.rejects(obtenerEstimacionesExternas(adminAjeno, PROYECTO, "operativo"));
  });

  test("la siguiente estimación continúa el folio; su documento trae las anteriores y el acumulado", async () => {
    const k = await crearContratoContratista(admin, PROYECTO, { nombreNuevoContratista: "Velador", descripcion: "x" });
    await asignarConcepto(admin, k.id, { conceptoId: C });
    await guardarAvanceSemanal(admin, PROYECTO, { semanaId: S42, filas: [{ conceptoId: C, cantidadEjecutada: 1 }] });
    await cambiarEstatusAprobacionAvance(admin, C, S42, "APROBADO");
    await cerrarSemana(admin, PROYECTO, S42);
    const capa = await db.estimacionClienteCapa.findFirstOrThrow({ where: { capa: "OPERATIVO", estimacionCliente: { proyectoId: PROYECTO } } });
    await emitirEstimacion(admin, capa.id, false);
    const doc = await obtenerDatosDocumentoEstimacion(admin, capa.id, "operativo");
    assert.equal(doc.numero, 2);
    assert.deepEqual(doc.externas.map((e) => [e.numero, e.importe, e.iva, e.importeNeto]), [[1, 1500, 240, 1740]]);
    assert.equal(doc.controlContractual.avanceContractual.trabajosEstimados.toFixed(2), "2620.00"); // 1,500 + 1,120
    assert.equal(doc.controlContractual.financiero!.pendienteFinancieroReal.toFixed(2), "1120.00");
    assert.equal(doc.historial.length, 1);
  });

  test("una obra sin externas no cambia; la base exige neto = importe + IVA y un número por capa", async () => {
    await db.estimacionExterna.deleteMany();
    const g = await obtenerControlContractual(admin, PROYECTO, "operativo");
    assert.deepEqual([g.avanceContractual.trabajosEstimados, g.avanceContractual.estimadoExterno], [0, 0]);
    assert.deepEqual(await obtenerEstimacionesExternas(admin, PROYECTO, "operativo"), []);
    const base = { empresaId: EMPRESA, proyectoId: PROYECTO, semanaId: SEMANA, capa: "OPERATIVO" as const, origen: "x" };
    await assert.rejects(db.estimacionExterna.create({ data: { ...base, numero: 9, importe: 10, iva: 1, importeNeto: 10 } }));
    await db.estimacionExterna.create({ data: { ...base, numero: 9, importe: 10, iva: 1, importeNeto: 11 } });
    await assert.rejects(db.estimacionExterna.create({ data: { ...base, semanaId: S42, numero: 9, importe: 10, iva: 0, importeNeto: 10 } }));
  });
});

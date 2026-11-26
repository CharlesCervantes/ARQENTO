import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { aprobarGasto } from "@/lib/server/control-de-obra/gastos";
import {
  generarRecibo,
  obtenerDatosPdfRecibo,
  obtenerDatosPdfRecibosSemana,
  obtenerDetalleCorte,
  obtenerHistorialCortesPorProyecto,
  obtenerRefEvidenciaRecibo,
  registrarEvidenciaRecibo,
} from "@/lib/server/control-de-obra/recibos";
import { obtenerReporteSemana } from "@/lib/server/reporte-general/queries";
import { BENEFICIARIO, EMPRESA, PROYECTO, SEMANA, admin, baseLimpiaConDatos, crearGasto, supervisor } from "./apoyo/base";

// Noviembre 2026 (decisión de Charles): el Supervisor ve las estimaciones de
// sus contratistas y descarga sus recibos — solo de sus obras —, pero no
// genera recibos ni sube el firmado. Y en Reporte General, Administración
// muestra el concepto, y una reposición muestra de qué gastos es.
// Contra PostgreSQL real; datos ficticios.

after(() => db.$disconnect());
beforeEach(() => baseLimpiaConDatos());

const OBRA_SIN_ACCESO = "obra-sin-acceso";

// Corte de contratista de la semana de prueba, con su movimiento en Reporte General.
async function corte(id: string, proyectoId = PROYECTO, monto = "12000.00") {
  const contratista = await db.beneficiario.upsert({
    where: { id: `contratista-${id}` },
    update: {},
    create: { id: `contratista-${id}`, empresaId: EMPRESA, tipo: "CONTRATISTA", nombre: `Contratista ${id} (ficticio)` },
  });
  const bp = await db.beneficiarioProyecto.upsert({
    where: { beneficiarioId_proyectoId: { beneficiarioId: contratista.id, proyectoId } },
    update: {},
    create: { beneficiarioId: contratista.id, proyectoId },
  });
  const cierre = await db.cierreSemanaProyecto.upsert({
    where: { proyectoId_semanaId: { proyectoId, semanaId: SEMANA } },
    update: {},
    create: { empresaId: EMPRESA, proyectoId, semanaId: SEMANA, estatus: "CERRADA", cerradoPorId: admin.id },
  });
  const mov = await db.movimientoSemanal.create({
    data: { beneficiarioProyectoId: bp.id, semanaId: SEMANA, origen: "CORTE_CONTRATISTA", montoFinSemana: monto, estatusAprobacion: "APROBADO", estatusPago: "PENDIENTE_PAGO", enviadoPorId: admin.id, aprobadoPorId: admin.id },
  });
  return db.corteSemanal.create({
    data: {
      id,
      empresaId: EMPRESA,
      proyectoId,
      semanaId: SEMANA,
      cierreSemanaProyectoId: cierre.id,
      beneficiarioProyectoId: bp.id,
      numero: 1,
      montoBruto: monto,
      montoNeto: monto,
      movimientoSemanalId: mov.id,
      generadoPorId: admin.id,
    },
  });
}

describe("Supervisor: recibos y estimaciones de sus obras", () => {
  test("ve el historial y el detalle, y descarga el recibo de su obra", async () => {
    await corte("c1");
    const recibo = await generarRecibo(admin, "c1");

    const historial = await obtenerHistorialCortesPorProyecto(supervisor, PROYECTO);
    assert.equal([...historial.values()].flat().length, 1);
    const detalle = await obtenerDetalleCorte(supervisor, "c1");
    assert.equal(detalle.reciboVigente?.id, recibo.id);
    const pdf = await obtenerDatosPdfRecibo(supervisor, recibo.id);
    assert.equal(pdf.folio, recibo.folio);
    assert.equal(await obtenerRefEvidenciaRecibo(supervisor, recibo.id), null);
  });

  test("no ve recibos ni cortes de una obra que no tiene asignada", async () => {
    await db.proyecto.create({ data: { id: OBRA_SIN_ACCESO, empresaId: EMPRESA, nombre: "Obra sin acceso (ficticia)" } });
    await corte("c-otra", OBRA_SIN_ACCESO);
    const recibo = await generarRecibo(admin, "c-otra");
    await assert.rejects(obtenerDatosPdfRecibo(supervisor, recibo.id), /no existe|no encontrad/i);
    await assert.rejects(obtenerRefEvidenciaRecibo(supervisor, recibo.id), /no existe|no encontrad/i);
    await assert.rejects(obtenerDetalleCorte(supervisor, "c-otra"), /no existe|no encontrad/i);
    await assert.rejects(obtenerHistorialCortesPorProyecto(supervisor, OBRA_SIN_ACCESO));
  });

  test("no genera recibos ni sube el firmado", async () => {
    await corte("c1");
    await assert.rejects(generarRecibo(supervisor, "c1"), (e: Error) => e.name === "SinPermisoError" || /permiso/i.test(e.message));
    const recibo = await generarRecibo(admin, "c1");
    await assert.rejects(
      registrarEvidenciaRecibo(supervisor, recibo.id, { archivoEvidenciaRef: "x", archivoEvidenciaNombre: "x.pdf", fechaRecepcion: "2026-10-09" }),
      (e: Error) => e.name === "SinPermisoError" || /permiso/i.test(e.message)
    );
  });

  test("«Descargar todos»: el Supervisor solo baja los que ya existen; nunca crea folios", async () => {
    await corte("c1");
    await assert.rejects(obtenerDatosPdfRecibosSemana(supervisor, PROYECTO, SEMANA), /Todavía no hay recibos generados/);
    assert.equal(await db.reciboPago.count(), 0);

    await generarRecibo(admin, "c1");
    const otro = await corte("c2", PROYECTO, "500.00");
    const datos = await obtenerDatosPdfRecibosSemana(supervisor, PROYECTO, SEMANA);
    assert.equal(datos.length, 1, "solo el que ya tenía recibo");
    assert.equal(await db.reciboPago.count({ where: { corteSemanalId: otro.id } }), 0);

    // Administración sí genera el faltante al descargar, como siempre.
    assert.equal((await obtenerDatosPdfRecibosSemana(admin, PROYECTO, SEMANA)).length, 2);
  });
});

describe("Reporte General: concepto de Administración y de qué es cada reposición", () => {
  test("la reposición trae sus gastos y la fila de Administración su concepto", async () => {
    await crearGasto("g1", "850.00");
    await crearGasto("g2", "150.00");
    await aprobarGasto(admin, "g1");
    await aprobarGasto(admin, "g2");
    await db.beneficiarioProyecto.update({
      where: { beneficiarioId_proyectoId: { beneficiarioId: BENEFICIARIO, proyectoId: PROYECTO } },
      data: { concepto: "Residente de obra" },
    });

    const [obra] = (await obtenerReporteSemana(EMPRESA, SEMANA)).filter((o) => o.proyecto.id === PROYECTO);
    const fila = obra.administracion.find((f) => f.origen === "REPOSICION_GASTOS");
    assert.ok(fila?.reposicion);
    assert.equal(fila.concepto, "Residente de obra");
    assert.deepEqual(
      fila.reposicion.gastos.map((g) => [g.descripcion, g.monto]).sort(),
      [["Gasto ficticio g1", 850], ["Gasto ficticio g2", 150]]
    );
  });
});

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { aprobarGasto, cancelarGastoAprobado, crearGasto as capturarGasto, editarGasto } from "@/lib/server/control-de-obra/gastos";
import { registrarAbonoReposicion } from "@/lib/server/control-de-obra/reposiciones";
import { liquidarMovimiento } from "@/lib/server/reporte-general/liquidar";
import { BENEFICIARIO, EMPRESA, MEDIO_BANCO, PROYECTO, SEMANA, admin, adminAjeno, baseLimpiaConDatos, crearGasto, supervisor } from "./apoyo/base";

// Noviembre 2026 (decisión de Charles):
// 1) El Supervisor solo registra gastos que pagó él: el servidor ignora lo
//    que mande el formulario sobre «quién pagó».
// 2) Administrador/Director pueden cancelar un gasto YA APROBADO con motivo:
//    sale de su reposición sin pagar (y se recalcula el movimiento), se
//    desliga de capas en borrador, y se niega si ya hay dinero pagado o una
//    estimación emitida. Contra PostgreSQL real; datos ficticios.

after(() => db.$disconnect());
beforeEach(() => baseLimpiaConDatos());

const datos = (extra: Record<string, unknown> = {}) => ({
  fecha: "2026-10-06",
  descripcion: "Gasolina",
  categoria: "MATERIAL",
  monto: 850,
  metodoPago: "EFECTIVO",
  quienPagoModo: "EMPRESA",
  ...extra,
});

const vincularSupervisor = () => db.beneficiario.update({ where: { id: BENEFICIARIO }, data: { usuarioId: supervisor.id } });

async function aprobadoEnReposicion(id: string, monto: string) {
  await crearGasto(id, monto);
  await aprobarGasto(admin, id);
  return db.gastoObra.findUniqueOrThrow({ where: { id }, include: { reposicion: true } });
}

describe("Supervisor: sus gastos siempre los pagó él", () => {
  test("aunque el formulario diga «la empresa» u «otra persona», queda a su nombre", async () => {
    await vincularSupervisor();
    const otro = await db.beneficiario.create({ data: { empresaId: EMPRESA, tipo: "ADMINISTRACION", nombre: "Otra persona (ficticia)" } });
    const a = await capturarGasto(supervisor, PROYECTO, SEMANA, datos({ quienPagoModo: "EMPRESA" }));
    const b = await capturarGasto(supervisor, PROYECTO, SEMANA, datos({ quienPagoModo: "OTRO", pagadorBeneficiarioId: otro.id }));
    assert.equal(a.pagadorBeneficiarioId, BENEFICIARIO);
    assert.equal(b.pagadorBeneficiarioId, BENEFICIARIO);
    // Al editar el suyo tampoco puede cambiarlo.
    const editado = await editarGasto(supervisor, a.id, datos({ quienPagoModo: "EMPRESA", descripcion: "Gasolina corregida" }));
    assert.equal(editado.pagadorBeneficiarioId, BENEFICIARIO);
  });

  test("sin beneficiario vinculado no puede registrar el gasto, con un aviso claro", async () => {
    await assert.rejects(capturarGasto(supervisor, PROYECTO, SEMANA, datos()), /Pide a un Administrador que lo vincule/);
    assert.equal(await db.gastoObra.count(), 0);
  });

  test("Administrador sigue eligiendo: la empresa o un beneficiario", async () => {
    const empresa = await capturarGasto(admin, PROYECTO, SEMANA, datos({ quienPagoModo: "EMPRESA" }));
    const otro = await capturarGasto(admin, PROYECTO, SEMANA, datos({ quienPagoModo: "OTRO", pagadorBeneficiarioId: BENEFICIARIO }));
    assert.equal(empresa.pagadorBeneficiarioId, null);
    assert.equal(otro.pagadorBeneficiarioId, BENEFICIARIO);
  });
});

describe("Cancelar un gasto aprobado", () => {
  test("gasto pagado por la empresa (caso CIENEGA): queda Cancelado con motivo y conserva quién lo aprobó", async () => {
    await crearGasto("g1", "850.00", { pagador: null });
    await aprobarGasto(admin, "g1");
    const g = await cancelarGastoAprobado(admin, "g1", "  No se indicó quién lo pagó  ");
    assert.equal(g.estatus, "CANCELADO");
    assert.equal(g.motivoRechazo, "No se indicó quién lo pagó");
    assert.equal(g.revisadoPorId, admin.id);
    const bitacora = await db.registroAuditoria.findFirst({ where: { entidad: "GastoObra", entidadId: "g1", accion: "CAMBIAR_ESTATUS" } });
    assert.ok(bitacora, "queda en la bitácora");
    // Idempotente: cancelar dos veces no falla ni duplica bitácora.
    await cancelarGastoAprobado(admin, "g1", "otra vez");
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "GastoObra", entidadId: "g1", accion: "CAMBIAR_ESTATUS" } }), 1);
  });

  test("sale de su reposición sin pagar y el pago pendiente se recalcula", async () => {
    await aprobadoEnReposicion("g1", "6000.00");
    const g2 = await aprobadoEnReposicion("g2", "4000.00");
    await cancelarGastoAprobado(admin, "g2", "Capturado dos veces");

    const rep = await db.reposicionGastos.findUniqueOrThrow({ where: { id: g2.reposicionGastosId! }, include: { gastos: true, movimientoSemanal: true } });
    assert.deepEqual(rep.gastos.map((x) => x.id), ["g1"]);
    assert.equal(rep.estatus, "APROBADA");
    assert.equal(Number(rep.movimientoSemanal!.montoFinSemana), 6000);
    assert.equal(rep.movimientoSemanal!.estatusAprobacion, "APROBADO");
    assert.equal(rep.movimientoSemanal!.estatusPago, "PENDIENTE_PAGO");
    assert.equal((await db.gastoObra.findUniqueOrThrow({ where: { id: "g2" } })).reposicionGastosId, null);
  });

  test("si era el único gasto, la reposición se rechaza y su movimiento deja de contar; otro gasto abre una nueva", async () => {
    const g1 = await aprobadoEnReposicion("g1", "850.00");
    await cancelarGastoAprobado(admin, "g1", "Error de captura");

    const rep = await db.reposicionGastos.findUniqueOrThrow({ where: { id: g1.reposicionGastosId! }, include: { movimientoSemanal: true } });
    assert.equal(rep.estatus, "RECHAZADA");
    assert.equal(rep.movimientoSemanal!.estatusAprobacion, "CANCELADO");
    assert.equal(rep.movimientoSemanal!.estatusPago, "SIN_MOVIMIENTO");
    assert.equal(Number(rep.movimientoSemanal!.montoFinSemana), 0);

    // Se vuelve a subir bien y se aprueba: reposición nueva, con folio propio.
    const nuevo = await aprobadoEnReposicion("g2", "850.00");
    assert.notEqual(nuevo.reposicionGastosId, g1.reposicionGastosId);
  });

  test("se niega si la reposición ya tiene abonos o ya se liquidó, sin cambiar nada", async () => {
    const g1 = await aprobadoEnReposicion("g1", "1000.00");
    await registrarAbonoReposicion(admin, g1.reposicionGastosId!, { monto: 100, fecha: "2026-10-08", metodoPago: "EFECTIVO" });
    await assert.rejects(cancelarGastoAprobado(admin, "g1", "Error"), /ya tiene pagos registrados/);
    assert.equal((await db.gastoObra.findUniqueOrThrow({ where: { id: "g1" } })).estatus, "APROBADO");

    const g2 = await aprobadoEnReposicion("g2", "500.00");
    const rep2 = await db.reposicionGastos.findUniqueOrThrow({ where: { id: g2.reposicionGastosId! } });
    await liquidarMovimiento(admin, rep2.movimientoSemanalId!, { fechaPago: "2026-10-09", metodoPago: "TRANSFERENCIA", referenciaPago: "SPEI", notasPago: "" });
    await assert.rejects(cancelarGastoAprobado(admin, "g2", "Error"), /ya tiene pagos registrados/);
    const g2Despues = await db.gastoObra.findUniqueOrThrow({ where: { id: "g2" } });
    assert.equal(g2Despues.estatus, "APROBADO");
    assert.equal(g2Despues.reposicionGastosId, g2.reposicionGastosId);
  });

  test("estimación al cliente: en borrador se desliga; emitida se niega", async () => {
    const estimacion = (estatus: "BORRADOR" | "EMITIDA") =>
      db.estimacionCliente.create({
        data: {
          empresaId: EMPRESA,
          proyectoId: PROYECTO,
          semanaId: SEMANA,
          generadoPorId: admin.id,
          capas: {
            create: [{ capa: "OPERATIVO", estatus, generadoPorId: admin.id, ...(estatus === "EMITIDA" ? { numero: 1, total: 1, emitidoPorId: admin.id, emitidoEn: new Date() } : {}) }],
          },
        },
        include: { capas: true },
      });

    const borrador = await estimacion("BORRADOR");
    await crearGasto("g1", "300.00", { pagador: null, estatus: "APROBADO" });
    await db.gastoObra.update({ where: { id: "g1" }, data: { incluidoEnCapaOperativoId: borrador.capas[0].id } });
    const cancelado = await cancelarGastoAprobado(admin, "g1", "Error");
    assert.equal(cancelado.incluidoEnCapaOperativoId, null);

    await db.estimacionClienteCapa.update({ where: { id: borrador.capas[0].id }, data: { estatus: "EMITIDA", numero: 1, total: 1, emitidoPorId: admin.id, emitidoEn: new Date() } });
    await crearGasto("g2", "300.00", { pagador: null, estatus: "APROBADO" });
    await db.gastoObra.update({ where: { id: "g2" }, data: { incluidoEnCapaOperativoId: borrador.capas[0].id } });
    await assert.rejects(cancelarGastoAprobado(admin, "g2", "Error"), /estimación emitida/);
    assert.equal((await db.gastoObra.findUniqueOrThrow({ where: { id: "g2" } })).estatus, "APROBADO");
  });

  test("se niega si Contabilidad ya registró su pago", async () => {
    await crearGasto("g1", "300.00", { pagador: null, estatus: "APROBADO" });
    await db.egreso.create({ data: { empresaId: EMPRESA, gastoObraId: "g1", registradoPorId: admin.id, medioFinancieroId: MEDIO_BANCO, fechaPago: new Date() } });
    await assert.rejects(cancelarGastoAprobado(admin, "g1", "Error"), /Contabilidad ya registró el pago/);
  });

  test("permisos, estatus y motivo", async () => {
    await crearGasto("g1", "300.00", { pagador: null, estatus: "APROBADO" });
    await crearGasto("g2", "300.00");
    await assert.rejects(cancelarGastoAprobado(supervisor, "g1", "Error"), (e: Error) => e.name === "SinPermisoError" || /permiso/i.test(e.message));
    await assert.rejects(cancelarGastoAprobado(adminAjeno, "g1", "Error"), /no existe|no encontrad/i);
    await assert.rejects(cancelarGastoAprobado(admin, "g2", "Error"), /recházalo/);
    await assert.rejects(cancelarGastoAprobado(admin, "g1", "   "), /motivo/i);
    assert.equal((await db.gastoObra.findUniqueOrThrow({ where: { id: "g1" } })).estatus, "APROBADO");
  });
});

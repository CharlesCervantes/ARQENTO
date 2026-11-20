import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta, obtenerCotizacionVenta, listarCotizacionesVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import {
  anularCompraComercial,
  confirmarCompraComercial,
  crearCompraComercial,
  crearProveedorComercial,
  guardarBorradorCompra,
} from "@/lib/server/comercializacion/compras";
import {
  anularMovimientoCuenta,
  definirCondicionesCuenta,
  detalleCuentaDeCompra,
  detalleCuentaDeOrden,
  hoyDeEmpresa,
  indicadoresCuentasEmpresa,
  obtenerComprobanteMovimiento,
  registrarMovimientoCuenta,
  resumenFinancieroOrden,
} from "@/lib/server/comercializacion/cuentas";
import { ConflictoEdicionError } from "@/lib/server/comercializacion/cotizaciones";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, sinInterbloqueos, supervisor } from "./apoyo/base";

// Comercialización B5 contra PostgreSQL REAL: cuentas por cobrar/pagar,
// condiciones, cuotas, cobros/pagos con aplicación, anulaciones, vencimientos,
// concurrencia e incorporación de documentos anteriores. Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b5", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);

const HOY = hoyNegocio();
const dias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let LOTE: string; // exento, $12,000 → total exacto
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-b5-${++n}-${Date.now()}`;

async function ordenDe12000(u: UsuarioSesion = admin) {
  const { id } = await crearCotizacionVenta(
    u,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia B5", vendedorId: vendedor.id, fecha: dias(-30), vigenciaHasta: dias(10), partidas: [{ productoId: LOTE, cantidad: "1" }] },
    clave()
  );
  await emitirCotizacionVenta(u, id, 1);
  const ov = await registrarAceptacionCotizacion(u, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pv = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
  return { cotizacionId: id, ordenId: ov.ordenId, partidaVentaId: pv.id };
}

async function compraDe12000(ordenId: string, partidaVentaId: string) {
  const { id } = await crearCompraComercial(admin, ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, {
    proveedorId: PROV,
    fecha: HOY,
    partidas: [{ partidaVentaId, cantidad: "1", costoUnitario: "12000", tratamientoImpuesto: "SIN_IVA" }],
  });
  await confirmarCompraComercial(admin, id, 2);
  return id;
}

const cuentaDeOrden = (ordenVentaId: string) => db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId } });
const cuentaDeCompra = (compraId: string) => db.cuentaComercial.findFirstOrThrow({ where: { compraId } });
const credito = (cuotas: [string, string][]) => ({ modalidad: "CREDITO", cuotas: cuotas.map(([fechaVencimiento, importe]) => ({ fechaVencimiento, importe })) });
const mov = (importe: string, extra: Record<string, unknown> = {}) => ({ importe, fecha: HOY, metodo: "TRANSFERENCIA", referencia: "SPEI ficticio", ...extra });

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B5", email: "director-b5@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  LOTE = (await crearProductoComercial(admin, { codigo: "LOTE", descripcion: "Lote ficticio", unidad: "lote", precioVenta: "12000", costoReferencia: "9000", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B5" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B5" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio B5" })).id;
});

describe("Origen de las cuentas", () => {
  test("La OV aceptada y la compra confirmada nacen con su cuenta (una sola, condiciones por definir)", async () => {
    const ov = await ordenDe12000();
    const cxc = await cuentaDeOrden(ov.ordenId);
    assert.deepEqual([cxc.tipo, cxc.total.toFixed(2), cxc.modalidad, cxc.estatus], ["POR_COBRAR", "12000.00", null, "VIGENTE"]);
    const borrador = (await crearCompraComercial(admin, ov.ordenId, clave())).id;
    assert.equal(await db.cuentaComercial.count({ where: { compraId: borrador } }), 0);
    const compra = await compraDe12000(ov.ordenId, ov.partidaVentaId);
    assert.equal((await cuentaDeCompra(compra)).tipo, "POR_PAGAR");
    await assert.rejects(db.cuentaComercial.create({ data: { empresaId: EMPRESA, tipo: "POR_COBRAR", ordenVentaId: ov.ordenId, total: "1" } }));
    // Cotización emitida sin aceptar: sin cuenta.
    const { id } = await crearCotizacionVenta(admin, { clienteId: CLIENTE, obraId: OBRA, descripcion: "x", fecha: HOY, vigenciaHasta: dias(5), partidas: [{ productoId: LOTE, cantidad: "1" }] }, clave());
    await emitirCotizacionVenta(admin, id, 1);
    assert.equal(await db.cuentaComercial.count(), 2);
  });

  test("Sin calendario: «Condiciones por definir», saldo completo, ni liquidada ni vencida, y no admite movimientos", async () => {
    const ov = await ordenDe12000();
    const d = await detalleCuentaDeOrden(admin, ov.ordenId);
    assert.deepEqual([d.estado.situacion, d.estado.liquidacion, d.estado.saldo, d.estado.vencido], ["SIN_CALENDARIO", "PENDIENTE", "12000.00", "0.00"]);
    await assert.rejects(registrarMovimientoCuenta(admin, d.id, mov("100"), null, clave()), /Define las condiciones/);
  });

  test("Incorporación de documentos anteriores: determinista y sin duplicados", async () => {
    const ov = await ordenDe12000();
    const compra = await compraDe12000(ov.ordenId, ov.partidaVentaId);
    // Simular datos previos a B5: retirar sus cuentas (solo en esta base de pruebas).
    await db.$executeRawUnsafe(`ALTER TABLE cuentas_comerciales DISABLE TRIGGER cuentas_comerciales_sin_borrado`);
    await db.$executeRawUnsafe(`DELETE FROM cuentas_comerciales`);
    await db.$executeRawUnsafe(`ALTER TABLE cuentas_comerciales ENABLE TRIGGER cuentas_comerciales_sin_borrado`);
    const sql = readFileSync("prisma/migrations/20261120090000_comercializacion_b5_cuentas/migration.sql", "utf8");
    const incorporacion = sql.slice(sql.indexOf("-- Incorporación de documentos existentes")).split(";").map((s) => s.trim()).filter((s) => s.startsWith("INSERT") || s.includes("INSERT INTO"));
    assert.equal(incorporacion.length, 2);
    for (let vuelta = 0; vuelta < 2; vuelta++) for (const s of incorporacion) await db.$executeRawUnsafe(s.slice(s.indexOf("INSERT")));
    const cuentas = await db.cuentaComercial.findMany({ orderBy: { tipo: "asc" } });
    assert.deepEqual(
      cuentas.map((c) => [c.id, c.tipo, c.total.toFixed(2), c.modalidad, c.tuvoMovimientos]),
      [
        [`cxc-${ov.ordenId}`, "POR_COBRAR", "12000.00", null, false],
        [`cxp-${compra}`, "POR_PAGAR", "12000.00", null, false],
      ]
    );
    assert.equal(await db.cuotaCuentaComercial.count(), 0);
    assert.equal(await db.movimientoComercial.count(), 0);
  });
});

describe("Condiciones de pago", () => {
  test("Contado: una cuota por el total; sin movimiento sigue pendiente", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await assert.rejects(definirCondicionesCuenta(admin, c.id, 1, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: HOY, importe: "6000" }, { fechaVencimiento: HOY, importe: "6000" }] }), /una sola fecha/);
    await definirCondicionesCuenta(admin, c.id, 1, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: HOY, importe: "12000" }] });
    const d = await detalleCuentaDeOrden(admin, ov.ordenId);
    assert.deepEqual([d.modalidad, d.estado.liquidacion, d.estado.situacion, d.estado.saldo], ["CONTADO", "PENDIENTE", "VENCE_HOY", "12000.00"]);
    assert.equal(await db.movimientoComercial.count(), 0);
  });

  test("Las cuotas deben sumar exactamente el total (servicio y base); se admiten fechas pasadas", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await assert.rejects(definirCondicionesCuenta(admin, c.id, 1, credito([[dias(-60), "4000"], [dias(30), "7999.99"]])), /deben coincidir/);
    await assert.rejects(definirCondicionesCuenta(admin, c.id, 1, credito([[dias(-60), "0"], [dias(30), "12000"]])), /mayor que 0/);
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.cuotaCuentaComercial.create({ data: { empresaId: EMPRESA, cuentaId: c.id, numero: 1, fechaVencimiento: new Date(`${HOY}T00:00:00Z`), importe: "100" } });
      }),
      /no suman el total/
    );
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(-60), "4000"], [dias(30), "8000"]]));
    assert.equal((await detalleCuentaDeOrden(admin, ov.ordenId)).estado.cuotas[0].fechaVencimiento, dias(-60));
  });

  test("Sustituir el calendario sin movimientos conserva el historial; con un movimiento (aunque se anule) queda bloqueado", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(10), "12000"]]));
    await assert.rejects(definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]])), ConflictoEdicionError);
    await definirCondicionesCuenta(admin, c.id, 2, credito([[dias(5), "6000"], [dias(15), "6000"]]));
    const d = await detalleCuentaDeOrden(admin, ov.ordenId);
    assert.equal(d.estado.cuotas.length, 2);
    assert.equal(d.calendariosAnteriores.length, 1);
    const { movimientoId } = await registrarMovimientoCuenta(admin, c.id, mov("100"), null, clave());
    await anularMovimientoCuenta(admin, movimientoId, "Captura equivocada");
    await assert.rejects(definirCondicionesCuenta(admin, c.id, 3, credito([[dias(1), "12000"]])), /ya no se pueden cambiar/);
    await assert.rejects(db.cuotaCuentaComercial.updateMany({ where: { cuentaId: c.id, vigente: true }, data: { vigente: false, sustituidaEn: new Date() } }), /no se puede modificar/);
  });
});

for (const lado of ["cobro", "pago"] as const) {
  describe(`Caso $12,000 — ${lado}`, () => {
    test("Cuotas $4,000 (vencida) y $8,000; abono $5,000 → saldo $7,000 y vencido $0; anularlo recupera todo", async () => {
      const ov = await ordenDe12000();
      const cuentaId = lado === "cobro" ? (await cuentaDeOrden(ov.ordenId)).id : (await cuentaDeCompra(await compraDe12000(ov.ordenId, ov.partidaVentaId))).id;
      const detalle = async () => {
        const c = await db.cuentaComercial.findUniqueOrThrow({ where: { id: cuentaId } });
        return c.ordenVentaId ? detalleCuentaDeOrden(admin, c.ordenVentaId) : (await detalleCuentaDeCompra(admin, c.compraId!))!;
      };
      await definirCondicionesCuenta(admin, cuentaId, 1, credito([[dias(-3), "4000"], [dias(20), "8000"]]));
      let d = await detalle();
      assert.deepEqual([d.estado.saldo, d.estado.vencido, d.estado.situacion], ["12000.00", "4000.00", "VENCIDA"]);

      const { movimientoId } = await registrarMovimientoCuenta(admin, cuentaId, mov("5000"), null, clave());
      d = await detalle();
      assert.deepEqual(d.estado.cuotas.map((q) => [q.numero, q.aplicado, q.saldo]), [
        [1, "4000.00", "0.00"],
        [2, "1000.00", "7000.00"],
      ]);
      assert.deepEqual([d.estado.aplicado, d.estado.saldo, d.estado.vencido, d.estado.liquidacion, d.estado.situacion], ["5000.00", "7000.00", "0.00", "PARCIAL", "AL_CORRIENTE"]);
      assert.deepEqual(d.movimientos[0].aplicaciones.map((a) => [a.cuotaNumero, a.importe]), [
        [1, "4000.00"],
        [2, "1000.00"],
      ]);
      assert.equal(await db.movimientoComercial.count(), 1, "un movimiento, no uno por cuota");

      await anularMovimientoCuenta(admin, movimientoId, "Capturado por error");
      d = await detalle();
      assert.deepEqual(d.estado.cuotas.map((q) => q.saldo), ["4000.00", "8000.00"]);
      assert.deepEqual([d.estado.saldo, d.estado.vencido, d.estado.liquidacion], ["12000.00", "4000.00", "PENDIENTE"]);
      assert.equal(d.movimientos[0].estatus, "ANULADO");
      assert.equal(d.movimientos[0].anulado?.motivo, "Capturado por error");
      assert.equal(await db.aplicacionMovimientoComercial.count(), 2, "las aplicaciones se conservan como historial");
    });
  });
}

for (const lado of ["cobro", "pago"] as const) {
  describe(`Anticipo como primera cuota — ${lado}`, () => {
    test("Anticipo $3,000 + $9,000: se registra antes de su vencimiento y el excedente va a la cuota futura de la misma cuenta", async () => {
      const ov = await ordenDe12000();
      const compraId = lado === "pago" ? await compraDe12000(ov.ordenId, ov.partidaVentaId) : null;
      const cuentaId = compraId ? (await cuentaDeCompra(compraId)).id : (await cuentaDeOrden(ov.ordenId)).id;
      const detalle = async () => (compraId ? (await detalleCuentaDeCompra(admin, compraId))! : detalleCuentaDeOrden(admin, ov.ordenId));
      // Las dos cuotas vencen en el futuro: la primera es el anticipo.
      await definirCondicionesCuenta(admin, cuentaId, 1, credito([[dias(3), "3000"], [dias(30), "9000"]]));

      // 1) Anticipo recibido HOY, antes de su vencimiento (propuesta automática).
      await registrarMovimientoCuenta(admin, cuentaId, mov("3000"), null, clave());
      let d = await detalle();
      assert.deepEqual(d.estado.cuotas.map((q) => [q.numero, q.aplicado, q.saldo, q.situacion]), [
        [1, "3000.00", "0.00", "LIQUIDADA"],
        [2, "0.00", "9000.00", "AL_CORRIENTE"],
      ]);
      assert.deepEqual([d.estado.saldo, d.estado.vencido, d.estado.liquidacion, d.estado.situacion], ["9000.00", "0.00", "PARCIAL", "AL_CORRIENTE"]);

      // 2) Un abono que excede el anticipo pendiente se reparte hacia la cuota futura.
      await anularMovimientoCuenta(admin, d.movimientos[0].id, "Se captura como un solo abono");
      await registrarMovimientoCuenta(admin, cuentaId, mov("5000", { fecha: dias(-1) }), null, clave());
      d = await detalle();
      assert.deepEqual(d.estado.cuotas.map((q) => [q.aplicado, q.saldo]), [
        ["3000.00", "0.00"],
        ["2000.00", "7000.00"],
      ]);

      // 3) Dinero anticipado aplicado directamente a la cuota futura (distribución explícita).
      const q2 = d.estado.cuotas[1];
      await registrarMovimientoCuenta(admin, cuentaId, mov("7000", { aplicaciones: [{ cuotaId: q2.id, importe: "7000" }] }), null, clave());
      d = await detalle();
      assert.deepEqual([d.estado.saldo, d.estado.vencido, d.estado.liquidacion], ["0.00", "0.00", "LIQUIDADA"]);
      // Sin saldo a favor: ya no se acepta más dinero en esta cuenta.
      await assert.rejects(registrarMovimientoCuenta(admin, cuentaId, mov("0.01"), null, clave()), /supera el saldo/);
    });
  });
}

describe("Abonos, sobrepagos y concurrencia", () => {
  test("Abono anticipado a una cuota futura con distribución explícita; la vencida sigue vencida", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(-3), "4000"], [dias(20), "8000"]]));
    const [q1, q2] = (await detalleCuentaDeOrden(admin, ov.ordenId)).estado.cuotas;
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("8000", { aplicaciones: [{ cuotaId: q2.id, importe: "7000" }] }), null, clave()), /deben coincidir/);
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("4500", { aplicaciones: [{ cuotaId: q1.id, importe: "4500" }] }), null, clave()), /saldo/);
    await registrarMovimientoCuenta(admin, c.id, mov("8000", { aplicaciones: [{ cuotaId: q2.id, importe: "8000" }] }), null, clave());
    const d = await detalleCuentaDeOrden(admin, ov.ordenId);
    assert.deepEqual([d.estado.saldo, d.estado.vencido, d.estado.liquidacion, d.estado.situacion], ["4000.00", "4000.00", "PARCIAL", "VENCIDA"]);
    void q1;
  });

  test("Sin sobrepagos ni fechas futuras; liquidar deja la cuenta liquidada", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("12000.01"), null, clave()), /supera el saldo/);
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("1", { fecha: dias(1) }), null, clave()), /futura/);
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("0"), null, clave()), /mayor que 0/);
    await registrarMovimientoCuenta(admin, c.id, mov("12000", { fecha: dias(-2), metodo: "EFECTIVO" }), null, clave());
    const d = await detalleCuentaDeOrden(admin, ov.ordenId);
    assert.deepEqual([d.estado.saldo, d.estado.liquidacion], ["0.00", "LIQUIDADA"]);
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("1"), null, clave()), /supera el saldo/);
  });

  test("Cobros simultáneos no superan el saldo (servicio y base)", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
    const r = await Promise.allSettled([1, 2, 3].map(() => registrarMovimientoCuenta(director, c.id, mov("5000"), null, clave())));
    sinInterbloqueos(r);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 2);
    assert.equal((await detalleCuentaDeOrden(admin, ov.ordenId)).estado.saldo, "2000.00");
    // La base también lo impide si se salta el servicio.
    const q = await db.cuotaCuentaComercial.findFirstOrThrow({ where: { cuentaId: c.id, vigente: true } });
    await assert.rejects(
      db.$transaction(async (tx) => {
        const m = await tx.movimientoComercial.create({ data: { empresaId: EMPRESA, cuentaId: c.id, importe: "3000", fecha: new Date(`${HOY}T00:00:00Z`), metodo: "OTRO", registradoPorId: admin.id } });
        await tx.aplicacionMovimientoComercial.create({ data: { empresaId: EMPRESA, movimientoId: m.id, cuotaId: q.id, importe: "3000" } });
      }),
      /supera el saldo de la cuota/
    );
  });

  test("Idempotencia: misma clave = mismo movimiento (también simultáneo); anular dos veces = una anulación", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
    const k = clave();
    const r = await Promise.allSettled([1, 2, 3].map(() => registrarMovimientoCuenta(admin, c.id, mov("1000"), { nombre: "spei.pdf", bytes: new Uint8Array(pdfFicticio("spei")) }, k)));
    sinInterbloqueos(r);
    const ids = new Set(r.map((x) => (x.status === "fulfilled" ? x.value.movimientoId : `error: ${(x.reason as Error).message}`)));
    assert.equal(ids.size, 1, [...ids].join(" | "));
    assert.equal(await db.movimientoComercial.count(), 1);
    assert.equal([...almacenamiento.keys()].filter((k2) => k2.includes("/movimientos/")).length, 1, "sin comprobantes huérfanos");
    const id = [...ids][0];
    assert.deepEqual(await Promise.all([anularMovimientoCuenta(admin, id, "Error"), anularMovimientoCuenta(admin, id, "Error")]).then((x) => x.map((y) => y.yaAnulado).sort()), [false, true]);
    assert.equal(await db.registroAuditoria.count({ where: { entidadId: id, accion: "CAMBIAR_ESTATUS" } }), 1);
  });

  test("Un movimiento registrado no se edita ni se borra (base)", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
    const { movimientoId } = await registrarMovimientoCuenta(admin, c.id, mov("1000"), null, clave());
    await assert.rejects(db.movimientoComercial.update({ where: { id: movimientoId }, data: { importe: "999" } }), /solo puede anularse/);
    await assert.rejects(db.movimientoComercial.delete({ where: { id: movimientoId } }), /no se eliminan/);
    await assert.rejects(db.aplicacionMovimientoComercial.deleteMany({ where: { movimientoId } }), /no se modifican/);
  });
});

describe("Compras: anulación y pagos", () => {
  test("Compra sin movimientos: se anula junto con su cuenta y deja de sumar por pagar", async () => {
    const ov = await ordenDe12000();
    const compra = await compraDe12000(ov.ordenId, ov.partidaVentaId);
    assert.equal((await resumenFinancieroOrden(admin, ov.ordenId)).porPagar.saldo, "12000.00");
    await anularCompraComercial(admin, compra, "Proveedor canceló");
    const c = await cuentaDeCompra(compra);
    assert.equal(c.estatus, "ANULADA");
    assert.equal((await resumenFinancieroOrden(admin, ov.ordenId)).porPagar.saldo, "0.00");
    assert.equal((await indicadoresCuentasEmpresa(admin)).porPagar.saldo, "0.00");
    await assert.rejects(registrarMovimientoCuenta(admin, c.id, mov("1"), null, clave()), /anulada/);
  });

  test("Compra con historial de pagos (aunque estén anulados) no se anula con la acción simple", async () => {
    const ov = await ordenDe12000();
    const compra = await compraDe12000(ov.ordenId, ov.partidaVentaId);
    const c = await cuentaDeCompra(compra);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
    const { movimientoId } = await registrarMovimientoCuenta(admin, c.id, mov("500"), null, clave());
    await anularMovimientoCuenta(admin, movimientoId, "Error");
    await assert.rejects(anularCompraComercial(admin, compra, "Intento"), /historial de pagos/);
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id: compra } })).estatus, "CONFIRMADA");
    await assert.rejects(db.compraComercial.update({ where: { id: compra }, data: { estatus: "ANULADA", anuladaEn: new Date(), anuladaPorId: admin.id, motivoAnulacion: "x" } }), /historial de pagos|sigue vigente/);
  });

  test("Anulación de compra y pago simultáneos: solo uno procede, nunca ambos", async () => {
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      const ov = await ordenDe12000();
      const compra = await compraDe12000(ov.ordenId, ov.partidaVentaId);
      const c = await cuentaDeCompra(compra);
      await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
      const [anulacion, pago] = await Promise.allSettled([
        anularCompraComercial(admin, compra, "Simultánea"),
        registrarMovimientoCuenta(director, c.id, mov("1000"), null, clave()),
      ]);
      sinInterbloqueos([anulacion, pago]);
      const ok = [anulacion.status, pago.status].filter((s) => s === "fulfilled").length;
      assert.equal(ok, 1, `vuelta ${vuelta}: ${anulacion.status}/${pago.status}`);
      const estadoCompra = (await db.compraComercial.findUniqueOrThrow({ where: { id: compra } })).estatus;
      const pagos = await db.movimientoComercial.count({ where: { cuentaId: c.id } });
      assert.ok((estadoCompra === "ANULADA" && pagos === 0) || (estadoCompra === "CONFIRMADA" && pagos === 1));
    }
  });
});

describe("Permisos, aislamiento y efectos", () => {
  test("Otra Empresa y el vendedor no acceden a cuentas, movimientos, comprobantes ni indicadores", async () => {
    const ov = await ordenDe12000();
    const c = await cuentaDeOrden(ov.ordenId);
    await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(5), "12000"]]));
    const { movimientoId } = await registrarMovimientoCuenta(admin, c.id, mov("2500"), { nombre: "spei.pdf", bytes: new Uint8Array(pdfFicticio("spei")) }, clave());
    for (const u of [adminAjeno]) {
      await assert.rejects(detalleCuentaDeOrden(u, ov.ordenId), RegistroNoEncontradoError);
      await assert.rejects(registrarMovimientoCuenta(u, c.id, mov("1"), null, clave()), RegistroNoEncontradoError);
      await assert.rejects(definirCondicionesCuenta(u, c.id, 2, credito([[dias(5), "12000"]])), RegistroNoEncontradoError);
      await assert.rejects(anularMovimientoCuenta(u, movimientoId, "Intento desde otra empresa"), RegistroNoEncontradoError);
      await assert.rejects(obtenerComprobanteMovimiento(u, movimientoId), RegistroNoEncontradoError);
    }
    for (const intento of [
      () => detalleCuentaDeOrden(vendedor, ov.ordenId),
      () => resumenFinancieroOrden(vendedor, ov.ordenId),
      () => indicadoresCuentasEmpresa(vendedor),
      () => registrarMovimientoCuenta(vendedor, c.id, mov("1"), null, clave()),
      () => definirCondicionesCuenta(vendedor, c.id, 2, credito([[dias(5), "12000"]])),
      () => anularMovimientoCuenta(vendedor, movimientoId, "x"),
      () => obtenerComprobanteMovimiento(vendedor, movimientoId),
    ]) {
      await assert.rejects(intento, SinPermisoComercialError);
    }
    // El vendedor conserva precios y totales de su OV, sin datos de cobranza.
    const texto = JSON.stringify([await obtenerCotizacionVenta(vendedor, ov.cotizacionId), await listarCotizacionesVenta(vendedor)]);
    assert.ok(texto.includes("12000.00"));
    for (const dato of ["2500", "SPEI", "spei", "cuota", c.id]) assert.ok(!texto.includes(dato), `el vendedor recibió ${dato}`);
  });

  test("Los totales históricos no cambian y no hay efectos en construcción ni Contabilidad", async () => {
    const ov = await ordenDe12000();
    const compra = await compraDe12000(ov.ordenId, ov.partidaVentaId);
    for (const c of [await cuentaDeOrden(ov.ordenId), await cuentaDeCompra(compra)]) {
      await definirCondicionesCuenta(admin, c.id, 1, credito([[dias(-1), "6000"], [dias(9), "6000"]]));
      await registrarMovimientoCuenta(admin, c.id, mov("7000"), null, clave());
    }
    assert.equal((await db.ordenVenta.findUniqueOrThrow({ where: { id: ov.ordenId } })).total.toFixed(2), "12000.00");
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id: compra } })).total.toFixed(2), "12000.00");
    const conteos = await Promise.all([
      db.ordenCompra.count(),
      db.movimientoSemanal.count(),
      db.gastoObra.count(),
      db.egreso.count(),
      db.ingreso.count(),
      db.movimientoFinancieroCliente.count(),
    ]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0]);
    const ind = await indicadoresCuentasEmpresa(admin);
    assert.deepEqual([ind.porCobrar.saldo, ind.porCobrar.vencido, ind.porPagar.saldo, ind.porPagar.vencido], ["5000.00", "0.00", "5000.00", "0.00"]);
  });

  test("«Hoy» usa la zona de la Empresa", async () => {
    const instante = new Date(Date.UTC(2026, 10, 20, 20, 0, 0)); // 14:00 en Monterrey; 05:00 del día siguiente en Tokio
    assert.equal(await hoyDeEmpresa(db, EMPRESA, instante), "2026-11-20");
    await db.empresa.update({ where: { id: EMPRESA }, data: { zonaHoraria: "Asia/Tokyo" } });
    assert.equal(await hoyDeEmpresa(db, EMPRESA, instante), "2026-11-21");
  });
});

void ValidacionError;

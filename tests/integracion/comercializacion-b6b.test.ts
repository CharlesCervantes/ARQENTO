import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { anularCompraComercial, confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra } from "@/lib/server/comercializacion/compras";
import { anularMovimientoCuenta, definirCondicionesCuenta, registrarMovimientoCuenta } from "@/lib/server/comercializacion/cuentas";
import { anularEntregaComercial, contarOrdenesConEntregaPendiente, registrarEntregaComercial } from "@/lib/server/comercializacion/entregas";
import { AVISOS_POR_PAGINA, recordatoriosComerciales } from "@/lib/server/comercializacion/recordatorios";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { jpgFicticio, pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Comercialización B6B contra PostgreSQL REAL: recordatorios internos de
// cobros y pagos calculados al consultar desde las cuotas reales de B5, con
// FECHA CONTROLADA (parámetro `ahora`; no se cambia el reloj ni la base), e
// indicador «Entregas pendientes». Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b6b", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);

// "Hoy" controlado: 10 de marzo de 2026, 12:00 en America/Monterrey.
const AHORA = new Date("2026-03-10T18:00:00Z");
const HOY_REAL = hoyNegocio(); // solo para fechas de movimientos y aceptación (no futuras)

let UNIDAD: string; // $1 exento por unidad → total = cantidad
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-b6b-${++n}-${Date.now()}`;

/** OV aceptada de `total` pesos (exento), asignada al vendedor. */
async function orden(total: string, u: UsuarioSesion = admin) {
  const { id } = await crearCotizacionVenta(
    u,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia B6B", vendedorId: vendedor.id, fecha: HOY_REAL, vigenciaHasta: HOY_REAL, partidas: [{ productoId: UNIDAD, cantidad: total }] },
    clave()
  );
  await emitirCotizacionVenta(u, id, 1);
  const ov = await registrarAceptacionCotizacion(u, id, { fechaAceptacion: HOY_REAL }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pv = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
  const cuenta = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: ov.ordenId } });
  const folio = (await db.ordenVenta.findUniqueOrThrow({ where: { id: ov.ordenId } })).folio;
  return { cotizacionId: id, ordenId: ov.ordenId, partidaVentaId: pv.id, cuentaId: cuenta.id, folio };
}

async function compra(o: { ordenId: string; partidaVentaId: string }, cantidad: string) {
  const { id } = await crearCompraComercial(admin, o.ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV, fecha: HOY_REAL, partidas: [{ partidaVentaId: o.partidaVentaId, cantidad, costoUnitario: "1", tratamientoImpuesto: "EXENTO" }] });
  await confirmarCompraComercial(admin, id, 2);
  const cuenta = await db.cuentaComercial.findFirstOrThrow({ where: { compraId: id } });
  const folio = (await db.compraComercial.findUniqueOrThrow({ where: { id } })).folio;
  return { compraId: id, cuentaId: cuenta.id, folio };
}

const version = async (cuentaId: string) => (await db.cuentaComercial.findUniqueOrThrow({ where: { id: cuentaId } })).version;
const credito = async (cuentaId: string, cuotas: [string, string][]) =>
  definirCondicionesCuenta(admin, cuentaId, await version(cuentaId), { modalidad: "CREDITO", cuotas: cuotas.map(([fechaVencimiento, importe]) => ({ fechaVencimiento, importe })) });
const mov = (importe: string) => ({ importe, fecha: HOY_REAL, metodo: "TRANSFERENCIA", referencia: "SPEI ficticio" });
const avisos = (opciones: { categoria?: string; visibles?: unknown; ahora?: Date } = {}, u: UsuarioSesion = admin) => recordatoriosComerciales(u, { ahora: AHORA, ...opciones });
const filas = (r: Awaited<ReturnType<typeof recordatoriosComerciales>>) => r.avisos.map((a) => [a.tipo, a.folio, a.cuotaNumero, a.fechaVencimiento, a.saldo]);

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B6B", email: "director-b6b@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  UNIDAD = (await crearProductoComercial(admin, { codigo: "UNI", descripcion: "Unidad ficticia", unidad: "pieza", precioVenta: "1", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B6B" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B6B" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio B6B" })).id;
});

describe("Clasificación con fecha controlada", () => {
  test("vencida, hoy, mañana, a 3 días y a 4 días: una categoría por cuota, sin duplicados", async () => {
    const o = await orden("5000");
    await credito(o.cuentaId, [
      ["2026-03-09", "1000"],
      ["2026-03-10", "1000"],
      ["2026-03-11", "1000"],
      ["2026-03-13", "1000"],
      ["2026-03-14", "1000"],
    ]);
    const v = await avisos();
    assert.equal(v.hoy, "2026-03-10");
    assert.deepEqual(filas(v), [["COBRO", o.folio, 1, "2026-03-09", "1000.00"]]);
    assert.deepEqual(filas(await avisos({ categoria: "HOY" })), [["COBRO", o.folio, 2, "2026-03-10", "1000.00"]]);
    assert.deepEqual(filas(await avisos({ categoria: "PROXIMO" })), [
      ["COBRO", o.folio, 3, "2026-03-11", "1000.00"],
      ["COBRO", o.folio, 4, "2026-03-13", "1000.00"],
    ]);
    assert.equal((await avisos({ categoria: "SIN_CONDICIONES" })).totalCategoria, 0);
    // La cuota a 4 días no aparece en ninguna categoría; cuenta = 1 en cada una.
    assert.deepEqual(v.resumen.PROXIMO.cobro, { cuotas: 2, cuentas: 1, importe: "2000.00" });
    const total = Object.values(v.resumen).reduce((s, r) => s + r.cobro.cuotas, 0);
    assert.equal(total, 4);
    // El enlace lleva al documento y a su bloque de cobros.
    assert.equal(v.avisos[0].enlace, `/comercializacion/cotizaciones/${o.cotizacionId}#cobros`);
    assert.equal(v.avisos[0].contraparte, "Cliente ficticio B6B");
  });

  test("límite de medianoche en la zona de la Empresa", async () => {
    const o = await orden("100");
    await credito(o.cuentaId, [["2026-03-09", "100"]]);
    const antes = await avisos({ categoria: "HOY", ahora: new Date("2026-03-10T05:59:59Z") });
    assert.equal(antes.hoy, "2026-03-09");
    assert.equal(antes.totalCategoria, 1);
    assert.equal(antes.resumen.VENCIDO.cobro.cuotas, 0);
    const despues = await avisos({ ahora: new Date("2026-03-10T06:00:00Z") });
    assert.equal(despues.hoy, "2026-03-10");
    assert.deepEqual([despues.resumen.HOY.cobro.cuotas, despues.resumen.VENCIDO.cobro.cuotas], [0, 1]);
    // Otra zona configurada en la Empresa cambia el "hoy" (misma regla de B5).
    await db.empresa.update({ where: { id: EMPRESA }, data: { zonaHoraria: "Asia/Tokyo" } });
    assert.equal((await avisos({ ahora: new Date("2026-03-09T15:30:00Z") })).hoy, "2026-03-10");
  });
});

describe("Actualización con los movimientos reales de B5", () => {
  test("abono parcial muestra solo el saldo; liquidar lo quita; anular el movimiento lo vuelve a mostrar", async () => {
    const o = await orden("12000");
    await credito(o.cuentaId, [
      ["2026-03-08", "4000"],
      ["2026-03-20", "8000"],
    ]);
    assert.deepEqual(filas(await avisos()), [["COBRO", o.folio, 1, "2026-03-08", "4000.00"]]);
    await registrarMovimientoCuenta(admin, o.cuentaId, mov("1500"), null, clave());
    assert.deepEqual(filas(await avisos()), [["COBRO", o.folio, 1, "2026-03-08", "2500.00"]]);
    const liq = await registrarMovimientoCuenta(admin, o.cuentaId, mov("2500"), null, clave());
    const sinAviso = await avisos();
    assert.equal(sinAviso.totalCategoria, 0);
    assert.equal(sinAviso.resumen.VENCIDO.cobro.importe, "0.00");
    await anularMovimientoCuenta(admin, liq.movimientoId, "Captura duplicada de prueba");
    assert.deepEqual(filas(await avisos()), [["COBRO", o.folio, 1, "2026-03-08", "2500.00"]]);
  });

  test("cuenta sin calendario: solo en «Condiciones por definir», una vez, sin fecha", async () => {
    const o = await orden("800");
    const v = await avisos({ categoria: "SIN_CONDICIONES" });
    assert.deepEqual(filas(v), [["COBRO", o.folio, null, null, "800.00"]]);
    assert.deepEqual(v.resumen.SIN_CONDICIONES.cobro, { cuotas: 0, cuentas: 1, importe: "800.00" });
    for (const k of ["VENCIDO", "HOY", "PROXIMO"] as const) assert.equal(v.resumen[k].cobro.cuentas, 0);
  });

  test("reprogramación permitida (sin movimientos): no deja avisos del calendario anterior", async () => {
    const o = await orden("5000");
    await credito(o.cuentaId, [["2026-03-01", "5000"]]);
    assert.equal((await avisos()).totalCategoria, 1);
    await credito(o.cuentaId, [
      ["2026-03-12", "2000"],
      ["2026-04-30", "3000"],
    ]);
    const v = await avisos({ categoria: "PROXIMO" });
    assert.equal(v.resumen.VENCIDO.cobro.cuotas, 0);
    assert.deepEqual(filas(v), [["COBRO", o.folio, 1, "2026-03-12", "2000.00"]]);
    assert.equal(Object.values(v.resumen).reduce((s, r) => s + r.cobro.cuotas + r.cobro.cuentas, 0), 2);
  });

  test("por cobrar y por pagar por separado; compra anulada sin movimientos no genera avisos", async () => {
    const o = await orden("1000");
    await credito(o.cuentaId, [["2026-03-05", "1000"]]);
    const c = await compra(o, "600");
    let v = await avisos({ categoria: "SIN_CONDICIONES" });
    assert.deepEqual(filas(v), [["PAGO", c.folio, null, null, "600.00"]]);
    assert.equal(v.avisos[0].contraparte, "Proveedor ficticio B6B");
    assert.equal(v.avisos[0].enlace, `/comercializacion/compras/${c.compraId}#pagos`);
    await credito(c.cuentaId, [["2026-03-07", "600"]]);
    v = await avisos();
    // Nunca se compensan: 1000 por cobrar y 600 por pagar, cada uno con su total.
    assert.deepEqual(v.resumen.VENCIDO, { cobro: { cuotas: 1, cuentas: 1, importe: "1000.00" }, pago: { cuotas: 1, cuentas: 1, importe: "600.00" } });
    assert.deepEqual(filas(v), [
      ["COBRO", o.folio, 1, "2026-03-05", "1000.00"],
      ["PAGO", c.folio, 1, "2026-03-07", "600.00"],
    ]);
    await anularCompraComercial(admin, c.compraId, "Proveedor canceló (prueba)");
    v = await avisos();
    assert.deepEqual(v.resumen.VENCIDO.pago, { cuotas: 0, cuentas: 0, importe: "0.00" });
    assert.deepEqual(filas(v), [["COBRO", o.folio, 1, "2026-03-05", "1000.00"]]);
  });
});

describe("Paginación, conteos y totales", () => {
  test("12 cuotas vencidas de una cuenta: totales del conjunto completo, 10 visibles y «Ver más»", async () => {
    const o = await orden("12000");
    await credito(
      o.cuentaId,
      Array.from({ length: 12 }, (_, i) => [`2026-02-${String(12 - i).padStart(2, "0")}`, "1000"] as [string, string])
    );
    const v = await avisos();
    assert.equal(AVISOS_POR_PAGINA, 10);
    assert.deepEqual([v.avisos.length, v.totalCategoria, v.visibles], [10, 12, 10]);
    assert.deepEqual(v.resumen.VENCIDO.cobro, { cuotas: 12, cuentas: 1, importe: "12000.00" });
    // Desde la más antigua.
    assert.equal(v.avisos[0].fechaVencimiento, "2026-02-01");
    assert.equal(v.avisos[9].fechaVencimiento, "2026-02-10");
    const mas = await avisos({ visibles: "20" });
    assert.equal(mas.avisos.length, 12);
    assert.equal(new Set(mas.avisos.map((a) => a.clave)).size, 12);
    // Parámetros inválidos: valores seguros.
    const raro = await recordatoriosComerciales(admin, { ahora: AHORA, categoria: "<script>", visibles: "-5" });
    assert.deepEqual([raro.categoria, raro.visibles], ["VENCIDO", 10]);
    assert.equal((await recordatoriosComerciales(admin, { ahora: AHORA, visibles: "999999" })).visibles, 500);
  });
});

describe("Permisos y aislamiento", () => {
  test("solo Administrador y Director de la Empresa; el vendedor no recibe recordatorios ni conteos", async () => {
    const o = await orden("100");
    await credito(o.cuentaId, [["2026-03-01", "100"]]);
    assert.equal((await avisos({}, director)).totalCategoria, 1);
    await assert.rejects(avisos({}, vendedor), SinPermisoComercialError);
    await assert.rejects(contarOrdenesConEntregaPendiente(vendedor), SinPermisoComercialError);
    // Sin el módulo habilitado tampoco.
    await assert.rejects(recordatoriosComerciales({ ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA, modulos: [] }), id: admin.id }, { ahora: AHORA }), SinPermisoComercialError);
    // Otra Empresa no ve nada de esta.
    const ajeno = await avisos({}, adminAjeno);
    assert.equal(Object.values(ajeno.resumen).reduce((s, r) => s + r.cobro.cuotas + r.cobro.cuentas + r.pago.cuotas + r.pago.cuentas, 0), 0);
    assert.equal(await contarOrdenesConEntregaPendiente(adminAjeno), 0);
  });

  test("consultar los avisos no modifica saldos ni crea registros (tampoco en construcción)", async () => {
    const o = await orden("3000");
    await credito(o.cuentaId, [
      ["2026-03-01", "1000"],
      ["2026-03-10", "2000"],
    ]);
    await registrarMovimientoCuenta(admin, o.cuentaId, mov("500"), null, clave());
    const foto = async () => ({
      cuentas: await db.cuentaComercial.findMany({ orderBy: { id: "asc" } }),
      cuotas: await db.cuotaCuentaComercial.findMany({ orderBy: { id: "asc" } }),
      movimientos: await db.movimientoComercial.findMany({ orderBy: { id: "asc" } }),
      aplicaciones: await db.aplicacionMovimientoComercial.count(),
      auditoria: await db.registroAuditoria.count(),
    });
    const antes = await foto();
    for (let i = 0; i < 3; i++) {
      await Promise.all([avisos(), avisos({ categoria: "HOY" }, director), contarOrdenesConEntregaPendiente(admin)]);
    }
    assert.deepEqual(await foto(), antes);
    const conteos = await Promise.all([db.ordenCompra.count(), db.movimientoSemanal.count(), db.gastoObra.count(), db.egreso.count(), db.ingreso.count(), db.movimientoFinancieroCliente.count()]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0]);
  });
});

describe("Indicador «Entregas pendientes»", () => {
  test("cuenta OV aceptadas con pendientes una vez por OV; completa sale; anular la entrega la regresa", async () => {
    assert.equal(await contarOrdenesConEntregaPendiente(admin), 0);
    // Cotización emitida sin aceptar: no cuenta.
    const { id } = await crearCotizacionVenta(admin, { clienteId: CLIENTE, obraId: OBRA, descripcion: "Sin aceptar", fecha: HOY_REAL, vigenciaHasta: HOY_REAL, partidas: [{ productoId: UNIDAD, cantidad: "5" }] }, clave());
    await emitirCotizacionVenta(admin, id, 1);
    const a = await orden("10");
    const b = await orden("4");
    assert.equal(await contarOrdenesConEntregaPendiente(admin), 2);
    const evid = () => [{ nombre: "foto.jpg", bytes: new Uint8Array(jpgFicticio("e")) }];
    // Parcial: sigue contando una sola vez.
    await registrarEntregaComercial(admin, a.ordenId, { fechaEntrega: HOY_REAL, partidas: [{ partidaVentaId: a.partidaVentaId, cantidad: "3" }] }, evid(), clave());
    await registrarEntregaComercial(admin, a.ordenId, { fechaEntrega: HOY_REAL, partidas: [{ partidaVentaId: a.partidaVentaId, cantidad: "2" }] }, evid(), clave());
    assert.equal(await contarOrdenesConEntregaPendiente(director), 2);
    // Completa: sale del indicador.
    const comp = await registrarEntregaComercial(admin, b.ordenId, { fechaEntrega: HOY_REAL, partidas: [{ partidaVentaId: b.partidaVentaId, cantidad: "4" }] }, evid(), clave());
    assert.equal(await contarOrdenesConEntregaPendiente(admin), 1);
    // Anulación de la entrega: vuelve a contar.
    await anularEntregaComercial(admin, comp.entregaId, "Cantidad capturada por error");
    assert.equal(await contarOrdenesConEntregaPendiente(admin), 2);
  });
});

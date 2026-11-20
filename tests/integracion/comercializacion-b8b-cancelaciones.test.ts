import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { actualizarCotizacionVenta, crearCotizacionVenta, obtenerCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { duplicarCotizacionVenta, emitirCotizacionVenta, obtenerDocumentoParaPdf } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { anularCompraComercial, confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra, resumenComprasOrden } from "@/lib/server/comercializacion/compras";
import {
  anularMovimientoCuenta,
  definirCondicionesCuenta,
  detalleCuentaDeOrden,
  indicadoresCuentasEmpresa,
  registrarMovimientoCuenta,
} from "@/lib/server/comercializacion/cuentas";
import { anularGastoComercial, registrarGastoComercial, resultadoOrden } from "@/lib/server/comercializacion/gastos";
import { anularEntregaComercial, contarOrdenesConEntregaPendiente, registrarEntregaComercial } from "@/lib/server/comercializacion/entregas";
import { vincularSurtido } from "@/lib/server/comercializacion/surtido";
import { recordatoriosComerciales } from "@/lib/server/comercializacion/recordatorios";
import { cancelarCotizacionVenta, cancelarOrdenVenta, estadoCancelacionOrden, rechazarCotizacionVenta } from "@/lib/server/comercializacion/cancelaciones";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { jpgFicticio, pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Comercialización B8B (cancelaciones) contra PostgreSQL REAL: rechazo y
// cancelación de cotizaciones, cancelación básica de la OV, bloqueos,
// efectos, concurrencia y aislamiento. Datos ficticios.

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b8b", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const HOY = hoyNegocio();
const dias = (d: number) => {
  const f = new Date(`${HOY}T00:00:00Z`);
  f.setUTCDate(f.getUTCDate() + d);
  return f.toISOString().slice(0, 10);
};

let POSTE: string;
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-b8b-${++n}-${Date.now()}`;
const evid = () => [{ nombre: "foto.jpg", bytes: new Uint8Array(jpgFicticio(`e${n}`)) }];
const ocPdf = () => ({ nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });

async function borrador(u: UsuarioSesion = admin) {
  const { id } = await crearCotizacionVenta(
    u,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia B8B", vendedorId: vendedor.id, fecha: HOY, vigenciaHasta: dias(10), partidas: [{ productoId: POSTE, cantidad: "10" }] },
    clave()
  );
  return id;
}
async function emitida() {
  const id = await borrador();
  await emitirCotizacionVenta(admin, id, 1);
  return id;
}
async function orden() {
  const id = await emitida();
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, ocPdf());
  const pv = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
  return { cotizacionId: id, ordenId: ov.ordenId, folio: ov.folio, partidaVentaId: pv.id };
}
type Orden = Awaited<ReturnType<typeof orden>>;
async function compra(o: Orden, confirmar = true, cantidad = "10") {
  const { id } = await crearCompraComercial(admin, o.ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV, fecha: HOY, partidas: [{ partidaVentaId: o.partidaVentaId, cantidad, costoUnitario: "50", tratamientoImpuesto: "SIN_IVA" }] });
  if (confirmar) await confirmarCompraComercial(admin, id, 2);
  return id;
}
const entregar = (o: Orden, cantidad = "4") =>
  registrarEntregaComercial(admin, o.ordenId, { fechaEntrega: HOY, partidas: [{ partidaVentaId: o.partidaVentaId, cantidad }] }, evid(), clave());
const gasto = (o: Orden) =>
  registrarGastoComercial(admin, o.ordenId, { concepto: "Flete", beneficiarioId: PROV, fecha: HOY, subtotal: "100", tratamientoImpuesto: "EXENTO" }, null, clave());
const cuentaOv = (ordenVentaId: string) => db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId } });
const contado = async (cuentaId: string, importe: string, fecha = dias(5)) => {
  const c = await db.cuentaComercial.findUniqueOrThrow({ where: { id: cuentaId } });
  return definirCondicionesCuenta(admin, cuentaId, c.version, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: fecha, importe }] });
};
const pagar = (cuentaId: string, importe: string) => registrarMovimientoCuenta(admin, cuentaId, { importe, fecha: HOY, metodo: "TRANSFERENCIA" }, null, clave());
const textos = async (ordenId: string) => (await estadoCancelacionOrden(admin, ordenId)).bloqueos.map((b) => `${b.texto} [${b.enlaces.map((e) => e.etiqueta).join(", ")}]`);

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B8B", email: "director-b8b@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  POSTE = (await crearProductoComercial(admin, { codigo: "POSTE", descripcion: "Poste ficticio", unidad: "pieza", precioVenta: "100", costoReferencia: "", tratamientoImpuesto: "GRAVADO", tasaIva: "16" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B8B" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B8B" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio B8B" })).id;
});

describe("Cotizaciones: rechazo y cancelación", () => {
  test("borrador cancelado: terminal, conserva datos, reintento no cambia el motivo y se duplica", async () => {
    const id = await borrador();
    assert.deepEqual(await cancelarCotizacionVenta(admin, id, "El cliente desistió"), { yaRegistrado: false });
    assert.deepEqual(await cancelarCotizacionVenta(director, id, "Otro motivo"), { yaRegistrado: true });
    const c = await obtenerCotizacionVenta(admin, id);
    assert.deepEqual([c.estatus, c.cierre?.motivo, c.cierre?.porNombre === undefined, c.partidas.length, c.emision], ["CANCELADA", "El cliente desistió", false, 1, null]);
    await assert.rejects(emitirCotizacionVenta(admin, id, c.version), /cancelada: no se emite/);
    await assert.rejects(actualizarCotizacionVenta(admin, id, c.version, { clienteId: CLIENTE, obraId: OBRA, descripcion: "x", vendedorId: vendedor.id, fecha: HOY, vigenciaHasta: dias(10), partidas: [{ productoId: POSTE, cantidad: "1" }] }), /Solo se pueden editar cotizaciones en borrador/);
    await assert.rejects(rechazarCotizacionVenta(admin, id, "No aplica"), /Solo se registra el rechazo de una cotización emitida/);
    await assert.rejects(obtenerDocumentoParaPdf(admin, id), RegistroNoEncontradoError);
    const dup = await duplicarCotizacionVenta(admin, id, clave());
    const nueva = await obtenerCotizacionVenta(admin, dup.id);
    assert.deepEqual([nueva.estatus, nueva.origen?.id, nueva.folio !== c.folio, nueva.partidas.length], ["BORRADOR", id, true, 1]);
    assert.equal((await obtenerCotizacionVenta(admin, id)).estatus, "CANCELADA");
    // La base no permite reabrir ni modificar.
    await assert.rejects(db.$executeRawUnsafe(`UPDATE cotizaciones_venta SET estatus = 'BORRADOR' WHERE id = $1`, id), /rechazada o cancelada no se modifica/);
    await assert.rejects(db.$executeRawUnsafe(`UPDATE cotizaciones_venta SET descripcion = 'x' WHERE id = $1`, id), /rechazada o cancelada no se modifica/);
    await assert.rejects(db.partidaCotizacionVenta.updateMany({ where: { cotizacionId: id }, data: { cantidad: "1" } }), /emitida no se pueden modificar/);
  });

  test("emitida rechazada: no se acepta, conserva la copia emitida y el PDF, y se duplica", async () => {
    const id = await emitida();
    const antes = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    await assert.rejects(rechazarCotizacionVenta(admin, id, " "), /motivo del rechazo/);
    await rechazarCotizacionVenta(director, id, "Precio fuera de presupuesto");
    assert.deepEqual(await rechazarCotizacionVenta(admin, id, "Otro"), { yaRegistrado: true });
    const d = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([d.estatus, d.motivoCierre, d.cerradaPorId, d.folio, d.total.toFixed(2)], ["RECHAZADA", "Precio fuera de presupuesto", director.id, antes.folio, antes.total.toFixed(2)]);
    assert.deepEqual(d.documentoEmitido, antes.documentoEmitido);
    assert.equal((await obtenerDocumentoParaPdf(admin, id)).borrador, false);
    await assert.rejects(registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, ocPdf()), /rechazada: no se registra su aceptación/);
    await assert.rejects(cancelarCotizacionVenta(admin, id, "x x x"), /Solo se cancela una cotización en borrador o emitida \(esta está rechazada\)/);
    assert.equal(await db.ordenVenta.count(), 0);
    assert.equal((await obtenerCotizacionVenta(admin, (await duplicarCotizacionVenta(admin, id, clave())).id)).estatus, "BORRADOR");
    // La base: una OV nunca nace de una cotización rechazada.
    await assert.rejects(
      db.$executeRawUnsafe(
        `INSERT INTO ordenes_venta (id, "empresaId", folio, "numeroFolio", "cotizacionId", "fechaAceptacion", "evidenciaRef", "evidenciaNombre", "evidenciaTipo", "evidenciaBytes", "registradaPorId", subtotal, iva, total)
         VALUES ('ov-x', $1, 'OV-000099', 99, $2, CURRENT_DATE, 'r', 'n', 'application/pdf', 1, $3, 1, 0, 1)`,
        EMPRESA,
        id,
        adminBase.id
      ),
      /Solo una cotización emitida puede aceptarse/
    );
  });

  test("emitida cancelada y transiciones inválidas", async () => {
    const id = await emitida();
    await cancelarCotizacionVenta(admin, id, "Se cotizó por error");
    await assert.rejects(registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, ocPdf()), /cancelada: no se registra su aceptación/);
    const o = await orden();
    await assert.rejects(cancelarCotizacionVenta(admin, o.cotizacionId, "x x x"), /se gestiona desde su orden de venta/);
    await assert.rejects(rechazarCotizacionVenta(admin, o.cotizacionId, "x x x"), /se gestiona desde su orden de venta/);
    await assert.rejects(rechazarCotizacionVenta(admin, await borrador(), "x x x"), /emitida \(esta está en borrador\)/);
    // La base: un borrador no pasa directo a aceptada ni a rechazada.
    const b = await borrador();
    await assert.rejects(db.$executeRawUnsafe(`UPDATE cotizaciones_venta SET estatus = 'ACEPTADA' WHERE id = $1`, b), /solo puede emitirse o cancelarse/);
  });

  test("solo administración de la Empresa: el vendedor consulta el estado pero no rechaza ni cancela", async () => {
    const id = await emitida();
    await assert.rejects(rechazarCotizacionVenta(vendedor, id, "No le interesa"), SinPermisoComercialError);
    await assert.rejects(cancelarCotizacionVenta(vendedor, id, "No le interesa"), SinPermisoComercialError);
    await assert.rejects(cancelarCotizacionVenta(adminAjeno, id, "No le interesa"), RegistroNoEncontradoError);
    await rechazarCotizacionVenta(admin, id, "No le interesa");
    const vista = await obtenerCotizacionVenta(vendedor, id);
    assert.deepEqual([vista.estatus, vista.cierre?.motivo], ["RECHAZADA", "No le interesa"]);
  });

  test("aceptación y cancelación simultáneas: solo una procede", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await emitida();
      const [a, c] = await Promise.allSettled([
        registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, ocPdf()),
        cancelarCotizacionVenta(director, id, "Cancelación simultánea"),
      ]);
      const final = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
      const ovs = await db.ordenVenta.count({ where: { cotizacionId: id } });
      assert.equal([a, c].filter((r) => r.status === "fulfilled").length, 1);
      assert.ok((final.estatus === "ACEPTADA" && ovs === 1) || (final.estatus === "CANCELADA" && ovs === 0), `${final.estatus}/${ovs}`);
    }
    // Emitir y cancelar un borrador a la vez.
    const b = await borrador();
    const r = await Promise.allSettled([emitirCotizacionVenta(admin, b, 1), cancelarCotizacionVenta(director, b, "Cancelación simultánea")]);
    const fin = await db.cotizacionVenta.findUniqueOrThrow({ where: { id: b } });
    assert.ok(fin.estatus === "CANCELADA" || fin.estatus === "EMITIDA");
    assert.ok(r.some((x) => x.status === "fulfilled"));
  });
});

describe("Cancelación básica de la OV", () => {
  test("OV sin seguimiento con calendario definido: se cancela y su cuenta se anula conservando total y calendario", async () => {
    const o = await orden();
    const cxc = await cuentaOv(o.ordenId);
    await contado(cxc.id, "1160.00");
    const otra = await orden(); // sigue vigente y cuenta en los indicadores
    await assert.rejects(cancelarOrdenVenta(admin, o.ordenId, " "), /motivo de la cancelación/);
    assert.deepEqual(await cancelarOrdenVenta(director, o.ordenId, "El cliente canceló el pedido"), { yaCancelada: false });
    assert.deepEqual(await cancelarOrdenVenta(admin, o.ordenId, "Otro motivo"), { yaCancelada: true });
    const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } });
    assert.deepEqual([ov.estatus, ov.motivoCancelacion, ov.canceladaPorId], ["CANCELADA", "El cliente canceló el pedido", director.id]);
    const cuenta = await db.cuentaComercial.findUniqueOrThrow({ where: { id: cxc.id }, include: { cuotas: true, movimientos: true } });
    assert.deepEqual([cuenta.estatus, cuenta.total.toFixed(2), cuenta.modalidad, cuenta.motivoAnulacion], ["ANULADA", "1160.00", "CONTADO", "El cliente canceló el pedido"]);
    assert.deepEqual(cuenta.cuotas.map((q) => [q.vigente, q.importe.toFixed(2)]), [[true, "1160.00"]]);
    assert.equal(cuenta.movimientos.length, 0);
    // La cotización sigue aceptada y no genera otra OV.
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: o.cotizacionId } })).estatus, "ACEPTADA");
    const re = await registrarAceptacionCotizacion(admin, o.cotizacionId, { fechaAceptacion: HOY }, ocPdf());
    assert.deepEqual([re.ordenId, re.existente], [o.ordenId, true]);
    assert.equal(await db.ordenVenta.count({ where: { cotizacionId: o.cotizacionId } }), 1);
    // Indicadores, avisos, entregas pendientes y resultado.
    const ind = await indicadoresCuentasEmpresa(admin);
    assert.equal(ind.porCobrar.saldo, "1160.00"); // solo la otra OV
    const r = await recordatoriosComerciales(admin);
    for (const categoria of Object.keys(r.resumen)) {
      const avisos = (await recordatoriosComerciales(admin, { categoria, visibles: 500 })).avisos;
      assert.ok(!avisos.some((a) => a.folio === o.folio), `aviso de OV cancelada en ${categoria}`);
    }
    assert.equal(await contarOrdenesConEntregaPendiente(admin), 1);
    const res = await resultadoOrden(admin, o.ordenId);
    assert.deepEqual([res.simulacion, res.ordenCancelada], [null, true]);
    assert.ok((await resultadoOrden(admin, otra.ordenId)).ordenCancelada === undefined);
    const vista = await obtenerCotizacionVenta(vendedor, o.cotizacionId);
    assert.deepEqual([vista.orden?.estatus, vista.orden?.cancelacion?.motivo], ["CANCELADA", "El cliente canceló el pedido"]);
    // La base: no se reabre ni se modifica.
    await assert.rejects(db.$executeRawUnsafe(`UPDATE ordenes_venta SET estatus = 'VIGENTE' WHERE id = $1`, o.ordenId), /cancelada no se modifica ni se reabre/);
  });

  test("una OV cancelada no admite compras, gastos, entregas, vínculos, cobros ni condiciones (servidor y base)", async () => {
    const o = await orden();
    const cxc = await cuentaOv(o.ordenId);
    await cancelarOrdenVenta(admin, o.ordenId, "Pedido cancelado");
    await assert.rejects(crearCompraComercial(admin, o.ordenId, clave()), /orden de venta está cancelada/);
    await assert.rejects(gasto(o), /orden de venta está cancelada/);
    await assert.rejects(entregar(o), /orden de venta está cancelada/);
    await assert.rejects(entregar(o).catch(() => registrarEntregaComercial(vendedor, o.ordenId, { fechaEntrega: HOY, partidas: [{ partidaVentaId: o.partidaVentaId, cantidad: "1" }] }, evid(), clave())), /orden de venta está cancelada/);
    const v = (await db.cuentaComercial.findUniqueOrThrow({ where: { id: cxc.id } })).version;
    await assert.rejects(definirCondicionesCuenta(admin, cxc.id, v, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: HOY, importe: "1160" }] }), /cuenta está anulada/);
    await assert.rejects(pagar(cxc.id, "10"), /anulada|Define las condiciones/);
    // La base, aunque se omita el servicio.
    await assert.rejects(
      db.$executeRawUnsafe(
        `INSERT INTO compras_comerciales (id, "empresaId", folio, "numeroFolio", "ordenVentaId", fecha, "creadoPorId") VALUES ('c-x', $1, 'COC-000099', 99, $2, CURRENT_DATE, $3)`,
        EMPRESA,
        o.ordenId,
        adminBase.id
      ),
      /orden de venta está cancelada/
    );
    assert.equal(await db.compraComercial.count({ where: { ordenVentaId: o.ordenId } }), 0);
  });

  test("bloqueos concretos con enlaces: compras, gastos, entregas, vínculos e historial financiero anulado", async () => {
    const o = await orden();
    const borradorId = await compra(o, false, "3");
    const confirmada = await compra(o, true, "5");
    const g = await gasto(o);
    const e = await entregar(o, "4");
    const pc = await db.partidaCompraComercial.findFirstOrThrow({ where: { compraId: confirmada } });
    const pe = await db.partidaEntregaComercial.findFirstOrThrow({ where: { entregaId: e.entregaId } });
    await vincularSurtido(admin, e.entregaId, [{ partidaEntregaId: pe.id, partidaCompraId: pc.id, cantidad: "4" }], clave());
    const folios = Object.fromEntries((await db.compraComercial.findMany({ where: { ordenVentaId: o.ordenId } })).map((c) => [c.id, c.folio]));
    assert.deepEqual(await textos(o.ordenId), [
      `Hay compras en borrador: descártalas. [${folios[borradorId]}]`,
      `Hay compras confirmadas vigentes: anúlalas primero. [${folios[confirmada]}]`,
      "Hay gastos adicionales vigentes: anúlalos primero. [Gasto 1]",
      "Hay entregas vigentes al cliente: anúlalas primero. [Entrega 1]",
      "Hay vínculos de surtido vigentes. [Entrega 1]",
    ]);
    const est = await estadoCancelacionOrden(admin, o.ordenId);
    assert.equal(est.bloqueos[0].enlaces[0].href, `/comercializacion/compras/${borradorId}`);
    assert.equal(est.bloqueos[3].enlaces[0].href, `/comercializacion/cotizaciones/${o.cotizacionId}#entrega-${e.entregaId}`);
    await assert.rejects(cancelarOrdenVenta(admin, o.ordenId, "Intento"), /No se puede cancelar .*compras en borrador.*entregas vigentes/);
    // La base también lo impide aunque se omita el servicio.
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE cuentas_comerciales SET estatus = 'ANULADA', "anuladaEn" = now(), "anuladaPorId" = $2, "motivoAnulacion" = 'x' WHERE "ordenVentaId" = $1`, o.ordenId, adminBase.id);
        await tx.$executeRawUnsafe(`UPDATE ordenes_venta SET estatus = 'CANCELADA', "canceladaEn" = now(), "canceladaPorId" = $2, "motivoCancelacion" = 'x' WHERE id = $1`, o.ordenId, adminBase.id);
      }),
      /compras vigentes o en borrador/
    );

    // Se atiende cada bloqueo en su documento (sin cancelaciones automáticas).
    await anularEntregaComercial(admin, e.entregaId, "Captura de prueba");
    await anularCompraComercial(admin, confirmada, "Compra de prueba");
    await anularGastoComercial(admin, g.gastoId, "Gasto de prueba");
    assert.deepEqual(await textos(o.ordenId), [`Hay compras en borrador: descártalas. [${folios[borradorId]}]`]);
    await anularCompraComercial(admin, borradorId, "Borrador que ya no se usa");
    assert.deepEqual(await textos(o.ordenId), []);
    await cancelarOrdenVenta(admin, o.ordenId, "Pedido cancelado");
    // Las dependencias anuladas se conservan como historial.
    assert.deepEqual((await db.compraComercial.findMany({ where: { ordenVentaId: o.ordenId }, orderBy: { numeroFolio: "asc" } })).map((c) => c.estatus), ["ANULADA", "ANULADA"]);
    assert.equal(await db.entregaComercial.count({ where: { ordenVentaId: o.ordenId, estatus: "ANULADA" } }), 1);
    assert.equal(await db.vinculoSurtidoComercial.count({ where: { ordenVentaId: o.ordenId } }), 1);
  });

  test("historial financiero anulado bloquea: cobro de la OV y pago de un gasto", async () => {
    const o = await orden();
    const cxc = await cuentaOv(o.ordenId);
    await contado(cxc.id, "1160.00");
    const { movimientoId } = await pagar(cxc.id, "100");
    await anularMovimientoCuenta(admin, movimientoId, "Cobro duplicado");
    assert.deepEqual(await textos(o.ordenId), ["La cuenta por cobrar tiene historial de cobros (aunque estén anulados). [Cobros del cliente]"]);
    await assert.rejects(cancelarOrdenVenta(admin, o.ordenId, "Intento"), /historial de cobros/);

    const o2 = await orden();
    const g = await gasto(o2);
    const cg = await db.cuentaComercial.findFirstOrThrow({ where: { gastoId: g.gastoId } });
    await contado(cg.id, "100.00");
    const p = await pagar(cg.id, "100");
    await anularMovimientoCuenta(admin, p.movimientoId, "Pago duplicado");
    assert.deepEqual(await textos(o2.ordenId), [
      "Hay gastos adicionales con historial de pagos (aunque estén anulados). [Gasto 1]",
      "Hay gastos adicionales vigentes: anúlalos primero. [Gasto 1]",
    ]);
    await assert.rejects(anularGastoComercial(admin, g.gastoId, "Intento"), /historial de pagos/);
    assert.equal((await db.ordenVenta.findUniqueOrThrow({ where: { id: o2.ordenId } })).estatus, "VIGENTE");
  });

  test("descartar una compra en borrador: motivo e historial, sin cuenta ni cantidades compradas, aunque haya entregas sin vincular", async () => {
    const o = await orden();
    await entregar(o, "4"); // entregado sin vincular (B8A)
    const id = await compra(o, false, "6");
    await assert.rejects(anularCompraComercial(admin, id, " "), /motivo/);
    assert.deepEqual(await anularCompraComercial(admin, id, "Proveedor equivocado"), { yaAnulada: false });
    assert.deepEqual(await anularCompraComercial(admin, id, "Otro"), { yaAnulada: true });
    const c = await db.compraComercial.findUniqueOrThrow({ where: { id }, include: { partidas: true } });
    assert.deepEqual([c.estatus, c.confirmadaEn, c.motivoAnulacion, c.partidas.length], ["ANULADA", null, "Proveedor equivocado", 1]);
    assert.equal(await db.cuentaComercial.count({ where: { compraId: id } }), 0);
    const q = (await resumenComprasOrden(admin, o.ordenId)).partidas[0];
    assert.deepEqual([q.comprado, q.pendiente], ["0.000", "10.000"]);
    const audit = await db.registroAuditoria.findFirstOrThrow({ where: { entidadId: id, accion: "CAMBIAR_ESTATUS" } });
    assert.deepEqual(audit.valorNuevo, { estatus: "ANULADA", motivo: "Proveedor equivocado", liberaCantidades: false });
  });

  test("cancelación simultánea con la creación de dependencias y con un cobro", async () => {
    for (let i = 0; i < 2; i++) {
      const o = await orden();
      const [cancel, alta] = await Promise.allSettled([cancelarOrdenVenta(admin, o.ordenId, "Cancelación simultánea"), crearCompraComercial(director, o.ordenId, clave())]);
      const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } });
      const compras = await db.compraComercial.count({ where: { ordenVentaId: o.ordenId, estatus: { not: "ANULADA" } } });
      assert.equal([cancel, alta].filter((r) => r.status === "fulfilled").length, 1);
      assert.ok((ov.estatus === "CANCELADA" && compras === 0) || (ov.estatus === "VIGENTE" && compras === 1), `${ov.estatus}/${compras}`);
    }
    for (let i = 0; i < 2; i++) {
      const o = await orden();
      const [cancel, alta] = await Promise.allSettled([cancelarOrdenVenta(admin, o.ordenId, "Cancelación simultánea"), entregar(o, "1")]);
      const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } });
      const entregas = await db.entregaComercial.count({ where: { ordenVentaId: o.ordenId } });
      assert.equal([cancel, alta].filter((r) => r.status === "fulfilled").length, 1);
      assert.ok((ov.estatus === "CANCELADA" && entregas === 0) || (ov.estatus === "VIGENTE" && entregas === 1), `${ov.estatus}/${entregas}`);
    }
    for (let i = 0; i < 2; i++) {
      const o = await orden();
      const cxc = await cuentaOv(o.ordenId);
      await contado(cxc.id, "1160.00");
      const [cancel, cobro] = await Promise.allSettled([cancelarOrdenVenta(admin, o.ordenId, "Cancelación simultánea"), pagar(cxc.id, "100")]);
      const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } });
      const movs = await db.movimientoComercial.count({ where: { cuentaId: cxc.id } });
      assert.equal([cancel, cobro].filter((r) => r.status === "fulfilled").length, 1);
      assert.ok((ov.estatus === "CANCELADA" && movs === 0) || (ov.estatus === "VIGENTE" && movs === 1), `${ov.estatus}/${movs}`);
    }
  });

  test("aislamiento: otra Empresa no la encuentra y el vendedor no cancela ni consulta bloqueos", async () => {
    const o = await orden();
    await assert.rejects(cancelarOrdenVenta(adminAjeno, o.ordenId, "Intento ajeno"), RegistroNoEncontradoError);
    await assert.rejects(estadoCancelacionOrden(adminAjeno, o.ordenId), RegistroNoEncontradoError);
    await assert.rejects(cancelarOrdenVenta(vendedor, o.ordenId, "Intento del vendedor"), SinPermisoComercialError);
    await assert.rejects(estadoCancelacionOrden(vendedor, o.ordenId), SinPermisoComercialError);
    assert.equal((await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } })).estatus, "VIGENTE");
    assert.equal((await detalleCuentaDeOrden(admin, o.ordenId)).estatus, "VIGENTE");
    // La base: la cuenta por cobrar no se anula sin cancelar su OV.
    await assert.rejects(
      db.$executeRawUnsafe(`UPDATE cuentas_comerciales SET estatus = 'ANULADA', "anuladaEn" = now(), "anuladaPorId" = $2, "motivoAnulacion" = 'x' WHERE "ordenVentaId" = $1`, o.ordenId, adminBase.id),
      /solo se anula al cancelar su orden de venta/
    );
  });
});

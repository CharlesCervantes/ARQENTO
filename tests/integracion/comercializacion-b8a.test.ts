import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { anularCompraComercial, confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra } from "@/lib/server/comercializacion/compras";
import { anularEntregaComercial, registrarEntregaComercial, resumenEntregasOrden } from "@/lib/server/comercializacion/entregas";
import { anularVinculoSurtido, bloqueosSurtidoDeCompra, surtidoDeCompra, surtidoDeOrden, vincularSurtido } from "@/lib/server/comercializacion/surtido";
import { resultadoOrden } from "@/lib/server/comercializacion/gastos";
import { resumenFinancieroOrden } from "@/lib/server/comercializacion/cuentas";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { jpgFicticio, pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Comercialización B8A contra PostgreSQL REAL: vínculo entre lo entregado al
// cliente (B6A) y las compras que lo surtieron (B4), protección de la
// anulación de compras, correcciones y concurrencia. Datos ficticios.

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b8a", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const HOY = hoyNegocio();

let POSTE: string;
let TUBO: string;
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-b8a-${++n}-${Date.now()}`;
const evid = () => [{ nombre: "foto.jpg", bytes: new Uint8Array(jpgFicticio(`e${n}`)) }];

type Orden = { cotizacionId: string; ordenId: string; pv: Record<string, string> };

async function orden(partidas: [string, string][] = [[POSTE, "100"]]): Promise<Orden> {
  const { id } = await crearCotizacionVenta(
    admin,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia B8A", vendedorId: vendedor.id, impuestoVenta: "SIN_IVA", fecha: HOY, vigenciaHasta: HOY, partidas: partidas.map(([productoId, cantidad]) => ({ productoId, cantidad })) },
    clave()
  );
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pvs = await db.partidaCotizacionVenta.findMany({ where: { cotizacionId: id } });
  return { cotizacionId: id, ordenId: ov.ordenId, pv: Object.fromEntries(pvs.map((p) => [p.codigo, p.id])) };
}

async function compra(o: Orden, lineas: [string, string][], confirmar = true) {
  const { id } = await crearCompraComercial(admin, o.ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, {
    proveedorId: PROV,
    fecha: HOY,
    partidas: lineas.map(([codigo, cantidad]) => ({ partidaVentaId: o.pv[codigo], cantidad, costoUnitario: "50", tratamientoImpuesto: "SIN_IVA" })),
  });
  if (confirmar) await confirmarCompraComercial(admin, id, 2);
  const pcs = await db.partidaCompraComercial.findMany({ where: { compraId: id } });
  return { id, pc: Object.fromEntries(pcs.map((p) => [p.codigo, p.id])) as Record<string, string> };
}

async function entregar(o: Orden, lineas: [string, string][], u: UsuarioSesion = admin) {
  const e = await registrarEntregaComercial(u, o.ordenId, { fechaEntrega: HOY, partidas: lineas.map(([codigo, cantidad]) => ({ partidaVentaId: o.pv[codigo], cantidad })) }, evid(), clave());
  const pes = await db.partidaEntregaComercial.findMany({ where: { entregaId: e.entregaId }, include: { partidaVenta: { select: { codigo: true } } } });
  return { id: e.entregaId, numero: e.numero, pe: Object.fromEntries(pes.map((p) => [p.partidaVenta.codigo, p.id])) as Record<string, string> };
}

const vincular = (e: { id: string; pe: Record<string, string> }, lineas: [string, string, string][], k = clave(), u: UsuarioSesion = admin) =>
  vincularSurtido(u, e.id, lineas.map(([codigo, partidaCompraId, cantidad]) => ({ partidaEntregaId: e.pe[codigo], partidaCompraId, cantidad })), k);

const estadoCompra = async (id: string) => (await surtidoDeCompra(admin, id)).partidas.map((p) => [p.codigo, p.comprado, p.vinculado, p.sinVincular, p.entregas.map((e) => `E${e.numero}:${e.cantidad}`).join(",")]);
const pendienteEntrega = async (o: Orden, entregaId: string) => (await surtidoDeOrden(admin, o.ordenId))[entregaId].partidas.map((p) => [p.codigo, p.entregado, p.vinculado, p.pendiente]);

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B8A", email: "director-b8a@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  POSTE = (await crearProductoComercial(admin, { codigo: "POSTE", descripcion: "Poste ficticio", unidad: "pieza", precioVenta: "100", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  TUBO = (await crearProductoComercial(admin, { codigo: "TUBO", descripcion: "Tubo ficticio", unidad: "m", precioVenta: "50", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B8A" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B8A" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio B8A" })).id;
});

describe("Caso principal: 100 postes, compras A 60 y B 40, entregas 70 y 30", () => {
  test("vincula 60 A + 10 B a la Entrega 1 y 30 B a la Entrega 2; límites y bloqueos de anulación", async () => {
    const o = await orden();
    const A = await compra(o, [["POSTE", "60"]]);
    const B = await compra(o, [["POSTE", "40"]]);
    const e1 = await entregar(o, [["POSTE", "70"]]);
    // Recién registrada: sin vínculos inventados, origen pendiente.
    assert.deepEqual(await pendienteEntrega(o, e1.id), [["POSTE", "70.000", "0.000", "70.000"]]);
    assert.equal(await db.vinculoSurtidoComercial.count(), 0);
    // Excesos: 71 a la Entrega 1 y 41 desde B.
    await assert.rejects(vincular(e1, [["POSTE", A.pc.POSTE, "60"], ["POSTE", B.pc.POSTE, "11"]]), /la captura suma 71 pieza y supera lo entregado sin vincular \(70 pieza\)/);
    await assert.rejects(vincular(e1, [["POSTE", B.pc.POSTE, "41"]]), /solo tiene 40 pieza sin vincular/);
    assert.equal(await db.vinculoSurtidoComercial.count(), 0, "un rechazo no deja vínculos parciales");
    await vincular(e1, [["POSTE", A.pc.POSTE, "60"], ["POSTE", B.pc.POSTE, "10"]]);
    const e2 = await entregar(o, [["POSTE", "30"]]);
    await vincular(e2, [["POSTE", B.pc.POSTE, "30"]]);
    assert.deepEqual(await estadoCompra(A.id), [["POSTE", "60.000", "60.000", "0.000", "E1:60.000"]]);
    assert.deepEqual(await estadoCompra(B.id), [["POSTE", "40.000", "40.000", "0.000", "E1:10.000,E2:30.000"]]);
    assert.deepEqual(await pendienteEntrega(o, e2.id), [["POSTE", "30.000", "30.000", "0.000"]]);
    // No se anula A ni B mientras tengan vínculos vigentes.
    await assert.rejects(anularCompraComercial(admin, A.id, "Prueba"), /vinculadas a entregas vigentes \(Entrega 1\)/);
    await assert.rejects(anularCompraComercial(admin, B.id, "Prueba"), /vinculadas a entregas vigentes \(Entrega 1, Entrega 2\)/);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "VinculoSurtidoComercial", accion: "CREAR" } }), 2);
  });

  test("corregir un vínculo conserva el historial, deja pendiente la cantidad y no permite saltarse el bloqueo", async () => {
    const o = await orden();
    const A = await compra(o, [["POSTE", "60"]]);
    const B = await compra(o, [["POSTE", "40"]]);
    const e1 = await entregar(o, [["POSTE", "70"]]);
    await vincular(e1, [["POSTE", A.pc.POSTE, "60"], ["POSTE", B.pc.POSTE, "10"]]);
    const vB = await db.vinculoSurtidoComercial.findFirstOrThrow({ where: { compraId: B.id } });
    await anularVinculoSurtido(director, vB.id, "Era de la compra A, captura errónea");
    assert.deepEqual(await anularVinculoSurtido(admin, vB.id, "otra vez"), { existente: true });
    assert.deepEqual(await pendienteEntrega(o, e1.id), [["POSTE", "70.000", "60.000", "10.000"]]);
    const historial = (await surtidoDeOrden(admin, o.ordenId))[e1.id].partidas[0].vinculos;
    const anulado = historial.find((v) => v.id === vB.id)!;
    assert.deepEqual([anulado.estatus, anulado.vigente, anulado.cantidad, anulado.anulado?.motivo], ["ANULADO", false, "10.000", "Era de la compra A, captura errónea"]);
    assert.equal(historial.length, 2, "no se borra ni se sobrescribe");
    assert.deepEqual(await estadoCompra(B.id), [["POSTE", "40.000", "0.000", "40.000", ""]]);
    // B ya no tiene vínculos, pero la Entrega 1 sigue con 10 sin vincular: bloqueada.
    await assert.rejects(anularCompraComercial(admin, B.id, "Prueba"), /sin vincular .*\(Entrega 1\)/);
    assert.deepEqual(
      (await bloqueosSurtidoDeCompra(admin, B.id)).map((b) => b.entregas.map((e) => e.numero)),
      [[1]]
    );
    // Cantidades compradas y entregadas sin cambio.
    assert.equal((await db.partidaEntregaComercial.findUniqueOrThrow({ where: { id: e1.pe.POSTE } })).cantidad.toFixed(3), "70.000");
    assert.equal((await db.partidaCompraComercial.findUniqueOrThrow({ where: { id: B.pc.POSTE } })).cantidad.toFixed(3), "40.000");
  });

  test("una compra sin vínculos se anula si las entregas de sus materiales están cubiertas por otras compras", async () => {
    const o = await orden();
    const A = await compra(o, [["POSTE", "60"]]);
    const B = await compra(o, [["POSTE", "40"]]);
    const e1 = await entregar(o, [["POSTE", "50"]]);
    await assert.rejects(anularCompraComercial(admin, B.id, "Proveedor canceló"), /sin vincular/);
    await vincular(e1, [["POSTE", A.pc.POSTE, "50"]]);
    assert.deepEqual(await bloqueosSurtidoDeCompra(admin, B.id), []);
    await anularCompraComercial(admin, B.id, "Proveedor canceló");
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id: B.id } })).estatus, "ANULADA");
    // Una compra anulada no es elegible.
    const e2 = await entregar(o, [["POSTE", "5"]]);
    const elegibles = (await surtidoDeOrden(admin, o.ordenId))[e2.id].partidas[0].elegibles.map((x) => x.compraId);
    assert.deepEqual(elegibles, [A.id]);
    await assert.rejects(vincular(e2, [["POSTE", B.pc.POSTE, "5"]]), /confirmadas y vigentes/);
  });

  test("anular una entrega deja sin efecto sus vínculos sin tocar los de otras entregas", async () => {
    const o = await orden();
    const A = await compra(o, [["POSTE", "60"]]);
    const B = await compra(o, [["POSTE", "40"]]);
    const e1 = await entregar(o, [["POSTE", "70"]]);
    await vincular(e1, [["POSTE", A.pc.POSTE, "60"], ["POSTE", B.pc.POSTE, "10"]]);
    const e2 = await entregar(o, [["POSTE", "30"]]);
    await vincular(e2, [["POSTE", B.pc.POSTE, "30"]]);
    await anularEntregaComercial(admin, e2.id, "Entrega capturada por error");
    assert.deepEqual(await estadoCompra(B.id), [["POSTE", "40.000", "10.000", "30.000", "E1:10.000"]]);
    assert.deepEqual(await pendienteEntrega(o, e1.id), [["POSTE", "70.000", "70.000", "0.000"]]);
    const s2 = (await surtidoDeOrden(admin, o.ordenId))[e2.id];
    assert.deepEqual([s2.vigente, s2.partidas[0].vinculos.map((v) => [v.estatus, v.vigente]), s2.partidas[0].pendiente], [false, [["VIGENTE", false]], "0.000"]);
    await assert.rejects(vincular(e2, [["POSTE", B.pc.POSTE, "1"]]), /anulada/);
    // La base tampoco lo admite.
    await assert.rejects(
      db.vinculoSurtidoComercial.create({
        data: { empresaId: EMPRESA, partidaEntregaId: e2.pe.POSTE, partidaCompraId: B.pc.POSTE, ordenVentaId: o.ordenId, entregaId: e2.id, compraId: B.id, partidaVentaId: o.pv.POSTE, cantidad: "1", claveRegistro: "clave-directa-b8a-1", registradoPorId: admin.id },
      }),
      /entrega anulada/
    );
  });
});

describe("Cantidades, elegibilidad y aislamiento", () => {
  test("cantidades fraccionarias exactas y vinculación parcial", async () => {
    const o = await orden([[TUBO, "2.375"], [POSTE, "100"]]);
    const A = await compra(o, [["TUBO", "1.25"], ["POSTE", "100"]]);
    const B = await compra(o, [["TUBO", "1.125"]]);
    const e = await entregar(o, [["TUBO", "2.375"], ["POSTE", "70"]]);
    await vincular(e, [["TUBO", A.pc.TUBO, "1.25"], ["TUBO", B.pc.TUBO, "1.125"], ["POSTE", A.pc.POSTE, "20"]]);
    assert.deepEqual(await pendienteEntrega(o, e.id), [
      ["TUBO", "2.375", "2.375", "0.000"],
      ["POSTE", "70.000", "20.000", "50.000"],
    ]);
    await assert.rejects(vincular(e, [["POSTE", A.pc.POSTE, "0.0005"]]), /máximo 3 decimales/);
    await assert.rejects(vincular(e, [["TUBO", B.pc.TUBO, "0.001"]]), /supera lo entregado/);
    // Material distinto: la compra de tubo no surte postes (no se relaciona por nombre).
    await assert.rejects(vincular(e, [["POSTE", B.pc.TUBO, "1"]]), /no corresponde a este material/);
    const elegibles = (await surtidoDeOrden(admin, o.ordenId))[e.id].partidas.find((p) => p.codigo === "POSTE")!.elegibles;
    assert.deepEqual(elegibles.map((x) => [x.folio.startsWith("COC-"), x.comprado, x.vinculado, x.disponible]), [[true, "100.000", "20.000", "80.000"]]);
  });

  test("compras en borrador, otra OV u otra Empresa no se vinculan; el vendedor no consulta ni gestiona vínculos", async () => {
    const o = await orden();
    const otra = await orden();
    const borrador = await compra(o, [["POSTE", "10"]], false);
    const ajena = await compra(otra, [["POSTE", "10"]]);
    const A = await compra(o, [["POSTE", "60"]]);
    const e = await entregar(o, [["POSTE", "10"]], vendedor); // el vendedor registra sin elegir compras
    assert.deepEqual((await surtidoDeOrden(admin, o.ordenId))[e.id].partidas[0].elegibles.map((x) => x.compraId), [A.id]);
    await assert.rejects(vincular(e, [["POSTE", borrador.pc.POSTE, "1"]]), /confirmadas y vigentes/);
    await assert.rejects(vincular(e, [["POSTE", ajena.pc.POSTE, "1"]]), /confirmadas y vigentes de esta orden/);
    await assert.rejects(vincular(e, [["POSTE", A.pc.POSTE, "1"]], clave(), adminAjeno), RegistroNoEncontradoError);
    await assert.rejects(surtidoDeOrden(adminAjeno, o.ordenId), RegistroNoEncontradoError);
    await assert.rejects(surtidoDeCompra(adminAjeno, A.id), RegistroNoEncontradoError);
    for (const op of [
      () => surtidoDeOrden(vendedor, o.ordenId),
      () => surtidoDeCompra(vendedor, A.id),
      () => vincular(e, [["POSTE", A.pc.POSTE, "1"]], clave(), vendedor),
      () => bloqueosSurtidoDeCompra(vendedor, A.id),
    ]) {
      await assert.rejects(op(), SinPermisoComercialError);
    }
    await vincular(e, [["POSTE", A.pc.POSTE, "10"]]);
    const v = await db.vinculoSurtidoComercial.findFirstOrThrow();
    await assert.rejects(anularVinculoSurtido(vendedor, v.id, "no autorizado"), SinPermisoComercialError);
    await assert.rejects(anularVinculoSurtido(adminAjeno, v.id, "no autorizado"), RegistroNoEncontradoError);
    // El resumen de entregas del vendedor no lleva compras, proveedores ni vínculos.
    const texto = JSON.stringify(await resumenEntregasOrden(vendedor, o.ordenId));
    for (const prohibido of ["COC-", "Proveedor", "vinculo", "surtido", A.id]) assert.ok(!texto.includes(prohibido), `el vendedor no recibe «${prohibido}»`);
  });

  test("vincular y corregir no cambia cantidades, importes, saldos ni el resultado", async () => {
    const o = await orden();
    const A = await compra(o, [["POSTE", "60"]]);
    const B = await compra(o, [["POSTE", "40"]]);
    const e1 = await entregar(o, [["POSTE", "70"]]);
    const foto = async () => ({
      cuentas: await db.cuentaComercial.findMany({ orderBy: { id: "asc" } }),
      compras: await db.compraComercial.findMany({ orderBy: { id: "asc" } }),
      pc: await db.partidaCompraComercial.findMany({ orderBy: { id: "asc" } }),
      entregas: await db.entregaComercial.findMany({ orderBy: { id: "asc" } }),
      pe: await db.partidaEntregaComercial.findMany({ orderBy: { id: "asc" } }),
      ov: await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } }),
      resultado: await resultadoOrden(admin, o.ordenId),
      financiero: await resumenFinancieroOrden(admin, o.ordenId),
      entregasOv: await resumenEntregasOrden(admin, o.ordenId),
    });
    const antes = await foto();
    await vincular(e1, [["POSTE", A.pc.POSTE, "60"], ["POSTE", B.pc.POSTE, "10"]]);
    await anularVinculoSurtido(admin, (await db.vinculoSurtidoComercial.findFirstOrThrow({ where: { compraId: B.id } })).id, "Prueba de efectos");
    assert.deepEqual(await foto(), antes);
    const conteos = await Promise.all([db.ordenCompra.count(), db.movimientoSemanal.count(), db.gastoObra.count(), db.egreso.count(), db.ingreso.count()]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0]);
  });
});

describe("Concurrencia, idempotencia y base", () => {
  test("reintentos y simultáneas con la misma clave no duplican; capturas simultáneas distintas no exceden lo entregado", async () => {
    const o = await orden();
    const A = await compra(o, [["POSTE", "60"]]);
    const B = await compra(o, [["POSTE", "40"]]);
    const e1 = await entregar(o, [["POSTE", "70"]]);
    const k = clave();
    const r = await Promise.all([1, 2, 3].map(() => vincular(e1, [["POSTE", A.pc.POSTE, "30"]], k)));
    assert.equal(r.filter((x) => !x.existente).length, 1);
    assert.equal(await db.vinculoSurtidoComercial.count(), 1);
    await assert.rejects(vincularSurtido(admin, (await entregar(o, [["POSTE", "1"]])).id, [], k), /Clave de registro inválida|al menos una/);
    for (let ronda = 0; ronda < 3; ronda++) {
      const e = await entregar(o, [["POSTE", "5"]]).catch(() => null);
      if (!e) break;
      const res = await Promise.allSettled([vincular(e, [["POSTE", A.pc.POSTE, "4"]]), vincular(e, [["POSTE", B.pc.POSTE, "4"]])]);
      assert.equal(res.filter((x) => x.status === "fulfilled").length, 1, `ronda ${ronda}: solo una cabe en 5`);
      const total = await db.vinculoSurtidoComercial.aggregate({ where: { entregaId: e.id }, _sum: { cantidad: true } });
      assert.equal(total._sum.cantidad?.toFixed(3), "4.000");
    }
  });

  test("registrar una entrega y anular una compra a la vez: el estado final respeta el bloqueo", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const o = await orden();
      const A = await compra(o, [["POSTE", "60"]]);
      const B = await compra(o, [["POSTE", "40"]]);
      const e1 = await entregar(o, [["POSTE", "60"]]);
      await vincular(e1, [["POSTE", A.pc.POSTE, "60"]]);
      const [entrega, anulacion] = await Promise.allSettled([entregar(o, [["POSTE", "10"]]), anularCompraComercial(admin, B.id, "Simultánea")]);
      assert.equal(entrega.status, "fulfilled");
      const b = await db.compraComercial.findUniqueOrThrow({ where: { id: B.id } });
      if (anulacion.status === "fulfilled") {
        // La anulación ocurrió antes: la entrega nueva se registró después y queda pendiente de vincular (solo con A).
        assert.equal(b.estatus, "ANULADA");
      } else {
        assert.match(String((anulacion.reason as Error).message), /sin vincular/);
        assert.equal(b.estatus, "CONFIRMADA");
      }
    }
  });

  test("vincular y anular la entrega a la vez: nunca cuenta un vínculo de una entrega anulada", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const o = await orden();
      const A = await compra(o, [["POSTE", "60"]]);
      const e = await entregar(o, [["POSTE", "30"]]);
      const [v] = await Promise.allSettled([vincular(e, [["POSTE", A.pc.POSTE, "30"]]), anularEntregaComercial(admin, e.id, "Simultánea")]);
      if (v.status === "rejected") assert.match(String((v.reason as Error).message), /anulada/);
      assert.deepEqual(await estadoCompra(A.id), [["POSTE", "60.000", "0.000", "60.000", ""]]);
    }
  });

  test("la base exige las reglas: misma partida y OV, límites, inmutabilidad y anulación de compra protegida", async () => {
    const o = await orden([[POSTE, "100"], [TUBO, "2"]]);
    const A = await compra(o, [["POSTE", "60"], ["TUBO", "2"]]);
    const e = await entregar(o, [["POSTE", "70"]]);
    const base = { empresaId: EMPRESA, ordenVentaId: o.ordenId, entregaId: e.id, compraId: A.id, partidaEntregaId: e.pe.POSTE, partidaVentaId: o.pv.POSTE, registradoPorId: admin.id };
    await assert.rejects(db.vinculoSurtidoComercial.create({ data: { ...base, partidaCompraId: A.pc.TUBO, cantidad: "1", claveRegistro: "clave-directa-b8a-2" } }), /misma partida de venta/);
    await assert.rejects(db.vinculoSurtidoComercial.create({ data: { ...base, partidaCompraId: A.pc.POSTE, cantidad: "61", claveRegistro: "clave-directa-b8a-3" } }), /supera la cantidad comprada/);
    const v = await db.vinculoSurtidoComercial.create({ data: { ...base, partidaCompraId: A.pc.POSTE, cantidad: "60", claveRegistro: "clave-directa-b8a-4" } });
    await assert.rejects(db.vinculoSurtidoComercial.update({ where: { id: v.id }, data: { cantidad: "1" } }), /no se modifica/);
    await assert.rejects(db.vinculoSurtidoComercial.delete({ where: { id: v.id } }), /no se elimina/);
    // Anulación directa de la compra (con su cuenta ya anulada): la base la rechaza por los vínculos.
    await db.$executeRaw`UPDATE cuentas_comerciales SET estatus = 'ANULADA', "anuladaEn" = now(), "anuladaPorId" = ${admin.id}, "motivoAnulacion" = 'prueba' WHERE "compraId" = ${A.id}`;
    await assert.rejects(
      db.compraComercial.update({ where: { id: A.id }, data: { estatus: "ANULADA", anuladaEn: new Date(), anuladaPorId: admin.id, motivoAnulacion: "x" } }),
      /vinculadas a entregas vigentes/
    );
  });
});

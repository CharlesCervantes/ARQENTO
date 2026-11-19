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
import { anularMovimientoCuenta, definirCondicionesCuenta, indicadoresCuentasEmpresa, registrarMovimientoCuenta, resumenFinancieroOrden } from "@/lib/server/comercializacion/cuentas";
import { anularGastoComercial, obtenerComprobanteGasto, registrarGastoComercial, resultadoOrden, resumenGastosOrden } from "@/lib/server/comercializacion/gastos";
import { recordatoriosComerciales } from "@/lib/server/comercializacion/recordatorios";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Comercialización B7 contra PostgreSQL REAL: gastos adicionales con su cuenta
// por pagar (B5), resultado estimado por OV y simulación 50/50. Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b7", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const HOY = hoyNegocio();
const dias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let PIEZA: string; // gravado 16 %, $100
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let PROV_AJENO: string;
let n = 0;
const clave = () => `clave-b7-${++n}-${Date.now()}`;

/** OV de 100 piezas a $100 + IVA 16 % = $10,000 + $1,600. */
async function ordenPrincipal(partidas: { productoId: string; cantidad: string }[] = [{ productoId: PIEZA, cantidad: "100" }]) {
  const { id } = await crearCotizacionVenta(admin, { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia B7", vendedorId: vendedor.id, fecha: HOY, vigenciaHasta: HOY, partidas }, clave());
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pvs = await db.partidaCotizacionVenta.findMany({ where: { cotizacionId: id }, orderBy: { orden: "asc" } });
  return { cotizacionId: id, ordenId: ov.ordenId, pv: pvs.map((p) => p.id) };
}

async function compra(ordenId: string, lineas: { partidaVentaId: string; cantidad: string; costoUnitario: string; tratamientoImpuesto?: string; tasaIva?: string }[], confirmar = true) {
  const { id } = await crearCompraComercial(admin, ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, {
    proveedorId: PROV,
    fecha: HOY,
    partidas: lineas.map((l) => ({ tratamientoImpuesto: "GRAVADO", tasaIva: "16", ...l })),
  });
  if (confirmar) await confirmarCompraComercial(admin, id, 2);
  return id;
}

const gasto = (ordenId: string, extra: Record<string, unknown> = {}, k = clave(), u: UsuarioSesion = admin, archivo: { nombre: string; bytes: Uint8Array } | null = null) =>
  registrarGastoComercial(u, ordenId, { concepto: "Flete", beneficiarioId: PROV, fecha: HOY, subtotal: "1000", tratamientoImpuesto: "GRAVADO", tasaIva: "16", ...extra }, archivo, k);
const cuentaDeGasto = (gastoId: string) => db.cuentaComercial.findFirstOrThrow({ where: { gastoId } });
const contado = (cuentaId: string, version: number, importe: string, fecha = HOY) => definirCondicionesCuenta(admin, cuentaId, version, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: fecha, importe }] });
const pagar = (cuentaId: string, importe: string) => registrarMovimientoCuenta(admin, cuentaId, { importe, fecha: HOY, metodo: "TRANSFERENCIA" }, null, clave());
const resumenR = async (ordenId: string) => {
  const r = await resultadoOrden(admin, ordenId);
  return [r.estado, r.venta, r.compras, r.gastos, r.resultado, r.simulacion ? `${r.simulacion.socio1}/${r.simulacion.socio2}` : null];
};

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B7", email: "director-b7@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  PIEZA = (await crearProductoComercial(admin, { codigo: "PIEZA", descripcion: "Pieza ficticia", unidad: "pieza", precioVenta: "100", costoReferencia: "1", tratamientoImpuesto: "GRAVADO", tasaIva: "16" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B7" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B7" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Fletes ficticios B7" })).id;
  PROV_AJENO = (await crearProveedorComercial(adminAjeno, { nombre: "Proveedor ajeno B7" })).id;
});

describe("Caso principal", () => {
  test("venta $10,000 + IVA, materiales $6,000 + IVA, gasto $1,000 + IVA → resultado $3,000, 50/50 de $1,500; por cobrar $11,600 y por pagar $8,120", async () => {
    const o = await ordenPrincipal();
    await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "100", costoUnitario: "60" }]);
    const g = await gasto(o.ordenId);
    assert.deepEqual(await resumenR(o.ordenId), ["POSITIVO", "10000.00", "6000.00", "1000.00", "3000.00", "1500.00/1500.00"]);
    const f = await resumenFinancieroOrden(admin, o.ordenId);
    assert.deepEqual([f.porCobrar.saldo, f.porPagar.saldo, f.comprasConCuenta, f.gastosConCuenta], ["11600.00", "8120.00", 1, 1]);
    // Listado: «Por pagar» incluye el gasto una sola vez.
    assert.equal((await indicadoresCuentasEmpresa(admin)).porPagar.saldo, "8120.00");
    // El gasto entra con su cuenta en «Condiciones por definir».
    const cg = await cuentaDeGasto(g.gastoId);
    assert.deepEqual([cg.tipo, cg.total.toFixed(2), cg.modalidad, cg.estatus], ["POR_PAGAR", "1160.00", null, "VIGENTE"]);
    const det = (await resumenGastosOrden(admin, o.ordenId)).gastos[0];
    assert.deepEqual([det.numero, det.concepto, det.beneficiarioNombre, det.subtotal, det.iva, det.total, det.cuenta?.origen], [1, "Flete", "Fletes ficticios B7", "1000.00", "160.00", "1160.00", "GASTO"]);
    // Importes originales de la OV y de las compras intactos.
    const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } });
    assert.deepEqual([ov.subtotal.toFixed(2), ov.iva.toFixed(2), ov.total.toFixed(2)], ["10000.00", "1600.00", "11600.00"]);
  });

  test("pagar o cobrar parte o todo no cambia el resultado; anular un pago recupera la deuda sin retirar el gasto", async () => {
    const o = await ordenPrincipal();
    await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "100", costoUnitario: "60" }]);
    const g = await gasto(o.ordenId);
    const cg = await cuentaDeGasto(g.gastoId);
    await contado(cg.id, cg.version, "1160.00");
    const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await contado(cxc.id, cxc.version, "11600.00");
    const esperado = ["POSITIVO", "10000.00", "6000.00", "1000.00", "3000.00", "1500.00/1500.00"];
    const p1 = await pagar(cg.id, "500");
    assert.deepEqual(await resumenR(o.ordenId), esperado);
    await pagar(cg.id, "660");
    assert.deepEqual(await resumenR(o.ordenId), esperado);
    await pagar(cxc.id, "1000");
    assert.deepEqual(await resumenR(o.ordenId), esperado);
    await pagar(cxc.id, "10600");
    assert.deepEqual(await resumenR(o.ordenId), esperado);
    let f = await resumenFinancieroOrden(admin, o.ordenId);
    assert.deepEqual([f.porCobrar.saldo, f.porPagar.saldo], ["0.00", "6960.00"]);
    await anularMovimientoCuenta(admin, p1.movimientoId, "Pago capturado por error");
    f = await resumenFinancieroOrden(admin, o.ordenId);
    assert.equal(f.porPagar.saldo, "7460.00");
    assert.deepEqual(await resumenR(o.ordenId), esperado, "el gasto sigue en el resultado");
    // Con historial de pagos (aunque uno esté anulado) no se anula el gasto.
    await assert.rejects(anularGastoComercial(admin, g.gastoId, "Intento"), /historial de pagos/);
  });

  test("anular un gasto sin movimientos retira su costo y anula su cuenta, atómicamente e idempotente", async () => {
    const o = await ordenPrincipal();
    await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "100", costoUnitario: "60" }]);
    const g = await gasto(o.ordenId);
    await anularGastoComercial(director, g.gastoId, "Capturado en la OV equivocada");
    assert.deepEqual(await resumenR(o.ordenId), ["POSITIVO", "10000.00", "6000.00", "0.00", "4000.00", "2000.00/2000.00"]);
    const cg = await cuentaDeGasto(g.gastoId);
    assert.deepEqual([cg.estatus, cg.motivoAnulacion], ["ANULADA", "Capturado en la OV equivocada"]);
    assert.equal((await resumenFinancieroOrden(admin, o.ordenId)).porPagar.saldo, "6960.00");
    assert.deepEqual(await anularGastoComercial(admin, g.gastoId, "Otra vez"), { existente: true });
    const gg = await db.gastoComercial.findUniqueOrThrow({ where: { id: g.gastoId } });
    assert.deepEqual([gg.estatus, gg.subtotal.toFixed(2), gg.concepto], ["ANULADO", "1000.00", "Flete"], "se conserva el registro");
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "GastoComercial", entidadId: g.gastoId } }), 2);
    // Una cuenta anulada no admite pagos.
    await assert.rejects(contado(cg.id, cg.version, "1160.00"));
  });
});

describe("Avisos de B6B", () => {
  test("un gasto nuevo entra en «Condiciones por definir» y, con calendario, en el aviso que corresponde con su concepto y su OV", async () => {
    const o = await ordenPrincipal();
    const g = await gasto(o.ordenId, { concepto: "Maniobra de descarga" });
    const folioOv = (await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } })).folio;
    let v = await recordatoriosComerciales(admin, { categoria: "SIN_CONDICIONES" });
    const aviso = v.avisos.find((a) => a.tipo === "PAGO")!;
    assert.deepEqual([aviso.folio, aviso.contraparte, aviso.saldo, aviso.enlace], [
      `${folioOv} · Gasto 1 (Maniobra de descarga)`,
      "Fletes ficticios B7",
      "1160.00",
      `/comercializacion/cotizaciones/${o.cotizacionId}#gasto-${g.gastoId}`,
    ]);
    const cg = await cuentaDeGasto(g.gastoId);
    await contado(cg.id, cg.version, "1160.00", dias(-2));
    v = await recordatoriosComerciales(admin);
    assert.deepEqual(v.resumen.VENCIDO.pago, { cuotas: 1, cuentas: 1, importe: "1160.00" });
    await pagar(cg.id, "160");
    assert.equal((await recordatoriosComerciales(admin)).resumen.VENCIDO.pago.importe, "1000.00");
    await anularGastoComercial(admin, (await gasto(o.ordenId)).gastoId, "Duplicado");
    assert.equal((await recordatoriosComerciales(admin, { categoria: "SIN_CONDICIONES" })).resumen.SIN_CONDICIONES.pago.cuentas, 0, "el gasto anulado no genera avisos");
  });
});

describe("Costos incompletos y compras", () => {
  test("materiales incompletos bloquean la cifra final y la simulación; borradores y anuladas no cuentan", async () => {
    const o = await ordenPrincipal();
    await gasto(o.ordenId);
    let r = await resultadoOrden(admin, o.ordenId);
    assert.deepEqual([r.estado, r.resultado, r.simulacion, r.costosConocidos], ["INCOMPLETO", null, null, "1000.00"]);
    assert.deepEqual(r.faltantes.map((f) => [f.codigo, f.vendido, f.comprado, f.falta]), [["PIEZA", "100.000", "0.000", "100.000"]]);
    await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "60", costoUnitario: "60" }]);
    await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "40", costoUnitario: "60" }], false); // borrador
    r = await resultadoOrden(admin, o.ordenId);
    assert.deepEqual([r.estado, r.compras, r.faltantes[0].falta], ["INCOMPLETO", "3600.00", "40.000"]);
    const resto = await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "40", costoUnitario: "60" }]);
    assert.deepEqual(await resumenR(o.ordenId), ["POSITIVO", "10000.00", "6000.00", "1000.00", "3000.00", "1500.00/1500.00"]);
    await anularCompraComercial(admin, resto, "Proveedor canceló");
    r = await resultadoOrden(admin, o.ordenId);
    assert.deepEqual([r.estado, r.compras, r.resultado], ["INCOMPLETO", "3600.00", null]);
  });

  test("resultado cero, pérdida y positivo con centavo indivisible", async () => {
    const o = await ordenPrincipal();
    await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "100", costoUnitario: "70" }]); // 7,000 → 3,000 disponibles
    const g1 = await gasto(o.ordenId, { subtotal: "2999.99", tratamientoImpuesto: "EXENTO", tasaIva: undefined });
    assert.deepEqual(await resumenR(o.ordenId), ["POSITIVO", "10000.00", "7000.00", "2999.99", "0.01", "0.00/0.01"]);
    await gasto(o.ordenId, { subtotal: "0.01", tratamientoImpuesto: "TASA_CERO", tasaIva: undefined });
    assert.deepEqual(await resumenR(o.ordenId), ["CERO", "10000.00", "7000.00", "3000.00", "0.00", null]);
    await gasto(o.ordenId, { subtotal: "0.01", tratamientoImpuesto: "EXENTO", tasaIva: undefined });
    assert.deepEqual(await resumenR(o.ordenId), ["PERDIDA", "10000.00", "7000.00", "3000.01", "-0.01", null]);
    await anularGastoComercial(admin, g1.gastoId, "Prueba");
    await gasto(o.ordenId, { subtotal: "999.99", tratamientoImpuesto: "EXENTO", tasaIva: undefined });
    // 3,000 − 0.02 − 999.99 = 2,000.01 → 1,000.00 / 1,000.01 (remanente a la segunda).
    assert.deepEqual(await resumenR(o.ordenId), ["POSITIVO", "10000.00", "7000.00", "1000.01", "1999.99", "999.99/1000.00"]);
  });

  test("tasas mixtas y cantidades fraccionarias, importes exactos", async () => {
    const TUBO = (await crearProductoComercial(admin, { codigo: "TUBO", descripcion: "Tubo", unidad: "m", precioVenta: "100.10", costoReferencia: "", tratamientoImpuesto: "GRAVADO", tasaIva: "8" })).id;
    const CEM = (await crearProductoComercial(admin, { codigo: "CEM", descripcion: "Cemento", unidad: "t", precioVenta: "33.33", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
    const o = await ordenPrincipal([
      { productoId: TUBO, cantidad: "2.375" },
      { productoId: CEM, cantidad: "1.5" },
    ]);
    const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } });
    // 2.375 × 100.10 = 237.74 (half-up) y 1.5 × 33.33 = 50.00 (49.995 half-up).
    assert.equal(ov.subtotal.toFixed(2), "287.74");
    await compra(o.ordenId, [
      { partidaVentaId: o.pv[0], cantidad: "2.375", costoUnitario: "70.01" },
      { partidaVentaId: o.pv[1], cantidad: "1.5", costoUnitario: "20", tratamientoImpuesto: "SIN_IVA", tasaIva: undefined },
    ]);
    const g = await gasto(o.ordenId, { subtotal: "10.55", tasaIva: "8" });
    const det = (await resumenGastosOrden(admin, o.ordenId)).gastos.find((x) => x.id === g.gastoId)!;
    assert.deepEqual([det.iva, det.total], ["0.84", "11.39"]);
    // Compras: 2.375 × 70.01 = 166.27 (166.27375) + 30.00 = 196.27.
    assert.deepEqual(await resumenR(o.ordenId), ["POSITIVO", "287.74", "196.27", "10.55", "80.92", "40.46/40.46"]);
  });
});

describe("Captura, reintentos y concurrencia", () => {
  test("validaciones: impuesto explícito, tasa del gravado, beneficiario de la Empresa, fecha y comprobante", async () => {
    const o = await ordenPrincipal();
    await assert.rejects(gasto(o.ordenId, { tratamientoImpuesto: undefined }), /Selecciona el impuesto aplicable/);
    await assert.rejects(gasto(o.ordenId, { tasaIva: "" }), /tasa de IVA/);
    await assert.rejects(gasto(o.ordenId, { beneficiarioId: PROV_AJENO }), RegistroNoEncontradoError);
    await assert.rejects(gasto(o.ordenId, { fecha: dias(1) }), /futura/);
    await assert.rejects(gasto(o.ordenId, { subtotal: "0" }), /mayor que 0/);
    await assert.rejects(gasto(o.ordenId, { concepto: " " }), /concepto/);
    const grande = new Uint8Array(Buffer.concat([pdfFicticio("g"), Buffer.alloc(4 * 1024 * 1024)]));
    await assert.rejects(gasto(o.ordenId, {}, clave(), admin, { nombre: "g.pdf", bytes: grande }), /máximo es 4 MB. No se registró el gasto/);
    await assert.rejects(gasto(o.ordenId, {}, clave(), admin, { nombre: "x.pdf", bytes: new TextEncoder().encode("no") }), /PDF, JPG o PNG/);
    assert.equal(await db.gastoComercial.count(), 0);
    // Con comprobante válido: descarga solo administración.
    const g = await gasto(o.ordenId, {}, clave(), admin, { nombre: "factura.pdf", bytes: new Uint8Array(pdfFicticio("factura")) });
    assert.ok((await obtenerComprobanteGasto(director, g.gastoId)).bytes.length > 0);
    await assert.rejects(obtenerComprobanteGasto(vendedor, g.gastoId), SinPermisoComercialError);
    await assert.rejects(obtenerComprobanteGasto(adminAjeno, g.gastoId), RegistroNoEncontradoError);
  });

  test("reintentos y solicitudes simultáneas con la misma clave: un gasto, una cuenta", async () => {
    const o = await ordenPrincipal();
    const k = clave();
    const r1 = await gasto(o.ordenId, {}, k);
    const r2 = await gasto(o.ordenId, {}, k);
    assert.deepEqual([r2.gastoId, r2.existente], [r1.gastoId, true]);
    const k2 = clave();
    const simultaneos = await Promise.all([1, 2, 3].map(() => gasto(o.ordenId, { concepto: "Maniobra" }, k2, admin, { nombre: "c.pdf", bytes: new Uint8Array(pdfFicticio("c")) })));
    assert.equal(new Set(simultaneos.map((r) => r.gastoId)).size, 1);
    assert.equal(await db.gastoComercial.count(), 2);
    assert.equal(await db.cuentaComercial.count({ where: { gastoId: { not: null } } }), 2);
    assert.deepEqual((await db.gastoComercial.findMany({ orderBy: { numero: "asc" } })).map((g) => g.numero), [1, 2]);
    const conComprobante = [...almacenamiento.keys()].filter((key) => key.includes("/gastos/"));
    assert.equal(conComprobante.length, 1, "los perdedores eliminan su comprobante");
  });

  test("pago y anulación simultáneos: gana uno; nunca queda un gasto anulado con pagos ni una cuenta vigente de un gasto anulado", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const o = await ordenPrincipal();
      const g = await gasto(o.ordenId);
      const cg = await cuentaDeGasto(g.gastoId);
      await contado(cg.id, cg.version, "1160.00");
      const [pago, anulacion] = await Promise.allSettled([pagar(cg.id, "100"), anularGastoComercial(admin, g.gastoId, "Anulación simultánea")]);
      const gg = await db.gastoComercial.findUniqueOrThrow({ where: { id: g.gastoId } });
      const cc = await cuentaDeGasto(g.gastoId);
      const movs = await db.movimientoComercial.count({ where: { cuentaId: cc.id } });
      assert.ok((pago.status === "fulfilled") !== (anulacion.status === "fulfilled"), `ronda ${ronda}: exactamente una operación gana`);
      if (pago.status === "fulfilled") assert.deepEqual([gg.estatus, cc.estatus, cc.tuvoMovimientos, movs], ["VIGENTE", "VIGENTE", true, 1]);
      else assert.deepEqual([gg.estatus, cc.estatus, movs], ["ANULADO", "ANULADA", 0]);
    }
  });
});

describe("Permisos, aislamiento, base y efectos", () => {
  test("solo Administrador y Director de la Empresa; el vendedor no recibe gastos, cuentas, costos ni resultado", async () => {
    const o = await ordenPrincipal();
    const g = await gasto(o.ordenId);
    assert.equal((await resultadoOrden(director, o.ordenId)).gastos, "1000.00");
    for (const op of [
      () => resultadoOrden(vendedor, o.ordenId),
      () => resumenGastosOrden(vendedor, o.ordenId),
      () => gasto(o.ordenId, {}, clave(), vendedor),
      () => anularGastoComercial(vendedor, g.gastoId, "x x x"),
    ]) {
      await assert.rejects(op(), SinPermisoComercialError);
    }
    for (const op of [
      () => resultadoOrden(adminAjeno, o.ordenId),
      () => resumenGastosOrden(adminAjeno, o.ordenId),
      () => registrarGastoComercial(adminAjeno, o.ordenId, { concepto: "x", beneficiarioId: PROV_AJENO, fecha: HOY, subtotal: "1", tratamientoImpuesto: "EXENTO" }, null, clave()),
      () => anularGastoComercial(adminAjeno, g.gastoId, "x x x"),
    ]) {
      await assert.rejects(op(), RegistroNoEncontradoError);
    }
    await assert.rejects(
      resultadoOrden({ ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA, modulos: [] }), id: admin.id }, o.ordenId),
      SinPermisoComercialError
    );
    // Una cotización emitida sin aceptar no admite gastos.
    const { id } = await crearCotizacionVenta(admin, { clienteId: CLIENTE, obraId: OBRA, descripcion: "x", fecha: HOY, vigenciaHasta: HOY, partidas: [{ productoId: PIEZA, cantidad: "1" }] }, clave());
    await emitirCotizacionVenta(admin, id, 1);
    assert.equal(await db.ordenVenta.count({ where: { cotizacionId: id } }), 0);
  });

  test("la base exige las reglas: sin editar ni borrar, un solo origen por cuenta, cuenta obligatoria", async () => {
    const o = await ordenPrincipal();
    const g = await gasto(o.ordenId);
    await assert.rejects(db.gastoComercial.update({ where: { id: g.gastoId }, data: { subtotal: "1" } }), /no se modifica/);
    await assert.rejects(db.gastoComercial.delete({ where: { id: g.gastoId } }), /no se elimina/);
    // Anular el gasto directamente con su cuenta vigente: rechazado.
    await assert.rejects(
      db.gastoComercial.update({ where: { id: g.gastoId }, data: { estatus: "ANULADO", anuladoEn: new Date(), anuladoPorId: admin.id, motivoAnulacion: "x" } }),
      /cuenta por pagar sigue vigente/
    );
    const cg = await cuentaDeGasto(g.gastoId);
    await assert.rejects(db.cuentaComercial.update({ where: { id: cg.id }, data: { gastoId: null } }));
    const compraId = await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "1", costoUnitario: "1" }], false);
    await assert.rejects(db.cuentaComercial.create({ data: { empresaId: EMPRESA, tipo: "POR_PAGAR", compraId, gastoId: g.gastoId, total: "1" } }));
    await assert.rejects(db.cuentaComercial.create({ data: { empresaId: EMPRESA, tipo: "POR_PAGAR", gastoId: g.gastoId, total: "1160" } }), "una sola cuenta por gasto");
    // Un gasto sin cuenta no se confirma.
    await assert.rejects(
      db.gastoComercial.create({
        data: { empresaId: EMPRESA, ordenVentaId: o.ordenId, numero: 99, concepto: "x", beneficiarioId: PROV, beneficiarioNombre: "x", fecha: new Date(), subtotal: "1", tratamientoImpuesto: "EXENTO", iva: "0", total: "1", claveRegistro: "clave-directa-b7", registradoPorId: admin.id },
      }),
      /no tiene su cuenta por pagar/
    );
    // Impuesto incoherente.
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.gastoComercial.create({
          data: { empresaId: EMPRESA, ordenVentaId: o.ordenId, numero: 98, concepto: "x", beneficiarioId: PROV, beneficiarioNombre: "x", fecha: new Date(), subtotal: "1", tratamientoImpuesto: "EXENTO", iva: "0.16", total: "1.16", claveRegistro: "clave-directa-b7-2", registradoPorId: admin.id },
        });
      })
    );
  });

  test("sin efectos en construcción ni en los importes de la OV y las compras", async () => {
    const o = await ordenPrincipal();
    const c = await compra(o.ordenId, [{ partidaVentaId: o.pv[0], cantidad: "100", costoUnitario: "60" }]);
    const antes = await db.compraComercial.findUniqueOrThrow({ where: { id: c } });
    const g = await gasto(o.ordenId);
    await resultadoOrden(admin, o.ordenId);
    await anularGastoComercial(admin, g.gastoId, "Prueba");
    const despues = await db.compraComercial.findUniqueOrThrow({ where: { id: c } });
    assert.deepEqual([despues.subtotal.toFixed(2), despues.total.toFixed(2), despues.updatedAt], [antes.subtotal.toFixed(2), antes.total.toFixed(2), antes.updatedAt]);
    const conteos = await Promise.all([db.ordenCompra.count(), db.movimientoSemanal.count(), db.gastoObra.count(), db.egreso.count(), db.ingreso.count(), db.movimientoFinancieroCliente.count()]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0]);
  });
});

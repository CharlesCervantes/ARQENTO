import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra, obtenerCompraComercial } from "@/lib/server/comercializacion/compras";
import { anularMovimientoCuenta, definirCondicionesCuenta, detalleCuentaDeCompra, registrarMovimientoCuenta } from "@/lib/server/comercializacion/cuentas";
import { registrarGastoComercial } from "@/lib/server/comercializacion/gastos";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, admin as adminBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Ajustes de compras y crédito al proveedor (nov-2026) contra PostgreSQL REAL:
// selector «Sin IVA» / «IVA 16 %», conservación de impuestos históricos y
// mensualidades automáticas sobre las cuentas y cuotas de B5. Datos ficticios.

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId: EMPRESA, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR");
const vendedor = sesion(supervisor.id, "SUPERVISOR", true);
const HOY = hoyNegocio();

let POSTE: string;
let TUBO: string;
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-cc-${++n}-${Date.now()}`;

type Orden = { ordenId: string; pv: Record<string, string> };

async function orden(): Promise<Orden> {
  const { id } = await crearCotizacionVenta(
    admin,
    {
      clienteId: CLIENTE,
      obraId: OBRA,
      descripcion: "Venta ficticia compras-crédito",
      vendedorId: vendedor.id,
      impuestoVenta: "SIN_IVA",
      fecha: HOY,
      vigenciaHasta: HOY,
      partidas: [
        { productoId: POSTE, cantidad: "100" },
        { productoId: TUBO, cantidad: "10" },
      ],
    },
    clave()
  );
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pvs = await db.partidaCotizacionVenta.findMany({ where: { cotizacionId: id } });
  return { ordenId: ov.ordenId, pv: Object.fromEntries(pvs.map((p) => [p.codigo, p.id])) };
}

type Linea = { codigo: string; cantidad: string; costo: string; t: string; tasa?: string };
const partidas = (o: Orden, lineas: Linea[]) =>
  lineas.map((l) => ({ partidaVentaId: o.pv[l.codigo], cantidad: l.cantidad, costoUnitario: l.costo, tratamientoImpuesto: l.t, tasaIva: l.tasa ?? "" }));

async function compra(o: Orden, lineas: Linea[], confirmar = true) {
  const { id } = await crearCompraComercial(admin, o.ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV, fecha: HOY, partidas: partidas(o, lineas) });
  if (confirmar) await confirmarCompraComercial(admin, id, 2);
  return id;
}

const cuentaDeCompra = (compraId: string) => db.cuentaComercial.findFirstOrThrow({ where: { compraId } });
const mensual = (plazo: unknown, primerVencimiento: string) => ({ modalidad: "CREDITO", mensualidades: { plazo, primerVencimiento } });
const cuotasVigentes = async (cuentaId: string) =>
  (await db.cuotaCuentaComercial.findMany({ where: { cuentaId, vigente: true }, orderBy: { numero: "asc" } })).map((q) => [q.fechaVencimiento.toISOString().slice(0, 10), q.importe.toFixed(2)]);
const cabecera = async (compraId: string) => {
  const c = await db.compraComercial.findUniqueOrThrow({ where: { id: compraId } });
  return [c.subtotal.toFixed(2), c.iva.toFixed(2), c.total.toFixed(2)];
};

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  POSTE = (await crearProductoComercial(admin, { codigo: "POSTE", descripcion: "Poste ficticio", unidad: "pieza", precioVenta: "100", costoReferencia: "", tratamientoImpuesto: "GRAVADO", tasaIva: "16" })).id;
  TUBO = (await crearProductoComercial(admin, { codigo: "TUBO", descripcion: "Tubo ficticio", unidad: "m", precioVenta: "50", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio compras-crédito" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra compras-crédito" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio compras-crédito" })).id;
});

describe("Impuesto de compras: «Sin IVA» / «IVA 16 %»", () => {
  test("compra sin IVA: subtotal = total, IVA $0 y la cuenta por pagar nace por ese total", async () => {
    const o = await orden();
    const id = await compra(o, [{ codigo: "POSTE", cantidad: "10", costo: "80.50", t: "SIN_IVA" }]);
    assert.deepEqual(await cabecera(id), ["805.00", "0.00", "805.00"]);
    const c = await obtenerCompraComercial(admin, id);
    assert.deepEqual([c.partidas[0].tratamientoImpuesto, c.partidas[0].tasaIva], ["SIN_IVA", null]);
    assert.deepEqual([c.totales.baseSinIva, c.totales.baseExenta, c.totales.baseTasaCero, c.totales.gravado.length], ["805.00", "0.00", "0.00", 0]);
    assert.equal((await cuentaDeCompra(id)).total.toFixed(2), "805.00");
  });

  test("compra con IVA: 16 % sobre el importe sin IVA, y mezcla con partidas sin IVA", async () => {
    const o = await orden();
    // 2.375 × 98.76 = 234.555 → 234.56; IVA 37.5296 → 37.53. Tubo sin IVA 1.5 × 20 = 30.00.
    const id = await compra(o, [
      { codigo: "POSTE", cantidad: "2.375", costo: "98.76", t: "GRAVADO", tasa: "16" },
      { codigo: "TUBO", cantidad: "1.5", costo: "20", t: "SIN_IVA" },
    ]);
    assert.deepEqual(await cabecera(id), ["264.56", "37.53", "302.09"]);
    const c = await obtenerCompraComercial(admin, id);
    assert.deepEqual(c.totales.gravado, [{ tasa: "16.00", base: "234.56", iva: "37.53" }]);
    assert.equal(c.totales.baseSinIva, "30.00");
    assert.equal((await cuentaDeCompra(id)).total.toFixed(2), "302.09");
  });

  test("las partidas nuevas solo admiten «Sin IVA» o «IVA 16 %»; catálogo y gastos no admiten «Sin IVA»", async () => {
    const o = await orden();
    const { id } = await crearCompraComercial(admin, o.ordenId, clave());
    const guardar = (l: Linea) => guardarBorradorCompra(admin, id, 1, { proveedorId: PROV, fecha: HOY, partidas: partidas(o, [l]) });
    await assert.rejects(guardar({ codigo: "POSTE", cantidad: "1", costo: "10", t: "EXENTO" }), /«Sin IVA» o «IVA 16 %» \(Exento solo se conserva/);
    await assert.rejects(guardar({ codigo: "POSTE", cantidad: "1", costo: "10", t: "TASA_CERO" }), /Tasa 0 % solo se conserva/);
    await assert.rejects(guardar({ codigo: "POSTE", cantidad: "1", costo: "10", t: "GRAVADO", tasa: "8" }), /IVA 8 % solo se conserva/);
    await assert.rejects(guardar({ codigo: "POSTE", cantidad: "1", costo: "10", t: "SIN_IVA", tasa: "16" }), /solo aplica a partidas con IVA/);
    assert.equal(await db.partidaCompraComercial.count({ where: { compraId: id } }), 0);
    // El catálogo no guarda impuesto (IVA por cotización, nov-2026): el campo
    // enviado se ignora y la base rechaza «Sin IVA» en productos. En ventas,
    // «Sin IVA» es la opción de la cotización (ver comercializacion-iva-cotizacion).
    const x = await crearProductoComercial(admin, { codigo: "X", descripcion: "x", unidad: "pz", precioVenta: "1", costoReferencia: "", tratamientoImpuesto: "SIN_IVA", tasaIva: "" });
    assert.equal((await db.productoComercial.findUniqueOrThrow({ where: { id: x.id } })).tratamientoImpuesto, null);
    await assert.rejects(db.$executeRawUnsafe(`UPDATE productos_comerciales SET "tratamientoImpuesto" = 'SIN_IVA', "tasaIva" = NULL WHERE id = $1`, TUBO), /sin_iva_solo_compras/);
    await assert.rejects(
      registrarGastoComercial(admin, o.ordenId, { concepto: "Flete", beneficiarioId: PROV, fecha: HOY, subtotal: "100", tratamientoImpuesto: "SIN_IVA" }, null, clave()),
      /impuesto/i
    );
    assert.equal(await db.gastoComercial.count(), 0);
  });

  test("impuestos históricos: tasa 0 %, exento y otras tasas se conservan sin recalcular", async () => {
    const o = await orden();
    // Borrador anterior al ajuste (simulado en esta base de pruebas): partidas con tratamientos previos.
    const { id } = await crearCompraComercial(admin, o.ordenId, clave());
    await guardarBorradorCompra(admin, id, 1, {
      proveedorId: PROV,
      fecha: HOY,
      partidas: partidas(o, [
        { codigo: "POSTE", cantidad: "1.5", costo: "100", t: "SIN_IVA" },
        { codigo: "TUBO", cantidad: "0.125", costo: "2500", t: "SIN_IVA" },
      ]),
    });
    await db.partidaCompraComercial.updateMany({ where: { compraId: id, codigo: "POSTE" }, data: { tratamientoImpuesto: "GRAVADO", tasaIva: "8" } });
    await db.partidaCompraComercial.updateMany({ where: { compraId: id, codigo: "TUBO" }, data: { tratamientoImpuesto: "TASA_CERO" } });
    // Guardar el borrador SIN cambiar esas partidas conserva su distinción y recalcula con sus reglas originales.
    const historico: Linea[] = [
      { codigo: "POSTE", cantidad: "1.5", costo: "100", t: "GRAVADO", tasa: "8" },
      { codigo: "TUBO", cantidad: "0.125", costo: "2500", t: "TASA_CERO" },
    ];
    await guardarBorradorCompra(admin, id, 2, { proveedorId: PROV, fecha: HOY, notas: "nota", partidas: partidas(o, historico) });
    assert.deepEqual(await cabecera(id), ["462.50", "12.00", "474.50"]);
    // Cambiar a otro tratamiento anterior no se permite; sí a una opción vigente.
    await assert.rejects(
      guardarBorradorCompra(admin, id, 3, { proveedorId: PROV, fecha: HOY, partidas: partidas(o, [{ ...historico[0] }, { ...historico[1], t: "EXENTO" }]) }),
      /Exento solo se conserva/
    );
    await confirmarCompraComercial(admin, id, 3);
    const c = await obtenerCompraComercial(admin, id);
    assert.deepEqual(
      c.partidas.map((p) => [p.codigo, p.tratamientoImpuesto, p.tasaIva, p.importe]),
      [
        ["POSTE", "GRAVADO", "8.00", "150.00"],
        ["TUBO", "TASA_CERO", null, "312.50"],
      ]
    );
    assert.deepEqual(c.totales.gravado, [{ tasa: "8.00", base: "150.00", iva: "12.00" }]);
    assert.deepEqual([c.totales.baseTasaCero, c.totales.baseSinIva, c.totales.total], ["312.50", "0.00", "474.50"]);
    assert.deepEqual(await cabecera(id), ["462.50", "12.00", "474.50"]);
    assert.equal((await cuentaDeCompra(id)).total.toFixed(2), "474.50");
    // Confirmada = inmutable: la base no permite tocar sus partidas.
    await assert.rejects(db.partidaCompraComercial.updateMany({ where: { compraId: id }, data: { tratamientoImpuesto: "SIN_IVA", tasaIva: null } }));
  });
});

describe("Mensualidades automáticas del crédito al proveedor", () => {
  test("los cinco plazos: cuotas mensuales que suman el total con IVA; la última ajusta centavos", async () => {
    const o = await orden();
    // 10 × 100 + IVA 16 % = 1,160.00
    const id = await compra(o, [{ codigo: "POSTE", cantidad: "10", costo: "100", t: "GRAVADO", tasa: "16" }]);
    const cuenta = await cuentaDeCompra(id);
    assert.equal(cuenta.total.toFixed(2), "1160.00");
    let version = cuenta.version;
    const esperado: Record<number, [string, string]> = { 3: ["386.66", "386.68"], 6: ["193.33", "193.35"], 12: ["96.66", "96.74"], 18: ["64.44", "64.52"], 24: ["48.33", "48.41"] };
    for (const plazo of [3, 6, 12, 18, 24]) {
      ({ version } = await definirCondicionesCuenta(admin, cuenta.id, version, mensual(plazo, "2027-01-15")));
      const cuotas = await cuotasVigentes(cuenta.id);
      assert.equal(cuotas.length, plazo);
      assert.equal(cuotas.reduce((s, [, i]) => s + Math.round(Number(i) * 100), 0), 116000);
      assert.deepEqual([cuotas[0][1], cuotas[plazo - 1][1]], esperado[plazo]);
      assert.ok(cuotas.slice(0, -1).every(([, i]) => i === esperado[plazo][0]));
      assert.deepEqual([cuotas[0][0], cuotas[1][0], cuotas[plazo - 1][0]], ["2027-01-15", "2027-02-15", plazo === 3 ? "2027-03-15" : cuotas[plazo - 1][0]]);
    }
    const d = await detalleCuentaDeCompra(admin, id);
    assert.deepEqual([d!.modalidad, d!.estado.aplicado, d!.estado.saldo, d!.movimientos.length], ["CREDITO", "0.00", "1160.00", 0]);
    // Cada sustitución conserva el calendario anterior (sin borrar historial).
    assert.equal(await db.cuotaCuentaComercial.count({ where: { cuentaId: cuenta.id, vigente: false } }), 3 + 6 + 12 + 18);
    const audit = await db.registroAuditoria.findFirst({ where: { entidadId: cuenta.id }, orderBy: { createdAt: "desc" } });
    assert.deepEqual((audit?.valorNuevo as { generacion: unknown }).generacion, { plazoMeses: 24, primerVencimiento: "2027-01-15" });
  });

  test("primer vencimiento en día 29, 30 o 31: último día del mes corto y se recupera el día original", async () => {
    const o = await orden();
    const id = await compra(o, [{ codigo: "POSTE", cantidad: "3", costo: "100", t: "SIN_IVA" }]);
    const cuenta = await cuentaDeCompra(id);
    let { version } = await definirCondicionesCuenta(admin, cuenta.id, cuenta.version, mensual(3, "2027-01-31"));
    assert.deepEqual(await cuotasVigentes(cuenta.id), [
      ["2027-01-31", "100.00"],
      ["2027-02-28", "100.00"],
      ["2027-03-31", "100.00"],
    ]);
    ({ version } = await definirCondicionesCuenta(admin, cuenta.id, version, mensual(3, "2027-01-30")));
    assert.deepEqual((await cuotasVigentes(cuenta.id)).map(([f]) => f), ["2027-01-30", "2027-02-28", "2027-03-30"]);
    ({ version } = await definirCondicionesCuenta(admin, cuenta.id, version, mensual(3, "2028-01-29")));
    assert.deepEqual((await cuotasVigentes(cuenta.id)).map(([f]) => f), ["2028-01-29", "2028-02-29", "2028-03-29"]);
    ({ version } = await definirCondicionesCuenta(admin, cuenta.id, version, mensual(6, "2027-08-31")));
    assert.deepEqual((await cuotasVigentes(cuenta.id)).map(([f]) => f), ["2027-08-31", "2027-09-30", "2027-10-31", "2027-11-30", "2027-12-31", "2028-01-31"]);
  });

  test("validación en servidor: plazo, fecha, importes mínimos, origen y permisos; nada se guarda", async () => {
    const o = await orden();
    const id = await compra(o, [{ codigo: "POSTE", cantidad: "1", costo: "0.05", t: "SIN_IVA" }]);
    const cuenta = await cuentaDeCompra(id);
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, cuenta.version, mensual(6, "2027-01-10")), /no alcanza para 6 mensualidades/);
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, cuenta.version, mensual(4, "2027-01-10")), /3, 6, 12, 18 o 24/);
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, cuenta.version, mensual("3", "2027-01-10")), /3, 6, 12, 18 o 24/);
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, cuenta.version, mensual(3, "2027-02-30")), /primer vencimiento/);
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, cuenta.version, { modalidad: "CONTADO", mensualidades: { plazo: 3, primerVencimiento: "2027-01-10" } }), /de crédito/);
    // No se aceptan importes del navegador junto con el plazo.
    await assert.rejects(
      definirCondicionesCuenta(admin, cuenta.id, cuenta.version, { ...mensual(3, "2027-01-10"), cuotas: [{ fechaVencimiento: "2027-01-10", importe: "0.05" }] }),
      /no ambos/
    );
    await assert.rejects(definirCondicionesCuenta(vendedor, cuenta.id, cuenta.version, mensual(3, "2027-01-10")), SinPermisoComercialError);
    // Las cuentas por cobrar y las de gastos conservan solo la captura manual.
    const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await assert.rejects(definirCondicionesCuenta(admin, cxc.id, cxc.version, mensual(3, "2027-01-10")), /solo aplican al crédito de compras/);
    assert.equal(await db.cuotaCuentaComercial.count(), 0);
  });

  test("cuotas manuales conservan el comportamiento actual", async () => {
    const o = await orden();
    const id = await compra(o, [{ codigo: "POSTE", cantidad: "10", costo: "100", t: "SIN_IVA" }]);
    const cuenta = await cuentaDeCompra(id);
    const manual = (cuotas: [string, string][]) => ({ modalidad: "CREDITO", cuotas: cuotas.map(([fechaVencimiento, importe]) => ({ fechaVencimiento, importe })) });
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, cuenta.version, manual([["2027-01-10", "500"]])), /deben coincidir exactamente/);
    // Propuesta automática pasada a edición manual: fechas e importes ajustados a mano.
    const { version } = await definirCondicionesCuenta(
      admin,
      cuenta.id,
      cuenta.version,
      manual([
        ["2027-03-10", "400"],
        ["2027-01-10", "300"],
        ["2027-02-20", "300"],
      ])
    );
    assert.deepEqual(await cuotasVigentes(cuenta.id), [
      ["2027-01-10", "300.00"],
      ["2027-02-20", "300.00"],
      ["2027-03-10", "400.00"],
    ]);
    await definirCondicionesCuenta(admin, cuenta.id, version, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: "2027-01-31", importe: "1000" }] });
    assert.deepEqual(await cuotasVigentes(cuenta.id), [["2027-01-31", "1000.00"]]);
  });

  test("con movimientos registrados (aunque se anulen) ya no se regenera ni se sustituye el calendario", async () => {
    const o = await orden();
    const id = await compra(o, [{ codigo: "POSTE", cantidad: "12", costo: "100", t: "SIN_IVA" }]);
    const cuenta = await cuentaDeCompra(id);
    const { version } = await definirCondicionesCuenta(admin, cuenta.id, cuenta.version, mensual(3, "2027-01-15"));
    const antes = await cuotasVigentes(cuenta.id);
    const { movimientoId } = await registrarMovimientoCuenta(admin, cuenta.id, { importe: "100", fecha: HOY, metodo: "TRANSFERENCIA" }, null, clave());
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, version, mensual(6, "2027-01-15")), /tiene cobros o pagos registrados/);
    await anularMovimientoCuenta(admin, movimientoId, "Captura equivocada");
    const v = (await cuentaDeCompra(id)).version;
    await assert.rejects(definirCondicionesCuenta(admin, cuenta.id, v, mensual(6, "2027-01-15")), /tiene cobros o pagos registrados/);
    await assert.rejects(
      definirCondicionesCuenta(admin, cuenta.id, v, { modalidad: "CREDITO", cuotas: [{ fechaVencimiento: "2027-01-15", importe: "1200" }] }),
      /tiene cobros o pagos registrados/
    );
    assert.deepEqual(await cuotasVigentes(cuenta.id), antes);
  });
});

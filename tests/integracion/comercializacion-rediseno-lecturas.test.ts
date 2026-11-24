import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import {
  anularCompraComercial,
  confirmarCompraComercial,
  crearCompraComercial,
  crearProveedorComercial,
  guardarBorradorCompra,
  obtenerCompraComercial,
  resumenComprasOrden,
} from "@/lib/server/comercializacion/compras";
import { definirCondicionesCuenta, detalleCuentaDeCompra, estadoPagoDeCompras, registrarMovimientoCuenta } from "@/lib/server/comercializacion/cuentas";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Rediseño de Comercialización — lecturas de apoyo del expediente contra
// PostgreSQL REAL (sin tablas ni migraciones nuevas):
// - estadoPagoDeCompras: mismo estado que el bloque de pagos de cada compra,
//   solo administración y solo de su Empresa.
// - resumenComprasOrden: fechas y autores de confirmación/anulación para la
//   actividad.
// - obtenerCompraComercial: contexto de la operación de origen.
// Datos ficticios.

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const HOY = hoyNegocio();
const dias = (d: number) => {
  const f = new Date(`${HOY}T00:00:00Z`);
  f.setUTCDate(f.getUTCDate() + d);
  return f.toISOString().slice(0, 10);
};

let PRODUCTO: string;
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-rediseno-${++n}-${Date.now()}`;

async function orden() {
  const { id } = await crearCotizacionVenta(
    admin,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Suministro ficticio para Torre A", vendedorId: vendedor.id, impuestoVenta: "SIN_IVA", fecha: dias(-5), vigenciaHasta: dias(10), partidas: [{ productoId: PRODUCTO, cantidad: "10" }] },
    clave()
  );
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pv = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
  return { ordenId: ov.ordenId, partidaVentaId: pv.id };
}
async function compra(o: Awaited<ReturnType<typeof orden>>, cantidad: string, confirmar = true) {
  const { id } = await crearCompraComercial(admin, o.ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, {
    proveedorId: PROV,
    fecha: HOY,
    partidas: [{ partidaVentaId: o.partidaVentaId, cantidad, costoUnitario: "100", tratamientoImpuesto: "SIN_IVA", tasaIva: "" }],
  });
  if (confirmar) await confirmarCompraComercial(admin, id, 2);
  return id;
}

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  PRODUCTO = (await crearProductoComercial(admin, { codigo: "PERFIL", descripcion: "Perfil ficticio", unidad: "pieza", precioVenta: "150", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Constructora ficticia" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Torre A ficticia" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio rediseño" })).id;
});

describe("Rediseño — lecturas del expediente", () => {
  test("estadoPagoDeCompras coincide con el bloque de pagos de cada compra y marca la anulada", async () => {
    const o = await orden();
    const conPago = await compra(o, "4"); // $400
    const anulada = await compra(o, "2"); // $200
    const cuenta = await db.cuentaComercial.findFirstOrThrow({ where: { compraId: conPago } });
    await definirCondicionesCuenta(admin, cuenta.id, cuenta.version, {
      modalidad: "CREDITO",
      cuotas: [
        { fechaVencimiento: dias(-2), importe: "150" },
        { fechaVencimiento: dias(20), importe: "250" },
      ],
    });
    await registrarMovimientoCuenta(admin, cuenta.id, { importe: "100", fecha: HOY, metodo: "TRANSFERENCIA" }, null, clave());
    await anularCompraComercial(admin, anulada, "Captura duplicada");

    const mapa = await estadoPagoDeCompras(admin, [conPago, anulada]);
    const detalle = (await detalleCuentaDeCompra(admin, conPago))!;
    const e = mapa.get(conPago)!;
    assert.deepEqual(
      [e.total, e.aplicado, e.saldo, e.vencido, e.liquidacion, e.situacion, e.anulada],
      [detalle.estado.total, detalle.estado.aplicado, detalle.estado.saldo, detalle.estado.vencido, detalle.estado.liquidacion, detalle.estado.situacion, false]
    );
    assert.deepEqual([e.total, e.aplicado, e.saldo, e.vencido], ["400.00", "100.00", "300.00", "50.00"]);
    assert.equal(mapa.get(anulada)!.anulada, true);
  });

  test("estadoPagoDeCompras: el vendedor no la recibe y otra Empresa no ve compras ajenas", async () => {
    const o = await orden();
    const id = await compra(o, "1");
    await assert.rejects(() => estadoPagoDeCompras(vendedor, [id]), SinPermisoComercialError);
    assert.equal((await estadoPagoDeCompras(adminAjeno, [id])).size, 0);
    assert.equal((await estadoPagoDeCompras(admin, [])).size, 0);
  });

  test("resumenComprasOrden informa confirmación y anulación con su autor; un borrador descartado no figura como confirmado", async () => {
    const o = await orden();
    const confirmada = await compra(o, "3");
    const descartada = await compra(o, "1", false);
    await anularCompraComercial(admin, descartada, "Borrador sin uso");
    const nombre = (await db.usuario.findUniqueOrThrow({ where: { id: adminBase.id } })).nombre;

    const r = await resumenComprasOrden(admin, o.ordenId);
    const c = r.compras.find((x) => x.id === confirmada)!;
    const d = r.compras.find((x) => x.id === descartada)!;
    assert.equal(c.confirmada?.porNombre, nombre);
    assert.ok(c.confirmada?.en && !Number.isNaN(Date.parse(c.confirmada.en)));
    assert.equal(c.anulada, null);
    assert.equal(d.confirmada, null);
    assert.equal(d.anulada?.porNombre, nombre);
    assert.equal(d.estatus, "ANULADA");
  });

  test("obtenerCompraComercial incluye la operación de origen (descripción, cliente y obra)", async () => {
    const o = await orden();
    const id = await compra(o, "1", false);
    const c = await obtenerCompraComercial(admin, id);
    assert.deepEqual([c.orden.descripcion, c.orden.clienteNombre, c.orden.obraNombre], ["Suministro ficticio para Torre A", "Constructora ficticia", "Torre A ficticia"]);
    await assert.rejects(() => obtenerCompraComercial(vendedor, id), SinPermisoComercialError);
  });
});

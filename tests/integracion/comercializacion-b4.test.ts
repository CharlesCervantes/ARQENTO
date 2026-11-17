import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { crearProductoComercial, editarProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta, obtenerCotizacionVenta, listarCotizacionesVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import {
  adjuntarDocumentoCompra,
  anularCompraComercial,
  confirmarCompraComercial,
  crearCompraComercial,
  crearProveedorComercial,
  guardarBorradorCompra,
  listarProveedoresComerciales,
  obtenerCompraComercial,
  obtenerDocumentoCompra,
  resumenComprasOrden,
} from "@/lib/server/comercializacion/compras";
import { ConflictoEdicionError } from "@/lib/server/comercializacion/cotizaciones";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, sinInterbloqueos, supervisor } from "./apoyo/base";

// Comercialización B4 contra PostgreSQL REAL: compras a proveedores de una
// OV, cantidades compradas/pendientes, cálculo exacto, concurrencia,
// idempotencia, anulación, inmutabilidad y aislamiento. Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b4", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);

const HOY = hoyNegocio();
const masDias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let POSTE: string;
let TUBO: string;
let VARILLA: string;
let FLETE: string;
let PROV_A: string;
let PROV_B: string;
let PROV_AJENO: string;
let CLIENTE: string;
let OBRA: string;
let n = 0;
const clave = () => `clave-b4-${++n}-${Date.now()}`;

const producto = (codigo: string, extra: Record<string, unknown> = {}) => ({
  codigo,
  descripcion: `Producto ${codigo} (ficticio)`,
  unidad: "pza",
  precioVenta: "100",
  costoReferencia: "77.77",
  tratamientoImpuesto: "GRAVADO",
  tasaIva: "16",
  ...extra,
});

/** OV aceptada con las partidas dadas (vendedor asignado: `vendedor`). */
async function ordenAceptada(partidas: { productoId: string; cantidad: string }[], u: UsuarioSesion = admin) {
  const { id } = await crearCotizacionVenta(
    u,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia", vendedorId: vendedor.id, fecha: HOY, vigenciaHasta: masDias(10), partidas },
    clave()
  );
  await emitirCotizacionVenta(u, id, 1);
  const ov = await registrarAceptacionCotizacion(u, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const partidasVenta = await db.partidaCotizacionVenta.findMany({ where: { cotizacionId: id }, orderBy: { orden: "asc" } });
  return { cotizacionId: id, ordenId: ov.ordenId, folio: ov.folio, partidasVenta };
}

const version = async (id: string) => (await db.compraComercial.findUniqueOrThrow({ where: { id } })).version;

/** Crea, guarda y (opcionalmente) confirma una compra. */
async function compra(
  ordenId: string,
  proveedorId: string | null,
  lineas: { partidaVentaId: string; cantidad: string; costoUnitario?: string; tratamientoImpuesto?: string; tasaIva?: string }[],
  confirmar = true,
  u: UsuarioSesion = admin
) {
  const { id } = await crearCompraComercial(u, ordenId, clave());
  await guardarBorradorCompra(u, id, 1, { proveedorId, fecha: HOY, partidas: lineas });
  if (confirmar) await confirmarCompraComercial(u, id, 2);
  return id;
}
const linea = (partidaVentaId: string, cantidad: string, costoUnitario = "50", tratamientoImpuesto = "GRAVADO", tasaIva = "16") => ({
  partidaVentaId,
  cantidad,
  costoUnitario,
  tratamientoImpuesto,
  tasaIva: tratamientoImpuesto === "GRAVADO" ? tasaIva : "",
});
const pendientes = async (ordenId: string) =>
  Object.fromEntries((await resumenComprasOrden(admin, ordenId)).partidas.map((p) => [p.codigo, { comprado: p.comprado, pendiente: p.pendiente, borrador: p.enBorrador }]));

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B4", email: "director-b4@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  POSTE = (await crearProductoComercial(admin, producto("POSTE", { precioVenta: "1500", costoReferencia: "1100" }))).id;
  TUBO = (await crearProductoComercial(admin, producto("TUBO", { unidad: "m", precioVenta: "123.45", costoReferencia: "88.88" }))).id;
  VARILLA = (await crearProductoComercial(admin, producto("VARILLA", { unidad: "ton", precioVenta: "2840", tratamientoImpuesto: "TASA_CERO", tasaIva: "" }))).id;
  FLETE = (await crearProductoComercial(admin, producto("FLETE", { unidad: "serv", precioVenta: "120", tratamientoImpuesto: "EXENTO", tasaIva: "" }))).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B4" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B4" })).id;
  PROV_A = (await crearProveedorComercial(admin, { nombre: "Proveedor A (ficticio)", rfc: "AAA010101AAA" })).id;
  PROV_B = (await crearProveedorComercial(admin, { nombre: "Proveedor B (ficticio)" })).id;
  PROV_AJENO = (await crearProveedorComercial(adminAjeno, { nombre: "Proveedor ajeno" })).id;
});

describe("Compras de una OV", () => {
  test("OV de 100 postes abastecida por dos proveedores: 60 + 40 = 100 comprados, 0 pendientes", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "100" }]);
    const [poste] = ov.partidasVenta;
    const a = await compra(ov.ordenId, PROV_A, [linea(poste.id, "60", "1080")]);
    assert.deepEqual((await pendientes(ov.ordenId)).POSTE, { comprado: "60.000", pendiente: "40.000", borrador: "0.000" });
    const b = await compra(ov.ordenId, PROV_B, [linea(poste.id, "40", "1095.50")]);
    assert.deepEqual((await pendientes(ov.ordenId)).POSTE, { comprado: "100.000", pendiente: "0.000", borrador: "0.000" });
    const resumen = await resumenComprasOrden(admin, ov.ordenId);
    assert.deepEqual(resumen.compras.map((c) => [c.folio, c.proveedorNombre, c.estatus]), [
      ["COC-000001", "Proveedor A (ficticio)", "CONFIRMADA"],
      ["COC-000002", "Proveedor B (ficticio)", "CONFIRMADA"],
    ]);
    assert.ok(a && b);
    // Una compra más supera lo vendido.
    const extra = await compra(ov.ordenId, PROV_A, [linea(poste.id, "1")], false);
    await assert.rejects(confirmarCompraComercial(admin, extra, 2), /supera lo pendiente/);
    // La OV no cambia: cantidades y precios de venta intactos.
    const venta = await db.partidaCotizacionVenta.findUniqueOrThrow({ where: { id: poste.id } });
    assert.equal(venta.cantidad.toFixed(3), "100.000");
    assert.equal(venta.precioUnitario.toFixed(2), "1500.00");
  });

  test("Compra parcial, varias partidas, cantidades fraccionarias e impuestos mixtos exactos (independientes de la venta)", async () => {
    const ov = await ordenAceptada([
      { productoId: TUBO, cantidad: "2.375" },
      { productoId: VARILLA, cantidad: "0.125" },
      { productoId: FLETE, cantidad: "1.5" },
    ]);
    const [tubo, varilla, flete] = ov.partidasVenta;
    const id = await compra(ov.ordenId, PROV_A, [
      linea(tubo.id, "1.25", "98.76", "GRAVADO", "16"), // 123.45; IVA 19.752 → 19.75
      linea(varilla.id, "0.125", "2500", "TASA_CERO"), // 312.50
      linea(flete.id, "1.5", "100", "GRAVADO", "8"), // venta EXENTA, compra gravada 8 %: 150.00; IVA 12.00
    ]);
    const c = await obtenerCompraComercial(admin, id);
    assert.deepEqual(c.partidas.map((p) => [p.codigo, p.cantidad, p.importe, p.tratamientoImpuesto, p.tasaIva]), [
      ["TUBO", "1.250", "123.45", "GRAVADO", "16.00"],
      ["VARILLA", "0.125", "312.50", "TASA_CERO", null],
      ["FLETE", "1.500", "150.00", "GRAVADO", "8.00"],
    ]);
    assert.equal(c.totales.subtotal, "585.95");
    assert.deepEqual(c.totales.gravado, [
      { tasa: "16.00", base: "123.45", iva: "19.75" },
      { tasa: "8.00", base: "150.00", iva: "12.00" },
    ]);
    assert.equal(c.totales.baseTasaCero, "312.50");
    assert.equal(c.totales.total, "617.70");
    const [fila] = await db.$queryRawUnsafe<{ s: string; i: string; t: string }[]>(
      `SELECT subtotal::text s, iva::text i, total::text t FROM compras_comerciales WHERE id = $1`,
      id
    );
    assert.deepEqual(fila, { s: "585.95", i: "31.75", t: "617.70" });
    assert.deepEqual(await pendientes(ov.ordenId), {
      TUBO: { comprado: "1.250", pendiente: "1.125", borrador: "0.000" },
      VARILLA: { comprado: "0.125", pendiente: "0.000", borrador: "0.000" },
      FLETE: { comprado: "1.500", pendiente: "0.000", borrador: "0.000" },
    });
  });

  test("Los borradores no consumen saldo; al confirmar se valida contra lo confirmado", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "100" }]);
    const [poste] = ov.partidasVenta;
    const borrador = await compra(ov.ordenId, PROV_A, [linea(poste.id, "100")], false);
    assert.deepEqual((await pendientes(ov.ordenId)).POSTE, { comprado: "0.000", pendiente: "100.000", borrador: "100.000" });
    await compra(ov.ordenId, PROV_B, [linea(poste.id, "70")]);
    await assert.rejects(confirmarCompraComercial(admin, borrador, 2), /supera lo pendiente por comprar \(30 pza\)/);
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id: borrador } })).estatus, "BORRADOR");
  });

  test("Costo de referencia no se copia ni un costo faltante cuenta como cero", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const { id } = await crearCompraComercial(admin, ov.ordenId, clave());
    await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV_A, fecha: HOY, partidas: [{ partidaVentaId: ov.partidasVenta[0].id, cantidad: "10" }] });
    const c = await obtenerCompraComercial(admin, id);
    assert.equal(c.partidas[0].costoUnitario, null);
    assert.equal(c.partidas[0].importe, null);
    assert.equal(c.completa, false);
    assert.equal(c.totales.total, "0.00");
    await assert.rejects(confirmarCompraComercial(admin, id, 2), /costo e impuesto de POSTE/);
  });

  test("Confirmar exige proveedor válido, partidas y datos completos", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const { id } = await crearCompraComercial(admin, ov.ordenId, clave());
    await assert.rejects(confirmarCompraComercial(admin, id, 1), (e: Error) => /proveedor/.test(e.message) && /al menos un material/.test(e.message));
    await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV_A, fecha: HOY, partidas: [linea(ov.partidasVenta[0].id, "5")] });
    await db.beneficiario.update({ where: { id: PROV_A }, data: { activo: false } });
    await assert.rejects(confirmarCompraComercial(admin, id, 2), /proveedor no está activo/);
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id } })).estatus, "BORRADOR");
  });
});

describe("Aislamiento", () => {
  test("No se compran materiales de otra OV ni con proveedor u OV de otra Empresa", async () => {
    const ov1 = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const ov2 = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const { id } = await crearCompraComercial(admin, ov1.ordenId, clave());
    await assert.rejects(
      guardarBorradorCompra(admin, id, 1, { proveedorId: PROV_A, fecha: HOY, partidas: [linea(ov2.partidasVenta[0].id, "1")] }),
      /no pertenece a la orden de venta/
    );
    await assert.rejects(guardarBorradorCompra(admin, id, 1, { proveedorId: PROV_AJENO, fecha: HOY, partidas: [] }), RegistroNoEncontradoError);
    await assert.rejects(crearCompraComercial(adminAjeno, ov1.ordenId, clave()), RegistroNoEncontradoError);
    await assert.rejects(obtenerCompraComercial(adminAjeno, id), RegistroNoEncontradoError);
    await assert.rejects(confirmarCompraComercial(adminAjeno, id, 1), RegistroNoEncontradoError);
    assert.ok(!(await listarProveedoresComerciales(admin)).some((p) => p.id === PROV_AJENO));
  });

  test("La base rechaza partidas de otra OV y proveedores de otra Empresa", async () => {
    const ov1 = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const ov2 = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const { id } = await crearCompraComercial(admin, ov1.ordenId, clave());
    const ajena = ov2.partidasVenta[0];
    await assert.rejects(
      db.partidaCompraComercial.create({
        data: { empresaId: EMPRESA, compraId: id, orden: 0, partidaVentaId: ajena.id, codigo: "X", descripcion: "x", unidad: "pza", cantidad: "1" },
      }),
      /no pertenece a la orden de venta/
    );
    await assert.rejects(db.compraComercial.update({ where: { id }, data: { proveedorId: PROV_AJENO } }));
  });

  test("El vendedor no accede a compras, proveedores, costos ni documentos", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const id = await compra(ov.ordenId, PROV_A, [linea(ov.partidasVenta[0].id, "10", "1087.65")]);
    await adjuntarDocumentoCompra(admin, id, { nombre: "factura proveedor.pdf", bytes: new Uint8Array(pdfFicticio("factura")) });
    for (const intento of [
      () => resumenComprasOrden(vendedor, ov.ordenId),
      () => obtenerCompraComercial(vendedor, id),
      () => crearCompraComercial(vendedor, ov.ordenId, clave()),
      () => guardarBorradorCompra(vendedor, id, 1, { fecha: HOY, partidas: [] }),
      () => confirmarCompraComercial(vendedor, id, 1),
      () => anularCompraComercial(vendedor, id, "intento"),
      () => obtenerDocumentoCompra(vendedor, id),
      () => adjuntarDocumentoCompra(vendedor, id, { nombre: "x.pdf", bytes: new Uint8Array(pdfFicticio("x")) }),
      () => listarProveedoresComerciales(vendedor),
      () => crearProveedorComercial(vendedor, { nombre: "x" }),
    ]) {
      await assert.rejects(intento, SinPermisoComercialError);
    }
    // Lo que sí recibe el vendedor (su OV) no contiene datos de compras.
    const texto = JSON.stringify([await obtenerCotizacionVenta(vendedor, ov.cotizacionId), await listarCotizacionesVenta(vendedor)]);
    for (const dato of ["1087.65", "Proveedor A", "COC-", "factura", "1100", "77.77"]) assert.ok(!texto.includes(dato), `el vendedor recibió ${dato}`);
  });
});

describe("Concurrencia, idempotencia y conflictos", () => {
  test("Dos confirmaciones simultáneas no superan juntas lo vendido", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "100" }]);
    const [poste] = ov.partidasVenta;
    const ids = await Promise.all([1, 2, 3].map(() => compra(ov.ordenId, PROV_A, [linea(poste.id, "60")], false)));
    const resultados = await Promise.allSettled(ids.map((id) => confirmarCompraComercial(director, id, 2)));
    sinInterbloqueos(resultados);
    assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of resultados) if (r.status === "rejected") assert.ok(r.reason instanceof ValidacionError, String(r.reason));
    assert.deepEqual((await pendientes(ov.ordenId)).POSTE.comprado, "60.000");
  });

  test("La base también impide superar lo vendido si se salta el servicio", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    await compra(ov.ordenId, PROV_A, [linea(ov.partidasVenta[0].id, "8")]);
    const otra = await compra(ov.ordenId, PROV_B, [linea(ov.partidasVenta[0].id, "5")], false);
    await assert.rejects(
      db.compraComercial.update({
        where: { id: otra },
        data: { estatus: "CONFIRMADA", proveedorConfirmado: { nombre: "x" }, confirmadaEn: new Date(), confirmadaPorId: admin.id },
      }),
      /supera la cantidad vendida/
    );
  });

  test("Crear, confirmar y anular son idempotentes; sin folios duplicados", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const k = clave();
    const creadas = await Promise.all([1, 2, 3].map(() => crearCompraComercial(admin, ov.ordenId, k)));
    assert.equal(new Set(creadas.map((c) => c.id)).size, 1);
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioCompraComercial, 1);
    const id = creadas[0].id;
    await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV_A, fecha: HOY, partidas: [linea(ov.partidasVenta[0].id, "10")] });
    const confirmaciones = await Promise.allSettled([1, 2, 3].map(() => confirmarCompraComercial(admin, id, 2)));
    sinInterbloqueos(confirmaciones);
    assert.ok(confirmaciones.every((r) => r.status === "fulfilled"));
    assert.equal(confirmaciones.filter((r) => r.status === "fulfilled" && !r.value.yaConfirmada).length, 1);
    assert.equal(await db.registroAuditoria.count({ where: { entidadId: id, accion: "CONFIRMAR" } }), 1);
    assert.equal((await anularCompraComercial(admin, id, "Error de captura")).yaAnulada, false);
    assert.equal((await anularCompraComercial(admin, id, "Error de captura")).yaAnulada, true);
    assert.equal(await db.registroAuditoria.count({ where: { entidadId: id, accion: "CAMBIAR_ESTATUS" } }), 1);
  });

  test("Guardar con una versión vieja es un conflicto y no sobrescribe", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const { id } = await crearCompraComercial(admin, ov.ordenId, clave());
    await guardarBorradorCompra(admin, id, 1, { proveedorId: PROV_A, fecha: HOY, partidas: [linea(ov.partidasVenta[0].id, "3")] });
    await assert.rejects(
      guardarBorradorCompra(director, id, 1, { proveedorId: PROV_B, fecha: HOY, partidas: [linea(ov.partidasVenta[0].id, "9")] }),
      ConflictoEdicionError
    );
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id } })).proveedorId, PROV_A);
  });
});

describe("Anulación e inmutabilidad", () => {
  test("Anular con motivo libera cantidades y conserva el historial", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "100" }]);
    const id = await compra(ov.ordenId, PROV_A, [linea(ov.partidasVenta[0].id, "60")]);
    await assert.rejects(anularCompraComercial(admin, id, ""), /motivo/);
    await anularCompraComercial(admin, id, "El proveedor canceló el pedido");
    assert.deepEqual((await pendientes(ov.ordenId)).POSTE, { comprado: "0.000", pendiente: "100.000", borrador: "0.000" });
    const c = await obtenerCompraComercial(admin, id);
    assert.equal(c.estatus, "ANULADA");
    assert.equal(c.anulada?.motivo, "El proveedor canceló el pedido");
    assert.equal(c.partidas.length, 1);
    assert.equal(c.totales.total, "3480.00"); // 60 × 50 + 16 %
    await assert.rejects(confirmarCompraComercial(admin, id, await version(id)), /anulada/);
    // Las cantidades liberadas se pueden volver a comprar.
    await compra(ov.ordenId, PROV_B, [linea(ov.partidasVenta[0].id, "100")]);
  });

  test("Una compra confirmada no se edita (servicio y base) y no cambia si cambian catálogo o proveedor", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const id = await compra(ov.ordenId, PROV_A, [linea(ov.partidasVenta[0].id, "10", "1000")]);
    const antes = await obtenerCompraComercial(admin, id);
    await assert.rejects(guardarBorradorCompra(admin, id, await version(id), { fecha: HOY, partidas: [] }), /borrador/);
    await assert.rejects(db.compraComercial.update({ where: { id }, data: { total: "1.00", subtotal: "1.00", iva: "0" } }), /no se puede modificar/);
    await assert.rejects(db.compraComercial.update({ where: { id }, data: { estatus: "BORRADOR" } }), /no se puede modificar/);
    const p = await db.partidaCompraComercial.findFirstOrThrow({ where: { compraId: id } });
    await assert.rejects(db.partidaCompraComercial.update({ where: { id: p.id }, data: { costoUnitario: "1.00" } }), /no se pueden modificar/);
    await db.beneficiario.update({ where: { id: PROV_A }, data: { nombre: "Proveedor renombrado" } });
    await editarProductoComercial(admin, POSTE, producto("POSTE-2", { descripcion: "Otro", precioVenta: "9", costoReferencia: "1" }));
    const despues = await obtenerCompraComercial(admin, id);
    assert.deepEqual(despues.proveedorConfirmado, antes.proveedorConfirmado);
    assert.equal(despues.proveedorConfirmado?.rfc, "AAA010101AAA");
    assert.deepEqual(despues.partidas, antes.partidas);
    assert.deepEqual(despues.totales, antes.totales);
  });
});

describe("Documento del proveedor", () => {
  test("Se adjunta en borrador o confirmada, se valida y solo lo descarga administración de la Empresa", async () => {
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const id = await compra(ov.ordenId, PROV_A, [linea(ov.partidasVenta[0].id, "10")]);
    await assert.rejects(adjuntarDocumentoCompra(admin, id, { nombre: "x.pdf", bytes: new TextEncoder().encode("no es pdf") }), /PDF, JPG o PNG/);
    const doc = new Uint8Array(pdfFicticio("factura proveedor"));
    await adjuntarDocumentoCompra(admin, id, { nombre: "Factura 123.pdf", bytes: doc });
    const r = await obtenerDocumentoCompra(director, id);
    assert.deepEqual(r.bytes, Buffer.from(doc));
    assert.equal(r.tipo, "application/pdf");
    await assert.rejects(obtenerDocumentoCompra(adminAjeno, id), RegistroNoEncontradoError);
    await anularCompraComercial(admin, id, "prueba");
    await assert.rejects(adjuntarDocumentoCompra(admin, id, { nombre: "y.pdf", bytes: doc }), /anulada/);
  });
});

describe("Sin efectos en construcción ni movimientos financieros", () => {
  test("Compras comerciales no tocan OC, semanas, gastos, egresos ni el folio de construcción", async () => {
    const antes = {
      oc: (await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenCompra,
      semanas: await db.semana.count(),
      proyectos: await db.proyecto.count(),
    };
    const ov = await ordenAceptada([{ productoId: POSTE, cantidad: "10" }]);
    const id = await compra(ov.ordenId, PROV_A, [linea(ov.partidasVenta[0].id, "10")]);
    await anularCompraComercial(admin, id, "prueba");
    await compra(ov.ordenId, PROV_B, [linea(ov.partidasVenta[0].id, "4")]);
    const conteos = await Promise.all([
      db.ordenCompra.count(),
      db.cotizacion.count(),
      db.requisicion.count(),
      db.movimientoSemanal.count(),
      db.gastoObra.count(),
      db.egreso.count(),
      db.ingreso.count(),
      db.movimientoFinancieroCliente.count(),
    ]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(
      {
        oc: (await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenCompra,
        semanas: await db.semana.count(),
        proyectos: await db.proyecto.count(),
      },
      antes
    );
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioCompraComercial, 2);
  });
});

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProductoComercial, editarProductoComercial, cambiarEstatusProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial, listarClientesYObras } from "@/lib/server/comercializacion/clientes";
import {
  ConflictoEdicionError,
  actualizarCotizacionVenta,
  crearCotizacionVenta,
  listarCotizacionesVenta,
  listarVendedoresElegibles,
  obtenerCotizacionVenta,
} from "@/lib/server/comercializacion/cotizaciones";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import type { UsuarioSesion } from "@/lib/server/session";
import { convertirEnAnterior, EXENTO, G16, TASA_CERO } from "./apoyo/cotizacion-anterior";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, sinInterbloqueos, supervisor } from "./apoyo/base";

// Comercialización B2 contra PostgreSQL REAL: clientes/obras, cotizaciones
// en borrador, alcance por vendedor, precios, copia histórica, cálculos
// exactos, folios, idempotencia y conflictos. Datos ficticios.

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});

const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b2", "DIRECTOR", EMPRESA);
const vendedorA = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const vendedorB = sesion("usuario-vendedor-b", "SUPERVISOR", EMPRESA, true);
const SUP_SIN_MARCA = "usuario-sup-sin-marca";
const VENDEDOR_AJENO = "usuario-vendedor-ajeno";

let P16: string; // gravado 16 %, $245.50 / bulto
let P_M: string; // gravado 16 %, $123.45 / m
let P_CERO: string; // tasa 0 %, $2,840.00 / ton
let P_EXENTO: string; // exento, $120.00 / servicio
let P_AJENO: string;
let CLIENTE: string;
let OBRA: string;
let CLIENTE_2: string;
let OBRA_2: string;
let CLIENTE_AJENO: string;

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

const borrador = (extra: Record<string, unknown> = {}) => ({
  clienteId: CLIENTE,
  obraId: OBRA,
  descripcion: "Material para losa (ficticio)",
  fecha: "2026-11-16",
  vigenciaHasta: "2026-11-30",
  condiciones: "Pago contra entrega",
  observaciones: "",
  partidas: [{ productoId: P16, cantidad: "10" }],
  ...extra,
});

let claves = 0;
const clave = () => `clave-prueba-${++claves}-${Date.now()}`;

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.createMany({
    data: [
      { id: director.id, nombre: "Director B2", email: "director-b2@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA },
      { id: vendedorB.id, nombre: "Vendedor B", email: "vendedor-b@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA, vendedorComercial: true },
      { id: SUP_SIN_MARCA, nombre: "Supervisor sin marca", email: "sup-sin@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA },
      { id: VENDEDOR_AJENO, nombre: "Vendedor ajeno", email: "vend-ajeno@ajena.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA_AJENA, vendedorComercial: true },
    ],
  });
  P16 = (await crearProductoComercial(admin, producto("CEM-50", { unidad: "bulto", precioVenta: "245.50", costoReferencia: "198.37" }))).id;
  P_M = (await crearProductoComercial(admin, producto("TUB-1", { unidad: "m", precioVenta: "123.45" }))).id;
  P_CERO = (await crearProductoComercial(admin, producto("VAR-T", { unidad: "ton", precioVenta: "2840", tratamientoImpuesto: "TASA_CERO", tasaIva: "" }))).id;
  P_EXENTO = (await crearProductoComercial(admin, producto("SRV-1", { unidad: "serv", precioVenta: "120", tratamientoImpuesto: "EXENTO", tasaIva: "" }))).id;
  P_AJENO = (await crearProductoComercial(adminAjeno, producto("AJ-1"))).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Constructora Norte (ficticia)" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Torre A" })).id;
  CLIENTE_2 = (await crearClienteComercial(admin, { nombre: "Desarrollos Sur (ficticio)" })).id;
  OBRA_2 = (await crearObraComercial(admin, { clienteId: CLIENTE_2, nombre: "Plaza" })).id;
  CLIENTE_AJENO = (await crearClienteComercial(adminAjeno, { nombre: "Cliente ajeno (ficticio)" })).id;
});

describe("Clientes y obras", () => {
  test("Vendedor puede dar de alta cliente y obra; nombre repetido devuelve el existente", async () => {
    const c = await crearClienteComercial(vendedorA, { nombre: "  constructora norte (FICTICIA) " });
    assert.equal(c.id, CLIENTE);
    assert.equal(c.existente, true);
    const nuevo = await crearClienteComercial(vendedorA, { nombre: "Cliente_1" });
    const otro = await crearClienteComercial(vendedorA, { nombre: "ClienteX1" });
    assert.notEqual(nuevo.id, otro.id, "«_» no debe tratarse como comodín");
    const o = await crearObraComercial(vendedorA, { clienteId: nuevo.id, nombre: "Bodega" });
    assert.equal(o.clienteId, nuevo.id);
    assert.equal((await crearObraComercial(vendedorA, { clienteId: nuevo.id, nombre: "BODEGA" })).id, o.id);
  });

  test("No se crea obra para un cliente de otra Empresa", async () => {
    await assert.rejects(crearObraComercial(admin, { clienteId: CLIENTE_AJENO, nombre: "X" }), RegistroNoEncontradoError);
  });

  test("Los selectores solo traen id y nombre, nunca cotizaciones ni importes", async () => {
    await crearCotizacionVenta(vendedorB, borrador(), clave());
    const r = await listarClientesYObras(vendedorA);
    assert.deepEqual(Object.keys(r.clientes[0]).sort(), ["id", "nombre"]);
    assert.deepEqual(Object.keys(r.obras[0]).sort(), ["clienteId", "id", "nombre"]);
    assert.ok(!r.clientes.some((c) => c.id === CLIENTE_AJENO));
  });

  test("No se crean proyectos, contratos ni semanas de construcción", async () => {
    const antes = { p: await db.proyecto.count(), s: await db.semana.count() };
    await crearCotizacionVenta(admin, borrador(), clave());
    assert.deepEqual({ p: await db.proyecto.count(), s: await db.semana.count() }, antes);
  });
});

describe("Creación de borradores y folios", () => {
  test("Borrador mínimo (solo descripción) se guarda y se reabre; COT- propio sin consumir el contador de OC", async () => {
    const ocAntes = (await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenCompra;
    const r = await crearCotizacionVenta(admin, { descripcion: "Pendiente de definir", fecha: "2026-11-16", partidas: [] }, clave());
    assert.equal(r.folio, "COT-000001");
    const c = await obtenerCotizacionVenta(admin, r.id);
    assert.equal(c.clienteId, null);
    // Vendedor opcional (nov-2026): administración sin elegir queda «Sin vendedor».
    assert.equal(c.vendedor, null);
    assert.equal(c.creadoPorNombre, "Admin Prueba");
    assert.equal(c.totales.total, "0.00");
    assert.equal(c.fecha, "2026-11-16");
    const e = await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } });
    assert.equal(e.ultimoFolioOrdenCompra, ocAntes);
    assert.equal(e.ultimoFolioCotizacionVenta, 1);
  });

  test("Folio independiente por Empresa", async () => {
    await crearCotizacionVenta(admin, borrador(), clave());
    const ajena = await crearCotizacionVenta(adminAjeno, { descripcion: "x", fecha: "2026-11-16", partidas: [] }, clave());
    assert.equal(ajena.folio, "COT-000001");
  });

  test("Altas concurrentes: folios consecutivos, sin repetidos ni huecos", async () => {
    const resultados = await Promise.allSettled(Array.from({ length: 8 }, () => crearCotizacionVenta(vendedorA, borrador(), clave())));
    sinInterbloqueos(resultados);
    const folios = resultados.map((r) => (r.status === "fulfilled" ? r.value.folio : "ERROR")).sort();
    assert.deepEqual(folios, Array.from({ length: 8 }, (_, i) => `COT-${String(i + 1).padStart(6, "0")}`));
  });

  test("Reintento con la misma clave (secuencial y simultáneo) no duplica ni consume folio", async () => {
    const k = clave();
    const primera = await crearCotizacionVenta(vendedorA, borrador(), k);
    const segunda = await crearCotizacionVenta(vendedorA, borrador(), k);
    assert.equal(segunda.id, primera.id);
    assert.equal(segunda.reintento, true);

    const k2 = clave();
    const simultaneas = await Promise.allSettled(Array.from({ length: 5 }, () => crearCotizacionVenta(vendedorA, borrador(), k2)));
    sinInterbloqueos(simultaneas);
    const ids = new Set(simultaneas.map((r) => (r.status === "fulfilled" ? r.value.id : `rechazo:${(r.reason as Error).message}`)));
    assert.equal(ids.size, 1, [...ids].join(" | "));
    assert.equal(await db.cotizacionVenta.count(), 2);
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioCotizacionVenta, 2);
  });

  test("Otra persona no puede reutilizar la clave de creación ajena", async () => {
    const k = clave();
    await crearCotizacionVenta(vendedorA, borrador(), k);
    await assert.rejects(crearCotizacionVenta(vendedorB, borrador(), k), ValidacionError);
  });

  test("Crear un borrador no genera OC, compra, cobro, ingreso, egreso ni gasto", async () => {
    await crearCotizacionVenta(admin, borrador({ partidas: [{ productoId: P16, cantidad: "100" }] }), clave());
    const conteos = await Promise.all([
      db.ordenCompra.count(),
      db.cotizacion.count(),
      db.requisicion.count(),
      db.movimientoSemanal.count(),
      db.movimientoFinancieroCliente.count(),
      db.ingreso.count(),
      db.egreso.count(),
      db.gastoObra.count(),
    ]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("Vendedor asignado", () => {
  test("El vendedor queda asignado a sí mismo; creador y vendedor se guardan por separado", async () => {
    const r = await crearCotizacionVenta(vendedorA, borrador(), clave());
    const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(fila.vendedorId, vendedorA.id);
    assert.equal(fila.creadoPorId, vendedorA.id);

    const deAdmin = await crearCotizacionVenta(admin, borrador({ vendedorId: vendedorB.id }), clave());
    const f2 = await db.cotizacionVenta.findUniqueOrThrow({ where: { id: deAdmin.id } });
    assert.equal(f2.vendedorId, vendedorB.id);
    assert.equal(f2.creadoPorId, admin.id);
  });

  test("Un vendedor no puede asignarse la cotización a otra persona (alta ni edición)", async () => {
    await assert.rejects(crearCotizacionVenta(vendedorA, borrador({ vendedorId: vendedorB.id }), clave()), SinPermisoComercialError);
    const r = await crearCotizacionVenta(vendedorA, borrador(), clave());
    await assert.rejects(actualizarCotizacionVenta(vendedorA, r.id, 1, borrador({ vendedorId: admin.id })), SinPermisoComercialError);
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: r.id } })).vendedorId, vendedorA.id);
  });

  test("Administración solo asigna vendedores elegibles de su Empresa", async () => {
    await assert.rejects(crearCotizacionVenta(admin, borrador({ vendedorId: SUP_SIN_MARCA }), clave()), ValidacionError);
    await assert.rejects(crearCotizacionVenta(admin, borrador({ vendedorId: VENDEDOR_AJENO }), clave()), ValidacionError);
    const ok = await crearCotizacionVenta(director, borrador({ vendedorId: director.id }), clave());
    assert.ok(ok.id);
    const elegibles = (await listarVendedoresElegibles(admin)).map((v) => v.id).sort();
    assert.deepEqual(elegibles, [admin.id, director.id, vendedorA.id, vendedorB.id].sort());
    assert.deepEqual(await listarVendedoresElegibles(vendedorA), [{ id: vendedorA.id, nombre: vendedorA.nombre }]);
  });
});

describe("Aislamiento entre Empresas y entre vendedores", () => {
  test("Un vendedor no ve ni edita cotizaciones de otro vendedor, ni por ID ni por filtro", async () => {
    const deA = await crearCotizacionVenta(vendedorA, borrador(), clave());
    const deB = await crearCotizacionVenta(vendedorB, borrador({ descripcion: "De B" }), clave());

    await assert.rejects(obtenerCotizacionVenta(vendedorB, deA.id), RegistroNoEncontradoError);
    await assert.rejects(actualizarCotizacionVenta(vendedorB, deA.id, 1, borrador({ descripcion: "hackeo" })), RegistroNoEncontradoError);
    assert.deepEqual((await listarCotizacionesVenta(vendedorB)).map((c) => c.id), [deB.id]);
    assert.deepEqual((await listarCotizacionesVenta(vendedorB, { vendedorId: vendedorA.id })).map((c) => c.id), [deB.id]);
    assert.deepEqual((await listarCotizacionesVenta(vendedorB, { busqueda: "Material" })).map((c) => c.id), []);
    // Administración ve ambas.
    assert.equal((await listarCotizacionesVenta(admin)).length, 2);
    assert.deepEqual((await listarCotizacionesVenta(admin, { vendedorId: vendedorA.id })).map((c) => c.id), [deA.id]);
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: deA.id } })).descripcion, "Material para losa (ficticio)");
  });

  test("Otra Empresa no ve ni edita por ID; filtros con IDs ajenos no devuelven nada", async () => {
    const r = await crearCotizacionVenta(admin, borrador(), clave());
    await assert.rejects(obtenerCotizacionVenta(adminAjeno, r.id), RegistroNoEncontradoError);
    await assert.rejects(actualizarCotizacionVenta(adminAjeno, r.id, 1, { descripcion: "x", fecha: "2026-11-16", partidas: [] }), RegistroNoEncontradoError);
    assert.deepEqual(await listarCotizacionesVenta(adminAjeno, { clienteId: CLIENTE }), []);
  });

  test("Supervisor sin marca, Empresa sin módulo y Master no acceden", async () => {
    const sinMarca = sesion(SUP_SIN_MARCA, "SUPERVISOR", EMPRESA);
    const adminSinModulo = { ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA }), id: admin.id };
    for (const u of [sinMarca, adminSinModulo, usuarioDePrueba({ rol: "MASTER" })]) {
      await assert.rejects(listarCotizacionesVenta(u), SinPermisoComercialError);
      await assert.rejects(crearCotizacionVenta(u, borrador(), clave()), SinPermisoComercialError);
      await assert.rejects(crearClienteComercial(u, { nombre: "x" }), SinPermisoComercialError);
    }
  });

  test("Relaciones: cliente y producto ajenos, obra de otro cliente y producto inactivo se rechazan", async () => {
    await assert.rejects(crearCotizacionVenta(admin, borrador({ clienteId: CLIENTE_AJENO, obraId: null }), clave()), RegistroNoEncontradoError);
    await assert.rejects(crearCotizacionVenta(admin, borrador({ obraId: OBRA_2 }), clave()), /no pertenece al cliente/);
    await assert.rejects(crearCotizacionVenta(admin, borrador({ partidas: [{ productoId: P_AJENO, cantidad: "1" }] }), clave()), ValidacionError);
    await cambiarEstatusProductoComercial(admin, P_M, { activo: false });
    await assert.rejects(crearCotizacionVenta(admin, borrador({ partidas: [{ productoId: P_M, cantidad: "1" }] }), clave()), /inactivo/);
    assert.equal(await db.cotizacionVenta.count(), 0);
  });

  test("La base también impide obra de otro cliente y producto de otra Empresa", async () => {
    const r = await crearCotizacionVenta(admin, borrador(), clave());
    await assert.rejects(db.cotizacionVenta.update({ where: { id: r.id }, data: { obraId: OBRA_2 } }));
    await assert.rejects(db.cotizacionVenta.update({ where: { id: r.id }, data: { clienteId: null } })); // obra sin cliente
    const p = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: r.id } });
    await assert.rejects(db.partidaCotizacionVenta.update({ where: { id: p.id }, data: { productoId: P_AJENO } }));
  });

  test("Una partida de otra cotización no puede incluirse en la mía", async () => {
    const otra = await crearCotizacionVenta(admin, borrador(), clave());
    const ajena = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: otra.id } });
    const mia = await crearCotizacionVenta(admin, borrador({ partidas: [] }), clave());
    await assert.rejects(
      actualizarCotizacionVenta(admin, mia.id, 1, borrador({ partidas: [{ id: ajena.id, productoId: P16, cantidad: "1" }] })),
      /no pertenece a esta cotización/
    );
  });
});

describe("Precios, impuestos y copia histórica", () => {
  test("Vendedor: precio distinto, tasa o importe enviados se rechazan; precio igual al de catálogo se acepta", async () => {
    await assert.rejects(
      crearCotizacionVenta(vendedorA, borrador({ partidas: [{ productoId: P16, cantidad: "1", precioUnitario: "200" }] }), clave()),
      SinPermisoComercialError
    );
    await assert.rejects(crearCotizacionVenta(vendedorA, borrador({ partidas: [{ productoId: P16, cantidad: "1", tasaIva: "0" }] }), clave()));
    await assert.rejects(crearCotizacionVenta(vendedorA, borrador({ partidas: [{ productoId: P16, cantidad: "1", importe: "1" }] }), clave()));
    await assert.rejects(crearCotizacionVenta(vendedorA, borrador({ total: "1.00" }), clave()));
    assert.equal(await db.cotizacionVenta.count(), 0);
    const ok = await crearCotizacionVenta(vendedorA, borrador({ partidas: [{ productoId: P16, cantidad: "1", precioUnitario: "245.5" }] }), clave());
    assert.ok(ok.id);
  });

  test("Administración ajusta el precio; el vendedor cambia cantidades y el precio ajustado se conserva", async () => {
    const r = await crearCotizacionVenta(admin, borrador({ vendedorId: vendedorA.id, partidas: [{ productoId: P16, cantidad: "10", precioUnitario: "260" }] }), clave());
    let c = await obtenerCotizacionVenta(vendedorA, r.id);
    assert.equal(c.partidas[0].precioUnitario, "260.00");
    assert.equal(c.partidas[0].precioBase, "245.50");
    assert.equal(c.partidas[0].precioAjustado, true);

    await actualizarCotizacionVenta(vendedorA, r.id, c.version, borrador({ partidas: [{ id: c.partidas[0].id, productoId: P16, cantidad: "12.5" }] }));
    c = await obtenerCotizacionVenta(vendedorA, r.id);
    assert.equal(c.partidas[0].precioUnitario, "260.00");
    assert.equal(c.partidas[0].cantidad, "12.500");
    assert.equal(c.partidas[0].importe, "3250.00");

    await assert.rejects(
      actualizarCotizacionVenta(vendedorA, r.id, c.version, borrador({ partidas: [{ id: c.partidas[0].id, productoId: P16, cantidad: "1", precioUnitario: "245.50" }] })),
      SinPermisoComercialError
    );
    const fila = await db.partidaCotizacionVenta.findUniqueOrThrow({ where: { id: c.partidas[0].id } });
    assert.equal(fila.precioUnitario.toFixed(2), "260.00");
    assert.equal(fila.precioAjustadoPorId, admin.id);
  });

  test("Volver al precio de catálogo quita la marca de ajuste; el catálogo nunca cambia", async () => {
    const r = await crearCotizacionVenta(admin, borrador({ partidas: [{ productoId: P16, cantidad: "1", precioUnitario: "300" }] }), clave());
    const c = await obtenerCotizacionVenta(admin, r.id);
    await actualizarCotizacionVenta(admin, r.id, c.version, borrador({ partidas: [{ id: c.partidas[0].id, productoId: P16, cantidad: "1", precioUnitario: "245.50" }] }));
    const p = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: r.id } });
    assert.equal(p.precioAjustadoPorId, null);
    assert.equal((await db.productoComercial.findUniqueOrThrow({ where: { id: P16 } })).precioVenta.toFixed(2), "245.50");
  });

  test("Cambiar o desactivar el producto en catálogo no altera borradores guardados", async () => {
    const r = await crearCotizacionVenta(admin, borrador({ partidas: [{ productoId: P16, cantidad: "2" }] }), clave());
    await editarProductoComercial(admin, P16, producto("CEM-50-N", { descripcion: "Otro nombre", unidad: "saco", precioVenta: "999", tratamientoImpuesto: "EXENTO", tasaIva: "" }));
    await cambiarEstatusProductoComercial(admin, P16, { activo: false });

    let c = await obtenerCotizacionVenta(admin, r.id);
    const p = c.partidas[0];
    assert.deepEqual(
      { codigo: p.codigo, unidad: p.unidad, precio: p.precioUnitario, trat: p.tratamientoImpuesto, tasa: p.tasaIva, activo: p.productoActivo },
      { codigo: "CEM-50", unidad: "bulto", precio: "245.50", trat: "GRAVADO", tasa: "16.00", activo: false }
    );
    // Editar el borrador conserva la partida histórica del producto inactivo...
    await actualizarCotizacionVenta(admin, r.id, c.version, borrador({ descripcion: "Editada", partidas: [{ id: p.id, productoId: P16, cantidad: "3" }] }));
    c = await obtenerCotizacionVenta(admin, r.id);
    assert.equal(c.partidas[0].codigo, "CEM-50");
    assert.equal(c.partidas[0].importe, "736.50");
    // ...pero no permite agregarlo como partida nueva.
    await assert.rejects(
      actualizarCotizacionVenta(admin, r.id, c.version, borrador({ partidas: [{ id: p.id, productoId: P16, cantidad: "3" }, { productoId: P16, cantidad: "1" }] })),
      /inactivo/
    );
  });

  test("Cantidades fraccionarias e impuestos mixtos (cotización anterior): importes y totales exactos en la base", async () => {
    const r = await crearCotizacionVenta(
      admin,
      borrador({
        partidas: [
          { productoId: P_M, cantidad: "2.375" }, // 293.19375 → 293.19
          { productoId: P16, cantidad: "3" }, // 736.50
          { productoId: P_CERO, cantidad: "0.125" }, // 355.00
          { productoId: P_EXENTO, cantidad: "1.5" }, // 180.00
        ],
      }),
      clave()
    );
    // Impuesto por partida = cotización creada antes del IVA por cotización.
    await convertirEnAnterior(r.id, [G16, G16, TASA_CERO, EXENTO]);
    const filas = await db.$queryRawUnsafe<{ cantidad: string; importe: string }[]>(
      `SELECT cantidad::text AS cantidad, importe::text AS importe FROM partidas_cotizacion_venta WHERE "cotizacionId" = $1 ORDER BY orden`,
      r.id
    );
    assert.deepEqual(filas, [
      { cantidad: "2.375", importe: "293.19" },
      { cantidad: "3.000", importe: "736.50" },
      { cantidad: "0.125", importe: "355.00" },
      { cantidad: "1.500", importe: "180.00" },
    ]);
    const c = await obtenerCotizacionVenta(admin, r.id);
    assert.equal(c.totales.subtotal, "1564.69");
    assert.deepEqual(c.totales.gravado, [{ tasa: "16.00", base: "1029.69", iva: "164.75" }]); // 164.7504
    assert.equal(c.totales.baseTasaCero, "355.00");
    assert.equal(c.totales.baseExenta, "180.00");
    assert.equal(c.totales.total, "1729.44");
    const [cab] = await db.$queryRawUnsafe<{ s: string; i: string; t: string }[]>(
      `SELECT subtotal::text s, iva::text i, total::text t FROM cotizaciones_venta WHERE id = $1`,
      r.id
    );
    assert.deepEqual(cab, { s: "1564.69", i: "164.75", t: "1729.44" });
  });

  test("Ninguna respuesta al vendedor contiene costos privados", async () => {
    const r = await crearCotizacionVenta(vendedorA, borrador(), clave());
    const textos = JSON.stringify([await obtenerCotizacionVenta(vendedorA, r.id), await listarCotizacionesVenta(vendedorA)]);
    assert.ok(!textos.includes("198.37") && !textos.includes("77.77"), "se filtró un costo");
    assert.ok(!/costo/i.test(textos));
  });
});

describe("Edición, conflictos y bitácora", () => {
  test("Borrador incompleto se reabre y se completa después", async () => {
    const r = await crearCotizacionVenta(vendedorA, { descripcion: "Por definir", fecha: "2026-11-16", partidas: [] }, clave());
    let c = await obtenerCotizacionVenta(vendedorA, r.id);
    assert.equal(c.partidas.length, 0);
    const v = await actualizarCotizacionVenta(vendedorA, r.id, c.version, borrador());
    assert.equal(v.version, 2);
    c = await obtenerCotizacionVenta(vendedorA, r.id);
    assert.equal(c.clienteId, CLIENTE);
    assert.equal(c.obraId, OBRA);
    assert.equal(c.partidas.length, 1);
    assert.equal(c.vigenciaHasta, "2026-11-30");
  });

  test("Guardar con una versión vieja se rechaza y no sobrescribe", async () => {
    const r = await crearCotizacionVenta(admin, borrador({ vendedorId: vendedorA.id }), clave());
    await actualizarCotizacionVenta(vendedorA, r.id, 1, borrador({ descripcion: "Cambio del vendedor" }));
    await assert.rejects(actualizarCotizacionVenta(admin, r.id, 1, borrador({ descripcion: "Cambio de admin" })), ConflictoEdicionError);
    const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(fila.descripcion, "Cambio del vendedor");
    assert.equal(fila.version, 2);
  });

  test("Dos guardados simultáneos con la misma versión: solo uno gana", async () => {
    const r = await crearCotizacionVenta(admin, borrador(), clave());
    const resultados = await Promise.allSettled([
      actualizarCotizacionVenta(admin, r.id, 1, borrador({ descripcion: "Uno" })),
      actualizarCotizacionVenta(director, r.id, 1, borrador({ descripcion: "Dos" })),
    ]);
    sinInterbloqueos(resultados);
    assert.equal(resultados.filter((x) => x.status === "fulfilled").length, 1);
    const rechazo = resultados.find((x) => x.status === "rejected") as PromiseRejectedResult;
    assert.ok(rechazo.reason instanceof ConflictoEdicionError);
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: r.id } })).version, 2);
  });

  test("Guardar sin cambios no sube versión ni registra bitácora", async () => {
    const r = await crearCotizacionVenta(admin, borrador(), clave());
    const c = await obtenerCotizacionVenta(admin, r.id);
    const res = await actualizarCotizacionVenta(
      admin,
      r.id,
      1,
      borrador({ partidas: [{ id: c.partidas[0].id, productoId: P16, cantidad: "10.000", precioUnitario: "245.50" }] })
    );
    assert.equal(res.sinCambios, true);
    assert.equal(await db.registroAuditoria.count({ where: { entidadId: r.id } }), 1);
  });

  test("Creación y cambios relevantes (precio, cantidad, vendedor, partidas) quedan en bitácora", async () => {
    const r = await crearCotizacionVenta(admin, borrador({ vendedorId: vendedorA.id }), clave());
    const c = await obtenerCotizacionVenta(admin, r.id);
    await actualizarCotizacionVenta(
      admin,
      r.id,
      1,
      borrador({
        vendedorId: vendedorB.id,
        partidas: [{ id: c.partidas[0].id, productoId: P16, cantidad: "11", precioUnitario: "250" }, { productoId: P_EXENTO, cantidad: "1" }],
      })
    );
    const registros = await db.registroAuditoria.findMany({ where: { entidadId: r.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(registros.map((x) => x.accion), ["CREAR", "EDITAR"]);
    assert.ok(registros.every((x) => x.empresaId === EMPRESA && x.entidad === "CotizacionVenta"));
    const nuevo = registros[1].valorNuevo as Record<string, unknown>;
    assert.equal(nuevo.vendedorId, vendedorB.id);
    assert.deepEqual(nuevo.partidasModificadas, [{ codigo: "CEM-50", cantidad: ["10.000", "11.000"], precioUnitario: ["245.50", "250.00"] }]);
    assert.deepEqual((nuevo.partidasAgregadas as { codigo: string }[]).map((p) => p.codigo), ["SRV-1"]);
    assert.equal((registros[1].valorAnterior as Record<string, unknown>).vendedorId, vendedorA.id);
  });
});

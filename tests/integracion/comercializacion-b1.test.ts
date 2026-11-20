import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import {
  cambiarEstatusProductoComercial,
  crearProductoComercial,
  editarProductoComercial,
  listarProductosAdministracion,
  listarProductosParaVenta,
  obtenerHistorialProductoComercial,
} from "@/lib/server/comercializacion/productos";
import { cambiarMarcaVendedorComercial, listarUsuariosElegiblesVendedor } from "@/lib/server/comercializacion/vendedores";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, sinInterbloqueos, supervisor } from "./apoyo/base";

// Comercialización B1 contra PostgreSQL REAL (base local dedicada): índice
// único lower(codigo) por Empresa, CHECK de importes/tasa, bloqueo de fila,
// aislamiento multiempresa, bitácora y marca de vendedor. Datos ficticios.

const M = "comercializacion";
const conModulo = (u: UsuarioSesion, empresaId: string): UsuarioSesion => {
  const base = usuarioDePrueba({ rol: u.rol, empresaId, vendedorComercial: u.vendedorComercial, modulos: [M] });
  return { ...base, id: u.id };
};

const admin = conModulo(adminBase, EMPRESA);
const adminAjeno = conModulo(adminAjenoBase, EMPRESA_AJENA);
const vendedor: UsuarioSesion = { ...conModulo(supervisor, EMPRESA), vendedorComercial: true };
const supervisorSinMarca: UsuarioSesion = { ...conModulo(supervisor, EMPRESA), vendedorComercial: false };
const director: UsuarioSesion = { ...usuarioDePrueba({ rol: "DIRECTOR", empresaId: EMPRESA, modulos: [M] }), id: "usuario-director-com" };
const adminSinModulo: UsuarioSesion = { ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA }), id: adminBase.id };

const SUP_INACTIVO = "usuario-sup-inactivo";
const SUP_AJENO = "usuario-sup-ajeno";

const producto = (extra: Record<string, unknown> = {}) => ({
  codigo: "CEM-50",
  descripcion: "Cemento gris 50 kg (ficticio)",
  unidad: "bulto",
  precioVenta: "245.50",
  costoReferencia: "198.37",
  tratamientoImpuesto: "GRAVADO",
  tasaIva: "16",
  ...extra,
});

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.createMany({
    data: [
      { id: director.id, nombre: "Director Prueba", email: "director-com@prueba.invalid", passwordHash: "sin-acceso", rol: "DIRECTOR", empresaId: EMPRESA },
      { id: SUP_INACTIVO, nombre: "Supervisor Inactivo", email: "sup-inactivo@prueba.invalid", passwordHash: "sin-acceso", rol: "SUPERVISOR", empresaId: EMPRESA, activo: false },
      { id: SUP_AJENO, nombre: "Supervisor Ajeno", email: "sup-ajeno-com@ajena.invalid", passwordHash: "sin-acceso", rol: "SUPERVISOR", empresaId: EMPRESA_AJENA },
    ],
  });
});

const auditoria = (entidadId: string) =>
  db.registroAuditoria.findMany({ where: { entidadId }, orderBy: { createdAt: "asc" } });

describe("Esquema", () => {
  test("Usuario nuevo nace sin marca de vendedor; producto nuevo nace activo y gravado", async () => {
    const u = await db.usuario.findUniqueOrThrow({ where: { id: supervisor.id } });
    assert.equal(u.vendedorComercial, false);
    const { id } = await crearProductoComercial(admin, producto());
    const p = await db.productoComercial.findUniqueOrThrow({ where: { id } });
    assert.equal(p.activo, true);
    assert.equal(p.tratamientoImpuesto, "GRAVADO");
    assert.equal(p.precioVenta.toFixed(2), "245.50");
    assert.equal(p.tasaIva?.toFixed(2), "16.00");
  });

  test("CHECK de la base rechaza precio 0, gravado sin tasa y tasa con Exento", async () => {
    const base = { empresaId: EMPRESA, codigo: "X", descripcion: "x", unidad: "pza", creadoPorId: admin.id };
    await assert.rejects(db.productoComercial.create({ data: { ...base, precioVenta: "0", tasaIva: "16" } }));
    await assert.rejects(db.productoComercial.create({ data: { ...base, precioVenta: "1", tasaIva: null } }));
    await assert.rejects(
      db.productoComercial.create({ data: { ...base, precioVenta: "1", tratamientoImpuesto: "EXENTO", tasaIva: "16" } })
    );
    await assert.rejects(db.productoComercial.create({ data: { ...base, precioVenta: "1", tasaIva: "16", costoReferencia: "-1" } }));
    assert.equal(await db.productoComercial.count(), 0);
  });

  test("Importes grandes se guardan exactos (sin float)", async () => {
    const { id } = await crearProductoComercial(admin, producto({ precioVenta: "999999999999.99", costoReferencia: "0.01" }));
    const [fila] = await db.$queryRawUnsafe<{ p: string; c: string }[]>(
      `SELECT "precioVenta"::text AS p, "costoReferencia"::text AS c FROM productos_comerciales WHERE id = $1`,
      id
    );
    assert.deepEqual(fila, { p: "999999999999.99", c: "0.01" });
  });
});

describe("Código único por Empresa", () => {
  test("Mismo código (sin distinguir mayúsculas) en la misma Empresa se rechaza", async () => {
    await crearProductoComercial(admin, producto());
    await assert.rejects(crearProductoComercial(admin, producto({ codigo: "cem-50" })), ValidacionError);
    assert.equal(await db.productoComercial.count({ where: { empresaId: EMPRESA } }), 1);
  });

  test("«_» y «%» en un código no actúan como comodines (regresión corregida en B2)", async () => {
    await crearProductoComercial(admin, producto({ codigo: "CEMX50" }));
    await crearProductoComercial(admin, producto({ codigo: "CEM_50" }));
    await crearProductoComercial(admin, producto({ codigo: "CEM%" }));
    await crearProductoComercial(admin, producto({ codigo: "CEMZZ" }));
    assert.equal(await db.productoComercial.count(), 4);
    await assert.rejects(crearProductoComercial(admin, producto({ codigo: "cem_50" })), ValidacionError);
  });

  test("El mismo código en otra Empresa sí se permite", async () => {
    await crearProductoComercial(admin, producto());
    await crearProductoComercial(adminAjeno, producto());
    assert.equal(await db.productoComercial.count(), 2);
  });

  test("Un producto inactivo sigue ocupando su código", async () => {
    const { id } = await crearProductoComercial(admin, producto());
    await cambiarEstatusProductoComercial(admin, id, { activo: false });
    await assert.rejects(crearProductoComercial(admin, producto()), /inactivo/);
  });

  test("Editar hacia un código ya usado se rechaza", async () => {
    await crearProductoComercial(admin, producto());
    const { id } = await crearProductoComercial(admin, producto({ codigo: "VAR-38" }));
    await assert.rejects(editarProductoComercial(admin, id, producto({ codigo: "Cem-50" })), ValidacionError);
  });

  test("Altas concurrentes del mismo código: exactamente una gana (índice único real)", async () => {
    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () => crearProductoComercial(admin, producto({ codigo: "CONC-1" })))
    );
    sinInterbloqueos(resultados);
    assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of resultados) {
      if (r.status === "rejected") assert.ok(r.reason instanceof ValidacionError, String(r.reason));
    }
    assert.equal(await db.productoComercial.count(), 1);
  });
});

describe("Vendedor", () => {
  test("Consulta solo productos activos y nunca recibe costos", async () => {
    const a = await crearProductoComercial(admin, producto());
    const b = await crearProductoComercial(admin, producto({ codigo: "VAR-38", costoReferencia: "777.77" }));
    await cambiarEstatusProductoComercial(admin, b.id, { activo: false });

    const lista = await listarProductosParaVenta(vendedor);
    assert.deepEqual(lista.map((p) => p.id), [a.id]);
    const serializado = JSON.stringify(lista);
    assert.ok(!serializado.includes("198.37"), "el costo llegó en la respuesta");
    assert.ok(!/costo|activo|creadoPor|actualizado/i.test(serializado), serializado);
    assert.deepEqual(Object.keys(lista[0]).sort(), [
      "codigo",
      "descripcion",
      "id",
      "precioVenta",
      "tasaIva",
      "tratamientoImpuesto",
      "unidad",
    ]);
  });

  test("Alta, edición, desactivación, historial y catálogo completo: rechazados sin cambios", async () => {
    const { id } = await crearProductoComercial(admin, producto());
    await assert.rejects(crearProductoComercial(vendedor, producto({ codigo: "NUEVO" })), SinPermisoComercialError);
    await assert.rejects(editarProductoComercial(vendedor, id, producto({ precioVenta: "1.00" })), SinPermisoComercialError);
    await assert.rejects(cambiarEstatusProductoComercial(vendedor, id, { activo: false }), SinPermisoComercialError);
    await assert.rejects(obtenerHistorialProductoComercial(vendedor, id), SinPermisoComercialError);
    await assert.rejects(listarProductosAdministracion(vendedor), SinPermisoComercialError);
    const p = await db.productoComercial.findUniqueOrThrow({ where: { id } });
    assert.equal(p.precioVenta.toFixed(2), "245.50");
    assert.equal(p.activo, true);
    assert.equal(await db.productoComercial.count(), 1);
  });

  test("Supervisor sin marca y Empresa sin módulo: acceso bloqueado en servidor", async () => {
    await assert.rejects(listarProductosParaVenta(supervisorSinMarca), SinPermisoComercialError);
    await assert.rejects(listarProductosParaVenta(adminSinModulo), SinPermisoComercialError);
    await assert.rejects(crearProductoComercial(adminSinModulo, producto()), SinPermisoComercialError);
    assert.equal(await db.productoComercial.count(), 0);
  });
});

describe("Aislamiento entre Empresas", () => {
  test("Otra Empresa no ve, edita, desactiva ni consulta historial de mis productos", async () => {
    const { id } = await crearProductoComercial(admin, producto());
    assert.deepEqual(await listarProductosAdministracion(adminAjeno), []);
    await assert.rejects(editarProductoComercial(adminAjeno, id, producto({ precioVenta: "1" })), RegistroNoEncontradoError);
    await assert.rejects(cambiarEstatusProductoComercial(adminAjeno, id, { activo: false }), RegistroNoEncontradoError);
    await assert.rejects(obtenerHistorialProductoComercial(adminAjeno, id), RegistroNoEncontradoError);
    const p = await db.productoComercial.findUniqueOrThrow({ where: { id } });
    assert.equal(p.precioVenta.toFixed(2), "245.50");
    assert.equal(p.activo, true);
    assert.equal(p.empresaId, EMPRESA);
  });

  test("Campos de Empresa o autor enviados en el formulario se ignoran", async () => {
    const { id } = await crearProductoComercial(admin, producto({ empresaId: EMPRESA_AJENA, creadoPorId: adminAjeno.id, activo: false }));
    const p = await db.productoComercial.findUniqueOrThrow({ where: { id } });
    assert.equal(p.empresaId, EMPRESA);
    assert.equal(p.creadoPorId, admin.id);
    assert.equal(p.activo, true);
  });
});

describe("Bitácora e historial", () => {
  test("Alta, cambio de precio, desactivación con motivo y reactivación quedan registrados", async () => {
    const { id } = await crearProductoComercial(admin, producto());
    await editarProductoComercial(director, id, producto({ precioVenta: "260", costoReferencia: "198.37" }));
    await cambiarEstatusProductoComercial(admin, id, { activo: false, motivo: "Descontinuado por el proveedor" });
    await cambiarEstatusProductoComercial(admin, id, { activo: true });

    const registros = await auditoria(id);
    assert.deepEqual(registros.map((r) => r.accion), ["CREAR", "EDITAR", "DESACTIVAR", "ACTIVAR"]);
    assert.ok(registros.every((r) => r.empresaId === EMPRESA && r.entidad === "ProductoComercial"));
    const edicion = registros[1];
    assert.equal(edicion.usuarioId, director.id);
    assert.deepEqual(edicion.valorAnterior, { precioVenta: "245.50" });
    assert.deepEqual(edicion.valorNuevo, { precioVenta: "260.00" });

    const historial = await obtenerHistorialProductoComercial(admin, id);
    assert.equal(historial.length, 4);
    const desactivacion = historial.find((h) => h.accion === "DESACTIVAR")!;
    assert.equal(desactivacion.motivo, "Descontinuado por el proveedor");
    const cambioPrecio = historial.find((h) => h.accion === "EDITAR")!;
    assert.deepEqual(cambioPrecio.cambios, [{ campo: "precioVenta", anterior: "245.50", nuevo: "260.00" }]);
  });

  test("Guardar sin cambios o repetir el mismo estatus no genera registros", async () => {
    const { id } = await crearProductoComercial(admin, producto());
    const r = await editarProductoComercial(admin, id, producto({ precioVenta: "245.5" }));
    assert.deepEqual(r.cambios, []);
    await cambiarEstatusProductoComercial(admin, id, { activo: true });
    assert.equal((await auditoria(id)).length, 1);
  });

  test("Cambiar tratamiento de impuesto registra tasa anterior y nueva", async () => {
    const { id } = await crearProductoComercial(admin, producto());
    await editarProductoComercial(admin, id, producto({ tratamientoImpuesto: "EXENTO", tasaIva: "" }));
    const [, edicion] = await auditoria(id);
    assert.deepEqual(edicion.valorAnterior, { tratamientoImpuesto: "GRAVADO", tasaIva: "16.00" });
    assert.deepEqual(edicion.valorNuevo, { tratamientoImpuesto: "EXENTO", tasaIva: null });
  });
});

describe("Marca de vendedor", () => {
  const marca = (id: string) => db.usuario.findUniqueOrThrow({ where: { id }, select: { vendedorComercial: true, rol: true, empresaId: true, activo: true } });

  test("Administrador y Director activan y retiran la marca a un Supervisor de su Empresa, con bitácora", async () => {
    await cambiarMarcaVendedorComercial(admin, { usuarioId: supervisor.id, vendedor: true });
    assert.equal((await marca(supervisor.id)).vendedorComercial, true);
    await cambiarMarcaVendedorComercial(director, { usuarioId: supervisor.id, vendedor: false });
    assert.equal((await marca(supervisor.id)).vendedorComercial, false);
    const registros = await auditoria(supervisor.id);
    assert.deepEqual(registros.map((r) => [r.accion, r.usuarioId]), [
      ["ACTIVAR", admin.id],
      ["DESACTIVAR", director.id],
    ]);
  });

  test("Solo lista y acepta Supervisores; no se puede marcar a un Administrador ni a un inactivo", async () => {
    const elegibles = await listarUsuariosElegiblesVendedor(admin);
    assert.deepEqual(elegibles.map((u) => u.id).sort(), [SUP_INACTIVO, supervisor.id].sort());
    await assert.rejects(cambiarMarcaVendedorComercial(admin, { usuarioId: director.id, vendedor: true }), ValidacionError);
    await assert.rejects(cambiarMarcaVendedorComercial(admin, { usuarioId: SUP_INACTIVO, vendedor: true }), ValidacionError);
    assert.equal((await marca(director.id)).vendedorComercial, false);
  });

  test("Un Administrador no puede marcar usuarios de otra Empresa", async () => {
    await assert.rejects(cambiarMarcaVendedorComercial(admin, { usuarioId: SUP_AJENO, vendedor: true }), RegistroNoEncontradoError);
    assert.equal((await marca(SUP_AJENO)).vendedorComercial, false);
    assert.ok(!(await listarUsuariosElegiblesVendedor(admin)).some((u) => u.id === SUP_AJENO));
  });

  test("La acción no cambia rol, Empresa ni estado aunque se envíen en la petición", async () => {
    await cambiarMarcaVendedorComercial(admin, {
      usuarioId: supervisor.id,
      vendedor: true,
      rol: "ADMINISTRADOR",
      empresaId: EMPRESA_AJENA,
      activo: false,
    });
    assert.deepEqual(await marca(supervisor.id), { vendedorComercial: true, rol: "SUPERVISOR", empresaId: EMPRESA, activo: true });
  });

  test("Un vendedor o un Administrador sin módulo no pueden asignar la marca", async () => {
    await assert.rejects(cambiarMarcaVendedorComercial(vendedor, { usuarioId: supervisor.id, vendedor: true }), SinPermisoComercialError);
    await assert.rejects(
      cambiarMarcaVendedorComercial(adminSinModulo, { usuarioId: supervisor.id, vendedor: true }),
      SinPermisoComercialError
    );
    assert.equal((await marca(supervisor.id)).vendedorComercial, false);
  });

  test("Valor no booleano se rechaza", async () => {
    await assert.rejects(cambiarMarcaVendedorComercial(admin, { usuarioId: supervisor.id, vendedor: "true" }));
    assert.equal((await marca(supervisor.id)).vendedorComercial, false);
  });
});

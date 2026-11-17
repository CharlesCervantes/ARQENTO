import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as productos from "@/lib/server/comercializacion/productos";
import {
  cambiarEstatusProductoComercial,
  crearProductoComercial,
  editarProductoComercial,
  listarProductosAdministracion,
  listarProductosParaVenta,
  obtenerHistorialProductoComercial,
  validarDatosProducto,
} from "@/lib/server/comercializacion/productos";
import { cambiarMarcaVendedorComercial, listarUsuariosElegiblesVendedor } from "@/lib/server/comercializacion/vendedores";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { usuarioDePrueba } from "../helpers/usuarios";

// Validación y puertas de permiso de los servicios, SIN base de datos (la
// prueba unitaria fuerza una URL inalcanzable): un rechazo de permiso debe
// ocurrir antes de cualquier consulta.

const M = "comercializacion";
const vendedor = usuarioDePrueba({ rol: "SUPERVISOR", vendedorComercial: true, modulos: [M] });
const supervisorSinMarca = usuarioDePrueba({ rol: "SUPERVISOR", modulos: [M] });
const adminSinModulo = usuarioDePrueba({ rol: "ADMINISTRADOR" });
const master = usuarioDePrueba({ rol: "MASTER" });

const valido = {
  codigo: "CEM-50",
  descripcion: "Cemento gris 50 kg",
  unidad: "bulto",
  precioVenta: "245.5",
  costoReferencia: "",
  tratamientoImpuesto: "GRAVADO",
  tasaIva: "16",
};

describe("validarDatosProducto", () => {
  test("normaliza importes y tasa", () => {
    const d = validarDatosProducto(valido);
    assert.equal(d.precioVenta, "245.50");
    assert.equal(d.tasaIva, "16.00");
    assert.equal(d.costoReferencia, null);
  });
  test("tasa editable distinta de 16", () => {
    assert.equal(validarDatosProducto({ ...valido, tasaIva: "8" }).tasaIva, "8.00");
  });
  test("Tasa 0 % y Exento guardan tasa nula y se distinguen", () => {
    const cero = validarDatosProducto({ ...valido, tratamientoImpuesto: "TASA_CERO", tasaIva: "" });
    const exento = validarDatosProducto({ ...valido, tratamientoImpuesto: "EXENTO", tasaIva: "" });
    assert.equal(cero.tasaIva, null);
    assert.equal(exento.tasaIva, null);
    assert.notEqual(cero.tratamientoImpuesto, exento.tratamientoImpuesto);
  });
  const rechazos: [string, Record<string, unknown>][] = [
    ["precio 0", { precioVenta: "0" }],
    ["precio negativo", { precioVenta: "-10" }],
    ["precio con 3 decimales", { precioVenta: "10.005" }],
    ["precio no numérico", { precioVenta: "diez" }],
    ["costo negativo", { costoReferencia: "-1" }],
    ["gravado sin tasa", { tasaIva: "" }],
    ["gravado con tasa 0", { tasaIva: "0" }],
    ["tasa > 100", { tasaIva: "116" }],
    ["tasa positiva con Exento", { tratamientoImpuesto: "EXENTO", tasaIva: "16" }],
    ["tasa positiva con Tasa 0 %", { tratamientoImpuesto: "TASA_CERO", tasaIva: "16" }],
    ["tratamiento desconocido", { tratamientoImpuesto: "IEPS" }],
    ["código vacío", { codigo: "  " }],
    ["código con espacios", { codigo: "CEM 50" }],
    ["sin descripción", { descripcion: "" }],
    ["sin unidad", { unidad: undefined }],
  ];
  for (const [nombre, cambio] of rechazos) {
    test(`rechaza: ${nombre}`, () => {
      assert.throws(() => validarDatosProducto({ ...valido, ...cambio }), (e: unknown) => e instanceof Error);
    });
  }
  test("los errores de importes son ValidacionError con mensaje claro", () => {
    assert.throws(() => validarDatosProducto({ ...valido, precioVenta: "0" }), ValidacionError);
  });
});

describe("Puertas de permiso antes de tocar la base", () => {
  const casos: [string, () => Promise<unknown>][] = [
    ["vendedor crea", () => crearProductoComercial(vendedor, valido)],
    ["vendedor edita", () => editarProductoComercial(vendedor, "p1", valido)],
    ["vendedor desactiva", () => cambiarEstatusProductoComercial(vendedor, "p1", { activo: false })],
    ["vendedor lista con costos", () => listarProductosAdministracion(vendedor)],
    ["vendedor ve historial", () => obtenerHistorialProductoComercial(vendedor, "p1")],
    ["vendedor lista usuarios", () => listarUsuariosElegiblesVendedor(vendedor)],
    ["vendedor marca vendedores", () => cambiarMarcaVendedorComercial(vendedor, { usuarioId: "x", vendedor: true })],
    ["supervisor sin marca consulta", () => listarProductosParaVenta(supervisorSinMarca)],
    ["admin sin módulo consulta", () => listarProductosParaVenta(adminSinModulo)],
    ["admin sin módulo crea", () => crearProductoComercial(adminSinModulo, valido)],
    ["master consulta", () => listarProductosParaVenta(master)],
    ["master crea", () => crearProductoComercial(master, valido)],
  ];
  for (const [nombre, fn] of casos) {
    test(`rechazado: ${nombre}`, async () => {
      await assert.rejects(fn, SinPermisoComercialError);
    });
  }

  test("No existe ninguna función para borrar productos", () => {
    const nombres = Object.keys(productos);
    assert.equal(nombres.filter((n) => /eliminar|borrar|delete/i.test(n)).length, 0, nombres.join(", "));
  });
});

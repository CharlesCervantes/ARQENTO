import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { db } from "@/lib/server/db";
import { crearProductoComercial, listarProductosParaVenta } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { actualizarCotizacionVenta, crearCotizacionVenta, obtenerCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { duplicarCotizacionVenta, emitirCotizacionVenta, obtenerDocumentoParaPdf } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, admin as adminBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";
import { convertirEnAnterior, EXENTO, G16, G8, TASA_CERO } from "./apoyo/cotizacion-anterior";

// IVA por cotización (noviembre 2026) contra PostgreSQL REAL. El catálogo
// guarda el precio de venta sin IVA; la cotización elige una vez «Con IVA»
// (16 %) o «Sin IVA» y el servidor lo aplica a todas sus partidas. Los datos
// anteriores conservan su impuesto por partida. Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId: EMPRESA, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR");
const director = sesion("usuario-director-iva", "DIRECTOR");
const vendedor = sesion(supervisor.id, "SUPERVISOR", true);

const HOY = hoyNegocio();
const masDias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let PIEZA: string; // $120.00 — el caso de la demo
let TUBO: string; // $45.10
let CEM: string; // $0.03 — redondeo
let CLIENTE: string;
let OBRA: string;
let n = 0;
const clave = () => `clave-iva-${++n}-${Date.now()}`;
const version = async (id: string) => (await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).version;
const completa = (extra: Record<string, unknown> = {}) => ({
  clienteId: CLIENTE,
  obraId: OBRA,
  descripcion: "Suministro ficticio",
  fecha: HOY,
  vigenciaHasta: masDias(10),
  condiciones: "Pago contra entrega",
  observaciones: "",
  partidas: [{ productoId: PIEZA, cantidad: "2" }],
  ...extra,
});
const evidencia = () => ({ nombre: "OC cliente.pdf", bytes: new Uint8Array(pdfFicticio("Aceptación ficticia")) });
const cabecera = async (id: string) => {
  const c = await db.cotizacionVenta.findUniqueOrThrow({ where: { id }, include: { partidas: { orderBy: { orden: "asc" } } } });
  return {
    impuestoVenta: c.impuestoVenta,
    subtotal: c.subtotal.toFixed(2),
    iva: c.iva.toFixed(2),
    total: c.total.toFixed(2),
    partidas: c.partidas.map((p) => [p.tratamientoImpuesto, p.tasaIva?.toFixed(2) ?? null, p.cantidad.toFixed(3), p.precioUnitario.toFixed(2)]),
  };
};
/** Datos de una cotización guardada en el formato del formulario (partidas con id). */
const desde = async (id: string, extra: Record<string, unknown> = {}) => {
  const c = await obtenerCotizacionVenta(admin, id);
  return {
    clienteId: c.clienteId,
    obraId: c.obraId,
    descripcion: c.descripcion,
    fecha: c.fecha,
    vigenciaHasta: c.vigenciaHasta,
    condiciones: c.condiciones,
    observaciones: c.observaciones,
    partidas: c.partidas.map((p) => ({ id: p.id, productoId: p.productoId, cantidad: p.cantidad, precioUnitario: p.precioUnitario })),
    ...extra,
  };
};

async function pdfTexto(u: UsuarioSesion, id: string): Promise<string> {
  const entrada = JSON.stringify(await obtenerDocumentoParaPdf(u, id));
  const script = fileURLToPath(new URL("./apoyo/renderizar-pdf-cotizacion.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--import", "tsx", script], { input: entrada, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`No se pudo renderizar el PDF: ${r.stderr}`);
  const parser = new PDFParse({ data: new Uint8Array(Buffer.from(r.stdout, "base64")) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({
    data: { id: director.id, nombre: "Director Ficticio", email: "director-iva@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA },
  });
  // Alta como la hace el formulario nuevo: sin datos fiscales.
  const alta = (codigo: string, precioVenta: string) =>
    crearProductoComercial(admin, { codigo, descripcion: `Producto ${codigo} (ficticio)`, unidad: "pza", precioVenta, costoReferencia: "1.11" });
  PIEZA = (await alta("PIEZA", "120")).id;
  TUBO = (await alta("TUBO", "45.10")).id;
  CEM = (await alta("CEM", "0.03")).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Constructora Ficticia" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Torre Ficticia" })).id;
});

describe("Catálogo sin datos fiscales", () => {
  test("alta con código, descripción, unidad, precio y costo; la consulta de venta no trae impuesto ni costo", async () => {
    const p = await db.productoComercial.findUniqueOrThrow({ where: { id: PIEZA } });
    assert.equal(p.precioVenta.toFixed(2), "120.00");
    assert.equal(p.costoReferencia?.toFixed(2), "1.11");
    assert.equal(p.tratamientoImpuesto, null);
    assert.equal(p.tasaIva, null);
    const venta = (await listarProductosParaVenta(vendedor)).find((x) => x.id === PIEZA)!;
    assert.deepEqual(Object.keys(venta).sort(), ["codigo", "descripcion", "id", "precioVenta", "unidad"]);
  });
});

describe("Con IVA / Sin IVA", () => {
  test("2 piezas de $120.00: Con IVA 240.00 + 38.40 = 278.40 (preseleccionado); Sin IVA 240.00", async () => {
    // Sin enviar la opción (como una cotización nueva): «Con IVA».
    const { id } = await crearCotizacionVenta(admin, completa(), clave());
    assert.deepEqual(await cabecera(id), {
      impuestoVenta: "CON_IVA",
      subtotal: "240.00",
      iva: "38.40",
      total: "278.40",
      partidas: [["GRAVADO", "16.00", "2.000", "120.00"]],
    });
    const sin = await crearCotizacionVenta(admin, completa({ impuestoVenta: "SIN_IVA" }), clave());
    assert.deepEqual(await cabecera(sin.id), {
      impuestoVenta: "SIN_IVA",
      subtotal: "240.00",
      iva: "0.00",
      total: "240.00",
      partidas: [["SIN_IVA", null, "2.000", "120.00"]],
    });
    const c = await obtenerCotizacionVenta(admin, sin.id);
    assert.equal(c.impuestoVenta, "SIN_IVA");
    // «Sin IVA» no es tasa 0 % ni exento.
    assert.equal(c.totales.baseTasaCero, "0.00");
    assert.equal(c.totales.baseExenta, "0.00");
  });

  test("Administración ajusta el precio a $110.00: 220.00 y 255.20 con IVA; el catálogo sigue en $120.00", async () => {
    const { id } = await crearCotizacionVenta(admin, completa(), clave());
    await actualizarCotizacionVenta(admin, id, 1, await desde(id, { partidas: (await desde(id)).partidas.map((p) => ({ ...p, precioUnitario: "110" })) }));
    const c = await cabecera(id);
    assert.equal(c.subtotal, "220.00");
    assert.equal(c.iva, "35.20");
    assert.equal(c.total, "255.20");
    assert.equal((await db.productoComercial.findUniqueOrThrow({ where: { id: PIEZA } })).precioVenta.toFixed(2), "120.00");
    // Pasar a «Sin IVA» conserva cantidades y el precio negociado.
    await actualizarCotizacionVenta(admin, id, 2, await desde(id, { impuestoVenta: "SIN_IVA" }));
    assert.deepEqual(await cabecera(id), {
      impuestoVenta: "SIN_IVA",
      subtotal: "220.00",
      iva: "0.00",
      total: "220.00",
      partidas: [["SIN_IVA", null, "2.000", "110.00"]],
    });
    // Ese ajuste solo afecta esta venta.
    const otra = await crearCotizacionVenta(admin, completa(), clave());
    assert.equal((await cabecera(otra.id)).total, "278.40");
  });

  test("varias partidas: alternar recalcula todas, incluidas las que se agregan después; redondeo al centavo sobre el subtotal", async () => {
    const { id } = await crearCotizacionVenta(
      admin,
      completa({ impuestoVenta: "SIN_IVA", partidas: [{ productoId: PIEZA, cantidad: "2" }, { productoId: TUBO, cantidad: "3.5" }] }),
      clave()
    );
    assert.equal((await cabecera(id)).total, "397.85"); // 240 + 157.85
    // Agrega 3 partidas de $0.03 y cambia a «Con IVA» en el mismo guardado.
    const datos = await desde(id, { impuestoVenta: "CON_IVA" });
    datos.partidas.push(...[1, 2, 3].map(() => ({ id: null, productoId: CEM, cantidad: "1", precioUnitario: null }) as never));
    await actualizarCotizacionVenta(admin, id, 1, datos);
    const c = await cabecera(id);
    assert.equal(c.subtotal, "397.94");
    // 397.94 × 16 % = 63.6704 → 63.67 (una vez, sobre el subtotal).
    assert.equal(c.iva, "63.67");
    assert.equal(c.total, "461.61");
    assert.ok(c.partidas.every(([t, tasa]) => t === "GRAVADO" && tasa === "16.00"), "todas las partidas con IVA 16 %");
    // De vuelta a «Sin IVA»: todas las partidas, mismo subtotal.
    await actualizarCotizacionVenta(admin, id, 2, await desde(id, { impuestoVenta: "SIN_IVA" }));
    const s = await cabecera(id);
    assert.equal(s.subtotal, "397.94");
    assert.equal(s.total, "397.94");
    assert.ok(s.partidas.every(([t, tasa]) => t === "SIN_IVA" && tasa === null));
  });

  test("guardado y reapertura: la opción se conserva al editar sin enviarla y al emitir", async () => {
    const { id } = await crearCotizacionVenta(admin, completa({ impuestoVenta: "SIN_IVA" }), clave());
    // Sin enviar la opción (p. ej. un cliente anterior): se conserva.
    await actualizarCotizacionVenta(admin, id, 1, await desde(id, { descripcion: "Cambio de texto" }));
    const reabierta = await obtenerCotizacionVenta(admin, id);
    assert.equal(reabierta.impuestoVenta, "SIN_IVA");
    assert.equal(reabierta.totales.total, "240.00");
    await emitirCotizacionVenta(admin, id, await version(id));
    const emitida = await obtenerCotizacionVenta(admin, id);
    assert.equal(emitida.emision?.documento.impuestoVenta, "SIN_IVA");
    assert.equal(emitida.emision?.documento.totales.total, "240.00");
    // Emitida: la opción ya no cambia (base de datos).
    await assert.rejects(db.cotizacionVenta.update({ where: { id }, data: { impuestoVenta: "CON_IVA" } }), /emitida/);
  });

  test("el servidor rechaza otras opciones e importes enviados por el navegador", async () => {
    await assert.rejects(crearCotizacionVenta(admin, completa({ impuestoVenta: "PENDIENTE" }), clave()));
    await assert.rejects(crearCotizacionVenta(admin, completa({ impuestoVenta: "EXENTO" }), clave()));
    await assert.rejects(crearCotizacionVenta(admin, completa({ impuestoVenta: null }), clave()));
    await assert.rejects(crearCotizacionVenta(admin, completa({ iva: "0" }), clave()));
    await assert.rejects(crearCotizacionVenta(admin, completa({ partidas: [{ productoId: PIEZA, cantidad: "1", tasaIva: "0" }] }), clave()));
    assert.equal(await db.cotizacionVenta.count(), 0);
  });
});

describe("Restricción del Vendedor", () => {
  test("elige Con IVA o Sin IVA, usa el precio autorizado y no puede ajustarlo", async () => {
    const { id } = await crearCotizacionVenta(vendedor, completa({ impuestoVenta: "SIN_IVA" }), clave());
    assert.equal((await cabecera(id)).total, "240.00");
    const { partidas } = await desde(id);
    await assert.rejects(
      actualizarCotizacionVenta(vendedor, id, 1, { ...(await desde(id)), partidas: partidas.map((p) => ({ ...p, precioUnitario: "110" })) }),
      SinPermisoComercialError
    );
    // Sin enviar precio: usa el autorizado; cambia la opción a «Con IVA».
    await actualizarCotizacionVenta(vendedor, id, 1, {
      ...(await desde(id)),
      impuestoVenta: "CON_IVA",
      partidas: partidas.map((p) => ({ id: p.id, productoId: p.productoId, cantidad: p.cantidad })),
    });
    assert.deepEqual((await cabecera(id)).partidas, [["GRAVADO", "16.00", "2.000", "120.00"]]);
    assert.equal((await cabecera(id)).total, "278.40");
    // El precio que administración autorizó se conserva al cambiar la opción.
    await actualizarCotizacionVenta(admin, id, 2, await desde(id, { partidas: partidas.map((p) => ({ ...p, precioUnitario: "110" })) }));
    await actualizarCotizacionVenta(vendedor, id, 3, {
      ...(await desde(id)),
      impuestoVenta: "SIN_IVA",
      partidas: partidas.map((p) => ({ id: p.id, productoId: p.productoId, cantidad: p.cantidad })),
    });
    assert.deepEqual(await cabecera(id), {
      impuestoVenta: "SIN_IVA",
      subtotal: "220.00",
      iva: "0.00",
      total: "220.00",
      partidas: [["SIN_IVA", null, "2.000", "110.00"]],
    });
  });
});

describe("Datos anteriores", () => {
  test("un borrador anterior conserva su impuesto por partida al abrirlo, editar datos generales y emitir", async () => {
    const { id } = await crearCotizacionVenta(
      admin,
      completa({ partidas: [{ productoId: PIEZA, cantidad: "2" }, { productoId: TUBO, cantidad: "1" }, { productoId: CEM, cantidad: "100" }] }),
      clave()
    );
    const antes = await convertirEnAnterior(id, [G8, TASA_CERO, EXENTO]);
    assert.equal(antes.iva, "19.20"); // 240 × 8 %
    const abierta = await obtenerCotizacionVenta(admin, id);
    assert.equal(abierta.impuestoVenta, null);
    assert.deepEqual(abierta.partidas.map((p) => p.tratamientoImpuesto), ["GRAVADO", "TASA_CERO", "EXENTO"]);
    // Editar datos generales y cantidades sin elegir opción: conserva el tratamiento.
    const datos = await desde(id, { descripcion: "Texto nuevo" });
    datos.partidas[0].cantidad = "3.000";
    await actualizarCotizacionVenta(admin, id, 1, datos);
    const c = await cabecera(id);
    assert.equal(c.impuestoVenta, null);
    assert.deepEqual(c.partidas.map(([t, tasa]) => [t, tasa]), [["GRAVADO", "8.00"], ["TASA_CERO", null], ["EXENTO", null]]);
    assert.equal(c.subtotal, "408.10"); // 360 + 45.10 + 3.00
    assert.equal(c.iva, "28.80");
    // Agregar un material exige elegir una de las dos opciones.
    const conNueva = await desde(id);
    conNueva.partidas.push({ id: null, productoId: PIEZA, cantidad: "1", precioUnitario: null } as never);
    await assert.rejects(actualizarCotizacionVenta(admin, id, 2, conNueva), /elige «Con IVA» o «Sin IVA»/);
    assert.equal((await cabecera(id)).impuestoVenta, null, "el rechazo no cambia nada");
    // Emitir sin elegir: el documento conserva el desglose anterior.
    await emitirCotizacionVenta(admin, id, 2);
    const doc = (await obtenerCotizacionVenta(admin, id)).emision!.documento;
    assert.equal(doc.impuestoVenta, null);
    assert.deepEqual(doc.totales.gravado, [{ tasa: "8.00", base: "360.00", iva: "28.80" }]);
    assert.equal(doc.totales.baseTasaCero, "45.10");
    assert.equal(doc.totales.baseExenta, "3.00");
    const texto = await pdfTexto(admin, id);
    assert.match(texto, /IVA 8 % sobre \$360\.00/);
    assert.match(texto, /Tasa 0 %/);
    assert.match(texto, /Exento/);
  });

  test("borrador anterior: elegir el IVA y agregar el material en el mismo guardado aplica la opción a todas", async () => {
    const { id } = await crearCotizacionVenta(admin, completa(), clave());
    await convertirEnAnterior(id, [EXENTO]);
    const datos = await desde(id, { impuestoVenta: "SIN_IVA" });
    datos.partidas.push({ id: null, productoId: TUBO, cantidad: "1", precioUnitario: null } as never);
    await actualizarCotizacionVenta(admin, id, 1, datos);
    assert.deepEqual(await cabecera(id), {
      impuestoVenta: "SIN_IVA",
      subtotal: "285.10",
      iva: "0.00",
      total: "285.10",
      partidas: [["SIN_IVA", null, "2.000", "120.00"], ["SIN_IVA", null, "1.000", "45.10"]],
    });
  });

  test("pasar un borrador anterior al nuevo esquema es explícito y aplica a todas las partidas", async () => {
    const { id } = await crearCotizacionVenta(admin, completa({ partidas: [{ productoId: PIEZA, cantidad: "2" }, { productoId: TUBO, cantidad: "1" }] }), clave());
    await convertirEnAnterior(id, [EXENTO, TASA_CERO]);
    assert.equal((await cabecera(id)).total, "285.10");
    await actualizarCotizacionVenta(admin, id, 1, await desde(id, { impuestoVenta: "CON_IVA" }));
    const c = await cabecera(id);
    assert.equal(c.impuestoVenta, "CON_IVA");
    assert.equal(c.total, "330.72"); // 285.10 × 1.16 = 330.716
    assert.ok(c.partidas.every(([t, tasa]) => t === "GRAVADO" && tasa === "16.00"));
    const bitacora = await db.registroAuditoria.findFirstOrThrow({ where: { entidadId: id, accion: "EDITAR" } });
    assert.deepEqual(bitacora.valorAnterior, { impuestoVenta: null, subtotal: "285.10", iva: "0.00", total: "285.10", version: 1 });
    assert.equal((bitacora.valorNuevo as Record<string, unknown>).impuestoVenta, "CON_IVA");
  });

  test("emitidas y órdenes anteriores no cambian: importes, desglose y documento", async () => {
    const { id } = await crearCotizacionVenta(admin, completa({ partidas: [{ productoId: PIEZA, cantidad: "2" }, { productoId: TUBO, cantidad: "1" }] }), clave());
    await convertirEnAnterior(id, [G16, EXENTO]);
    await emitirCotizacionVenta(admin, id, 1);
    await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, evidencia());
    const antes = await db.cotizacionVenta.findUniqueOrThrow({ where: { id }, include: { ordenVenta: { include: { cuenta: true } } } });
    // Un producto «anterior» que se edita hoy no cambia nada de lo emitido.
    await crearProductoComercial(admin, { codigo: "OTRO", descripcion: "x", unidad: "pza", precioVenta: "1" });
    const despues = await db.cotizacionVenta.findUniqueOrThrow({ where: { id }, include: { ordenVenta: { include: { cuenta: true } } } });
    assert.deepEqual(despues.documentoEmitido, antes.documentoEmitido);
    assert.equal(despues.total.toFixed(2), "323.50"); // 240 × 1.16 + 45.10
    assert.equal(despues.ordenVenta!.total.toFixed(2), "323.50");
    assert.equal(despues.ordenVenta!.cuenta!.total.toFixed(2), "323.50");
    assert.equal(despues.impuestoVenta, null);
  });

  test("duplicar: copia la opción del nuevo esquema; de un anterior representable usa Con IVA; si no, pide elegir", async () => {
    // Nuevo esquema «Sin IVA».
    const a = await crearCotizacionVenta(admin, completa({ impuestoVenta: "SIN_IVA" }), clave());
    await emitirCotizacionVenta(admin, a.id, 1);
    const copiaA = await duplicarCotizacionVenta(admin, a.id, clave());
    assert.equal((await cabecera(copiaA.id)).impuestoVenta, "SIN_IVA");
    assert.equal((await cabecera(copiaA.id)).total, "240.00");

    // Anterior todo al 16 %: equivalente a «Con IVA».
    const b = await crearCotizacionVenta(admin, completa(), clave());
    await convertirEnAnterior(b.id, [G16]);
    await emitirCotizacionVenta(admin, b.id, 1);
    const copiaB = await duplicarCotizacionVenta(admin, b.id, clave());
    assert.equal((await cabecera(copiaB.id)).impuestoVenta, "CON_IVA");

    // Anterior con exento: no se representa → PENDIENTE con el impuesto de origen.
    const c = await crearCotizacionVenta(admin, completa({ partidas: [{ productoId: PIEZA, cantidad: "2" }, { productoId: TUBO, cantidad: "1" }] }), clave());
    await convertirEnAnterior(c.id, [G16, EXENTO]);
    await emitirCotizacionVenta(admin, c.id, 1);
    const copiaC = await duplicarCotizacionVenta(admin, c.id, clave());
    const pc = await cabecera(copiaC.id);
    assert.equal(pc.impuestoVenta, "PENDIENTE");
    assert.deepEqual(pc.partidas.map(([t]) => t), ["GRAVADO", "EXENTO"]);
    await assert.rejects(emitirCotizacionVenta(admin, copiaC.id, 1), /elegir «Con IVA» o «Sin IVA»/);
    // La base tampoco deja emitir una PENDIENTE.
    await assert.rejects(db.cotizacionVenta.update({ where: { id: copiaC.id }, data: { estatus: "EMITIDA" } }));
    // Al elegir, se aplica a todas las partidas y ya se puede emitir.
    await actualizarCotizacionVenta(admin, copiaC.id, 1, await desde(copiaC.id, { impuestoVenta: "SIN_IVA" }));
    assert.equal((await cabecera(copiaC.id)).total, "285.10");
    await emitirCotizacionVenta(admin, copiaC.id, 2);
    assert.equal((await obtenerCotizacionVenta(admin, copiaC.id)).emision?.documento.impuestoVenta, "SIN_IVA");
  });

  test("emitir valida que las partidas coincidan con la opción guardada", async () => {
    const { id } = await crearCotizacionVenta(admin, completa(), clave());
    await db.partidaCotizacionVenta.updateMany({ where: { cotizacionId: id }, data: { tratamientoImpuesto: "EXENTO", tasaIva: null } });
    await assert.rejects(emitirCotizacionVenta(admin, id, 1), ValidacionError);
  });
});

describe("Duplicar una emitida «Sin IVA»", () => {
  test("la copia conserva «Sin IVA» aunque las nuevas arranquen «Con IVA» (Vendedor y Administración)", async () => {
    for (const u of [vendedor, admin]) {
      const { id } = await crearCotizacionVenta(u, completa({ impuestoVenta: "SIN_IVA" }), clave());
      await emitirCotizacionVenta(u, id, 1);
      const copia = await duplicarCotizacionVenta(u, id, clave());
      // Se reabre con la opción guardada: el formulario la muestra marcada.
      const reabierta = await obtenerCotizacionVenta(u, copia.id);
      assert.equal(reabierta.estatus, "BORRADOR");
      assert.equal(reabierta.impuestoVenta, "SIN_IVA");
      assert.equal(reabierta.totales.iva, "0.00");
      assert.equal(reabierta.totales.total, "240.00");
      assert.deepEqual((await cabecera(copia.id)).partidas, [["SIN_IVA", null, "2.000", "120.00"]]);
      // Una nueva, sin elegir, sigue arrancando «Con IVA».
      assert.equal((await cabecera((await crearCotizacionVenta(u, completa(), clave())).id)).impuestoVenta, "CON_IVA");
      // Emitida, la opción queda fija: el original no cambia.
      assert.equal((await cabecera(id)).impuestoVenta, "SIN_IVA");
    }
  });
});

describe("Recorrido de la demo con IVA y «Sin vendedor»", () => {
  for (const [opcion, iva, total] of [
    ["CON_IVA", "38.40", "278.40"],
    ["SIN_IVA", "0.00", "240.00"],
  ] as const) {
    test(`${opcion}: borrador → emitir → PDF → aceptación → OV y cuenta por cobrar con el total emitido`, async () => {
      const { id, folio } = await crearCotizacionVenta(admin, completa({ vendedorId: null, impuestoVenta: opcion }), clave());
      await emitirCotizacionVenta(director, id, await version(id));
      const doc = (await obtenerCotizacionVenta(director, id)).emision!.documento;
      assert.equal(doc.vendedor, null);
      assert.equal(doc.totales.iva, iva);
      assert.equal(doc.totales.total, total);

      const texto = await pdfTexto(director, id);
      assert.match(texto, new RegExp(folio));
      assert.ok(texto.includes(`$${total}`), `PDF con total ${total}`);
      assert.match(texto, opcion === "CON_IVA" ? /IVA 16 % \$38\.40/ : /IVA \(Sin IVA\) \$0\.00/);
      assert.doesNotMatch(texto, /Vendedor|Exento|Tasa 0/);

      await registrarAceptacionCotizacion(director, id, { fechaAceptacion: HOY }, evidencia());
      const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id }, include: { ordenVenta: { include: { cuenta: true } } } });
      assert.equal(fila.vendedorId, null);
      assert.equal(fila.ordenVenta!.iva.toFixed(2), iva);
      assert.equal(fila.ordenVenta!.total.toFixed(2), total);
      assert.equal(fila.ordenVenta!.cuenta!.total.toFixed(2), total, "importe por cobrar = total emitido");
    });
  }
});

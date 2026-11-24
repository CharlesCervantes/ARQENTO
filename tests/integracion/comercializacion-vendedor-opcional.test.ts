import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import {
  actualizarCotizacionVenta,
  crearCotizacionVenta,
  listarCotizacionesVenta,
  obtenerCotizacionVenta,
} from "@/lib/server/comercializacion/cotizaciones";
import { duplicarCotizacionVenta, emitirCotizacionVenta, obtenerDocumentoParaPdf } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { cambiarMarcaVendedorComercial } from "@/lib/server/comercializacion/vendedores";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import { FILTRO_SIN_VENDEDOR } from "@/lib/comercializacion/vendedor";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, admin as adminBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Vendedor opcional (noviembre 2026) contra PostgreSQL REAL: Administración y
// Dirección completan cotización → emisión → PDF → aceptación → orden de
// venta SIN vendedor (vendedorId NULL). Quién hizo cada acción se registra
// aparte. Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId: EMPRESA, vendedorComercial, modulos: [M] }),
  id,
});
// Los dos dueños: Administración y Dirección.
const duenoA = sesion(adminBase.id, "ADMINISTRADOR");
const duenoB = sesion("usuario-director-vo", "DIRECTOR");
const vendedor = sesion(supervisor.id, "SUPERVISOR", true);

const HOY = hoyNegocio();
const masDias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let PRODUCTO: string;
let CLIENTE: string;
let OBRA: string;
let n = 0;
const clave = () => `clave-vo-${++n}-${Date.now()}`;
const version = async (id: string) => (await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).version;
const completa = (extra: Record<string, unknown> = {}) => ({
  clienteId: CLIENTE,
  obraId: OBRA,
  descripcion: "Suministro ficticio",
  fecha: HOY,
  vigenciaHasta: masDias(10),
  condiciones: "Pago contra entrega",
  observaciones: "",
  partidas: [{ productoId: PRODUCTO, cantidad: "3" }],
  ...extra,
});
const evidencia = () => ({ nombre: "OC cliente.pdf", bytes: new Uint8Array(pdfFicticio("Aceptación ficticia")) });

async function pdfTexto(u: UsuarioSesion, id: string): Promise<string> {
  const entrada = JSON.stringify(await obtenerDocumentoParaPdf(u, id));
  const script = fileURLToPath(new URL("./apoyo/renderizar-pdf-cotizacion.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--import", "tsx", script], { input: entrada, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`No se pudo renderizar el PDF: ${r.stderr}`);
  const buffer = Buffer.from(r.stdout, "base64");
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
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
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true, nombre: "Vendedora Ficticia" } });
  await db.usuario.create({
    data: { id: duenoB.id, nombre: "Director Ficticio", email: "director-vo@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA },
  });
  PRODUCTO = (await crearProductoComercial(duenoA, {
    codigo: "CEM-50",
    descripcion: "Cemento ficticio",
    unidad: "bulto",
    precioVenta: "245.50",
    costoReferencia: "198.37",
    tratamientoImpuesto: "GRAVADO",
    tasaIva: "16",
  })).id;
  CLIENTE = (await crearClienteComercial(duenoA, { nombre: "Constructora Ficticia" })).id;
  OBRA = (await crearObraComercial(duenoA, { clienteId: CLIENTE, nombre: "Torre Ficticia" })).id;
});

describe("Vendedor opcional — recorrido de la demo", () => {
  test("Dueño A crea «Sin vendedor»; dueño B emite, genera PDF y acepta; la OV se genera sin pedir vendedor", async () => {
    // Dueño A: borrador con «Sin vendedor» (el formulario envía null).
    const { id, folio } = await crearCotizacionVenta(duenoA, completa({ vendedorId: null }), clave());
    const reabierta = await obtenerCotizacionVenta(duenoA, id);
    assert.equal(reabierta.vendedor, null, "al volver a abrirla sigue «Sin vendedor»");

    // Dueño B la abre (misma Empresa), la emite sin tocar el vendedor.
    const vistaB = await obtenerCotizacionVenta(duenoB, id);
    assert.equal(vistaB.vendedor, null);
    await emitirCotizacionVenta(duenoB, id, await version(id));
    const emitida = await obtenerCotizacionVenta(duenoB, id);
    assert.equal(emitida.estatus, "EMITIDA");
    assert.equal(emitida.emision?.documento.vendedor, null, "la copia emitida conserva «Sin vendedor»");

    // PDF para el cliente: válido y sin fila de vendedor.
    const texto = await pdfTexto(duenoB, id);
    assert.match(texto, new RegExp(folio));
    assert.doesNotMatch(texto, /Vendedor/);

    // Aceptación → orden de venta.
    const r = await registrarAceptacionCotizacion(duenoB, id, { fechaAceptacion: HOY, referenciaOcCliente: "OC-DEMO-1" }, evidencia());
    const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id }, include: { ordenVenta: true } });
    assert.equal(fila.estatus, "ACEPTADA");
    assert.ok(fila.ordenVenta, `se generó la OV (${JSON.stringify(r)})`);
    assert.equal(fila.vendedorId, null, "válido hasta la orden de venta");

    // Quién hizo cada acción, registrado por separado.
    assert.equal(fila.creadoPorId, duenoA.id);
    assert.equal(fila.emitidaPorId, duenoB.id);
    assert.equal(fila.ordenVenta.registradaPorId, duenoB.id);

    // La operación aparece en Operaciones para ambos dueños.
    for (const u of [duenoA, duenoB]) {
      const filaListado = (await listarCotizacionesVenta(u)).find((c) => c.id === id);
      assert.ok(filaListado);
      assert.equal(filaListado.vendedorNombre, null);
      assert.equal(filaListado.ordenFolio, fila.ordenVenta.folio);
    }
  });

  test("Al editar: omitir el campo conserva; null quita al vendedor; administración puede asignar uno de su Empresa en borrador", async () => {
    const { id } = await crearCotizacionVenta(duenoA, completa({ vendedorId: vendedor.id }), clave());
    // Sin el campo vendedorId: se conserva el asignado.
    const sinCampo = { ...completa() } as Record<string, unknown>;
    await actualizarCotizacionVenta(duenoA, id, await version(id), { ...sinCampo, descripcion: "Cambio 1" });
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).vendedorId, vendedor.id);
    // null explícito: «Sin vendedor».
    await actualizarCotizacionVenta(duenoA, id, await version(id), completa({ vendedorId: null }));
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).vendedorId, null);
    // "" (opción «Sin vendedor» del select) también.
    await actualizarCotizacionVenta(duenoB, id, await version(id), completa({ vendedorId: vendedor.id }));
    await actualizarCotizacionVenta(duenoB, id, await version(id), completa({ vendedorId: "" }));
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).vendedorId, null);
  });
});

describe("Vendedor opcional — alcance y reglas", () => {
  test("El vendedor crea a su nombre, ve solo las suyas; las ventas sin vendedor son solo de administración", async () => {
    const propia = await crearCotizacionVenta(vendedor, completa({ descripcion: "Propia" }), clave());
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: propia.id } })).vendedorId, vendedor.id);
    // Aunque intente «Sin vendedor», queda a su nombre.
    const intento = await crearCotizacionVenta(vendedor, completa({ descripcion: "Intento", vendedorId: null }), clave());
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: intento.id } })).vendedorId, vendedor.id);

    const sinVendedor = await crearCotizacionVenta(duenoA, completa({ vendedorId: null }), clave());
    assert.deepEqual((await listarCotizacionesVenta(vendedor)).map((c) => c.id).sort(), [propia.id, intento.id].sort());
    await assert.rejects(obtenerCotizacionVenta(vendedor, sinVendedor.id), RegistroNoEncontradoError);

    // Filtro «Sin vendedor» de administración.
    const filtradas = await listarCotizacionesVenta(duenoA, { vendedorId: FILTRO_SIN_VENDEDOR });
    assert.deepEqual(filtradas.map((c) => c.id), [sinVendedor.id]);
    // Para el vendedor el filtro no amplía su alcance.
    assert.equal((await listarCotizacionesVenta(vendedor, { vendedorId: FILTRO_SIN_VENDEDOR })).length, 2);
  });

  test("Emitir con un vendedor que perdió la función se bloquea; con «Sin vendedor» se emite", async () => {
    const { id } = await crearCotizacionVenta(duenoA, completa({ vendedorId: vendedor.id }), clave());
    await cambiarMarcaVendedorComercial(duenoA, { usuarioId: vendedor.id, vendedor: false });
    await assert.rejects(emitirCotizacionVenta(duenoA, id, await version(id)), (e: Error) => e instanceof ValidacionError && /vendedor elegible/.test(e.message));
    await actualizarCotizacionVenta(duenoA, id, await version(id), completa({ vendedorId: null }));
    await emitirCotizacionVenta(duenoA, id, await version(id));
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).estatus, "EMITIDA");
  });

  test("Las cotizaciones con vendedor conservan su asignación y su documento emitido", async () => {
    const { id } = await crearCotizacionVenta(duenoA, completa({ vendedorId: vendedor.id }), clave());
    await emitirCotizacionVenta(duenoA, id, await version(id));
    const c = await obtenerCotizacionVenta(duenoA, id);
    assert.equal(c.vendedor?.id, vendedor.id);
    assert.equal(c.emision?.documento.vendedor?.nombre, "Vendedora Ficticia");
    assert.match(await pdfTexto(duenoA, id), /Vendedora Ficticia/);
  });

  test("La base impide cambiar el vendedor de una cotización emitida, también desde o hacia «Sin vendedor»", async () => {
    const sin = (await crearCotizacionVenta(duenoA, completa({ vendedorId: null }), clave())).id;
    await emitirCotizacionVenta(duenoA, sin, await version(sin));
    await assert.rejects(db.cotizacionVenta.update({ where: { id: sin }, data: { vendedorId: vendedor.id } }), /no se puede modificar/);

    const con = (await crearCotizacionVenta(duenoA, completa({ vendedorId: vendedor.id }), clave())).id;
    await emitirCotizacionVenta(duenoA, con, await version(con));
    await assert.rejects(db.cotizacionVenta.update({ where: { id: con }, data: { vendedorId: null } }), /no se puede modificar/);
  });

  test("Duplicar: una venta sin vendedor sigue sin vendedor; la de un vendedor que ya no es elegible queda sin vendedor", async () => {
    const sin = (await crearCotizacionVenta(duenoA, completa({ vendedorId: null }), clave())).id;
    await emitirCotizacionVenta(duenoA, sin, await version(sin));
    const dup1 = await duplicarCotizacionVenta(duenoB, sin, clave());
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: dup1.id } })).vendedorId, null);

    const con = (await crearCotizacionVenta(duenoA, completa({ vendedorId: vendedor.id }), clave())).id;
    await emitirCotizacionVenta(duenoA, con, await version(con));
    const dup2 = await duplicarCotizacionVenta(duenoA, con, clave());
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: dup2.id } })).vendedorId, vendedor.id);
    await cambiarMarcaVendedorComercial(duenoA, { usuarioId: vendedor.id, vendedor: false });
    const dup3 = await duplicarCotizacionVenta(duenoA, con, clave());
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: dup3.id } })).vendedorId, null);
  });
});

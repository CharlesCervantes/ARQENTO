import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { db } from "@/lib/server/db";
import { crearProductoComercial, editarProductoComercial, cambiarEstatusProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import {
  ConflictoEdicionError,
  actualizarCotizacionVenta,
  crearCotizacionVenta,
  listarCotizacionesVenta,
  obtenerCotizacionVenta,
} from "@/lib/server/comercializacion/cotizaciones";
import { duplicarCotizacionVenta, emitirCotizacionVenta, obtenerDocumentoParaPdf } from "@/lib/server/comercializacion/emision";
import { generarPdfCotizacion } from "@/lib/server/comercializacion/pdf";
import { obtenerEvidenciaOrdenVenta, registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { cambiarMarcaVendedorComercial } from "@/lib/server/comercializacion/vendedores";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import { formatearImporte } from "@/lib/comercializacion/importes";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio, pngFicticio } from "../helpers/archivos-ficticios";
import {
  EMPRESA,
  EMPRESA_AJENA,
  admin as adminBase,
  adminAjeno as adminAjenoBase,
  baseLimpiaConDatos,
  conFallaSimulada,
  sinInterbloqueos,
  supervisor,
} from "./apoyo/base";

// Comercialización B3 contra PostgreSQL REAL y almacenamiento SIMULADO en
// memoria: emisión, copia histórica inmutable, PDF, aceptación con evidencia,
// orden de venta única y duplicado. Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b3", "DIRECTOR", EMPRESA);
const vendedorA = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const vendedorB = sesion("usuario-vendedor-b3", "SUPERVISOR", EMPRESA, true);
const supSinMarca = sesion("usuario-sup-sin-marca-b3", "SUPERVISOR", EMPRESA);

const HOY = hoyNegocio();
const masDias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let P16: string;
let P_CERO: string;
let P_EXENTO: string;
let CLIENTE: string;
let OBRA: string;

const COSTOS = ["198.37", "1500.00", "88.88"];

const producto = (codigo: string, extra: Record<string, unknown> = {}) => ({
  codigo,
  descripcion: `Producto ${codigo} (ficticio)`,
  unidad: "pza",
  precioVenta: "100",
  costoReferencia: "88.88",
  tratamientoImpuesto: "GRAVADO",
  tasaIva: "16",
  ...extra,
});

const completa = (extra: Record<string, unknown> = {}) => ({
  clienteId: CLIENTE,
  obraId: OBRA,
  descripcion: "Material para losa (ficticio)",
  fecha: HOY,
  vigenciaHasta: masDias(10),
  condiciones: "Pago contra entrega",
  observaciones: "",
  partidas: [
    { productoId: P16, cantidad: "2.375" },
    { productoId: P_CERO, cantidad: "0.125" },
    { productoId: P_EXENTO, cantidad: "1.5" },
  ],
  ...extra,
});

let n = 0;
const clave = () => `clave-b3-${++n}-${Date.now()}`;
const version = async (id: string) => (await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).version;

async function borrador(u: UsuarioSesion, extra: Record<string, unknown> = {}) {
  return (await crearCotizacionVenta(u, completa(extra), clave())).id;
}
async function emitida(u: UsuarioSesion, extra: Record<string, unknown> = {}) {
  const id = await borrador(u, extra);
  await emitirCotizacionVenta(u, id, await version(id));
  return id;
}
const evidencia = (semilla = "ok") => ({ nombre: `OC cliente ${semilla}.pdf`, bytes: new Uint8Array(pdfFicticio(`Aceptación ${semilla}`)) });
const aceptar = (u: UsuarioSesion, id: string, extra: Record<string, unknown> = {}, archivo: ReturnType<typeof evidencia> | null = evidencia()) =>
  registrarAceptacionCotizacion(u, id, { fechaAceptacion: HOY, referenciaOcCliente: "OC-CLI-778", ...extra }, archivo);
const evidenciasEnAlmacen = (cotizacionId: string) => [...almacenamiento.keys()].filter((k) => k.includes(`/aceptaciones/${cotizacionId}/`));

// PDF real en un proceso aparte (ver apoyo/renderizar-pdf-cotizacion.ts),
// alimentado con la copia que devuelve el servicio con alcance aplicado.
async function pdfDe(u: UsuarioSesion, id: string): Promise<Buffer> {
  const entrada = JSON.stringify(await obtenerDocumentoParaPdf(u, id));
  const script = fileURLToPath(new URL("./apoyo/renderizar-pdf-cotizacion.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--import", "tsx", script], { input: entrada, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`No se pudo renderizar el PDF: ${r.stderr}`);
  return Buffer.from(r.stdout, "base64");
}

async function textoPdf(buffer: Buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await parser.getText();
    return { texto: r.text, paginas: r.total };
  } finally {
    await parser.destroy();
  }
}

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.createMany({
    data: [
      { id: director.id, nombre: "Director B3", email: "director-b3@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA },
      { id: vendedorB.id, nombre: "Vendedor B", email: "vend-b3@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA, vendedorComercial: true },
      { id: supSinMarca.id, nombre: "Supervisor sin marca", email: "sup-b3@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA },
    ],
  });
  P16 = (await crearProductoComercial(admin, producto("CEM-50", { unidad: "bulto", precioVenta: "245.50", costoReferencia: "198.37" }))).id;
  P_CERO = (await crearProductoComercial(admin, producto("VAR-T", { unidad: "ton", precioVenta: "2840", costoReferencia: "1500", tratamientoImpuesto: "TASA_CERO", tasaIva: "" }))).id;
  P_EXENTO = (await crearProductoComercial(admin, producto("SRV-1", { unidad: "serv", precioVenta: "120", tratamientoImpuesto: "EXENTO", tasaIva: "" }))).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Constructora Norte (ficticia)", contacto: "Ing. Ficticio" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Torre A", ubicacion: "Calle Ficticia 1" })).id;
});

describe("Emisión", () => {
  test("Exige cliente, obra, descripción, vigencia y al menos un material; el borrador sigue editable", async () => {
    const id = (await crearCotizacionVenta(admin, { clienteId: CLIENTE, fecha: HOY, partidas: [] }, clave())).id;
    await assert.rejects(emitirCotizacionVenta(admin, id, 1), (e: Error) => {
      assert.ok(e instanceof ValidacionError);
      for (const falta of ["obra del cliente", "descripción", "vigencia", "al menos un material"]) assert.match(e.message, new RegExp(falta));
      return true;
    });
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).estatus, "BORRADOR");
  });

  test("Vigencia pasada, material desactivado y vendedor ya no elegible impiden emitir", async () => {
    const vencida = await borrador(admin, { fecha: "2026-01-01", vigenciaHasta: "2026-01-05" });
    await assert.rejects(emitirCotizacionVenta(admin, vencida, 1), /vigencia ya pasó/);

    const conInactivo = await borrador(admin);
    await cambiarEstatusProductoComercial(admin, P_EXENTO, { activo: false });
    await assert.rejects(emitirCotizacionVenta(admin, conInactivo, 1), /SRV-1/);
    await cambiarEstatusProductoComercial(admin, P_EXENTO, { activo: true });

    const deA = await borrador(vendedorA);
    await cambiarMarcaVendedorComercial(admin, { usuarioId: vendedorA.id, vendedor: false });
    await assert.rejects(emitirCotizacionVenta(admin, deA, 1), /vendedor elegible/);
  });

  test("Versión vieja = conflicto; emitir dos veces o editar una emitida se rechaza", async () => {
    const id = await borrador(admin);
    await actualizarCotizacionVenta(admin, id, 1, completa({ descripcion: "Cambio" }));
    await assert.rejects(emitirCotizacionVenta(admin, id, 1), ConflictoEdicionError);
    await emitirCotizacionVenta(admin, id, 2);
    await assert.rejects(emitirCotizacionVenta(admin, id, 3), /ya fue emitida/);
    await assert.rejects(actualizarCotizacionVenta(admin, id, 3, completa()), /Solo se pueden editar cotizaciones en borrador/);
  });

  test("La base impide modificar partidas, totales o regresar a borrador una emitida", async () => {
    const id = await emitida(admin);
    const p = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
    await assert.rejects(db.partidaCotizacionVenta.update({ where: { id: p.id }, data: { cantidad: "99" } }), /emitida/);
    await assert.rejects(db.partidaCotizacionVenta.delete({ where: { id: p.id } }), /emitida/);
    await assert.rejects(db.cotizacionVenta.update({ where: { id }, data: { total: "1.00", subtotal: "1.00", iva: "0" } }), /emitida/);
    await assert.rejects(db.cotizacionVenta.update({ where: { id }, data: { estatus: "BORRADOR" } }), /emitida/);
    await assert.rejects(db.cotizacionVenta.update({ where: { id }, data: { documentoEmitido: { alterado: true } } }), /emitida/);
  });

  test("Emisión exitosa: copia histórica con totales exactos, sin costos, y bitácora", async () => {
    const id = await borrador(vendedorA);
    const r = await emitirCotizacionVenta(vendedorA, id, 1);
    assert.equal(r.version, 2);
    const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    assert.equal(fila.estatus, "EMITIDA");
    assert.equal(fila.emitidaPorId, vendedorA.id);
    const doc = fila.documentoEmitido as Record<string, unknown>;
    const totales = doc.totales as Record<string, unknown>;
    // 2.375 × 245.50 = 583.0625 → 583.06; IVA 16 % = 93.2896 → 93.29;
    // tasa 0: 0.125 × 2840 = 355.00; exento: 1.5 × 120 = 180.00.
    assert.equal(totales.subtotal, "1118.06");
    assert.equal(totales.iva, "93.29");
    assert.equal(totales.total, "1211.35");
    assert.equal(fila.total.toFixed(2), "1211.35");
    const texto = JSON.stringify(doc);
    for (const costo of COSTOS) assert.ok(!texto.includes(costo), `costo ${costo} en la copia`);
    assert.ok(!/costo|precioBase|ajust/i.test(texto));
    const bitacora = await db.registroAuditoria.findFirstOrThrow({ where: { entidadId: id, accion: "CAMBIAR_ESTATUS" } });
    assert.deepEqual(bitacora.valorNuevo && (bitacora.valorNuevo as Record<string, unknown>).estatus, "EMITIDA");
  });

  test("Alcance: un vendedor no emite cotizaciones de otro; otra Empresa tampoco", async () => {
    const deA = await borrador(vendedorA);
    await assert.rejects(emitirCotizacionVenta(vendedorB, deA, 1), RegistroNoEncontradoError);
    await assert.rejects(emitirCotizacionVenta(adminAjeno, deA, 1), RegistroNoEncontradoError);
    await assert.rejects(emitirCotizacionVenta(supSinMarca, deA, 1), SinPermisoComercialError);
  });
});

describe("Copia histórica inmutable y PDF", () => {
  test("Cambios posteriores de catálogo, cliente, obra, vendedor y Empresa no alteran el documento ni su PDF", async () => {
    const id = await emitida(admin, { vendedorId: vendedorA.id });
    const antes = (await obtenerDocumentoParaPdf(admin, id)).documento;

    await editarProductoComercial(admin, P16, producto("CEM-50-NUEVO", { descripcion: "Otro producto", precioVenta: "999", tratamientoImpuesto: "EXENTO", tasaIva: "" }));
    await db.clienteComercial.update({ where: { id: CLIENTE }, data: { nombre: "Cliente Renombrado" } });
    await db.obraComercial.update({ where: { id: OBRA }, data: { nombre: "Obra Renombrada" } });
    await db.usuario.update({ where: { id: vendedorA.id }, data: { nombre: "Vendedor Renombrado" } });
    await db.empresa.update({ where: { id: EMPRESA }, data: { nombre: "Empresa Renombrada", razonSocial: "Otra Razón SA" } });

    const despues = (await obtenerDocumentoParaPdf(admin, id)).documento;
    assert.deepEqual(despues, antes);
    const { texto } = await textoPdf(await pdfDe(admin, id));
    assert.match(texto, /Constructora Norte \(ficticia\)/);
    assert.match(texto, /CEM-50/);
    for (const nuevo of ["Renombrad", "CEM-50-NUEVO", "Otra Razón", "$999.00"]) assert.ok(!texto.includes(nuevo), `PDF con dato nuevo: ${nuevo}`);
  });

  test("El PDF trae los totales guardados, distingue Tasa 0 % y Exento, y no incluye costos", async () => {
    const id = await emitida(admin);
    const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    assert.equal((await obtenerDocumentoParaPdf(admin, id)).borrador, false);
    const { texto } = await textoPdf(await pdfDe(admin, id));
    assert.ok(texto.includes(formatearImporte(fila.total.toFixed(2))), `total ${fila.total} no aparece`);
    assert.ok(texto.includes(formatearImporte(fila.subtotal.toFixed(2))));
    assert.match(texto, /IVA 16 % sobre \$583\.06/);
    assert.match(texto, /Base tasa 0 %/);
    assert.match(texto, /Base exenta/);
    assert.match(texto, /Tasa 0 %/);
    assert.match(texto, /Exento/);
    assert.match(texto, new RegExp(fila.folio));
    for (const costo of [...COSTOS, "$198.37", "$1,500.00", "$88.88"]) assert.ok(!texto.includes(costo), `costo ${costo} en el PDF`);
    assert.ok(!/BORRADOR/.test(texto));
  });

  test("La vista previa de un borrador se marca BORRADOR", async () => {
    const id = await borrador(admin);
    assert.equal((await obtenerDocumentoParaPdf(admin, id)).borrador, true);
    assert.match((await textoPdf(await pdfDe(admin, id))).texto, /BORRADOR/);
  });

  test("Documento de varias páginas con textos largos", async () => {
    const largos = Array.from({ length: 12 }, (_, i) => ({ productoId: [P16, P_CERO, P_EXENTO][i % 3], cantidad: String(i + 1) }));
    const muchas = Array.from({ length: 5 }, () => largos).flat();
    const texto = "Condición ficticia muy larga. ".repeat(60);
    const id = await emitida(admin, { partidas: muchas, condiciones: texto, observaciones: texto, descripcion: "Descripción larga ".repeat(10).trim() });
    const fila = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    const r = await textoPdf(await pdfDe(admin, id));
    assert.ok(r.paginas >= 2, `páginas: ${r.paginas}`);
    assert.match(r.texto, new RegExp(`Página ${r.paginas} de ${r.paginas}`));
    assert.ok(r.texto.includes(formatearImporte(fila.total.toFixed(2))));
  });

  test("PDF protegido por Empresa y vendedor, también por ID directo", async () => {
    const deA = await emitida(vendedorA);
    await assert.rejects(generarPdfCotizacion(vendedorB, deA), RegistroNoEncontradoError);
    await assert.rejects(generarPdfCotizacion(adminAjeno, deA), RegistroNoEncontradoError);
    await assert.rejects(generarPdfCotizacion(supSinMarca, deA), SinPermisoComercialError);
    await assert.rejects(generarPdfCotizacion(usuarioDePrueba({ rol: "MASTER" }), deA), SinPermisoComercialError);
    // Usuarios autorizados obtienen el documento (el render se prueba arriba).
    assert.equal((await obtenerDocumentoParaPdf(vendedorA, deA)).borrador, false);
    assert.equal((await obtenerDocumentoParaPdf(director, deA)).borrador, false);
    assert.ok((await pdfDe(vendedorA, deA)).length > 0);
  });
});

describe("Aceptación y orden de venta", () => {
  test("Administración acepta con evidencia: OV-000001 atómica, con totales de la COT y bitácora", async () => {
    const id = await emitida(admin);
    const ocAntes = (await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenCompra;
    const r = await aceptar(admin, id);
    assert.equal(r.folio, "OV-000001");
    assert.equal(r.existente, false);
    const cot = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    const ov = await db.ordenVenta.findUniqueOrThrow({ where: { id: r.ordenId } });
    assert.equal(cot.estatus, "ACEPTADA");
    assert.equal(ov.cotizacionId, id);
    assert.equal(ov.total.toFixed(2), cot.total.toFixed(2));
    assert.equal(ov.referenciaOcCliente, "OC-CLI-778");
    assert.equal(ov.registradaPorId, admin.id);
    assert.equal(ov.evidenciaTipo, "application/pdf");
    assert.equal(evidenciasEnAlmacen(id).length, 1);
    assert.ok(ov.evidenciaRef.startsWith(`comercializacion/${EMPRESA}/aceptaciones/${id}/`));
    const e = await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } });
    assert.equal(e.ultimoFolioOrdenVenta, 1);
    assert.equal(e.ultimoFolioOrdenCompra, ocAntes);
    const acciones = (await db.registroAuditoria.findMany({ where: { entidad: { in: ["CotizacionVenta", "OrdenVenta"] } } })).map((x) => `${x.entidad}:${x.accion}`);
    assert.ok(acciones.includes("OrdenVenta:CREAR"));
    assert.equal(acciones.filter((a) => a === "CotizacionVenta:CAMBIAR_ESTATUS").length, 2); // emitir + aceptar
  });

  test("Roles: director y vendedor asignado aceptan; otro vendedor, Supervisor sin marca y otra Empresa no", async () => {
    const deA = await emitida(vendedorA);
    await assert.rejects(aceptar(vendedorB, deA), RegistroNoEncontradoError);
    await assert.rejects(aceptar(adminAjeno, deA), RegistroNoEncontradoError);
    await assert.rejects(aceptar(supSinMarca, deA), SinPermisoComercialError);
    assert.equal(await db.ordenVenta.count(), 0);
    assert.equal((await aceptar(vendedorA, deA)).folio, "OV-000001");
    const deAdmin = await emitida(admin);
    assert.equal((await aceptar(director, deAdmin)).folio, "OV-000002");
  });

  test("Validaciones: borrador, evidencia faltante o inválida, tamaño, fechas — sin efectos", async () => {
    const enBorrador = await borrador(admin);
    await assert.rejects(aceptar(admin, enBorrador), /cotización emitida/);
    const id = await emitida(admin);
    await assert.rejects(aceptar(admin, id, {}, null), /Adjunta la evidencia/);
    await assert.rejects(aceptar(admin, id, {}, { nombre: "falso.pdf", bytes: new TextEncoder().encode("no soy un pdf") }), /PDF, JPG o PNG/);
    // Límite por carga de Comercialización: 4 MB (lib/comercializacion/cargas.ts).
    const grande = new Uint8Array(4 * 1024 * 1024 + 1);
    grande.set(pdfFicticio("grande").subarray(0, 8));
    await assert.rejects(aceptar(admin, id, {}, { nombre: "grande.pdf", bytes: grande }), /el máximo es 4 MB/);
    await assert.rejects(aceptar(admin, id, { fechaAceptacion: masDias(1) }), /futura/);
    await assert.rejects(aceptar(admin, id, { fechaAceptacion: "2025-01-01" }), /anterior a la fecha/);
    await assert.rejects(aceptar(admin, id, { referenciaOcCliente: "x".repeat(101) }));
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).estatus, "EMITIDA");
    assert.equal(await db.ordenVenta.count(), 0);
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenVenta, 0);
    assert.equal(evidenciasEnAlmacen(id).length, 0);
    // Imagen PNG también es evidencia válida.
    assert.equal((await aceptar(admin, id, {}, { nombre: "captura.png", bytes: new Uint8Array(pngFicticio("ok")) })).folio, "OV-000001");
  });

  test("Cotización vencida: no se acepta (decisión provisional); se puede duplicar", async () => {
    const id = await emitida(admin);
    await db.$executeRawUnsafe(`ALTER TABLE cotizaciones_venta DISABLE TRIGGER cotizaciones_venta_emitida_inmutable`);
    try {
      await db.cotizacionVenta.update({ where: { id }, data: { fecha: new Date("2026-01-01T00:00:00Z"), vigenciaHasta: new Date("2026-01-10T00:00:00Z") } });
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE cotizaciones_venta ENABLE TRIGGER cotizaciones_venta_emitida_inmutable`);
    }
    await assert.rejects(aceptar(admin, id, { fechaAceptacion: "2026-01-05" }), /vencida/);
    assert.equal(await db.ordenVenta.count(), 0);
    assert.equal((await obtenerCotizacionVenta(admin, id)).vencida, true);
    const dup = await duplicarCotizacionVenta(admin, id, clave());
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: dup.id } })).estatus, "BORRADOR");
  });

  test("Doble clic, reintento y solicitudes simultáneas devuelven la MISMA OV", async () => {
    const id = await emitida(admin, { vendedorId: vendedorA.id });
    const resultados = await Promise.allSettled([
      aceptar(admin, id, {}, evidencia("1")),
      aceptar(vendedorA, id, {}, evidencia("2")),
      aceptar(director, id, {}, evidencia("3")),
      aceptar(admin, id, {}, evidencia("4")),
      aceptar(admin, id, {}, evidencia("5")),
    ]);
    sinInterbloqueos(resultados);
    const ids = new Set(resultados.map((r) => (r.status === "fulfilled" ? r.value.ordenId : `rechazo:${(r.reason as Error).message}`)));
    assert.equal(ids.size, 1, [...ids].join(" | "));
    assert.equal(await db.ordenVenta.count(), 1);
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenVenta, 1);
    assert.equal(evidenciasEnAlmacen(id).length, 1, "solo debe quedar la evidencia de la OV ganadora");

    const reintento = await aceptar(admin, id, {}, evidencia("6"));
    assert.equal(reintento.existente, true);
    assert.equal(reintento.ordenId, [...ids][0]);
    assert.equal(evidenciasEnAlmacen(id).length, 1);
  });

  test("Si la operación falla, nada queda aceptado: rollback completo y evidencia retirada", async () => {
    const id = await emitida(admin);
    await assert.rejects(conFallaSimulada("ordenes_venta", "true", () => aceptar(admin, id)), /Falla simulada/);
    await assert.rejects(
      conFallaSimulada("registros_auditoria", `NEW."entidad" = 'OrdenVenta'`, () => aceptar(admin, id)),
      /Falla simulada/
    );
    const cot = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    assert.equal(cot.estatus, "EMITIDA");
    assert.equal(await db.ordenVenta.count(), 0);
    assert.equal((await db.empresa.findUniqueOrThrow({ where: { id: EMPRESA } })).ultimoFolioOrdenVenta, 0);
    assert.equal(evidenciasEnAlmacen(id).length, 0);
    assert.equal((await aceptar(admin, id)).folio, "OV-000001");
  });

  test("Después de aceptar: sin edición, sin cambios en partidas y la OV se mantiene", async () => {
    const id = await emitida(admin);
    await aceptar(admin, id);
    await assert.rejects(actualizarCotizacionVenta(admin, id, await version(id), completa()), /borrador/);
    await assert.rejects(emitirCotizacionVenta(admin, id, await version(id)), /ya fue emitida/);
    const p = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
    await assert.rejects(db.partidaCotizacionVenta.update({ where: { id: p.id }, data: { precioUnitario: "1.00" } }), /emitida/);
    await assert.rejects(db.cotizacionVenta.update({ where: { id }, data: { estatus: "EMITIDA" } }), /emitida/);
  });

  test("Evidencia protegida por Empresa y vendedor", async () => {
    const id = await emitida(admin, { vendedorId: vendedorA.id });
    const { ordenId } = await aceptar(admin, id, {}, evidencia("protegida"));
    const original = Buffer.from(evidencia("protegida").bytes);
    assert.deepEqual((await obtenerEvidenciaOrdenVenta(admin, ordenId)).bytes, original);
    assert.deepEqual((await obtenerEvidenciaOrdenVenta(vendedorA, ordenId)).bytes, original);
    await assert.rejects(obtenerEvidenciaOrdenVenta(vendedorB, ordenId), RegistroNoEncontradoError);
    await assert.rejects(obtenerEvidenciaOrdenVenta(adminAjeno, ordenId), RegistroNoEncontradoError);
    await assert.rejects(obtenerEvidenciaOrdenVenta(supSinMarca, ordenId), SinPermisoComercialError);
  });

  test("Sin movimientos financieros ni efectos en construcción", async () => {
    const antes = { proyectos: await db.proyecto.count(), semanas: await db.semana.count() };
    const id = await emitida(admin);
    await aceptar(admin, id);
    const conteos = await Promise.all([
      db.ordenCompra.count(),
      db.cotizacion.count(),
      db.requisicion.count(),
      db.movimientoSemanal.count(),
      db.movimientoFinancieroCliente.count(),
      db.ingreso.count(),
      db.egreso.count(),
      db.gastoObra.count(),
      db.factura.count(),
    ]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual({ proyectos: await db.proyecto.count(), semanas: await db.semana.count() }, antes);
  });

  test("Listado: una fila por operación con OV y COT; búsqueda por OV y OC; alcance del vendedor", async () => {
    const deA = await emitida(admin, { vendedorId: vendedorA.id });
    const { folio } = await aceptar(admin, deA);
    await borrador(vendedorB);
    const filasA = await listarCotizacionesVenta(vendedorA);
    assert.equal(filasA.length, 1);
    assert.equal(filasA[0].ordenFolio, folio);
    assert.equal(filasA[0].estatus, "ACEPTADA");
    assert.deepEqual((await listarCotizacionesVenta(admin, { busqueda: "OV-000001" })).map((f) => f.id), [deA]);
    assert.deepEqual((await listarCotizacionesVenta(admin, { busqueda: "OC-CLI-778" })).map((f) => f.id), [deA]);
    assert.deepEqual((await listarCotizacionesVenta(vendedorB, { busqueda: "OV-000001" })).map((f) => f.id), []);
    assert.equal((await listarCotizacionesVenta(admin, { estatus: "ACEPTADA" })).length, 1);
    assert.equal((await listarCotizacionesVenta(admin, { estatus: "BORRADOR" })).length, 1);
    const detalle = await obtenerCotizacionVenta(vendedorA, deA);
    assert.equal(detalle.orden?.folio, folio);
    assert.ok(!/costo/i.test(JSON.stringify(detalle)));
  });
});

describe("Duplicar", () => {
  test("Administración: borrador nuevo vinculado, original intacto y precio ajustado conservado", async () => {
    const id = await emitida(admin, { partidas: [{ productoId: P16, cantidad: "2", precioUnitario: "260" }] });
    const antes = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    await editarProductoComercial(admin, P16, producto("CEM-50", { unidad: "bulto", precioVenta: "250", costoReferencia: "198.37" }));
    const dup = await duplicarCotizacionVenta(admin, id, clave());
    const nueva = await db.cotizacionVenta.findUniqueOrThrow({ where: { id: dup.id }, include: { partidas: true } });
    assert.equal(nueva.estatus, "BORRADOR");
    assert.equal(nueva.origenId, id);
    assert.notEqual(nueva.folio, antes.folio);
    assert.equal(nueva.partidas[0].precioUnitario.toFixed(2), "260.00");
    assert.equal(nueva.partidas[0].precioBase.toFixed(2), "250.00");
    assert.equal(nueva.partidas[0].precioAjustadoPorId, admin.id);
    const despues = await db.cotizacionVenta.findUniqueOrThrow({ where: { id } });
    assert.deepEqual(
      { e: despues.estatus, v: despues.version, d: despues.documentoEmitido, t: despues.total.toFixed(2) },
      { e: antes.estatus, v: antes.version, d: antes.documentoEmitido, t: antes.total.toFixed(2) }
    );
  });

  test("Vendedor: no hereda precios ajustados (toma catálogo vigente) y no puede introducir precios propios", async () => {
    const id = await emitida(admin, { vendedorId: vendedorA.id, partidas: [{ productoId: P16, cantidad: "2", precioUnitario: "300" }] });
    const dup = await duplicarCotizacionVenta(vendedorA, id, clave());
    const p = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: dup.id } });
    assert.equal(p.precioUnitario.toFixed(2), "245.50");
    assert.equal(p.precioAjustadoPorId, null);
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id: dup.id } })).vendedorId, vendedorA.id);
    await assert.rejects(
      actualizarCotizacionVenta(vendedorA, dup.id, 1, completa({ partidas: [{ id: p.id, productoId: P16, cantidad: "2", precioUnitario: "300" }] })),
      SinPermisoComercialError
    );
  });

  test("Omite productos desactivados, se puede duplicar una aceptada y la clave evita duplicados", async () => {
    const id = await emitida(admin);
    await aceptar(admin, id);
    await cambiarEstatusProductoComercial(admin, P_CERO, { activo: false });
    const k = clave();
    const dup = await duplicarCotizacionVenta(admin, id, k);
    assert.deepEqual(dup.omitidos, ["VAR-T"]);
    assert.equal(await db.partidaCotizacionVenta.count({ where: { cotizacionId: dup.id } }), 2);
    assert.equal((await duplicarCotizacionVenta(admin, id, k)).id, dup.id);
  });

  test("No se duplica un borrador ni una cotización fuera de alcance", async () => {
    const enBorrador = await borrador(admin);
    await assert.rejects(duplicarCotizacionVenta(admin, enBorrador, clave()), /borrador/);
    const deA = await emitida(vendedorA);
    await assert.rejects(duplicarCotizacionVenta(vendedorB, deA, clave()), RegistroNoEncontradoError);
    await assert.rejects(duplicarCotizacionVenta(adminAjeno, deA, clave()), RegistroNoEncontradoError);
  });
});

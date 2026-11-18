import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra } from "@/lib/server/comercializacion/compras";
import { definirCondicionesCuenta, detalleCuentaDeOrden, registrarMovimientoCuenta } from "@/lib/server/comercializacion/cuentas";
import {
  anularEntregaComercial,
  estadoEntregaDeOrdenes,
  obtenerEvidenciaEntrega,
  registrarEntregaComercial,
  resumenEntregasOrden,
  type ArchivoEvidenciaEntrega,
} from "@/lib/server/comercializacion/entregas";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { jpgFicticio, pdfFicticio, pngFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Comercialización B6A contra PostgreSQL REAL: entregas parciales al cliente
// con evidencias, cantidades exactas, concurrencia, idempotencia, anulación,
// permisos y ausencia de efectos en compras, cuentas y construcción.
// Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b6a", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const otroVendedor = sesion("usuario-vendedor2-b6a", "SUPERVISOR", EMPRESA, true);

const HOY = hoyNegocio();
const dias = (n: number) => {
  const d = new Date(`${HOY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let POSTE: string;
let TUBO: string;
let CLIENTE: string;
let OBRA: string;
let n = 0;
const clave = () => `clave-b6a-${++n}-${Date.now()}`;
const foto = (s = "a"): ArchivoEvidenciaEntrega => ({ nombre: `foto-${s}.jpg`, bytes: new Uint8Array(jpgFicticio(s)) });
const remision = (s = "r"): ArchivoEvidenciaEntrega => ({ nombre: `remision-${s}.pdf`, bytes: new Uint8Array(pdfFicticio(`Remisión ${s}`)) });

type Orden = { ordenId: string; poste: string; tubo: string };

/** OV de 100 postes (pieza) y 2.375 m de tubo, asignada al vendedor. */
async function ordenPostesYTubo(vendedorId = vendedor.id): Promise<Orden> {
  const { id } = await crearCotizacionVenta(
    admin,
    {
      clienteId: CLIENTE,
      obraId: OBRA,
      descripcion: "Venta ficticia B6A",
      vendedorId,
      fecha: dias(-10),
      vigenciaHasta: dias(10),
      partidas: [
        { productoId: POSTE, cantidad: "100" },
        { productoId: TUBO, cantidad: "2.375" },
      ],
    },
    clave()
  );
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const partidas = await db.partidaCotizacionVenta.findMany({ where: { cotizacionId: id }, orderBy: { orden: "asc" } });
  return { ordenId: ov.ordenId, poste: partidas[0].id, tubo: partidas[1].id };
}

const datos = (o: Orden, poste: string | null, tubo: string | null, extra: Record<string, unknown> = {}) => ({
  fechaEntrega: HOY,
  recibidoPor: "Residente ficticio",
  partidas: [
    ...(poste === null ? [] : [{ partidaVentaId: o.poste, cantidad: poste }]),
    ...(tubo === null ? [] : [{ partidaVentaId: o.tubo, cantidad: tubo }]),
  ],
  ...extra,
});

const entregar = (o: Orden, poste: string | null, tubo: string | null, u: UsuarioSesion = admin, archivos = [foto(), remision()], k = clave()) =>
  registrarEntregaComercial(u, o.ordenId, datos(o, poste, tubo), archivos, k);

const pendientes = async (o: Orden, u: UsuarioSesion = admin) => {
  const r = await resumenEntregasOrden(u, o.ordenId);
  return { pend: r.partidas.map((p) => p.pendiente), estado: r.estado, completas: r.completas, r };
};

const objetosDeEntregas = () => [...almacenamiento.keys()].filter((k) => k.includes("/entregas/"));

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.createMany({
    data: [
      { id: director.id, nombre: "Director B6A", email: "director-b6a@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA },
      { id: otroVendedor.id, nombre: "Vendedor 2 B6A", email: "vendedor2-b6a@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA, vendedorComercial: true },
    ],
  });
  POSTE = (await crearProductoComercial(admin, { codigo: "POSTE", descripcion: "Poste ficticio", unidad: "pieza", precioVenta: "100", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  TUBO = (await crearProductoComercial(admin, { codigo: "TUBO", descripcion: "Tubo ficticio", unidad: "m", precioVenta: "50", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B6A" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B6A" })).id;
});

describe("Caso principal: 100 postes y 2.375 m de tubo", () => {
  test("Entrega 1 parcial, rechazo de excedente, Entrega 2 completa, anulación de la Entrega 1", async () => {
    const o = await ordenPostesYTubo();
    let s = await pendientes(o);
    assert.deepEqual([s.pend, s.estado, s.completas], [["100.000", "2.375"], "PENDIENTE", 0]);

    const e1 = await entregar(o, "60", "1.250");
    assert.equal(e1.numero, 1);
    s = await pendientes(o);
    assert.deepEqual([s.pend, s.estado, s.completas], [["40.000", "1.125"], "PARCIAL", 0]);

    // 41 postes > 40 pendientes: rechazada sin crear nada ni dejar archivos.
    const archivosAntes = objetosDeEntregas().length;
    await assert.rejects(entregar(o, "41", null), /POSTE: la entrega \(41 pieza\) supera lo pendiente por entregar \(40 pieza\)/);
    assert.equal(await db.entregaComercial.count(), 1);
    assert.equal(objetosDeEntregas().length, archivosAntes, "sin archivos huérfanos del intento rechazado");

    const e2 = await entregar(o, "40", "1.125");
    assert.equal(e2.numero, 2);
    s = await pendientes(o);
    assert.deepEqual([s.pend, s.estado, s.completas], [["0.000", "0.000"], "COMPLETA", 2]);
    await assert.rejects(entregar(o, "0.001", null), /supera lo pendiente/);

    await anularEntregaComercial(admin, e1.entregaId, "Capturada con cantidades equivocadas");
    s = await pendientes(o);
    assert.deepEqual([s.pend, s.estado, s.completas], [["60.000", "1.250"], "PARCIAL", 0]);
    const anulada = s.r.entregas.find((e) => e.numero === 1)!;
    assert.equal(anulada.estatus, "ANULADA");
    assert.equal(anulada.anulada?.motivo, "Capturada con cantidades equivocadas");
    assert.deepEqual(anulada.partidas.map((p) => p.cantidad), ["60.000", "1.250"], "el registro se conserva");
    assert.equal(anulada.evidencias.length, 2, "las evidencias se conservan");
    const ev = await obtenerEvidenciaEntrega(admin, anulada.evidencias[0].id);
    assert.equal(ev.tipo, "image/jpeg");

    // Anular de nuevo es idempotente (una sola entrada de bitácora).
    assert.deepEqual(await anularEntregaComercial(admin, e1.entregaId, "Otra vez"), { existente: true });
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "EntregaComercial", entidadId: e1.entregaId, accion: "CAMBIAR_ESTATUS" } }), 1);
    // Una nueva entrega correcta vuelve a completar.
    await entregar(o, "60", "1.250");
    assert.equal((await pendientes(o)).estado, "COMPLETA");
  });

  test("Unidades distintas: todos los postes y nada de tubo es Parcial (1 de 2 partidas), sin porcentajes mezclados", async () => {
    const o = await ordenPostesYTubo();
    await entregar(o, "100", null);
    const s = await pendientes(o);
    assert.deepEqual([s.estado, s.completas, s.r.totalPartidas], ["PARCIAL", 1, 2]);
    assert.deepEqual(s.r.partidas.map((p) => [p.codigo, p.completa]), [["POSTE", true], ["TUBO", false]]);
  });

  test("Cantidades fraccionarias exactas", async () => {
    const o = await ordenPostesYTubo();
    await entregar(o, null, "0.001");
    await entregar(o, null, "2.373");
    assert.deepEqual((await pendientes(o)).pend, ["100.000", "0.001"]);
    await assert.rejects(entregar(o, null, "0.0005"), /máximo 3 decimales/);
    await assert.rejects(entregar(o, null, "-1"), /positivas/);
    await assert.rejects(entregar(o, "0", ""), /al menos una cantidad/);
    await entregar(o, null, "0.001");
    assert.deepEqual((await pendientes(o)).r.partidas.map((p) => [p.entregado, p.pendiente]), [["0.000", "100.000"], ["2.375", "0.000"]]);
  });
});

describe("Validaciones de captura", () => {
  test("Fecha no futura (se admiten pasadas), partida una sola vez, partidas solo de la OV", async () => {
    const o = await ordenPostesYTubo();
    const otra = await ordenPostesYTubo();
    await assert.rejects(registrarEntregaComercial(admin, o.ordenId, datos(o, "1", null, { fechaEntrega: dias(1) }), [foto()], clave()), /futura/);
    await registrarEntregaComercial(admin, o.ordenId, datos(o, "1", null, { fechaEntrega: dias(-5) }), [foto()], clave());
    await assert.rejects(
      registrarEntregaComercial(admin, o.ordenId, { fechaEntrega: HOY, partidas: [{ partidaVentaId: o.poste, cantidad: "1" }, { partidaVentaId: o.poste, cantidad: "2" }] }, [foto()], clave()),
      /una sola vez/
    );
    await assert.rejects(
      registrarEntregaComercial(admin, o.ordenId, { fechaEntrega: HOY, partidas: [{ partidaVentaId: otra.poste, cantidad: "1" }] }, [foto()], clave()),
      /no pertenece a esta orden/
    );
    assert.equal(await db.entregaComercial.count(), 1);
  });

  test("Evidencias: obligatorias, tipo real por contenido, límites de cantidad y tamaño; una inválida rechaza todo", async () => {
    const o = await ordenPostesYTubo();
    await assert.rejects(entregar(o, "1", null, admin, []), /al menos una evidencia/);
    const falso: ArchivoEvidenciaEntrega = { nombre: "foto.jpg", bytes: new TextEncoder().encode("no soy una imagen") };
    await assert.rejects(entregar(o, "1", null, admin, [foto(), falso]), /«foto.jpg» no es una fotografía/);
    await assert.rejects(entregar(o, "1", null, admin, Array.from({ length: 11 }, (_, i) => foto(`${i}`))), /máximo 10 archivos por carga/);
    const grande: ArchivoEvidenciaEntrega = { nombre: "grande.pdf", bytes: new Uint8Array(Buffer.concat([pdfFicticio("g"), Buffer.alloc(4 * 1024 * 1024)])) };
    await assert.rejects(entregar(o, "1", null, admin, [grande]), /máximo por carga es 4 MB/);
    // Suma de varios archivos que individualmente caben.
    const medio = (s: string): ArchivoEvidenciaEntrega => ({ nombre: `medio-${s}.pdf`, bytes: new Uint8Array(Buffer.concat([pdfFicticio(s), Buffer.alloc(2 * 1024 * 1024)])) });
    await assert.rejects(entregar(o, "1", null, admin, [medio("a"), medio("b")]), /suman .* MB; el máximo por carga es 4 MB/);
    assert.equal(await db.entregaComercial.count(), 0);
    assert.equal(objetosDeEntregas().length, 0, "nada subido de registros rechazados");

    const ok = await entregar(o, "1", null, admin, [foto("x"), { nombre: "p.png", bytes: new Uint8Array(pngFicticio("p")) }, remision("y")]);
    const evs = await db.evidenciaEntregaComercial.findMany({ where: { entregaId: ok.entregaId }, orderBy: { orden: "asc" } });
    assert.deepEqual(evs.map((e) => [e.clase, e.tipo]), [["FOTOGRAFIA", "image/jpeg"], ["FOTOGRAFIA", "image/png"], ["REMISION", "application/pdf"]]);
    assert.ok(evs.every((e) => e.ref.startsWith(`comercializacion/${EMPRESA}/entregas/${o.ordenId}/`)), "ruta propia, separada de compras y comprobantes");
    assert.equal(objetosDeEntregas().length, 3);
  });

  test("Si la transacción falla, se eliminan los archivos subidos y no queda nada aplicado", async () => {
    const o = await ordenPostesYTubo();
    // El excedente se detecta dentro de la transacción (después de subir): no deben quedar archivos.
    await entregar(o, "100", null);
    const antes = objetosDeEntregas().length;
    await assert.rejects(entregar(o, "1", "1", admin, [foto("f1"), remision("f2")]), /supera lo pendiente/);
    assert.equal(objetosDeEntregas().length, antes);
    assert.equal(await db.partidaEntregaComercial.count(), 1);
  });
});

describe("Concurrencia e idempotencia", () => {
  test("Registros simultáneos no superan juntos lo vendido (varias rondas)", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const o = await ordenPostesYTubo();
      const r = await Promise.allSettled([entregar(o, "60", null), entregar(o, "60", null, director), entregar(o, "60", null, vendedor)]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, `ronda ${ronda}: solo una procede`);
      for (const x of r) if (x.status === "rejected") assert.match(String(x.reason?.message), /supera lo pendiente/);
      assert.deepEqual((await pendientes(o)).pend, ["40.000", "2.375"]);
    }
  });

  test("Reintentos y doble clic con la misma clave no duplican la entrega ni sus archivos", async () => {
    const o = await ordenPostesYTubo();
    const k = clave();
    const a = await entregar(o, "10", null, admin, [foto()], k);
    const b = await entregar(o, "10", null, admin, [foto()], k);
    assert.equal(b.entregaId, a.entregaId);
    assert.equal(b.existente, true);
    const k2 = clave();
    const sim = await Promise.all([1, 2, 3].map(() => entregar(o, "5", null, admin, [foto()], k2)));
    assert.equal(new Set(sim.map((x) => x.entregaId)).size, 1);
    assert.equal(await db.entregaComercial.count(), 2);
    assert.deepEqual((await pendientes(o)).pend, ["85.000", "2.375"]);
    assert.equal(objetosDeEntregas().length, 2, "los archivos de los perdedores se eliminan");
    await assert.rejects(registrarEntregaComercial(admin, (await ordenPostesYTubo()).ordenId, datos(o, "1", null), [foto()], k), /Clave de registro inválida/);
  });
});

describe("La base garantiza las reglas", () => {
  test("Sin editar, borrar ni agregar partidas/evidencias después; sin entregas sin evidencia; sin exceder lo vendido", async () => {
    const o = await ordenPostesYTubo();
    const e = await entregar(o, "10", null);
    await assert.rejects(db.entregaComercial.update({ where: { id: e.entregaId }, data: { fechaEntrega: new Date("2026-01-01") } }), /no se modifica/);
    await assert.rejects(db.entregaComercial.delete({ where: { id: e.entregaId } }), /no se borra/);
    await assert.rejects(db.partidaEntregaComercial.deleteMany({ where: { entregaId: e.entregaId } }), /no se modifican ni se borran/);
    await assert.rejects(db.partidaEntregaComercial.updateMany({ where: { entregaId: e.entregaId }, data: { cantidad: "1" } }), /no se modifican ni se borran/);
    await assert.rejects(db.evidenciaEntregaComercial.deleteMany({ where: { entregaId: e.entregaId } }), /no se modifican ni se borran/);
    await assert.rejects(
      db.partidaEntregaComercial.create({ data: { empresaId: EMPRESA, entregaId: e.entregaId, partidaVentaId: o.tubo, cantidad: "1" } }),
      /solo se capturan al registrar/
    );
    await assert.rejects(
      db.evidenciaEntregaComercial.create({ data: { empresaId: EMPRESA, entregaId: e.entregaId, orden: 9, clase: "FOTOGRAFIA", ref: "x", nombre: "x.jpg", tipo: "image/jpeg", bytes: 1 } }),
      /mediante una carga/
    );
    const nueva = (cantidad: string, evidencia: boolean) =>
      db.$transaction(async (tx) => {
        const en = await tx.entregaComercial.create({
          data: { empresaId: EMPRESA, ordenVentaId: o.ordenId, numero: 50 + n++, fechaEntrega: new Date(`${HOY}T00:00:00Z`), claveRegistro: clave(), registradaPorId: admin.id },
        });
        await tx.partidaEntregaComercial.create({ data: { empresaId: EMPRESA, entregaId: en.id, partidaVentaId: o.poste, cantidad } });
        if (evidencia) {
          await tx.evidenciaEntregaComercial.create({ data: { empresaId: EMPRESA, entregaId: en.id, orden: 0, clase: "REMISION", ref: "r", nombre: "r.pdf", tipo: "application/pdf", bytes: 1 } });
        }
      });
    await assert.rejects(nueva("1", false), /al menos una evidencia/);
    await assert.rejects(nueva("91", true), /supera la cantidad vendida/);
    await assert.rejects(
      db.$transaction(async (tx) => {
        const en = await tx.entregaComercial.create({
          data: { empresaId: EMPRESA, ordenVentaId: o.ordenId, numero: 99, fechaEntrega: new Date(`${HOY}T00:00:00Z`), claveRegistro: clave(), registradaPorId: admin.id },
        });
        await tx.partidaEntregaComercial.create({ data: { empresaId: EMPRESA, entregaId: en.id, partidaVentaId: (await ordenPostesYTubo()).poste, cantidad: "1" } });
      }),
      /no pertenece a la orden de venta/
    );
    await assert.rejects(
      db.evidenciaEntregaComercial.updateMany({ where: { entregaId: e.entregaId }, data: { clase: "REMISION" } }),
      /no se modifican ni se borran/
    );
    assert.equal(await db.entregaComercial.count({ where: { ordenVentaId: o.ordenId } }), 1);
  });
});

describe("Permisos y aislamiento", () => {
  test("Vendedor: registra y consulta sus OV (con evidencias), no anula; OV ajena y otra Empresa = no encontrada", async () => {
    const o = await ordenPostesYTubo(vendedor.id);
    const ajena = await ordenPostesYTubo(otroVendedor.id);
    const e = await entregar(o, "5", null, vendedor);
    const r = await resumenEntregasOrden(vendedor, o.ordenId);
    assert.equal(r.puedeAnular, false);
    assert.equal(r.entregas[0].registradaPorNombre, "Supervisor Prueba");
    assert.equal((await obtenerEvidenciaEntrega(vendedor, r.entregas[0].evidencias[0].id)).tipo, "image/jpeg");
    // El resumen del vendedor no trae costos, compras, proveedores ni cobranza.
    assert.doesNotMatch(JSON.stringify(r), /costo|proveedor|compra|cobr|saldo|cuota/i);

    await assert.rejects(anularEntregaComercial(vendedor, e.entregaId, "Intento del vendedor"), SinPermisoComercialError);
    await assert.rejects(resumenEntregasOrden(vendedor, ajena.ordenId), RegistroNoEncontradoError);
    await assert.rejects(entregar(ajena, "1", null, vendedor), RegistroNoEncontradoError);
    const eAjena = await entregar(ajena, "1", null, otroVendedor);
    const evAjena = (await resumenEntregasOrden(admin, ajena.ordenId)).entregas[0].evidencias[0].id;
    await assert.rejects(obtenerEvidenciaEntrega(vendedor, evAjena), RegistroNoEncontradoError);
    assert.deepEqual([...(await estadoEntregaDeOrdenes(vendedor, [o.ordenId, ajena.ordenId])).keys()], [o.ordenId]);

    for (const fuera of [adminAjeno]) {
      await assert.rejects(resumenEntregasOrden(fuera, o.ordenId), RegistroNoEncontradoError);
      await assert.rejects(entregar(o, "1", null, fuera), RegistroNoEncontradoError);
      await assert.rejects(anularEntregaComercial(fuera, eAjena.entregaId, "Intento desde otra empresa"), RegistroNoEncontradoError);
      await assert.rejects(obtenerEvidenciaEntrega(fuera, evAjena), RegistroNoEncontradoError);
      assert.equal((await estadoEntregaDeOrdenes(fuera, [o.ordenId])).size, 0);
    }
    // Permisos vigentes en cada petición: sin la marca de vendedor ya no accede.
    const sinMarca = sesion(vendedor.id, "SUPERVISOR", EMPRESA, false);
    await assert.rejects(resumenEntregasOrden(sinMarca, o.ordenId), SinPermisoComercialError);
    await assert.rejects(entregar(o, "1", null, sinMarca), SinPermisoComercialError);
    // Director administra entregas de la Empresa.
    await anularEntregaComercial(director, e.entregaId, "Corrección del director");
    assert.deepEqual((await pendientes(o)).pend, ["100.000", "2.375"]);
  });
});

describe("Sin efectos fuera de las entregas", () => {
  test("OV entregada por completo: saldo por cobrar intacto, compras y construcción sin cambios", async () => {
    const o = await ordenPostesYTubo();
    const cuenta = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await definirCondicionesCuenta(admin, cuenta.id, 1, { modalidad: "CREDITO", cuotas: [{ fechaVencimiento: dias(30), importe: "10118.75" }] });
    await registrarMovimientoCuenta(admin, cuenta.id, { importe: "1000", fecha: HOY, metodo: "TRANSFERENCIA" }, null, clave());
    const prov = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio B6A" })).id;
    const { id: compraId } = await crearCompraComercial(admin, o.ordenId, clave());
    await guardarBorradorCompra(admin, compraId, 1, {
      proveedorId: prov,
      fecha: HOY,
      partidas: [{ partidaVentaId: o.poste, cantidad: "30", costoUnitario: "80", tratamientoImpuesto: "EXENTO" }],
    });
    await confirmarCompraComercial(admin, compraId, 2);
    const fotoAntes = async () => ({
      ov: (await db.ordenVenta.findUniqueOrThrow({ where: { id: o.ordenId } })).total.toFixed(2),
      partidas: (await db.partidaCotizacionVenta.findMany({ where: { id: { in: [o.poste, o.tubo] } }, orderBy: { orden: "asc" } })).map((p) => [p.cantidad.toFixed(3), p.precioUnitario.toFixed(2)]),
      compra: await db.compraComercial.findUniqueOrThrow({ where: { id: compraId }, select: { estatus: true, total: true, version: true, updatedAt: true } }),
      cuenta: await db.cuentaComercial.findUniqueOrThrow({ where: { id: cuenta.id }, select: { version: true, total: true } }),
      movimientos: await db.movimientoComercial.count(),
    });
    const antes = await fotoAntes();
    await entregar(o, "100", "2.375");
    assert.equal((await pendientes(o)).estado, "COMPLETA");
    assert.deepEqual(await fotoAntes(), antes);
    const d = await detalleCuentaDeOrden(admin, o.ordenId);
    assert.deepEqual([d.estado.total, d.estado.aplicado, d.estado.saldo, d.estado.liquidacion], ["10118.75", "1000.00", "9118.75", "PARCIAL"]);
    const conteos = await Promise.all([
      db.ordenCompra.count(),
      db.movimientoSemanal.count(),
      db.gastoObra.count(),
      db.egreso.count(),
      db.ingreso.count(),
      db.movimientoFinancieroCliente.count(),
    ]);
    assert.deepEqual(conteos, [0, 0, 0, 0, 0, 0]);
  });
});

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { adjuntarDocumentoCompra, confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra } from "@/lib/server/comercializacion/compras";
import { definirCondicionesCuenta, detalleCuentaDeOrden, registrarMovimientoCuenta } from "@/lib/server/comercializacion/cuentas";
import {
  agregarEvidenciasEntrega,
  anularEntregaComercial,
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
import { jpgFicticio, pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Cierre de B6 contra PostgreSQL REAL: evidencias agregadas a una entrega
// vigente (permisos, idempotencia, anulación simultánea, archivos y reglas de
// la base) y límite por carga de 4 MB en todas las cargas del módulo.
// Datos ficticios.

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;
const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-cierre", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const otroVendedor = sesion("usuario-vendedor2-cierre", "SUPERVISOR", EMPRESA, true);
const HOY = hoyNegocio();

let POSTE: string;
let CLIENTE: string;
let OBRA: string;
let n = 0;
const clave = () => `clave-cierre-${++n}-${Date.now()}`;
const foto = (s = "a"): ArchivoEvidenciaEntrega => ({ nombre: `foto-${s}.jpg`, bytes: new Uint8Array(jpgFicticio(s)) });
const remision = (s = "r"): ArchivoEvidenciaEntrega => ({ nombre: `remision-${s}.pdf`, bytes: new Uint8Array(pdfFicticio(`Remisión ${s}`)) });
const pdfDe = (mb: number, s = "g") => new Uint8Array(Buffer.concat([pdfFicticio(s), Buffer.alloc(Math.round(mb * 1024 * 1024))]));
const objetosDeEntregas = () => [...almacenamiento.keys()].filter((k) => k.includes("/entregas/")).sort();
const refsEnBase = async () => (await db.evidenciaEntregaComercial.findMany({ select: { ref: true } })).map((e) => e.ref).sort();

/** OV de 100 postes asignada al vendedor, con una entrega de 60 (foto + remisión). */
async function ordenConEntrega(vendedorId = vendedor.id) {
  const { id } = await crearCotizacionVenta(
    admin,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia cierre B6", vendedorId, fecha: HOY, vigenciaHasta: HOY, partidas: [{ productoId: POSTE, cantidad: "100" }] },
    clave()
  );
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pv = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
  const e = await registrarEntregaComercial(admin, ov.ordenId, { fechaEntrega: HOY, partidas: [{ partidaVentaId: pv.id, cantidad: "60" }] }, [foto(), remision()], clave());
  return { cotizacionId: id, ordenId: ov.ordenId, partidaVentaId: pv.id, entregaId: e.entregaId };
}

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  almacenamiento.clear();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.createMany({
    data: [
      { id: director.id, nombre: "Director cierre", email: "director-cierre@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA },
      { id: otroVendedor.id, nombre: "Vendedor 2 cierre", email: "vendedor2-cierre@prueba.invalid", passwordHash: "x", rol: "SUPERVISOR", empresaId: EMPRESA, vendedorComercial: true },
    ],
  });
  POSTE = (await crearProductoComercial(admin, { codigo: "POSTE", descripcion: "Poste ficticio", unidad: "pieza", precioVenta: "100", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio cierre" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra cierre" })).id;
});

describe("Agregar evidencia a una entrega existente", () => {
  test("solo agrega: cantidades, fecha, estado, saldos e historia intactos; autor y fecha de la carga; ambas descargables", async () => {
    const o = await ordenConEntrega();
    await definirCondicionesCuenta(admin, (await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } })).id, 1, {
      modalidad: "CONTADO",
      cuotas: [{ fechaVencimiento: HOY, importe: "10000" }],
    });
    const antes = await resumenEntregasOrden(admin, o.ordenId);
    const saldoAntes = (await detalleCuentaDeOrden(admin, o.ordenId)).estado;
    const entregaAntes = await db.entregaComercial.findUniqueOrThrow({ where: { id: o.entregaId } });

    const r = await agregarEvidenciasEntrega(vendedor, o.entregaId, [foto("nueva")], clave());
    assert.deepEqual([r.agregadas, r.existente], [1, false]);

    const despues = await resumenEntregasOrden(admin, o.ordenId);
    assert.deepEqual(despues.partidas, antes.partidas);
    assert.equal(despues.estado, antes.estado);
    assert.deepEqual((await detalleCuentaDeOrden(admin, o.ordenId)).estado, saldoAntes);
    const entregaDespues = await db.entregaComercial.findUniqueOrThrow({ where: { id: o.entregaId } });
    assert.deepEqual(entregaDespues, entregaAntes, "la fila de la entrega no cambia");
    const ev = despues.entregas[0].evidencias;
    assert.equal(ev.length, 3);
    // Las originales siguen igual; la nueva lleva autor y fecha de su carga.
    assert.deepEqual(
      ev.map((x) => [x.clase, x.agregada === null]),
      [
        ["FOTOGRAFIA", true],
        ["REMISION", true],
        ["FOTOGRAFIA", false],
      ]
    );
    assert.ok(ev[2].agregada && ev[2].agregada.porNombre.length > 0 && !Number.isNaN(Date.parse(ev[2].agregada.en)));
    assert.equal(despues.entregas[0].evidenciasDisponibles, 17);
    const carga = await db.cargaEvidenciaEntrega.findFirstOrThrow({ where: { entregaId: o.entregaId } });
    assert.equal(carga.registradaPorId, vendedor.id);
    // Evidencia anterior y nueva, descargables por quien tiene alcance.
    for (const x of ev) assert.ok((await obtenerEvidenciaEntrega(vendedor, x.id)).bytes.length > 0);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "EntregaComercial", entidadId: o.entregaId, accion: "EDITAR" } }), 1);
    assert.deepEqual(objetosDeEntregas(), await refsEnBase(), "sin archivos huérfanos");
  });

  test("permisos: administración y director de la Empresa, el vendedor solo de sus OV actualmente asignadas", async () => {
    const o = await ordenConEntrega();
    assert.equal((await agregarEvidenciasEntrega(director, o.entregaId, [foto("d")], clave())).agregadas, 1);
    await assert.rejects(agregarEvidenciasEntrega(otroVendedor, o.entregaId, [foto("x")], clave()), RegistroNoEncontradoError);
    await assert.rejects(agregarEvidenciasEntrega(adminAjeno, o.entregaId, [foto("x")], clave()), RegistroNoEncontradoError);
    await assert.rejects(
      agregarEvidenciasEntrega({ ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA, modulos: [] }), id: admin.id }, o.entregaId, [foto("x")], clave()),
      SinPermisoComercialError
    );
    // La asignación de una OV no cambia una vez emitida (la base lo impide);
    // retirar la función Vendedor sí quita el acceso en la siguiente petición.
    await assert.rejects(agregarEvidenciasEntrega(sesion(supervisor.id, "SUPERVISOR", EMPRESA, false), o.entregaId, [foto("x")], clave()), SinPermisoComercialError);
    assert.equal((await agregarEvidenciasEntrega(vendedor, o.entregaId, [foto("y")], clave())).agregadas, 1);
    // La evidencia tampoco se descarga fuera del alcance.
    const ev = await db.evidenciaEntregaComercial.findFirstOrThrow({ where: { entregaId: o.entregaId } });
    await assert.rejects(obtenerEvidenciaEntrega(otroVendedor, ev.id), RegistroNoEncontradoError);
    await assert.rejects(obtenerEvidenciaEntrega(adminAjeno, ev.id), RegistroNoEncontradoError);
    assert.deepEqual(objetosDeEntregas(), await refsEnBase());
  });

  test("entrega anulada: no admite evidencias y no deja archivos", async () => {
    const o = await ordenConEntrega();
    await anularEntregaComercial(admin, o.entregaId, "Captura errónea de prueba");
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, [foto("x")], clave()), /anulada/);
    assert.equal(await db.cargaEvidenciaEntrega.count(), 0);
    assert.deepEqual(objetosDeEntregas(), await refsEnBase());
    assert.equal((await resumenEntregasOrden(admin, o.ordenId)).entregas[0].evidenciasDisponibles, 0);
  });

  test("reintentos y solicitudes simultáneas con la misma clave: una sola carga", async () => {
    const o = await ordenConEntrega();
    const k = clave();
    const r1 = await agregarEvidenciasEntrega(admin, o.entregaId, [foto("1"), remision("1")], k);
    const r2 = await agregarEvidenciasEntrega(admin, o.entregaId, [foto("1"), remision("1")], k);
    assert.deepEqual([r2.cargaId, r2.existente, r2.agregadas], [r1.cargaId, true, 2]);
    const k2 = clave();
    const simultaneas = await Promise.all([1, 2, 3].map(() => agregarEvidenciasEntrega(admin, o.entregaId, [foto("s")], k2)));
    assert.equal(new Set(simultaneas.map((r) => r.cargaId)).size, 1);
    assert.equal(await db.cargaEvidenciaEntrega.count(), 2);
    assert.equal(await db.evidenciaEntregaComercial.count({ where: { entregaId: o.entregaId } }), 5);
    assert.deepEqual(objetosDeEntregas(), await refsEnBase(), "los perdedores eliminan sus archivos; nunca los del ganador");
    // La clave de una carga no sirve para otra entrega.
    const o2 = await ordenConEntrega();
    await assert.rejects(agregarEvidenciasEntrega(admin, o2.entregaId, [foto("z")], k), /Clave de carga inválida/);
  });

  test("anulación simultánea con la incorporación: nunca queda una carga sobre una entrega ya anulada ni archivos huérfanos", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const o = await ordenConEntrega();
      const [carga, anulacion] = await Promise.allSettled([
        agregarEvidenciasEntrega(admin, o.entregaId, [foto(`c${ronda}`)], clave()),
        anularEntregaComercial(admin, o.entregaId, "Anulación simultánea de prueba"),
      ]);
      assert.equal(anulacion.status, "fulfilled");
      const cargas = await db.cargaEvidenciaEntrega.count({ where: { entregaId: o.entregaId } });
      if (carga.status === "fulfilled") assert.equal(cargas, 1, "la carga confirmó antes de la anulación y se conserva");
      else {
        assert.match(String((carga.reason as Error).message), /anulada/);
        assert.equal(cargas, 0);
      }
      assert.equal((await db.entregaComercial.findUniqueOrThrow({ where: { id: o.entregaId } })).estatus, "ANULADA");
      assert.deepEqual(objetosDeEntregas(), await refsEnBase());
    }
  });

  test("archivos: inválido, exceso por carga y máximo acumulado de 20 por entrega, sin aplicar nada", async () => {
    const o = await ordenConEntrega();
    const falso = { nombre: "falso.pdf", bytes: new TextEncoder().encode("no soy un pdf") };
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, [foto("ok"), falso], clave()), /no es una fotografía JPG\/PNG ni un PDF válido. No se agregó ninguna evidencia/);
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, [{ nombre: "g.pdf", bytes: pdfDe(4) }], clave()), /máximo por carga es 4 MB/);
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, Array.from({ length: 11 }, (_, i) => foto(`m${i}`)), clave()), /máximo 10 archivos por carga/);
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, [], clave()), /Adjunta al menos una evidencia/);
    assert.equal(await db.cargaEvidenciaEntrega.count(), 0);
    // 2 originales + 10 + 8 = 20; la siguiente se rechaza.
    await agregarEvidenciasEntrega(admin, o.entregaId, Array.from({ length: 10 }, (_, i) => foto(`a${i}`)), clave());
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, Array.from({ length: 9 }, (_, i) => foto(`b${i}`)), clave()), /admite 8 evidencias más/);
    await agregarEvidenciasEntrega(admin, o.entregaId, Array.from({ length: 8 }, (_, i) => foto(`b${i}`)), clave());
    await assert.rejects(agregarEvidenciasEntrega(admin, o.entregaId, [foto("x")], clave()), /máximo de 20 evidencias/);
    assert.equal(await db.evidenciaEntregaComercial.count({ where: { entregaId: o.entregaId } }), 20);
    assert.deepEqual(objetosDeEntregas(), await refsEnBase());
  });

  test("la base vuelve a exigir las reglas", async () => {
    const o = await ordenConEntrega();
    const dato = { empresaId: EMPRESA, entregaId: o.entregaId, orden: 50, clase: "FOTOGRAFIA" as const, ref: "x/y.jpg", nombre: "y.jpg", tipo: "image/jpeg", bytes: 1 };
    // Sin carga, fuera de la transacción de registro.
    await assert.rejects(db.evidenciaEntregaComercial.create({ data: dato }), /mediante una carga/);
    // Carga sin evidencias.
    await assert.rejects(db.cargaEvidenciaEntrega.create({ data: { empresaId: EMPRESA, entregaId: o.entregaId, clave: "clave-directa-1", registradaPorId: admin.id } }), /al menos una evidencia/);
    // Evidencia en una carga de otra transacción.
    const r = await agregarEvidenciasEntrega(admin, o.entregaId, [foto("k")], clave());
    await assert.rejects(db.evidenciaEntregaComercial.create({ data: { ...dato, cargaId: r.cargaId } }), /al crear su carga/);
    // Inmutables.
    await assert.rejects(db.cargaEvidenciaEntrega.update({ where: { id: r.cargaId }, data: { clave: "otra-clave-x" } }), /no se modifica/);
    await assert.rejects(db.cargaEvidenciaEntrega.delete({ where: { id: r.cargaId } }));
    await assert.rejects(db.evidenciaEntregaComercial.deleteMany({ where: { cargaId: r.cargaId } }), /no se modifican ni se borran/);
    // Entrega anulada.
    await anularEntregaComercial(admin, o.entregaId, "Prueba de base");
    await assert.rejects(
      db.$transaction(async (tx) => {
        const c = await tx.cargaEvidenciaEntrega.create({ data: { empresaId: EMPRESA, entregaId: o.entregaId, clave: "clave-directa-2", registradaPorId: admin.id } });
        await tx.evidenciaEntregaComercial.create({ data: { ...dato, cargaId: c.id } });
      }),
      /entrega anulada/
    );
  });
});

describe("Límite por carga (4 MB) en todas las cargas del módulo", () => {
  test("aceptación, documento de compra, comprobante y entregas: rechazo comprensible y nada guardado", async () => {
    const o = await ordenConEntrega();
    // Aceptación.
    const { id } = await crearCotizacionVenta(admin, { clienteId: CLIENTE, obraId: OBRA, descripcion: "x", fecha: HOY, vigenciaHasta: HOY, partidas: [{ productoId: POSTE, cantidad: "1" }] }, clave());
    await emitirCotizacionVenta(admin, id, 1);
    await assert.rejects(registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: pdfDe(4.1) }), /pesa 4\.\d MB; el máximo es 4 MB/);
    assert.equal((await db.cotizacionVenta.findUniqueOrThrow({ where: { id } })).estatus, "EMITIDA");
    // Justo bajo el límite: sí.
    await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: pdfDe(3.9) });
    // Documento de compra.
    const prov = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio cierre" })).id;
    const compra = (await crearCompraComercial(admin, o.ordenId, clave())).id;
    await guardarBorradorCompra(admin, compra, 1, { proveedorId: prov, fecha: HOY, partidas: [{ partidaVentaId: o.partidaVentaId, cantidad: "1", costoUnitario: "10", tratamientoImpuesto: "EXENTO" }] });
    await assert.rejects(adjuntarDocumentoCompra(admin, compra, { nombre: "f.pdf", bytes: pdfDe(4.1) }), /el máximo es 4 MB/);
    assert.equal((await db.compraComercial.findUniqueOrThrow({ where: { id: compra } })).documentoRef, null);
    await confirmarCompraComercial(admin, compra, 2);
    // Comprobante.
    const cuenta = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await definirCondicionesCuenta(admin, cuenta.id, 1, { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: HOY, importe: "10000" }] });
    await assert.rejects(
      registrarMovimientoCuenta(admin, cuenta.id, { importe: "100", fecha: HOY, metodo: "TRANSFERENCIA" }, { nombre: "c.pdf", bytes: pdfDe(4.1) }, clave()),
      /el máximo es 4 MB. No se registró el movimiento/
    );
    assert.equal(await db.movimientoComercial.count(), 0);
    // Registro de entrega: suma de archivos.
    await assert.rejects(
      registrarEntregaComercial(admin, o.ordenId, { fechaEntrega: HOY, partidas: [{ partidaVentaId: o.partidaVentaId, cantidad: "1" }] }, [{ nombre: "a.pdf", bytes: pdfDe(2.1, "a") }, { nombre: "b.pdf", bytes: pdfDe(2.1, "b") }], clave()),
      /suman .* MB; el máximo por carga es 4 MB/
    );
    assert.equal(await db.entregaComercial.count({ where: { ordenVentaId: o.ordenId } }), 1);
    assert.deepEqual(objetosDeEntregas(), await refsEnBase());
  });
});

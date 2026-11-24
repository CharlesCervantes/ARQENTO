import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { crearProductoComercial } from "@/lib/server/comercializacion/productos";
import { crearClienteComercial, crearObraComercial } from "@/lib/server/comercializacion/clientes";
import { crearCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { emitirCotizacionVenta } from "@/lib/server/comercializacion/emision";
import { registrarAceptacionCotizacion } from "@/lib/server/comercializacion/ordenes";
import { anularCompraComercial, confirmarCompraComercial, crearCompraComercial, crearProveedorComercial, guardarBorradorCompra } from "@/lib/server/comercializacion/compras";
import {
  anularMovimientoCuenta,
  cambiarVencimientoCuota,
  definirCondicionesCuenta,
  detalleCuentaDeCompra,
  detalleCuentaDeOrden,
  registrarMovimientoCuenta,
} from "@/lib/server/comercializacion/cuentas";
import { registrarGastoComercial, resultadoOrden } from "@/lib/server/comercializacion/gastos";
import { recordatoriosComerciales } from "@/lib/server/comercializacion/recordatorios";
import { ConflictoEdicionError } from "@/lib/server/comercializacion/cotizaciones";
import { SinPermisoComercialError } from "@/lib/server/comercializacion/acceso";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";
import { pdfFicticio } from "../helpers/archivos-ficticios";
import { EMPRESA, EMPRESA_AJENA, admin as adminBase, adminAjeno as adminAjenoBase, baseLimpiaConDatos, supervisor } from "./apoyo/base";

// Comercialización B8B (vencimientos) contra PostgreSQL REAL: cambio
// individual del vencimiento de una cuota con saldo, aunque la cuenta tenga
// movimientos, con historial y sin tocar importes ni aplicaciones. Incluye la
// integración de «Sin IVA» con B7. Datos ficticios.

const M = "comercializacion";
const sesion = (id: string, rol: UsuarioSesion["rol"], empresaId: string, vendedorComercial = false): UsuarioSesion => ({
  ...usuarioDePrueba({ rol, empresaId, vendedorComercial, modulos: [M] }),
  id,
});
const admin = sesion(adminBase.id, "ADMINISTRADOR", EMPRESA);
const adminAjeno = sesion(adminAjenoBase.id, "ADMINISTRADOR", EMPRESA_AJENA);
const director = sesion("usuario-director-b8b-v", "DIRECTOR", EMPRESA);
const vendedor = sesion(supervisor.id, "SUPERVISOR", EMPRESA, true);
const HOY = hoyNegocio();
const dias = (d: number) => {
  const f = new Date(`${HOY}T00:00:00Z`);
  f.setUTCDate(f.getUTCDate() + d);
  return f.toISOString().slice(0, 10);
};

let LOTE: string; // exento, $12,000
let CLIENTE: string;
let OBRA: string;
let PROV: string;
let n = 0;
const clave = () => `clave-b8b-v-${++n}-${Date.now()}`;

async function orden() {
  const { id } = await crearCotizacionVenta(
    admin,
    { clienteId: CLIENTE, obraId: OBRA, descripcion: "Venta ficticia B8B", vendedorId: vendedor.id, impuestoVenta: "SIN_IVA", fecha: dias(-30), vigenciaHasta: dias(10), partidas: [{ productoId: LOTE, cantidad: "1" }] },
    clave()
  );
  await emitirCotizacionVenta(admin, id, 1);
  const ov = await registrarAceptacionCotizacion(admin, id, { fechaAceptacion: HOY }, { nombre: "oc.pdf", bytes: new Uint8Array(pdfFicticio("oc")) });
  const pv = await db.partidaCotizacionVenta.findFirstOrThrow({ where: { cotizacionId: id } });
  return { ordenId: ov.ordenId, folio: ov.folio, partidaVentaId: pv.id };
}
type Orden = Awaited<ReturnType<typeof orden>>;
async function compra(o: Orden, linea: { costo: string; t: string; tasa?: string }) {
  const { id } = await crearCompraComercial(admin, o.ordenId, clave());
  await guardarBorradorCompra(admin, id, 1, {
    proveedorId: PROV,
    fecha: HOY,
    partidas: [{ partidaVentaId: o.partidaVentaId, cantidad: "1", costoUnitario: linea.costo, tratamientoImpuesto: linea.t, tasaIva: linea.tasa ?? "" }],
  });
  await confirmarCompraComercial(admin, id, 2);
  return id;
}
const version = async (cuentaId: string) => (await db.cuentaComercial.findUniqueOrThrow({ where: { id: cuentaId } })).version;
const credito = async (cuentaId: string, cuotas: [string, string][]) =>
  definirCondicionesCuenta(admin, cuentaId, await version(cuentaId), { modalidad: "CREDITO", cuotas: cuotas.map(([fechaVencimiento, importe]) => ({ fechaVencimiento, importe })) });
const pagar = (cuentaId: string, importe: string) => registrarMovimientoCuenta(admin, cuentaId, { importe, fecha: HOY, metodo: "TRANSFERENCIA" }, null, clave());
const cuotasDe = async (cuentaId: string) =>
  (await db.cuotaCuentaComercial.findMany({ where: { cuentaId, vigente: true }, orderBy: { numero: "asc" } })).map((q) => ({ id: q.id, numero: q.numero, fecha: q.fechaVencimiento.toISOString().slice(0, 10), importe: q.importe.toFixed(2) }));
const cambiar = (cuotaId: string, fechaLeida: string, nuevaFecha: string, u: UsuarioSesion = admin, k = clave(), motivo = "Prórroga acordada con el cliente") =>
  cambiarVencimientoCuota(u, cuotaId, { fechaLeida, nuevaFecha, motivo }, k);
const aplicaciones = async (cuentaId: string) =>
  (await db.aplicacionMovimientoComercial.findMany({ where: { movimiento: { cuentaId } }, orderBy: { id: "asc" } })).map((a) => [a.id, a.movimientoId, a.cuotaId, a.importe.toFixed(2)]);

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.update({ where: { id: supervisor.id }, data: { vendedorComercial: true } });
  await db.usuario.create({ data: { id: director.id, nombre: "Director B8B", email: "director-b8b-v@prueba.invalid", passwordHash: "x", rol: "DIRECTOR", empresaId: EMPRESA } });
  LOTE = (await crearProductoComercial(admin, { codigo: "LOTE", descripcion: "Lote ficticio", unidad: "lote", precioVenta: "12000", costoReferencia: "", tratamientoImpuesto: "EXENTO", tasaIva: "" })).id;
  CLIENTE = (await crearClienteComercial(admin, { nombre: "Cliente ficticio B8B" })).id;
  OBRA = (await crearObraComercial(admin, { clienteId: CLIENTE, nombre: "Obra B8B" })).id;
  PROV = (await crearProveedorComercial(admin, { nombre: "Proveedor ficticio B8B" })).id;
});

describe("Cambiar vencimiento", () => {
  test("caso $12,000: mover la cuota vencida a +5 días deja el vencido en $0 sin tocar saldo, aplicación ni la segunda cuota", async () => {
    const o = await orden();
    const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await credito(cxc.id, [
      [dias(-10), "4000"],
      [dias(30), "8000"],
    ]);
    await pagar(cxc.id, "1500"); // propuesta: se aplica a la primera cuota
    const antes = await detalleCuentaDeOrden(admin, o.ordenId);
    assert.deepEqual([antes.estado.saldo, antes.estado.vencido], ["10500.00", "2500.00"]);
    const apAntes = await aplicaciones(cxc.id);
    const [q1, q2] = await cuotasDe(cxc.id);
    const resultadoAntes = await resultadoOrden(admin, o.ordenId);
    const avisosAntes = (await recordatoriosComerciales(admin, { categoria: "VENCIDO" })).avisos.filter((a) => a.folio === o.folio);
    assert.equal(avisosAntes.length, 1);

    await cambiar(q1.id, dias(-10), dias(5));

    const d = await detalleCuentaDeOrden(admin, o.ordenId);
    assert.deepEqual([d.estado.saldo, d.estado.vencido, d.estado.aplicado], ["10500.00", "0.00", "1500.00"]);
    assert.deepEqual(
      d.estado.cuotas.map((q) => [q.numero, q.fechaVencimiento, q.importe, q.aplicado, q.saldo, q.situacion]),
      [
        [1, dias(5), "4000.00", "1500.00", "2500.00", "AL_CORRIENTE"],
        [2, dias(30), "8000.00", "0.00", "8000.00", "AL_CORRIENTE"],
      ]
    );
    assert.deepEqual(await aplicaciones(cxc.id), apAntes);
    assert.deepEqual((await cuotasDe(cxc.id))[1], q2);
    assert.equal(d.modalidad, "CREDITO");
    assert.equal(d.movimientos.length, 1);
    // Historial: fecha anterior (pactada), nueva, motivo y autor.
    const h = d.vencimientos[q1.id];
    assert.equal(h.fechaPactada, dias(-10));
    assert.deepEqual(
      h.cambios.map((x) => [x.fechaAnterior, x.fechaNueva, x.motivo, x.porNombre]),
      [[dias(-10), dias(5), "Prórroga acordada con el cliente", (await db.usuario.findUniqueOrThrow({ where: { id: adminBase.id } })).nombre]]
    );
    // Avisos (B6B) sin datos obsoletos; resultado (B7) intacto.
    assert.equal((await recordatoriosComerciales(admin, { categoria: "VENCIDO" })).avisos.filter((a) => a.folio === o.folio).length, 0);
    assert.deepEqual(await resultadoOrden(admin, o.ordenId), resultadoAntes);
    // Un cobro posterior usa los vencimientos vigentes (B5): sigue por la cuota 1.
    await pagar(cxc.id, "3000");
    const fin = await detalleCuentaDeOrden(admin, o.ordenId);
    assert.deepEqual(fin.estado.cuotas.map((q) => q.saldo), ["0.00", "7500.00"]);
  });

  test("mensualidades automáticas con pagos: cambiar una cuota no desplaza ni regenera las demás", async () => {
    const o = await orden();
    const id = await compra(o, { costo: "1000", t: "GRAVADO", tasa: "16" }); // $1,160.00
    const cxp = await db.cuentaComercial.findFirstOrThrow({ where: { compraId: id } });
    await definirCondicionesCuenta(admin, cxp.id, cxp.version, { modalidad: "CREDITO", mensualidades: { plazo: 3, primerVencimiento: "2027-01-31" } });
    const [c1, c2, c3] = await cuotasDe(cxp.id);
    assert.deepEqual([c1.fecha, c2.fecha, c3.fecha], ["2027-01-31", "2027-02-28", "2027-03-31"]);
    await pagar(cxp.id, "386.66"); // liquida la primera
    await pagar(cxp.id, "100.00"); // abono parcial a la segunda
    const apAntes = await aplicaciones(cxp.id);

    await assert.rejects(cambiar(c1.id, c1.fecha, "2027-02-15"), /liquidada/);
    await cambiar(c2.id, c2.fecha, "2027-03-15");
    await cambiar(c3.id, c3.fecha, "2027-04-30", director);
    await cambiar(c3.id, "2027-04-30", "2027-05-15");
    const ahora = await cuotasDe(cxp.id);
    assert.deepEqual(
      ahora.map((q) => [q.id, q.fecha, q.importe]),
      [
        [c1.id, "2027-01-31", "386.66"],
        [c2.id, "2027-03-15", "386.66"],
        [c3.id, "2027-05-15", "386.68"],
      ]
    );
    assert.deepEqual(await aplicaciones(cxp.id), apAntes);
    const d = await detalleCuentaDeCompra(admin, id);
    assert.deepEqual([d!.vencimientos[c3.id].fechaPactada, d!.vencimientos[c3.id].cambios.length, d!.estado.saldo, d!.modalidad], ["2027-03-31", 2, "673.34", "CREDITO"]);
    assert.equal(await db.cuotaCuentaComercial.count({ where: { cuentaId: cxp.id } }), 3); // no se regeneró nada
    // Sigue sin poder sustituirse el calendario completo.
    await assert.rejects(
      definirCondicionesCuenta(admin, cxp.id, await version(cxp.id), { modalidad: "CREDITO", mensualidades: { plazo: 6, primerVencimiento: "2027-01-31" } }),
      /tiene cobros o pagos registrados/
    );
    await assert.rejects(
      definirCondicionesCuenta(admin, cxp.id, await version(cxp.id), { modalidad: "CONTADO", cuotas: [{ fechaVencimiento: "2027-05-15", importe: "1160" }] }),
      /tiene cobros o pagos registrados/
    );
  });

  test("validaciones: fecha de hoy en adelante y distinta, motivo, cuotas liquidadas, cuentas anuladas y gastos", async () => {
    const o = await orden();
    const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await credito(cxc.id, [
      [dias(-3), "2000"],
      [dias(20), "10000"],
    ]);
    const [q1] = await cuotasDe(cxc.id);
    await assert.rejects(cambiar(q1.id, q1.fecha, dias(-1)), /de hoy en adelante/);
    await assert.rejects(cambiar(q1.id, q1.fecha, q1.fecha), /igual al vencimiento vigente/);
    await assert.rejects(cambiar(q1.id, q1.fecha, dias(4), admin, clave(), "x"), /motivo/);
    await assert.rejects(cambiar(q1.id, q1.fecha, "2027-02-30"), /nueva fecha/);
    await cambiar(q1.id, q1.fecha, HOY); // hoy sí se permite
    // Cuota liquidada: ya no cambia; con un cobro anulado vuelve a tener saldo.
    const { movimientoId } = await pagar(cxc.id, "2000");
    await assert.rejects(cambiar(q1.id, HOY, dias(2)), /liquidada/);
    await anularMovimientoCuenta(admin, movimientoId, "Cobro duplicado");
    await cambiar(q1.id, HOY, dias(2));
    // Compra anulada → cuenta anulada: no se cambia.
    const id = await compra(o, { costo: "500", t: "SIN_IVA" });
    const cxp = await db.cuentaComercial.findFirstOrThrow({ where: { compraId: id } });
    await credito(cxp.id, [[dias(10), "500"]]);
    const [p1] = await cuotasDe(cxp.id);
    await anularCompraComercial(admin, id, "Compra de prueba");
    await assert.rejects(cambiar(p1.id, p1.fecha, dias(15)), /cuenta está anulada/);
    // Gasto adicional: sí.
    const g = await registrarGastoComercial(admin, o.ordenId, { concepto: "Flete", beneficiarioId: PROV, fecha: HOY, subtotal: "100", tratamientoImpuesto: "EXENTO" }, null, clave());
    const cg = await db.cuentaComercial.findFirstOrThrow({ where: { gastoId: g.gastoId } });
    await credito(cg.id, [[dias(1), "100"]]);
    const [g1] = await cuotasDe(cg.id);
    await cambiar(g1.id, g1.fecha, dias(9));
    assert.equal((await cuotasDe(cg.id))[0].fecha, dias(9));
  });

  test("permisos, aislamiento, reintentos y cambios simultáneos", async () => {
    const o = await orden();
    const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await credito(cxc.id, [[dias(2), "12000"]]);
    const [q] = await cuotasDe(cxc.id);
    await assert.rejects(cambiar(q.id, q.fecha, dias(7), vendedor), SinPermisoComercialError);
    await assert.rejects(cambiar(q.id, q.fecha, dias(7), adminAjeno), RegistroNoEncontradoError);
    // Reintento con la misma clave: devuelve el registro, sin duplicar.
    const k = clave();
    const r1 = await cambiar(q.id, q.fecha, dias(7), admin, k);
    const r2 = await cambiar(q.id, q.fecha, dias(7), admin, k);
    assert.deepEqual([r1.reintento, r2.reintento, r2.cambioId], [false, true, r1.cambioId]);
    assert.equal(await db.cambioVencimientoCuota.count(), 1);
    // Fecha leída obsoleta (otro ya la cambió): se rechaza, no se sobrescribe.
    await assert.rejects(cambiar(q.id, q.fecha, dias(9)), ConflictoEdicionError);
    // Dos cambios simultáneos desde la misma fecha leída: solo uno procede.
    const r = await Promise.allSettled([cambiar(q.id, dias(7), dias(11)), cambiar(q.id, dias(7), dias(12), director)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.ok(r.some((x) => x.status === "rejected" && x.reason instanceof ConflictoEdicionError));
    assert.equal(await db.cambioVencimientoCuota.count(), 2);
  });

  test("cambio simultáneo con un pago que liquida la cuota: nunca cambia una cuota ya liquidada", async () => {
    for (let i = 0; i < 3; i++) {
      const o = await orden();
      const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
      await credito(cxc.id, [
        [dias(1), "2000"],
        [dias(40), "10000"],
      ]);
      const [q1] = await cuotasDe(cxc.id);
      const [cambio, pago] = await Promise.allSettled([cambiar(q1.id, q1.fecha, dias(6)), pagar(cxc.id, "2000")]);
      assert.equal(pago.status, "fulfilled");
      const fecha = (await cuotasDe(cxc.id))[0].fecha;
      const historial = await db.cambioVencimientoCuota.count({ where: { cuotaId: q1.id } });
      if (cambio.status === "fulfilled") assert.deepEqual([fecha, historial], [dias(6), 1]);
      else assert.deepEqual([fecha, historial, /liquidada/.test(String(cambio.reason))], [q1.fecha, 0, true]);
      assert.equal((await detalleCuentaDeOrden(admin, o.ordenId)).estado.saldo, "10000.00");
    }
  });

  test("la base exige historial para cambiar una fecha y no permite editarlo ni borrarlo", async () => {
    const o = await orden();
    const cxc = await db.cuentaComercial.findFirstOrThrow({ where: { ordenVentaId: o.ordenId } });
    await credito(cxc.id, [[dias(5), "12000"]]);
    const [q] = await cuotasDe(cxc.id);
    await pagar(cxc.id, "100");
    await assert.rejects(db.$executeRawUnsafe(`UPDATE cuotas_cuenta_comercial SET "fechaVencimiento" = $2::date WHERE id = $1`, q.id, dias(9)), /solo cambia con su registro en el historial/);
    await assert.rejects(db.$executeRawUnsafe(`UPDATE cuotas_cuenta_comercial SET importe = 1 WHERE id = $1`, q.id), /ya tiene cobros o pagos/);
    await cambiar(q.id, q.fecha, dias(9));
    await assert.rejects(db.$executeRawUnsafe(`UPDATE cambios_vencimiento_cuota SET motivo = 'otro motivo'`), /no se modifica ni se elimina/);
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM cambios_vencimiento_cuota`), /no se modifica ni se elimina/);
    // Un registro con fecha anterior equivocada se rechaza.
    await assert.rejects(
      db.cambioVencimientoCuota.create({
        data: { empresaId: EMPRESA, cuentaId: cxc.id, cuotaId: q.id, fechaAnterior: new Date(`${dias(5)}T00:00:00Z`), fechaNueva: new Date(`${dias(12)}T00:00:00Z`), motivo: "Manual", registradoPorId: adminBase.id, claveRegistro: "manual-12345" },
      }),
      /no coincide con el vencimiento vigente/
    );
  });
});

describe("«Sin IVA» y el resultado de B7", () => {
  test("una compra «Sin IVA» cuenta completa como costo de materiales y genera su cuenta por pagar por el mismo total", async () => {
    // Complementa comercializacion-b7 («tasas mixtas…», con una partida Sin IVA de $30.00).
    const o = await orden();
    const id = await compra(o, { costo: "8050.50", t: "SIN_IVA" });
    const c = await db.compraComercial.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([c.subtotal.toFixed(2), c.iva.toFixed(2), c.total.toFixed(2)], ["8050.50", "0.00", "8050.50"]);
    assert.equal((await db.cuentaComercial.findFirstOrThrow({ where: { compraId: id } })).total.toFixed(2), "8050.50");
    const r = await resultadoOrden(admin, o.ordenId);
    assert.deepEqual([r.venta, r.compras, r.resultado, r.estado], ["12000.00", "8050.50", "3949.50", "POSITIVO"]);
  });
});

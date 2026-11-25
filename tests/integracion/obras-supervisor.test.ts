import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { guardarAccesosSupervisor, obtenerAccesosSupervisores } from "@/lib/server/control-de-obra/accesos-obra";
import { editarProyecto, listarProyectos, obtenerProyecto } from "@/lib/server/control-de-obra/proyectos";
import { crearGasto as capturarGasto, aprobarGasto, editarGasto, obtenerGastos, obtenerGastosGlobal, obtenerRefArchivoGasto, registrarFacturaGasto } from "@/lib/server/control-de-obra/gastos";
import { crearOrdenCompra, editarOrdenCompra, marcarRecepcionOrdenCompra, obtenerDatosPdfOrdenCompra, obtenerOrdenesCompra } from "@/lib/server/control-de-obra/ordenes-compra";
import { agregarCotizacion, cancelarRequisicion, crearRequisicion, editarRequisicion, obtenerRefArchivoCotizacion, obtenerRefEvidenciaRequisicion, obtenerRequisicion, obtenerRequisicionesGlobal } from "@/lib/server/control-de-obra/requisiciones";
import { guardarAvanceSemanal, obtenerAvanceSemanal } from "@/lib/server/control-de-obra/avance";
import { obtenerContratistasProyecto } from "@/lib/server/control-de-obra/estructura-contractual";
import { obtenerReposiciones } from "@/lib/server/control-de-obra/reposiciones";
import { obtenerResumenEjecutivo } from "@/lib/server/dashboard";
import { obtenerMiReporte } from "@/lib/server/reporte-general/mi-reporte";
import { usuarioDePrueba } from "../helpers/usuarios";
import { BENEFICIARIO, EMPRESA, EMPRESA_AJENA, PROYECTO, PROYECTO_AJENO, SEMANA, admin, adminAjeno, baseLimpiaConDatos, supervisor as supBase } from "./apoyo/base";

// Obras visibles por Supervisor, contra PostgreSQL REAL. El supervisor tiene
// asignada PROYECTO; OTRA es de la misma empresa y no la tiene.

const OTRA = "proyecto-int-no-asignado";
const OFICINA = "proyecto-int-oficina";
const sup = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA, modulos: ["inicio", "control_de_obra"] }), id: supBase.id };
// obtenerProyecto usa cache() por objeto de usuario: cada lectura usa uno nuevo, como cada petición.
const s = () => ({ ...sup });
const master = { ...usuarioDePrueba({ rol: "MASTER" }), id: "master-int" };
const gasto = (extra: Record<string, unknown> = {}) => ({ fecha: "2026-10-06", descripcion: "Material", categoria: "MATERIAL", monto: 100, metodoPago: "EFECTIVO", quienPagoModo: "EMPRESA", ...extra });
const oc = { proveedorBeneficiarioId: BENEFICIARIO, fecha: "2026-10-06", detalle: [{ concepto: "x", unidad: "pza", cantidad: 1, precioUnitario: 10 }] };
const req = { concepto: "Cemento", cantidad: 1, unidad: "bulto", prioridad: "NORMAL" };
const semana = () => db.semana.findUniqueOrThrow({ where: { id: SEMANA } });

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.proyecto.createMany({
    data: [
      { id: OTRA, empresaId: EMPRESA, nombre: "Obra reservada" },
      { id: OFICINA, empresaId: EMPRESA, nombre: "Oficina", tipo: "OFICINA" },
    ],
  });
  await db.beneficiario.update({ where: { id: BENEFICIARIO }, data: { usuarioId: sup.id } });
});

describe("Asignación de obras", () => {
  test("Administrador y Director asignan y retiran, con bitácora; nadie más", async () => {
    const director = { ...usuarioDePrueba({ rol: "DIRECTOR", empresaId: EMPRESA }), id: admin.id };
    await guardarAccesosSupervisor(director, { supervisorId: sup.id, obraIds: [PROYECTO, OTRA] });
    assert.deepEqual((await listarProyectos(s())).map((p) => p.id).sort(), [PROYECTO, OTRA].sort());
    assert.deepEqual(await guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [OTRA, PROYECTO] }), { cambios: false });
    await guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [] });
    assert.deepEqual(await listarProyectos(s()), []);
    assert.equal(await db.registroAuditoria.count({ where: { entidad: "AccesoObra", entidadId: sup.id } }), 2);
    for (const u of [sup, master, adminAjeno]) await assert.rejects(guardarAccesosSupervisor(u, { supervisorId: sup.id, obraIds: [OTRA] }));
    await assert.rejects(obtenerAccesosSupervisores(sup));
    await assert.rejects(guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [PROYECTO_AJENO] }));
    await assert.rejects(guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [OFICINA] }));
    await assert.rejects(guardarAccesosSupervisor(admin, { supervisorId: admin.id, obraIds: [OTRA] }));
    assert.equal(await db.accesoObra.count(), 0);
  });

  test("nombrarlo responsable de la obra le da acceso; una obra nueva no la ve", async () => {
    await editarProyecto(admin, OTRA, { nombre: "Obra reservada", tipo: "MOMENTANEA", supervisorUsuarioId: sup.id });
    assert.equal((await obtenerProyecto(s(), OTRA)).id, OTRA);
    await db.proyecto.create({ data: { id: "nueva", empresaId: EMPRESA, nombre: "Nueva" } });
    await assert.rejects(obtenerProyecto(s(), "nueva"));
  });
});

describe("El Supervisor solo alcanza sus obras", () => {
  test("por obra: todo lo que no tiene asignado «no existe»", async () => {
    assert.deepEqual((await listarProyectos(s())).map((p) => p.id), [PROYECTO]);
    await obtenerProyecto(s(), PROYECTO);
    for (const obra of [OTRA, OFICINA, PROYECTO_AJENO]) {
      for (const f of [
        () => obtenerProyecto(s(), obra),
        async () => obtenerAvanceSemanal(s(), obra, await semana()),
        () => guardarAvanceSemanal(s(), obra, { semanaId: SEMANA, filas: [] }),
        () => obtenerContratistasProyecto(s(), obra),
        () => obtenerGastos(s(), obra, SEMANA),
        () => obtenerReposiciones(s(), obra, SEMANA),
        () => obtenerOrdenesCompra(s(), obra, SEMANA),
        () => crearOrdenCompra(s(), obra, SEMANA, oc),
        () => crearRequisicion(s(), obra, req),
      ]) await assert.rejects(f(), /proyecto|no existe|encontr/i, obra);
    }
    await assert.rejects(capturarGasto(s(), OTRA, SEMANA, gasto()));
    await capturarGasto(s(), PROYECTO, SEMANA, gasto());
  });

  test("por id directo (gastos, OC, requisiciones y archivos), aunque él lo haya capturado antes", async () => {
    await guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [PROYECTO, OTRA] });
    const g = await capturarGasto(s(), OTRA, SEMANA, gasto());
    const o = await crearOrdenCompra(s(), OTRA, SEMANA, oc);
    const r = await crearRequisicion(s(), OTRA, req);
    const c = await agregarCotizacion(s(), r.id, { proveedorBeneficiarioId: BENEFICIARIO, importe: 10 });
    await obtenerRequisicion(s(), r.id);
    await editarGasto(s(), g.id, gasto());
    await guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [PROYECTO] });
    for (const f of [
      () => editarGasto(s(), g.id, gasto()),
      () => registrarFacturaGasto(s(), g.id, { facturaRef: "x", facturaNombre: "x" }),
      () => obtenerRefArchivoGasto(s(), g.id, "ticket"),
      () => editarOrdenCompra(s(), o.id, oc),
      () => marcarRecepcionOrdenCompra(s(), o.id, { estatusRecepcion: "COMPLETA" }),
      () => obtenerDatosPdfOrdenCompra(s(), o.id),
      () => editarRequisicion(s(), r.id, req),
      () => cancelarRequisicion(s(), r.id, "motivo"),
      () => agregarCotizacion(s(), r.id, { proveedorBeneficiarioId: BENEFICIARIO, importe: 1 }),
      () => obtenerRequisicion(s(), r.id),
      () => obtenerRefEvidenciaRequisicion(s(), r.id),
      () => obtenerRefArchivoCotizacion(s(), c.id),
    ]) await assert.rejects(f(), (e: Error) => e.name === "RegistroNoEncontradoError");
    assert.equal((await obtenerRequisicionesGlobal(s())).length, 0);
    assert.ok(!JSON.stringify(await obtenerGastosGlobal(s(), SEMANA)).includes("reservada"));
    // Administración no cambia.
    assert.equal((await obtenerRequisicion(admin, r.id)).id, r.id);
    assert.equal((await obtenerGastosGlobal(admin, SEMANA)).length, 1);
  });

  test("Gastos de Empresa: captura, pero solo ve los suyos", async () => {
    await capturarGasto(admin, OFICINA, SEMANA, gasto({ descripcion: "Renta secreta", categoria: "PAPELERIA" }));
    const propio = await capturarGasto(s(), OFICINA, SEMANA, gasto({ descripcion: "Hojas", categoria: "PAPELERIA" }));
    assert.deepEqual((await obtenerGastosGlobal(s(), SEMANA)).map((g) => g.id), [propio.id]);
  });

  test("Inicio: solo sus obras; sin asignación, vacío; Administración ve todas", async () => {
    const r = await obtenerResumenEjecutivo(s(), "general", "semana");
    assert.deepEqual(r.proyectos.map((p) => p.id), [PROYECTO]);
    assert.equal(r.obrasActivas.total, 1);
    assert.ok(!JSON.stringify(r).includes("reservada"));
    await guardarAccesosSupervisor(admin, { supervisorId: sup.id, obraIds: [] });
    assert.equal((await obtenerResumenEjecutivo(s(), "general", "semana")).proyectos.length, 0);
    const deAdmin = { ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA, modulos: ["inicio"] }), id: admin.id };
    assert.equal((await obtenerResumenEjecutivo(deAdmin, "general", "semana")).proyectos.length, 2);
  });
});

describe("Reporte General del Supervisor", () => {
  test("solo sus pagos y sus gastos, también de una obra que ya no ve", async () => {
    const otro = await db.beneficiario.create({ data: { empresaId: EMPRESA, tipo: "CONTRATISTA", nombre: "Contratista ajeno" } });
    const bp = await db.beneficiarioProyecto.create({ data: { beneficiarioId: otro.id, proyectoId: PROYECTO } });
    await db.movimientoSemanal.create({ data: { beneficiarioProyectoId: bp.id, semanaId: SEMANA, origen: "CORTE_CONTRATISTA", montoFinSemana: 99999, estatusAprobacion: "APROBADO", estatusPago: "PENDIENTE_PAGO", enviadoPorId: admin.id } });
    const mio = await db.beneficiarioProyecto.create({ data: { beneficiarioId: BENEFICIARIO, proyectoId: OTRA } });
    await db.movimientoSemanal.create({ data: { beneficiarioProyectoId: mio.id, semanaId: SEMANA, origen: "MANUAL", montoFinSemana: 5000, estatusAprobacion: "APROBADO", estatusPago: "PENDIENTE_PAGO", enviadoPorId: admin.id } });

    const pagado = await capturarGasto(s(), PROYECTO, SEMANA, gasto({ descripcion: "Clavos", monto: 300, quienPagoModo: "YO" }));
    await capturarGasto(s(), PROYECTO, SEMANA, gasto({ descripcion: "Cinta", monto: 50, quienPagoModo: "YO" }));
    await capturarGasto(admin, PROYECTO, SEMANA, gasto({ descripcion: "Gasto de otra persona", monto: 777 }));
    await aprobarGasto(admin, pagado.id);

    const r = await obtenerMiReporte(s(), SEMANA);
    assert.deepEqual(r.pagos.map((p) => [p.origen, p.monto, p.pendiente]).sort(), [["MANUAL", 5000, 5000], ["REPOSICION_GASTOS", 300, 300]]);
    assert.equal(r.totalPagos, 5300);
    assert.equal(r.totalPendiente, 5300);
    assert.equal(r.gastosPorRevisar, 50);
    assert.deepEqual(r.gastos.map((g) => g.descripcion).sort(), ["Cinta", "Clavos"]);
    const texto = JSON.stringify(r);
    for (const ajeno of ["99999", "Contratista ajeno", "777", "otra persona"]) assert.ok(!texto.includes(ajeno), ajeno);
  });

  test("sin registro de pago vinculado: aviso y solo lo que capturó", async () => {
    await db.beneficiario.update({ where: { id: BENEFICIARIO }, data: { usuarioId: null } });
    const r = await obtenerMiReporte(s(), SEMANA);
    assert.equal(r.vinculado, false);
    assert.deepEqual([r.pagos.length, r.gastos.length], [0, 0]);
  });

  test("otra empresa no comparte nada", async () => {
    const ajeno = { ...usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA_AJENA }), id: sup.id };
    await assert.rejects(obtenerProyecto(ajeno, PROYECTO));
    assert.equal((await obtenerMiReporte(ajeno, SEMANA)).pagos.length, 0);
  });
});

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import {
  confirmarComoEgresoManual,
  confirmarComoGastoNuevo,
} from "@/lib/server/contabilidad/documentos/confirmar-propuesta";
import { PosiblesDuplicadosError } from "@/lib/server/contabilidad/documentos/duplicados";
import { guardarDecoracionEgreso } from "@/lib/server/contabilidad/egresos";
import { aprobarGasto } from "@/lib/server/control-de-obra/gastos";
import { procesarTrabajos } from "@/lib/server/inteligencia/worker";
import {
  BENEFICIARIO,
  BENEFICIARIO_AJENO,
  EMPRESA,
  EMPRESA_AJENA,
  MEDIO_BANCO,
  PROYECTO,
  SEMANA,
  admin,
  adminAjeno,
  baseLimpiaConDatos,
  conFallaSimulada,
  repetir,
  sinInterbloqueos,
  supervisor,
} from "./apoyo/base";

// Fase 0 WhatsApp + ARQENTO IA contra PostgreSQL REAL (base local dedicada,
// verificada por tests/setup/integracion.mjs): confirmación de documentos de
// Captura Inteligente con pagador real, aprobación posterior con reposición
// R2, R1, concurrencia (FOR UPDATE + bloqueo consultivo), rollback real,
// multiempresa y worker acotado por Empresa. OpenAI y R2 siguen simulados:
// ninguna prueba sube archivos ni llama a la IA. Datos ficticios.

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.empresa.update({ where: { id: EMPRESA }, data: { inteligenciaHabilitada: true } });
  // El Supervisor ficticio tiene su beneficiario de pago vinculado.
  await db.beneficiario.update({ where: { id: BENEFICIARIO }, data: { usuarioId: supervisor.id } });
});

async function documento(id: string, extra: { subidoPorId?: string; propuesta?: object; empresaId?: string } = {}) {
  return db.documentoEgreso.create({
    data: {
      id,
      empresaId: extra.empresaId ?? EMPRESA,
      archivoRef: `pruebas/${id}.jpg`,
      archivoNombre: `${id}.jpg`,
      tipoMime: "image/jpeg",
      hashArchivo: `hash-${id}`,
      loteId: "lote-fase0",
      subidoPorId: extra.subidoPorId ?? supervisor.id,
      estatus: "PROCESADO",
      propuestaReconciliada: extra.propuesta ?? { campos: [{ campo: "total", valor: 2450 }] },
    },
  });
}

const GASTO = {
  destino: "OBRA",
  proyectoId: PROYECTO,
  semanaId: SEMANA,
  fecha: "2026-10-08",
  descripcion: "Cemento ficticio",
  categoria: "MATERIAL",
  monto: "2450.00",
  metodoPago: "EFECTIVO",
};

describe("Fase 0 en PostgreSQL — gasto de obra desde documento", () => {
  test("YO: gasto del remitente → aprobación → reposición R2 por el mismo importe; R1 sin pago bancario", async () => {
    await documento("doc-1");
    const { gastoObraId, egresoId } = await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO" });

    const gasto = await db.gastoObra.findUniqueOrThrow({ where: { id: gastoObraId } });
    assert.equal(gasto.pagadorBeneficiarioId, BENEFICIARIO);
    assert.equal(gasto.capturadoPorId, supervisor.id, "capturista = remitente");
    assert.equal(gasto.estatus, "PENDIENTE_REVISION");
    assert.equal(gasto.reposicionGastosId, null, "la reposición nace al aprobar, no al confirmar");
    const doc = await db.documentoEgreso.findUniqueOrThrow({ where: { id: "doc-1" } });
    assert.deepEqual([doc.estatus, doc.egresoId, doc.confirmadoPorId], ["CONVERTIDO", egresoId, admin.id]);

    await aprobarGasto(admin, gastoObraId);
    const aprobado = await db.gastoObra.findUniqueOrThrow({ where: { id: gastoObraId } });
    assert.equal(aprobado.revisadoPorId, admin.id, "quien aprueba queda aparte");
    const rep = await db.reposicionGastos.findUniqueOrThrow({ where: { id: aprobado.reposicionGastosId! }, include: { movimientoSemanal: true } });
    assert.equal(rep.beneficiarioId, BENEFICIARIO);
    assert.equal(Number(rep.movimientoSemanal!.montoFinSemana), 2450);

    // R1: un gasto pagado por una persona no recibe además un pago bancario.
    await assert.rejects(guardarDecoracionEgreso(admin, gastoObraId, { fechaPago: "2026-10-09", medioFinancieroId: MEDIO_BANCO }));
  });

  test("YO sin beneficiario vinculado al remitente: se rechaza y no se escribe nada", async () => {
    await documento("doc-1", { subidoPorId: admin.id });
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO" }), /no tiene un beneficiario/);
    assert.equal(await db.gastoObra.count(), 0);
    assert.equal((await db.documentoEgreso.findUniqueOrThrow({ where: { id: "doc-1" } })).estatus, "PROCESADO");
  });

  test("OTRO de otra Empresa se rechaza; EMPRESA explícita no genera reposición al aprobar", async () => {
    await documento("doc-1");
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "OTRO", pagadorBeneficiarioId: BENEFICIARIO_AJENO }));
    const { gastoObraId } = await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" });
    await aprobarGasto(admin, gastoObraId);
    assert.equal(await db.reposicionGastos.count(), 0);
  });

  test("Confirmaciones simultáneas del mismo documento: un solo gasto, sin interbloqueos", async () => {
    await repetir(6, async (vuelta) => {
      await db.documentoEgreso.deleteMany({});
      await db.egreso.deleteMany({});
      await db.gastoObra.deleteMany({});
      await documento(`doc-${vuelta}`);
      const r = await Promise.allSettled([
        confirmarComoGastoNuevo(admin, `doc-${vuelta}`, { ...GASTO, pagadorModo: "YO" }),
        confirmarComoGastoNuevo(admin, `doc-${vuelta}`, { ...GASTO, pagadorModo: "YO" }),
      ]);
      sinInterbloqueos(r);
      assert.ok(r.every((x) => x.status === "fulfilled"), JSON.stringify(r));
      const [a, b] = r as PromiseFulfilledResult<{ gastoObraId: string }>[];
      assert.equal(a.value.gastoObraId, b.value.gastoObraId);
      assert.equal(await db.gastoObra.count(), 1);
    });
  });

  test("Dos documentos de la misma compra confirmados a la vez: el segundo recibe el aviso de duplicado", async () => {
    await repetir(6, async (vuelta) => {
      await db.documentoEgreso.deleteMany({});
      await db.egreso.deleteMany({});
      await db.gastoObra.deleteMany({});
      await documento(`foto-${vuelta}`);
      await documento(`pdf-${vuelta}`);
      const r = await Promise.allSettled([
        confirmarComoGastoNuevo(admin, `foto-${vuelta}`, { ...GASTO, pagadorModo: "EMPRESA" }),
        confirmarComoGastoNuevo(admin, `pdf-${vuelta}`, { ...GASTO, pagadorModo: "EMPRESA" }),
      ]);
      sinInterbloqueos(r);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(r));
      const rechazo = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
      assert.ok(rechazo.reason instanceof PosiblesDuplicadosError, String(rechazo.reason));
      assert.equal(await db.gastoObra.count(), 1);
    });
  });

  test("Duplicado FUERTE por referencia bancaria: aviso; con aceptación explícita sí se registra", async () => {
    await db.egreso.create({ data: { empresaId: EMPRESA, concepto: "Pago previo", monto: "999.00", fecha: new Date(Date.UTC(2026, 8, 1)), referenciaPago: "SPEI-77", clasificacionManual: "GASTO_OPERACION", registradoPorId: admin.id } });
    await documento("doc-1", { propuesta: { campos: [{ campo: "referenciaBancaria", valor: "SPEI-77" }] } });
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" }), PosiblesDuplicadosError);
    assert.equal(await db.gastoObra.count(), 0);
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA", aceptaPosiblesDuplicados: "on" });
    assert.equal(await db.gastoObra.count(), 1);
  });

  test("Rollback real: si falla marcar el documento, no queda gasto, egreso ni auditoría", async () => {
    await documento("doc-1");
    const auditorias = await db.registroAuditoria.count();
    await conFallaSimulada("documentos_egreso", `TG_OP = 'UPDATE'`, () =>
      assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO" }), /Falla simulada/)
    );
    assert.equal(await db.gastoObra.count(), 0);
    assert.equal(await db.egreso.count(), 0);
    assert.equal(await db.registroAuditoria.count(), auditorias);
  });

  test("Multiempresa y permisos: otra Empresa no confirma; Supervisor tampoco", async () => {
    await documento("doc-1");
    await assert.rejects(confirmarComoGastoNuevo(adminAjeno, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" }));
    await assert.rejects(confirmarComoGastoNuevo(supervisor, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" }));
    assert.equal(await db.gastoObra.count(), 0);
  });
});

describe("Fase 0 en PostgreSQL — destino Empresa (Oficina) y cobrabilidad", () => {
  test("Oficina pagada por una persona: Proyecto de Oficina único → aprobación → reposición R2 en ese proyecto", async () => {
    await documento("doc-1");
    await documento("doc-2");
    const OFICINA = { ...GASTO, destino: "EMPRESA", proyectoId: undefined, categoria: "PAPELERIA", descripcion: "Papelería ficticia" };
    const r = await Promise.all([
      confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, pagadorModo: "YO", monto: "120.00" }),
      confirmarComoGastoNuevo(admin, "doc-2", { ...OFICINA, pagadorModo: "EMPRESA", monto: "80.00", fecha: "2026-10-01" }),
    ]);
    const oficinas = await db.proyecto.findMany({ where: { empresaId: EMPRESA, tipo: "OFICINA" } });
    assert.equal(oficinas.length, 1, "un solo Proyecto de Oficina aunque se cree en paralelo");
    const gasto = await db.gastoObra.findUniqueOrThrow({ where: { id: r[0].gastoObraId } });
    assert.deepEqual([gasto.proyectoId, gasto.tratamientoCliente, gasto.pagadorBeneficiarioId], [oficinas[0].id, "NO_COBRABLE", BENEFICIARIO]);
    await aprobarGasto(admin, gasto.id);
    const aprobado = await db.gastoObra.findUniqueOrThrow({ where: { id: gasto.id } });
    const rep = await db.reposicionGastos.findUniqueOrThrow({ where: { id: aprobado.reposicionGastosId! } });
    assert.deepEqual([rep.proyectoId, rep.beneficiarioId], [oficinas[0].id, BENEFICIARIO]);
  });

  test("Obra cobrable en estimación: el tratamiento se guarda y la aprobación sigue el flujo de Gastos", async () => {
    await documento("doc-1");
    const { gastoObraId } = await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, tratamientoCliente: "COBRABLE_EN_ESTIMACION", pagadorModo: "EMPRESA" });
    await aprobarGasto(admin, gastoObraId);
    const g = await db.gastoObra.findUniqueOrThrow({ where: { id: gastoObraId } });
    assert.deepEqual([g.tratamientoCliente, g.estatus], ["COBRABLE_EN_ESTIMACION", "APROBADO"]);
  });
});

describe("Fase 0 en PostgreSQL — egreso de empresa desde documento", () => {
  test("Exige confirmar que pagó la Empresa; es atómico e idempotente", async () => {
    await documento("doc-1");
    const EGRESO = { fecha: "2026-10-08", concepto: "Papelería ficticia", monto: "300.00", clasificacionManual: "GASTO_OPERACION", notasContables: "Nota" };
    await assert.rejects(confirmarComoEgresoManual(admin, "doc-1", EGRESO), /pagó la Empresa/);
    const r = await Promise.allSettled([
      confirmarComoEgresoManual(admin, "doc-1", { ...EGRESO, pagadoPorEmpresa: "on" }),
      confirmarComoEgresoManual(admin, "doc-1", { ...EGRESO, pagadoPorEmpresa: "on" }),
    ]);
    sinInterbloqueos(r);
    assert.ok(r.every((x) => x.status === "fulfilled"), JSON.stringify(r));
    const egresos = await db.egreso.findMany();
    assert.equal(egresos.length, 1);
    assert.equal(egresos[0].notasContables, "Nota");
  });
});

describe("Fase 0 en PostgreSQL — worker acotado por Empresa", () => {
  async function trabajo(id: string, empresaId: string, referenciaModulo: string) {
    return db.trabajoProcesamientoDocumento.create({
      data: {
        id,
        empresaId,
        // Operación sin manejador: el worker la deja en ERROR sin descargar
        // archivos ni llamar a la IA — basta para observar qué trabajos toma.
        modulo: "pruebas",
        operacion: "sin-manejador",
        referenciaModulo,
        archivoRef: "pruebas/ninguno",
        tipoMime: "application/pdf",
        creadoPorId: empresaId === EMPRESA ? admin.id : adminAjeno.id,
      },
    });
  }

  test("Solo toma trabajos de su Empresa y de las referencias indicadas; dos corridas simultáneas no lo procesan dos veces", async () => {
    await trabajo("propio-1", EMPRESA, "doc-a");
    await trabajo("propio-2", EMPRESA, "doc-b");
    await trabajo("ajeno-1", EMPRESA_AJENA, "doc-a");
    const r = await Promise.all([
      procesarTrabajos({ empresaId: EMPRESA, referencias: ["doc-a"] }, 5),
      procesarTrabajos({ empresaId: EMPRESA, referencias: ["doc-a"] }, 5),
    ]);
    assert.equal(r[0].tomados + r[1].tomados, 1, "el mismo trabajo se toma una sola vez");
    const estatus = Object.fromEntries((await db.trabajoProcesamientoDocumento.findMany()).map((t) => [t.id, t.estatus]));
    assert.deepEqual(estatus, { "propio-1": "ERROR", "propio-2": "PENDIENTE", "ajeno-1": "PENDIENTE" });
  });
});

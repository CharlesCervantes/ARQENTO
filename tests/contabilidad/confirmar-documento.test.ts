import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import {
  confirmarComoEgresoManual,
  confirmarComoGastoNuevo,
  descartarDocumentoEgreso,
} from "@/lib/server/contabilidad/documentos/confirmar-propuesta";
import { PosiblesDuplicadosError, buscarPosiblesDuplicadosTx } from "@/lib/server/contabilidad/documentos/duplicados";
import { avanzarProcesamientoDeLote } from "@/lib/server/contabilidad/documentos/documento-egreso";
import { procesarTrabajos } from "@/lib/server/inteligencia/worker";
import { obtenerManejador } from "@/lib/server/inteligencia/registro-operaciones";
import { listarSemanasParaRegistro } from "@/lib/server/semanas";
import { crearGasto } from "@/lib/server/control-de-obra/gastos";
import { datosGastoDesdeFormData } from "@/lib/control-de-obra/gasto-form-data";
import { usuarioDePrueba } from "../helpers/usuarios";

// Fase 0 WhatsApp + ARQENTO IA (octubre 2026) — confirmación de documentos
// de Captura Inteligente: R3 (pagador obligatorio, YO = beneficiario del
// remitente), trazabilidad remitente/confirmador, atomicidad, idempotencia,
// posibles duplicados, egreso de empresa explícito, descarte, permisos, y
// procesamiento acotado por Empresa. Base SIMULADA en memoria con reversión
// de transacciones. Datos ficticios.

type Fila = Record<string, unknown>;
const EMPRESA = "empresa-prueba";
const PROYECTOS: Record<string, string> = { "obra-1": "Villas Ficticias", "obra-2": "Torre Ficticia", "proyecto-oficina": "Gastos de Empresa" };
const TIPO_PROYECTO: Record<string, string> = { "obra-1": "FORMAL", "obra-2": "FORMAL", "proyecto-oficina": "OFICINA" };
let oficinaExiste: boolean;
let oficinasCreadas: number;

let estado: {
  documentos: Map<string, Fila>;
  gastos: Fila[];
  egresos: Fila[];
  auditorias: Fila[];
};
let bloqueos: string[];
let candadosConsultivos: string[];
let fallarEn: string | null;
let siguiente: number;
let consultasTrabajos: Fila[];
const originales: [Record<string, unknown>, string, unknown][] = [];

const USUARIOS: Record<string, { nombre: string; empresaId: string; beneficiario: { id: string; activo: boolean; empresaId: string } | null }> = {
  "usuario-sergio": { nombre: "Sergio (ficticio)", empresaId: EMPRESA, beneficiario: { id: "benef-sergio", activo: true, empresaId: EMPRESA } },
  "usuario-sin-benef": { nombre: "Ana (ficticia)", empresaId: EMPRESA, beneficiario: null },
  "usuario-benef-inactivo": { nombre: "Luis (ficticio)", empresaId: EMPRESA, beneficiario: { id: "benef-inactivo", activo: false, empresaId: EMPRESA } },
  "usuario-administrador": { nombre: "Admin (ficticio)", empresaId: EMPRESA, beneficiario: null },
};
const BENEFICIARIOS: Fila[] = [
  { id: "benef-sergio", empresaId: EMPRESA, activo: true },
  { id: "benef-andres", empresaId: EMPRESA, activo: true },
  { id: "benef-inactivo", empresaId: EMPRESA, activo: false },
  { id: "benef-ajeno", empresaId: "empresa-ajena", activo: true },
  { id: "prov-1", empresaId: EMPRESA, activo: true },
];

function sustituir(destino: Record<string, unknown>, metodo: string, impl: unknown) {
  originales.push([destino, metodo, destino[metodo]]);
  destino[metodo] = impl;
}
const modelo = (nombre: string) => (db as unknown as Record<string, Record<string, unknown>>)[nombre];
const clonar = () => ({
  documentos: new Map([...estado.documentos].map(([k, v]) => [k, { ...v }])),
  gastos: estado.gastos.map((g) => ({ ...g })),
  egresos: estado.egresos.map((e) => ({ ...e })),
  auditorias: [...estado.auditorias],
});
function escribir(op: string) {
  if (fallarEn === op) throw new Error(`Falla simulada en ${op}`);
}

// Coincidencia mínima de filtros Prisma usados por estos flujos.
function coincide(fila: Fila, where: Fila | undefined): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (k === "OR") {
      if (!(cond as Fila[]).some((w) => coincide(fila, w))) return false;
      continue;
    }
    if (k === "factura") {
      const lista = ((cond as Fila).uuid as { in: string[] }).in;
      if (!lista.includes(fila.facturaUuid as string)) return false;
      continue;
    }
    const v = fila[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
      if ("gte" in c && !((v as number) >= (c.gte as number))) return false;
      if ("lte" in c && !((v as number) <= (c.lte as number))) return false;
      if ("not" in c && v === c.not) return false;
      continue;
    }
    if (cond === null ? !(v === null || v === undefined) : v !== cond) return false;
  }
  return true;
}
const conProyecto = (g: Fila) => ({ ...g, proyecto: g.proyectoId ? { nombre: PROYECTOS[g.proyectoId as string] } : null });

beforeEach(() => {
  estado = { documentos: new Map(), gastos: [], egresos: [], auditorias: [] };
  bloqueos = [];
  candadosConsultivos = [];
  fallarEn = null;
  siguiente = 1;
  consultasTrabajos = [];
  oficinaExiste = true;
  oficinasCreadas = 0;
  const cliente = db as unknown as Record<string, unknown>;
  sustituir(cliente, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) => {
    const respaldo = clonar();
    try {
      return await fn(db);
    } catch (error) {
      estado = respaldo;
      throw error;
    }
  });
  sustituir(cliente, "$queryRaw", async (partes: TemplateStringsArray, ...valores: unknown[]) => {
    bloqueos.push(`${partes.join("?")} [${valores.join(",")}]`);
    return [];
  });
  sustituir(cliente, "$executeRaw", async (_partes: TemplateStringsArray, ...valores: unknown[]) => {
    candadosConsultivos.push(String(valores[0]));
    return 1;
  });
  sustituir(modelo("empresa"), "findUnique", async () => ({ inteligenciaHabilitada: true }));
  sustituir(modelo("semana"), "upsert", async () => ({ id: "semana-41" }));
  sustituir(modelo("semana"), "findFirst", async ({ where }: { where: Fila }) => (where.id === "semana-41" && where.empresaId === EMPRESA ? { id: "semana-41" } : null));
  sustituir(modelo("proyecto"), "findFirst", async ({ where }: { where: Fila }) => {
    if (where.empresaId !== EMPRESA) return null;
    if (where.tipo === "OFICINA") return oficinaExiste ? { id: "proyecto-oficina" } : null;
    const id = where.id as string;
    if (!PROYECTOS[id] || (id === "proyecto-oficina" && !oficinaExiste)) return null;
    return { id, empresaId: EMPRESA, tipo: TIPO_PROYECTO[id] };
  });
  sustituir(modelo("proyecto"), "create", async () => {
    oficinasCreadas++;
    oficinaExiste = true;
    return { id: "proyecto-oficina" };
  });
  sustituir(modelo("documentoEgreso"), "findFirst", async ({ where }: { where: Fila }) => {
    const d = estado.documentos.get(where.id as string);
    return d && d.empresaId === where.empresaId ? { ...d } : null;
  });
  sustituir(modelo("documentoEgreso"), "update", async ({ where, data }: { where: Fila; data: Fila }) => {
    escribir("documento.update");
    Object.assign(estado.documentos.get(where.id as string)!, data);
    return {};
  });
  sustituir(modelo("usuario"), "findFirst", async ({ where }: { where: Fila }) => {
    const u = USUARIOS[where.id as string];
    return u && u.empresaId === where.empresaId ? { nombre: u.nombre, beneficiario: u.beneficiario } : null;
  });
  sustituir(modelo("beneficiario"), "findFirst", async ({ where }: { where: Fila }) => {
    const b = BENEFICIARIOS.find((x) => coincide(x, where));
    return b ? { id: b.id } : null;
  });
  sustituir(modelo("gastoObra"), "findMany", async ({ where }: { where: Fila }) => estado.gastos.filter((g) => coincide(g, where)).map(conProyecto));
  sustituir(modelo("gastoObra"), "findFirst", async ({ where }: { where: Fila }) => {
    const g = estado.gastos.find((x) => coincide(x, where));
    return g ? { ...g } : null;
  });
  sustituir(modelo("gastoObra"), "create", async ({ data }: { data: Fila }) => {
    escribir("gasto.create");
    const nuevo = { id: `gasto-${siguiente++}`, estatus: "PENDIENTE_REVISION", ...data };
    estado.gastos.push(nuevo);
    return { ...nuevo };
  });
  sustituir(modelo("egreso"), "findMany", async ({ where }: { where: Fila }) =>
    estado.egresos
      .filter((e) => coincide(e, where))
      .map((e) => ({ ...conProyecto(e), gastoObra: e.gastoObraId ? conProyecto(estado.gastos.find((g) => g.id === e.gastoObraId)!) : null }))
  );
  sustituir(modelo("egreso"), "findUnique", async ({ where }: { where: Fila }) => {
    const e = estado.egresos.find((x) => (where.id ? x.id === where.id : x.gastoObraId === where.gastoObraId));
    return e ? { ...e } : null;
  });
  sustituir(modelo("egreso"), "create", async ({ data }: { data: Fila }) => {
    escribir("egreso.create");
    const nuevo = { id: `egreso-${siguiente++}`, estatus: "VIGENTE", gastoObraId: null, ...data };
    estado.egresos.push(nuevo);
    return { ...nuevo };
  });
  for (const m of ["medioFinanciero", "factura"]) {
    sustituir(modelo(m), "findFirst", async ({ where }: { where: Fila }) => (where.empresaId === EMPRESA && !String(where.id).includes("ajen") ? { id: where.id } : null));
  }
  sustituir(modelo("registroAuditoria"), "create", async ({ data }: { data: Fila }) => {
    escribir("auditoria");
    estado.auditorias.push(data);
    return data;
  });
  sustituir(modelo("documentoEgreso"), "findMany", async ({ where }: { where: Fila }) =>
    [...estado.documentos.values()].filter((d) => coincide(d, where)).map((d) => ({ id: d.id }))
  );
  for (const metodo of ["findMany"]) {
    sustituir(modelo("trabajoProcesamientoDocumento"), metodo, async (args: Fila) => {
      consultasTrabajos.push(args);
      return [];
    });
  }
});
afterEach(() => {
  for (const [destino, metodo, original] of originales.splice(0).reverse()) destino[metodo] = original;
});

const admin = usuarioDePrueba({ rol: "ADMINISTRADOR" });
const supervisor = usuarioDePrueba({ rol: "SUPERVISOR" });
const adminAjeno = usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: "empresa-ajena" });

function documento(id: string, extra: Fila = {}) {
  estado.documentos.set(id, {
    id,
    empresaId: EMPRESA,
    estatus: "PROCESADO",
    egresoId: null,
    subidoPorId: "usuario-sergio",
    propuestaReconciliada: { campos: [{ campo: "total", valor: 2450 }] },
    ...extra,
  });
}
const FECHA = "2026-10-08";
const GASTO = {
  destino: "OBRA",
  proyectoId: "obra-1",
  semanaId: "semana-41",
  fecha: FECHA,
  descripcion: "Cemento ficticio",
  categoria: "MATERIAL",
  monto: "2450",
  metodoPago: "EFECTIVO",
};
const doc = (id: string) => estado.documentos.get(id)!;
const sinEscrituras = () => estado.gastos.length === 0 && estado.egresos.length === 0 && estado.auditorias.length === 0;

describe("R3 — quién pagó (obligatorio, resuelto en el servidor)", () => {
  test("Sin pagador: se rechaza y no se escribe nada", async () => {
    documento("doc-1");
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", GASTO), /quién pagó/i);
    assert.ok(sinEscrituras());
    assert.equal(doc("doc-1").estatus, "PROCESADO");
  });

  test("EMPRESA explícita: gasto sin pagador; capturista = remitente, confirmador = revisor", async () => {
    documento("doc-1");
    const r = await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" });
    const gasto = estado.gastos[0];
    assert.equal(gasto.id, r.gastoObraId);
    assert.equal(gasto.pagadorBeneficiarioId, null);
    assert.equal(gasto.capturadoPorId, "usuario-sergio");
    assert.equal(gasto.estatus, "PENDIENTE_REVISION", "aprobar sigue siendo un paso aparte");
    assert.equal(doc("doc-1").estatus, "CONVERTIDO");
    assert.equal(doc("doc-1").confirmadoPorId, admin.id);
    const auditGasto = estado.auditorias.find((a) => a.entidad === "GastoObra")!;
    assert.equal(auditGasto.usuarioId, admin.id);
    assert.deepEqual((auditGasto.valorNuevo as Fila).origen, "DOCUMENTO");
  });

  test("YO: el beneficiario vinculado al REMITENTE, no al revisor ni al cliente", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO", pagadorBeneficiarioId: "benef-andres" });
    assert.equal(estado.gastos[0].pagadorBeneficiarioId, "benef-sergio");
  });

  test("YO sin beneficiario vinculado: pide completarlo y no escribe nada", async () => {
    documento("doc-1", { subidoPorId: "usuario-sin-benef" });
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO" }), /Ana \(ficticia\) no tiene un beneficiario/);
    assert.ok(sinEscrituras());
  });

  test("YO con beneficiario inactivo: se rechaza", async () => {
    documento("doc-1", { subidoPorId: "usuario-benef-inactivo" });
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO" }), /beneficiario/);
    assert.ok(sinEscrituras());
  });

  test("OTRO: obligatorio, de la misma Empresa y activo", async () => {
    documento("doc-1");
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "OTRO" }), /Selecciona a la persona/);
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "OTRO", pagadorBeneficiarioId: "benef-ajeno" }));
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "OTRO", pagadorBeneficiarioId: "benef-inactivo" }));
    assert.ok(sinEscrituras());
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "OTRO", pagadorBeneficiarioId: "benef-andres" });
    assert.equal(estado.gastos[0].pagadorBeneficiarioId, "benef-andres");
  });
});

describe("Semana del gasto: se propone la actual y se puede elegir otra válida", () => {
  test("Sin semana: se rechaza", async () => {
    documento("doc-1");
    const { semanaId: _omitida, ...sinSemana } = GASTO;
    void _omitida;
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...sinSemana, pagadorModo: "EMPRESA" }), /semana/i);
    assert.ok(sinEscrituras());
  });

  test("La semana elegida se respeta; la fecha del comprobante no la decide", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, fecha: "2026-08-01", pagadorModo: "EMPRESA" });
    assert.equal(estado.gastos[0].semanaId, "semana-41");
  });

  test("ACTUAL se resuelve en el servidor con la semana actual de la Empresa", async () => {
    documento("doc-1");
    const { semanaId: _omitida, ...sinSemana } = GASTO;
    void _omitida;
    await confirmarComoGastoNuevo(admin, "doc-1", { ...sinSemana, semanaDe: "ACTUAL", pagadorModo: "EMPRESA" });
    assert.equal(estado.gastos[0].semanaId, "semana-41");
  });

  test("Una semana que no es de la Empresa se rechaza sin escribir nada", async () => {
    documento("doc-1");
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, semanaId: "semana-ajena", pagadorModo: "EMPRESA" }), /semana/i);
    assert.ok(sinEscrituras());
  });

  test("Semanas para registrar: la actual (creada si falta) primero, y las existentes de la Empresa", async () => {
    const inicio = new Date("2026-10-19T00:00:00Z");
    sustituir(modelo("semana"), "upsert", async () => ({ id: "semana-43", numero: 43, anio: 2026, fechaInicio: inicio, fechaFin: inicio }));
    const consultas: Fila[] = [];
    sustituir(modelo("semana"), "findMany", async (args: Fila) => {
      consultas.push(args);
      return [{ id: "semana-41", numero: 41, anio: 2026, fechaInicio: inicio, fechaFin: inicio }];
    });
    const { semanaActualId, semanas } = await listarSemanasParaRegistro(EMPRESA);
    assert.equal(semanaActualId, "semana-43");
    assert.deepEqual(semanas.map((x) => x.id), ["semana-43", "semana-41"]);
    assert.deepEqual((consultas[0].where as Fila), { empresaId: EMPRESA });
  });
});

describe("Atomicidad e idempotencia", () => {
  test("Confirmar dos veces devuelve el mismo gasto y no crea otro", async () => {
    documento("doc-1");
    const primero = await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" });
    const segundo = await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" });
    assert.deepEqual(segundo, primero);
    assert.equal(estado.gastos.length, 1);
    assert.ok(bloqueos.some((b) => /documentos_egreso/.test(b) && /FOR UPDATE/.test(b)));
  });

  test("Un documento ya registrado como egreso de empresa no se registra además como gasto", async () => {
    documento("doc-1");
    await confirmarComoEgresoManual(admin, "doc-1", { fecha: FECHA, concepto: "Papelería", monto: "300", clasificacionManual: "GASTO_OPERACION", pagadoPorEmpresa: "on" });
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" }), /otra operación/);
    assert.equal(estado.gastos.length, 0);
  });

  test("Un documento descartado se puede registrar después (decisión explícita)", async () => {
    documento("doc-1", { estatus: "DESCARTADO" });
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" });
    assert.equal(doc("doc-1").estatus, "CONVERTIDO");
  });

  for (const op of ["gasto.create", "egreso.create", "documento.update", "auditoria"]) {
    test(`Falla en ${op}: rollback completo (sin gasto, sin egreso, sin auditoría, documento intacto)`, async () => {
      documento("doc-1");
      fallarEn = op;
      await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "YO" }), /Falla simulada/);
      assert.ok(sinEscrituras());
      assert.equal(doc("doc-1").estatus, "PROCESADO");
    });
  }
});

describe("Posibles duplicados: avisan y requieren aceptación explícita", () => {
  function gastoExistente(extra: Fila) {
    estado.gastos.push({ id: `previo-${siguiente++}`, empresaId: EMPRESA, estatus: "APROBADO", categoria: "MATERIAL", descripcion: "Compra previa", monto: 2450, fecha: new Date(`${FECHA}T00:00:00Z`), proyectoId: "obra-1", proveedorBeneficiarioId: null, ...extra });
  }
  const capturar = async (datos: Fila) => {
    try {
      await confirmarComoGastoNuevo(admin, "doc-1", datos);
      return [];
    } catch (error) {
      if (error instanceof PosiblesDuplicadosError) return error.candidatos;
      throw error;
    }
  };

  test("FUERTE por referencia bancaria ya registrada: no escribe; con aceptación sí, y queda auditado", async () => {
    documento("doc-1", { propuestaReconciliada: { campos: [{ campo: "referenciaBancaria", valor: "SPEI-12345" }] } });
    estado.egresos.push({ id: "egreso-previo", empresaId: EMPRESA, estatus: "VIGENTE", gastoObraId: null, referenciaPago: "SPEI-12345", concepto: "Pago previo", monto: 999, fecha: new Date("2026-09-01T00:00:00Z"), proyectoId: null });
    const candidatos = await capturar({ ...GASTO, pagadorModo: "EMPRESA" });
    assert.equal(candidatos[0].nivel, "FUERTE");
    assert.equal(estado.gastos.length, 0);
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA", aceptaPosiblesDuplicados: "on" });
    assert.equal(estado.gastos.length, 1);
    const valores = doc("doc-1").valoresFinalesUsuario as Fila;
    assert.deepEqual(valores.posiblesDuplicadosAceptados, [{ tipo: "EGRESO", id: "egreso-previo", nivel: "FUERTE" }]);
  });

  test("FUERTE por UUID fiscal ligado a un egreso", async () => {
    const uuid = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
    documento("doc-1", { propuestaReconciliada: { campos: [{ campo: "folio", valor: `CFDI ${uuid.toLowerCase()}` }] } });
    gastoExistente({ id: "gasto-facturado", monto: 10, proyectoId: "obra-2" });
    estado.egresos.push({ id: "egreso-fact", empresaId: EMPRESA, estatus: "VIGENTE", gastoObraId: "gasto-facturado", facturaUuid: uuid, monto: null, fecha: null, proyectoId: null });
    const candidatos = await capturar({ ...GASTO, pagadorModo: "EMPRESA" });
    assert.deepEqual(candidatos.map((c) => [c.nivel, c.id]), [["FUERTE", "gasto-facturado"]]);
  });

  test("MEDIO: mismo proveedor e importe a ±3 días (a 5 días ya no)", async () => {
    documento("doc-1");
    gastoExistente({ id: "cerca", proveedorBeneficiarioId: "prov-1", proyectoId: "obra-2", fecha: new Date("2026-10-10T00:00:00Z") });
    gastoExistente({ id: "lejos", proveedorBeneficiarioId: "prov-1", proyectoId: "obra-2", fecha: new Date("2026-10-13T12:00:00Z") });
    const candidatos = await capturar({ ...GASTO, pagadorModo: "EMPRESA", proveedorBeneficiarioId: "prov-1" });
    assert.deepEqual(candidatos.map((c) => [c.nivel, c.id]), [["MEDIO", "cerca"]]);
  });

  test("DEBIL: mismo importe y obra a ±1 día; otra obra no cuenta", async () => {
    documento("doc-1");
    gastoExistente({ id: "misma-obra" });
    gastoExistente({ id: "otra-obra", proyectoId: "obra-2" });
    const candidatos = await capturar({ ...GASTO, pagadorModo: "EMPRESA" });
    assert.deepEqual(candidatos.map((c) => [c.nivel, c.id]), [["DEBIL", "misma-obra"]]);
  });

  test("Rechazados, cancelados y de otra Empresa no cuentan; el bloqueo consultivo se toma antes de buscar", async () => {
    documento("doc-1");
    gastoExistente({ id: "rechazado", estatus: "RECHAZADO" });
    gastoExistente({ id: "cancelado", estatus: "CANCELADO" });
    gastoExistente({ id: "ajeno", empresaId: "empresa-ajena" });
    assert.deepEqual(await capturar({ ...GASTO, pagadorModo: "EMPRESA" }), []);
    assert.deepEqual(candadosConsultivos, [`duplicados:${EMPRESA}:245000`]);
  });

  test("Privacidad: quien no ve categorías sensibles no recibe avisos de esos gastos", async () => {
    gastoExistente({ id: "nomina", categoria: "NOMINA" });
    gastoExistente({ id: "material" });
    const criterio = { empresaId: EMPRESA, monto: 2450, fecha: new Date(`${FECHA}T00:00:00Z`), proyectoId: "obra-1" };
    const paraSupervisor = await buscarPosiblesDuplicadosTx(db, supervisor, criterio);
    assert.deepEqual(paraSupervisor.map((c) => c.id), ["material"]);
    const paraAdmin = await buscarPosiblesDuplicadosTx(db, admin, criterio);
    assert.deepEqual(paraAdmin.map((c) => c.id).sort(), ["material", "nomina"]);
    for (const c of paraAdmin) assert.deepEqual(Object.keys(c).sort(), ["descripcion", "fecha", "id", "monto", "motivo", "nivel", "proyectoNombre", "tipo"]);
  });
});

describe("Egreso de empresa desde documento (D2)", () => {
  const EGRESO = { fecha: FECHA, concepto: "Papelería ficticia", monto: "300", clasificacionManual: "GASTO_OPERACION", facturaId: "factura-1", notasContables: "Nota" };

  test("Exige confirmar explícitamente que lo pagó la Empresa", async () => {
    documento("doc-1");
    await assert.rejects(confirmarComoEgresoManual(admin, "doc-1", EGRESO), /pagó la Empresa/);
    assert.ok(sinEscrituras());
  });

  test("Con la confirmación: egreso con factura y notas (antes se descartaban), atómico e idempotente", async () => {
    documento("doc-1");
    const r1 = await confirmarComoEgresoManual(admin, "doc-1", { ...EGRESO, pagadoPorEmpresa: "on" });
    const r2 = await confirmarComoEgresoManual(admin, "doc-1", { ...EGRESO, pagadoPorEmpresa: "on" });
    assert.deepEqual(r2, r1);
    assert.equal(estado.egresos.length, 1);
    assert.equal(estado.egresos[0].facturaId, "factura-1");
    assert.equal(estado.egresos[0].notasContables, "Nota");
    assert.equal(doc("doc-1").estatus, "CONVERTIDO");
  });

  test("Rollback si falla la marca del documento", async () => {
    documento("doc-1");
    fallarEn = "documento.update";
    await assert.rejects(confirmarComoEgresoManual(admin, "doc-1", { ...EGRESO, pagadoPorEmpresa: "on" }), /Falla simulada/);
    assert.ok(sinEscrituras());
  });

  test("Posible duplicado: egreso manual con el mismo importe y fecha", async () => {
    documento("doc-1");
    estado.egresos.push({ id: "egreso-igual", empresaId: EMPRESA, estatus: "VIGENTE", gastoObraId: null, concepto: "Papelería previa", monto: 300, fecha: new Date(`${FECHA}T00:00:00Z`), proyectoId: null });
    await assert.rejects(confirmarComoEgresoManual(admin, "doc-1", { ...EGRESO, pagadoPorEmpresa: "on" }), PosiblesDuplicadosError);
    assert.equal(estado.egresos.length, 1);
  });
});

describe("Descartar, permisos y multiempresa", () => {
  test("Descartar es idempotente y un documento ya registrado no se puede descartar", async () => {
    documento("doc-1");
    await descartarDocumentoEgreso(admin, "doc-1");
    await descartarDocumentoEgreso(admin, "doc-1");
    assert.equal(estado.auditorias.length, 1);
    documento("doc-2", { estatus: "CONVERTIDO", egresoId: "egreso-x" });
    await assert.rejects(descartarDocumentoEgreso(admin, "doc-2"), /ya fue registrado/);
  });

  test("Supervisor no confirma; un documento de otra Empresa no existe", async () => {
    documento("doc-1");
    await assert.rejects(confirmarComoGastoNuevo(supervisor, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" }));
    await assert.rejects(confirmarComoGastoNuevo(adminAjeno, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" }));
    assert.ok(sinEscrituras());
  });
});

describe("Procesamiento acotado por Empresa (Vercel)", () => {
  test("procesarTrabajos exige Empresa y filtra por Empresa y referencias", async () => {
    await assert.rejects(procesarTrabajos({ empresaId: "" }), /requiere una Empresa/);
    await procesarTrabajos({ empresaId: EMPRESA, referencias: ["doc-1"] }, 1);
    assert.ok(consultasTrabajos.length > 0);
    for (const c of consultasTrabajos) {
      const where = c.where as Fila;
      assert.equal(where.empresaId, EMPRESA);
      assert.deepEqual(where.referenciaModulo, { in: ["doc-1"] });
    }
  });

  test("El avance por consulta solo toma documentos PENDIENTES del lote y de la Empresa del usuario", async () => {
    documento("doc-1", { estatus: "PENDIENTE", loteId: "lote-1" });
    documento("doc-2", { estatus: "PROCESADO", loteId: "lote-1" });
    documento("doc-3", { estatus: "PENDIENTE", loteId: "lote-1", empresaId: "empresa-ajena" });
    await avanzarProcesamientoDeLote(admin, "lote-1");
    for (const c of consultasTrabajos) assert.deepEqual((c.where as Fila).referenciaModulo, { in: ["doc-1"] });
    consultasTrabajos = [];
    documento("doc-1", { estatus: "PROCESADO", loteId: "lote-1" });
    await avanzarProcesamientoDeLote(admin, "lote-1");
    assert.equal(consultasTrabajos.length, 0, "sin pendientes no procesa nada");
  });

  test("El worker no vuelve a procesar ni cambia el estatus de un documento ya resuelto por una persona", async () => {
    const manejador = obtenerManejador("contabilidad", "extraccion_documento_egreso")!;
    const actualizaciones: string[] = [];
    sustituir(modelo("documentoEgreso"), "update", async () => (actualizaciones.push("update"), {}));
    sustituir(modelo("documentoEgreso"), "updateMany", async () => (actualizaciones.push("updateMany"), { count: 0 }));
    for (const estatus of ["CONVERTIDO", "VINCULADO", "DESCARTADO"]) {
      documento("doc-1", { estatus, tipoMime: "application/pdf" });
      const job = { id: "job-1", empresaId: EMPRESA, referenciaModulo: "doc-1" } as never;
      assert.deepEqual(await manejador.ejecutarExtraccionDeterministica(job, Buffer.from("%PDF")), { continuarProcesamiento: false });
      await manejador.ejecutarExtraccionIA(job, Buffer.from("%PDF"));
      await manejador.reconciliarYFinalizar(job);
    }
    assert.deepEqual(actualizaciones, []);
  });
});

describe("Destino Empresa (Oficina) y cobrabilidad", () => {
  const OFICINA = { ...GASTO, destino: "EMPRESA", proyectoId: undefined, categoria: "PAPELERIA", descripcion: "Papelería ficticia" };

  test("Oficina con pagador YO: el gasto va al Proyecto de Oficina, no cobrable, con el beneficiario del remitente", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, pagadorModo: "YO" });
    const g = estado.gastos[0];
    assert.deepEqual([g.proyectoId, g.tratamientoCliente, g.pagadorBeneficiarioId, g.capturadoPorId], ["proyecto-oficina", "NO_COBRABLE", "benef-sergio", "usuario-sergio"]);
  });

  test("Oficina con pagador EMPRESA también se permite (no solo pagados por personas)", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, pagadorModo: "EMPRESA" });
    assert.equal(estado.gastos[0].pagadorBeneficiarioId, null);
  });

  test("Si la Empresa aún no tiene Proyecto de Oficina, se crea con obtenerOCrearProyectoOficina", async () => {
    oficinaExiste = false;
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, pagadorModo: "EMPRESA" });
    assert.equal(oficinasCreadas, 1);
    assert.equal(estado.gastos[0].proyectoId, "proyecto-oficina");
  });

  test("Con destino Empresa se ignora el proyectoId que mande el cliente", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, proyectoId: "obra-1", pagadorModo: "EMPRESA" });
    assert.equal(estado.gastos[0].proyectoId, "proyecto-oficina");
  });

  test("Coherencia de destino, categoría y cobrabilidad", async () => {
    documento("doc-1");
    const casos: [Fila, RegExp][] = [
      [{ ...OFICINA, categoria: "MATERIAL" }, /gastos de Empresa/],
      [{ ...GASTO, categoria: "PAPELERIA" }, /gastos de obra/],
      [{ ...OFICINA, tratamientoCliente: "COBRABLE_EN_ESTIMACION" }, /no se cobra al cliente/],
      [{ ...GASTO, proyectoId: "proyecto-oficina" }, /destino Empresa/],
      [{ ...GASTO, destino: undefined }, /obra o de la Empresa/],
      [{ ...GASTO, proyectoId: undefined }, /Selecciona la obra/],
      [{ ...GASTO, tratamientoCliente: "COBRAR_DOBLE" }, /./],
    ];
    for (const [datos, error] of casos) {
      await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...datos, pagadorModo: "EMPRESA" }), error, JSON.stringify(datos));
    }
    assert.ok(sinEscrituras());
  });

  test("Categoría sensible de Empresa (nómina): la registra quien tiene ese permiso", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, categoria: "NOMINA", pagadorModo: "EMPRESA" });
    assert.equal(estado.gastos[0].categoria, "NOMINA");
  });

  for (const tratamiento of ["COBRABLE_EN_ESTIMACION", "INCLUIDO_EN_CONTRATO", "NO_COBRABLE"]) {
    test(`Obra con tratamiento ${tratamiento}: se guarda tal cual (mismas opciones que Gastos)`, async () => {
      documento("doc-1");
      await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, tratamientoCliente: tratamiento, pagadorModo: "EMPRESA" });
      assert.equal(estado.gastos[0].tratamientoCliente, tratamiento);
    });
  }

  test("Obra sin tratamiento indicado: no cobrable (mismo valor por omisión que Gastos)", async () => {
    documento("doc-1");
    await confirmarComoGastoNuevo(admin, "doc-1", { ...GASTO, pagadorModo: "EMPRESA" });
    assert.equal(estado.gastos[0].tratamientoCliente, "NO_COBRABLE");
  });

  test("Duplicados entre caminos: gasto de Oficina frente a un egreso de empresa, y al revés", async () => {
    documento("doc-1");
    estado.egresos.push({ id: "egreso-empresa", empresaId: EMPRESA, estatus: "VIGENTE", gastoObraId: null, concepto: "Papelería previa", monto: 2450, fecha: new Date(`${FECHA}T00:00:00Z`), proyectoId: null });
    await assert.rejects(confirmarComoGastoNuevo(admin, "doc-1", { ...OFICINA, pagadorModo: "EMPRESA" }), PosiblesDuplicadosError);
    estado.egresos = [];
    estado.gastos.push({ id: "gasto-oficina", empresaId: EMPRESA, estatus: "APROBADO", categoria: "PAPELERIA", descripcion: "Papelería", monto: 300, fecha: new Date(`${FECHA}T00:00:00Z`), proyectoId: "proyecto-oficina", proveedorBeneficiarioId: null });
    documento("doc-2");
    await assert.rejects(
      confirmarComoEgresoManual(admin, "doc-2", { fecha: FECHA, concepto: "Papelería", monto: "300", clasificacionManual: "GASTO_OPERACION", pagadoPorEmpresa: "on" }),
      PosiblesDuplicadosError
    );
  });
});

describe("Gastos: un pagador ausente ya no se interpreta como Empresa", () => {
  test("El traductor del formulario no inventa un pagador", () => {
    const fd = new FormData();
    fd.set("categoria", "MATERIAL");
    assert.equal(datosGastoDesdeFormData(fd).quienPagoModo, null);
    fd.set("quienPagoModo", "YO");
    assert.equal(datosGastoDesdeFormData(fd).quienPagoModo, "YO");
  });

  test("crearGasto sin pagador se rechaza; con pagador explícito funciona igual que antes", async () => {
    const base = { fecha: FECHA, descripcion: "Cemento", categoria: "MATERIAL", monto: "100", metodoPago: "EFECTIVO" };
    await assert.rejects(crearGasto(admin, "obra-1", "semana-41", base), /Indica quién pagó/);
    await assert.rejects(crearGasto(admin, "obra-1", "semana-41", { ...base, quienPagoModo: null }), /Indica quién pagó/);
    assert.equal(estado.gastos.length, 0);
    await crearGasto(admin, "obra-1", "semana-41", { ...base, quienPagoModo: "EMPRESA" });
    assert.equal(estado.gastos[0].pagadorBeneficiarioId, null);
  });
});

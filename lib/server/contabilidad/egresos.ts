import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import type { Prisma } from "@/lib/generated/prisma/client";
import { puedeVerContabilidad, puedeRegistrarMovimientoContable, puedeCancelarRegistroContable } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { EMPRESA_PROYECTO_LABEL } from "@/lib/server/control-de-obra/proyecto-oficina";
import { CLASIFICACIONES_EGRESO_MANUAL } from "./estado-resultados";

// Egreso decora un GastoObra existente (SIN duplicar monto/fecha/concepto/
// proyecto/pagador) o representa un egreso fiscal manual (gastoObraId null).
// Se crea perezosamente: la lista de Egresos de Contabilidad se arma leyendo
// GastoObra directo (fiscalmente elegible = requiereFactura = true) y
// decorando con la fila Egreso SI existe — nunca al revés (Contabilidad,
// septiembre 2026).

function requerirContabilidad(usuario: UsuarioSesion): string {
  if (!puedeVerContabilidad(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

function rangoMes(anio: number, mes: number): { desde: Date; hasta: Date } {
  return { desde: new Date(anio, mes - 1, 1), hasta: new Date(anio, mes, 1) };
}

// Aislamiento multiempresa (Preparación de Producción — Etapa 1, septiembre
// 2026) — toda referencia opcional que llegue del cliente (proyecto, medio
// financiero, factura) debe comprobarse contra la Empresa del usuario ANTES
// de vincularla, nunca confiarse tal cual. Mismo patrón ya usado en
// vincularFacturaAGasto/vincularFacturaAIngreso (facturas.ts) — aquí se
// reutiliza para los mismos tres campos donde antes faltaba.
async function validarReferenciasEgreso(
  empresaId: string,
  datos: { proyectoId?: string | null; medioFinancieroId?: string | null; facturaId?: string | null },
  cliente: Prisma.TransactionClient = db
): Promise<void> {
  const [proyecto, medioFinanciero, factura] = await Promise.all([
    datos.proyectoId ? cliente.proyecto.findFirst({ where: { id: datos.proyectoId, empresaId }, select: { id: true } }) : null,
    datos.medioFinancieroId
      ? cliente.medioFinanciero.findFirst({ where: { id: datos.medioFinancieroId, empresaId }, select: { id: true } })
      : null,
    datos.facturaId ? cliente.factura.findFirst({ where: { id: datos.facturaId, empresaId }, select: { id: true } }) : null,
  ]);
  if (datos.proyectoId && !proyecto) throw new RegistroNoEncontradoError("El proyecto");
  if (datos.medioFinancieroId && !medioFinanciero) throw new RegistroNoEncontradoError("El medio financiero");
  if (datos.facturaId && !factura) throw new RegistroNoEncontradoError("La factura");
}

export type FilaEgreso = {
  // id del Egreso SI ya existe, o el id del GastoObra (prefijado) si todavía
  // es solo una fila proyectada — el llamador nunca debe confundir ambos con
  // el mismo espacio de ids.
  egresoId: string | null;
  gastoObraId: string | null;
  fecha: string;
  concepto: string;
  proyectoNombre: string | null;
  monto: number;
  medioFinancieroNombre: string | null;
  // Identificadores actuales — para precargar el formulario sin perder datos
  // (siempre de la propia Empresa, ver validarReferenciasEgreso).
  medioFinancieroId: string | null;
  referenciaPago: string | null;
  facturaId: string | null;
  facturaUuid: string | null;
  notasContables: string | null;
  estatus: "VIGENTE" | "CANCELADO";
  // Los tres ejes, siempre expuestos por separado — nunca se infiere uno de
  // otro (Contabilidad — reconocimiento, septiembre 2026).
  cobroPago: "PAGADO" | "POR_PAGAR";
  fechaPago: string | null;
  cfdi: "NO_REQUERIDO" | "PENDIENTE" | "VINCULADO";
  // R1 — el gasto se paga por otra vía (persona u orden de compra); null en
  // gastos pagados por la Empresa y en egresos manuales.
  pagoPorOtraVia: ViaDePagoExterna | null;
  // Registro histórico a revisar: se paga por otra vía y aun así tiene datos
  // de pago bancario. Solo se señala — nunca se corrige automáticamente.
  pagoRegistradoIndebido: boolean;
};

export async function obtenerEgresos(
  usuario: UsuarioSesion,
  anio: number,
  mes: number
): Promise<FilaEgreso[]> {
  const empresaId = requerirContabilidad(usuario);
  const { desde, hasta } = rangoMes(anio, mes);

  // Eje 1 (inclusión) — ya NO se lee requiereFactura (eje CFDI, no decide
  // inclusión contable) ni se infiere de nada: solo incluidoEnContabilidad,
  // marcado explícitamente por quien tenga puedeMarcarInclusionContable.
  const [gastosIncluidos, egresosManuales] = await Promise.all([
    db.gastoObra.findMany({
      where: {
        empresaId,
        estatus: "APROBADO",
        incluidoEnContabilidad: true,
        fecha: { gte: desde, lt: hasta },
      },
      include: {
        proyecto: { select: { nombre: true, tipo: true } },
        egreso: {
          include: {
            medioFinanciero: { select: { nombre: true } },
            factura: { select: { id: true, uuid: true } },
          },
        },
      },
      orderBy: { fecha: "desc" },
    }),
    db.egreso.findMany({
      where: { empresaId, gastoObraId: null, estatus: "VIGENTE", fecha: { gte: desde, lt: hasta } },
      include: {
        proyecto: { select: { nombre: true, tipo: true } },
        medioFinanciero: { select: { nombre: true } },
        factura: { select: { id: true, uuid: true } },
      },
      orderBy: { fecha: "desc" },
    }),
  ]);

  const cfdiDeGasto = (g: { requiereFactura: boolean; facturaRef: string | null }): FilaEgreso["cfdi"] =>
    !g.requiereFactura ? "NO_REQUERIDO" : g.facturaRef ? "VINCULADO" : "PENDIENTE";

  const filasDeGasto: FilaEgreso[] = gastosIncluidos.map((g) => {
    const pagoPorOtraVia = viaDePagoExterna(g);
    const tieneDatosDePago = Boolean(g.egreso?.fechaPago || g.egreso?.medioFinancieroId || g.egreso?.referenciaPago);
    return {
      egresoId: g.egreso?.id ?? null,
      gastoObraId: g.id,
      fecha: g.fecha.toISOString(),
      concepto: g.descripcion,
      proyectoNombre: g.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : g.proyecto.nombre,
      monto: Number(g.monto),
      medioFinancieroNombre: g.egreso?.medioFinanciero?.nombre ?? null,
      medioFinancieroId: g.egreso?.medioFinancieroId ?? null,
      referenciaPago: g.egreso?.referenciaPago ?? null,
      facturaId: g.egreso?.factura?.id ?? null,
      facturaUuid: g.egreso?.factura?.uuid ?? null,
      notasContables: g.egreso?.notasContables ?? null,
      estatus: g.egreso?.estatus ?? "VIGENTE",
      cobroPago: g.egreso?.fechaPago ? "PAGADO" : "POR_PAGAR",
      fechaPago: g.egreso?.fechaPago ? g.egreso.fechaPago.toISOString() : null,
      cfdi: cfdiDeGasto(g),
      pagoPorOtraVia,
      pagoRegistradoIndebido: pagoPorOtraVia !== null && tieneDatosDePago,
    };
  });

  const filasManuales: FilaEgreso[] = egresosManuales.map((e) => ({
    egresoId: e.id,
    gastoObraId: null,
    fecha: (e.fecha ?? e.createdAt).toISOString(),
    concepto: e.concepto ?? "Egreso manual",
    proyectoNombre: e.proyecto ? (e.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : e.proyecto.nombre) : null,
    monto: Number(e.monto ?? 0),
    medioFinancieroNombre: e.medioFinanciero?.nombre ?? null,
    medioFinancieroId: e.medioFinancieroId ?? null,
    referenciaPago: e.referenciaPago ?? null,
    facturaId: e.factura?.id ?? null,
    facturaUuid: e.factura?.uuid ?? null,
    notasContables: e.notasContables,
    estatus: e.estatus,
    cobroPago: e.fechaPago ? "PAGADO" : "POR_PAGAR",
    fechaPago: e.fechaPago ? e.fechaPago.toISOString() : null,
    cfdi: e.facturaId ? "VINCULADO" : "NO_REQUERIDO",
    pagoPorOtraVia: null,
    pagoRegistradoIndebido: false,
  }));

  return [...filasDeGasto, ...filasManuales].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

// R1 — vía de pago ajena a Contabilidad: la persona que pagó (se le repone
// desde Reposiciones / Reporte General) o la orden de compra (se liquida en
// Reporte General). null = la Empresa pagó directo; solo ese gasto puede
// tener un pago bancario propio aquí.
export type ViaDePagoExterna = "PERSONA" | "ORDEN_COMPRA";

function viaDePagoExterna(gasto: { pagadorBeneficiarioId: string | null; ordenCompraId: string | null }): ViaDePagoExterna | null {
  if (gasto.ordenCompraId) return "ORDEN_COMPRA";
  if (gasto.pagadorBeneficiarioId) return "PERSONA";
  return null;
}

const MENSAJE_PAGO_POR_OTRA_VIA: Record<ViaDePagoExterna, string> = {
  PERSONA:
    "Este gasto lo pagó una persona: su pago se registra al liquidar la reposición (Reporte General / Reposiciones), no como pago bancario aquí. Puedes agregar factura y notas.",
  ORDEN_COMPRA:
    "Este gasto proviene de una orden de compra: su pago se registra al liquidarla en Reporte General, no como pago bancario aquí. Puedes agregar factura y notas.",
};

const mismoDia = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

// ¿Trae un dato de pago nuevo o distinto del que ya tenía? Vacío (eliminar)
// y "el mismo valor" nunca cuentan como nuevos. La fecha se compara por día:
// es lo que el formulario reenvía (input type="date").
function registraPagoNuevo(
  nuevo: { fechaPago: Date | null; medioFinancieroId: string | null; referenciaPago: string | null },
  anterior: { fechaPago: Date | null; medioFinancieroId: string | null; referenciaPago: string | null } | null
): boolean {
  if (nuevo.fechaPago && !(anterior?.fechaPago && mismoDia(nuevo.fechaPago, anterior.fechaPago))) return true;
  if (nuevo.medioFinancieroId && nuevo.medioFinancieroId !== anterior?.medioFinancieroId) return true;
  if (nuevo.referenciaPago && nuevo.referenciaPago !== anterior?.referenciaPago) return true;
  return false;
}

const DatosDecoracionSchema = z.object({
  medioFinancieroId: z.string().trim().optional().nullable(),
  facturaId: z.string().trim().optional().nullable(),
  notasContables: z.string().trim().optional().nullable(),
  // Eje 4 — pago real (Contabilidad — reconocimiento, septiembre 2026):
  // aplica cuando GastoObra.pagadorBeneficiarioId es null (la Empresa pagó
  // directo) — null/ausente = todavía por pagar, nunca resta del saldo de
  // banco. Independiente de estatus (reconocimiento) y de requiereFactura
  // (CFDI).
  fechaPago: z.coerce.date().optional().nullable(),
  referenciaPago: z.string().trim().optional().nullable(),
});

const CAMPOS_DECORACION = ["medioFinancieroId", "facturaId", "notasContables", "fechaPago", "referenciaPago"] as const;
type CampoDecoracion = (typeof CAMPOS_DECORACION)[number];
type ValoresDecoracion = {
  medioFinancieroId: string | null;
  facturaId: string | null;
  notasContables: string | null;
  fechaPago: Date | null;
  referenciaPago: string | null;
};

const mismoValor = (a: string | Date | null, b: string | Date | null) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

// Crea o actualiza la decoración fiscal de un GastoObra existente — nunca
// toca monto/fecha/concepto/proyecto/pagador del gasto.
//
// Contrato de actualización PARCIAL (octubre 2026), igual para cualquier
// llamador:
// - campo omitido (propiedad ausente o undefined) → se conserva lo guardado;
// - campo explícito en null o "" → se limpia;
// - campo con valor → se actualiza.
// Al crear el Egreso, los campos omitidos quedan vacíos. Solo se escriben y
// se auditan los campos que cambian de verdad.
//
// `opciones.tx` permite ejecutar dentro de la transacción del llamador (p.
// ej. la vinculación de un documento, que debe ser atómica); sin ella, la
// función abre su propia transacción.
export async function guardarDecoracionEgreso(
  usuario: UsuarioSesion,
  gastoObraId: string,
  datosCrudos: unknown,
  opciones: { tx?: Prisma.TransactionClient } = {}
) {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();

  // "" explícito = limpiar (mismo significado que null).
  const crudo = { ...((datosCrudos ?? {}) as Record<string, unknown>) };
  for (const campo of CAMPOS_DECORACION) if (crudo[campo] === "") crudo[campo] = null;
  const datos = DatosDecoracionSchema.parse(crudo);

  const enviados: Partial<ValoresDecoracion> = {};
  for (const campo of CAMPOS_DECORACION) {
    if (datos[campo] === undefined) continue;
    (enviados as Record<CampoDecoracion, unknown>)[campo] = datos[campo] || null;
  }

  const ejecutar = async (cliente: Prisma.TransactionClient) => {
    // Serializa las decoraciones del mismo gasto (lectura → validación → escritura).
    await cliente.$queryRaw`SELECT id FROM gastos_obra WHERE id = ${gastoObraId} FOR UPDATE`;
    const gasto = await cliente.gastoObra.findFirst({ where: { id: gastoObraId, empresaId } });
    if (!gasto) throw new RegistroNoEncontradoError("El gasto");
    await validarReferenciasEgreso(empresaId, enviados, cliente);

    const anterior = await cliente.egreso.findUnique({ where: { gastoObraId } });
    const actuales: ValoresDecoracion = {
      medioFinancieroId: anterior?.medioFinancieroId ?? null,
      facturaId: anterior?.facturaId ?? null,
      notasContables: anterior?.notasContables ?? null,
      fechaPago: anterior?.fechaPago ?? null,
      referenciaPago: anterior?.referenciaPago ?? null,
    };
    const finales: ValoresDecoracion = { ...actuales, ...enviados };

    // R1 (C6, octubre 2026) — un gasto pagado por una persona (se repone) o
    // generado por una orden de compra (se liquida en Reporte General) ya
    // tiene su propio pago: nunca recibe además un pago bancario aquí. Se
    // evalúa sobre los valores FINALES: conservar lo que un registro
    // histórico ya tenía (sin alterarlo, ni siquiera la hora) o eliminarlo
    // está permitido; solo se rechaza un valor de pago nuevo o distinto.
    // Factura y notas, siempre.
    const via = viaDePagoExterna(gasto);
    if (via) {
      if (registraPagoNuevo(finales, actuales)) throw new ValidacionError(MENSAJE_PAGO_POR_OTRA_VIA[via]);
      if (finales.fechaPago && actuales.fechaPago) finales.fechaPago = actuales.fechaPago;
    }

    const cambios = CAMPOS_DECORACION.filter((campo) => !mismoValor(finales[campo], actuales[campo]));
    const elegir = (valores: ValoresDecoracion) => Object.fromEntries(cambios.map((campo) => [campo, valores[campo]]));

    let egreso;
    if (!anterior) {
      egreso = await cliente.egreso.create({ data: { empresaId, gastoObraId, registradoPorId: usuario.id, ...finales } });
    } else if (cambios.length > 0) {
      egreso = await cliente.egreso.update({ where: { gastoObraId }, data: elegir(finales) });
    } else {
      return anterior;
    }

    await registrarAuditoriaTx(cliente, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "Egreso",
      entidadId: egreso.id,
      accion: "EDITAR",
      valorAnterior: anterior ? elegir(actuales) : undefined,
      valorNuevo: { gastoObraId, ...elegir(finales) },
    });

    return egreso;
  };

  return opciones.tx ? ejecutar(opciones.tx) : db.$transaction(ejecutar);
}

const DatosEgresoManualSchema = z.object({
  fecha: z.coerce.date(),
  concepto: z.string().trim().min(1, "El concepto es obligatorio."),
  monto: z.coerce.number().positive("El monto debe ser mayor a cero."),
  proyectoId: z.string().trim().optional().nullable(),
  medioFinancieroId: z.string().trim().optional().nullable(),
  facturaId: z.string().trim().optional().nullable(),
  notasContables: z.string().trim().optional().nullable(),
  // Eje 4 — null/ausente = reconocido, todavía por pagar (Contabilidad —
  // reconocimiento, septiembre 2026). No se asume que un registro manual ya
  // significa dinero movido.
  fechaPago: z.coerce.date().optional().nullable(),
  referenciaPago: z.string().trim().optional().nullable(),
  // Clasificación exclusiva — obligatoria, nunca inferida de `concepto`.
  // Garantiza que un egreso manual participe en exactamente una línea del
  // Estado de Resultados.
  clasificacionManual: z.enum(CLASIFICACIONES_EGRESO_MANUAL, {
    error: "Selecciona a qué línea del Estado de Resultados pertenece este egreso.",
  }),
});

export async function crearEgresoManual(usuario: UsuarioSesion, datosCrudos: unknown) {
  return db.$transaction((tx) => crearEgresoManualTx(tx, usuario, datosCrudos));
}

// Núcleo de crearEgresoManual dentro de la transacción del llamador — mismas
// validaciones y mismo registro; la auditoría va en la MISMA transacción.
// Lo reutiliza la confirmación de un documento como egreso de empresa
// (Fase 0 WhatsApp + ARQENTO IA, octubre 2026), que necesita crear el egreso
// y marcar el documento de forma atómica.
export async function crearEgresoManualTx(
  tx: Prisma.TransactionClient,
  usuario: UsuarioSesion,
  datosCrudos: unknown,
  auditoriaAdicional: Record<string, unknown> = {}
) {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();
  const datos = DatosEgresoManualSchema.parse(datosCrudos);
  await validarReferenciasEgreso(empresaId, datos, tx);

  const egreso = await tx.egreso.create({
    data: {
      empresaId,
      fecha: datos.fecha,
      concepto: datos.concepto,
      monto: datos.monto,
      proyectoId: datos.proyectoId || null,
      medioFinancieroId: datos.medioFinancieroId || null,
      facturaId: datos.facturaId || null,
      notasContables: datos.notasContables || null,
      fechaPago: datos.fechaPago || null,
      referenciaPago: datos.referenciaPago || null,
      clasificacionManual: datos.clasificacionManual,
      registradoPorId: usuario.id,
    },
  });

  await registrarAuditoriaTx(tx, {
    empresaId,
    usuarioId: usuario.id,
    entidad: "Egreso",
    entidadId: egreso.id,
    accion: "CREAR",
    valorNuevo: { concepto: egreso.concepto, monto: datos.monto, ...auditoriaAdicional },
  });

  return egreso;
}

export async function editarEgresoManual(usuario: UsuarioSesion, id: string, datosCrudos: unknown) {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();
  const datos = DatosEgresoManualSchema.parse(datosCrudos);

  const anterior = await db.egreso.findFirst({ where: { id, empresaId } });
  if (!anterior) throw new RegistroNoEncontradoError("El egreso");
  if (anterior.gastoObraId) {
    throw new ValidacionError("Este egreso proviene de un gasto — sus datos operativos se editan desde Gastos.");
  }
  await validarReferenciasEgreso(empresaId, datos);

  const egreso = await db.egreso.update({
    where: { id },
    data: {
      fecha: datos.fecha,
      concepto: datos.concepto,
      monto: datos.monto,
      proyectoId: datos.proyectoId || null,
      medioFinancieroId: datos.medioFinancieroId || null,
      facturaId: datos.facturaId || null,
      notasContables: datos.notasContables || null,
      fechaPago: datos.fechaPago || null,
      referenciaPago: datos.referenciaPago || null,
      clasificacionManual: datos.clasificacionManual,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Egreso",
    entidadId: egreso.id,
    accion: "EDITAR",
    valorAnterior: { concepto: anterior.concepto, monto: Number(anterior.monto ?? 0) },
    valorNuevo: { concepto: egreso.concepto, monto: datos.monto },
  });

  return egreso;
}

export async function cancelarEgreso(usuario: UsuarioSesion, id: string) {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeCancelarRegistroContable(usuario)) throw new SinPermisoError();

  const anterior = await db.egreso.findFirst({ where: { id, empresaId } });
  if (!anterior) throw new RegistroNoEncontradoError("El egreso");

  const egreso = await db.egreso.update({ where: { id }, data: { estatus: "CANCELADO" } });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Egreso",
    entidadId: egreso.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: anterior.estatus },
    valorNuevo: { estatus: "CANCELADO" },
  });

  return egreso;
}

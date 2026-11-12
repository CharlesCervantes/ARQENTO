"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import * as z from "zod";
import { requireSession } from "@/lib/server/auth/dal";
import { descartarDocumentoRecibido, reanudarRecepcionesRecibidas, type ResultadoReanudacion } from "@/lib/server/contabilidad/documentos/recibidos-whatsapp";
import { subirArchivo } from "@/lib/server/archivos";
import {
  crearMedioFinanciero,
  editarMedioFinanciero,
  cambiarEstatusMedioFinanciero,
} from "@/lib/server/contabilidad/medios-financieros";
import {
  marcarInclusionGasto,
  marcarInclusionCapa,
  marcarInclusionMovimientoFondo,
} from "@/lib/server/contabilidad/inclusion";
import {
  crearEgresoManual,
  editarEgresoManual,
  guardarDecoracionEgreso,
  cancelarEgreso,
} from "@/lib/server/contabilidad/egresos";
import {
  crearIngresoManual,
  editarIngresoManual,
  guardarDecoracionIngreso,
  cancelarIngreso,
} from "@/lib/server/contabilidad/ingresos";
import {
  cargarFactura,
  vincularFacturaAGasto,
  vincularFacturaAIngreso,
} from "@/lib/server/contabilidad/facturas";
import { CfdiInvalidoError, CfdiNotaCreditoError } from "@/lib/server/contabilidad/cfdi";
import { decoracionEgresoDesdeFormulario } from "@/lib/contabilidad/formulario-egreso";
import { decoracionIngresoDesdeFormulario, ingresoManualDesdeFormulario } from "@/lib/contabilidad/formulario-ingreso";
import {
  subirDocumentosEgreso,
  obtenerDocumentosDelLote,
  avanzarProcesamientoDeLote,
  procesarDocumentosSubidos,
} from "@/lib/server/contabilidad/documentos/documento-egreso";
import { PosiblesDuplicadosError, type PosibleDuplicado } from "@/lib/server/contabilidad/documentos/duplicados";
import {
  confirmarComoGastoNuevo,
  confirmarVinculadoAExistente,
  confirmarComoEgresoManual,
  crearProveedorDesdeDocumento,
  descartarDocumentoEgreso,
} from "@/lib/server/contabilidad/documentos/confirmar-propuesta";
import { SinPermisoError, ValidacionError, ProyectoNoEncontradoError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";

function mensajeError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Datos inválidos.";
  if (
    error instanceof SinPermisoError ||
    error instanceof ValidacionError ||
    error instanceof ProyectoNoEncontradoError ||
    error instanceof RegistroNoEncontradoError ||
    error instanceof CfdiInvalidoError ||
    error instanceof CfdiNotaCreditoError
  ) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Ocurrió un error inesperado.";
}

function opcional(valor: FormDataEntryValue | null): string | null {
  const texto = typeof valor === "string" ? valor.trim() : "";
  return texto.length > 0 ? texto : null;
}

function revalidarContabilidad() {
  revalidatePath("/contabilidad");
  revalidatePath("/contabilidad/ingresos");
  revalidatePath("/contabilidad/egresos");
  revalidatePath("/contabilidad/facturas");
  revalidatePath("/contabilidad/cuentas");
}

export type ContabilidadFormState = { error?: string; guardado?: boolean } | undefined;

// ---------------------------------------------------------------------------
// Medios financieros
// ---------------------------------------------------------------------------

function datosMedioFinancieroDesdeFormData(formData: FormData) {
  return {
    nombre: formData.get("nombre"),
    tipo: formData.get("tipo"),
    moneda: opcional(formData.get("moneda")) ?? "MXN",
    numeroCuentaEnmascarado: opcional(formData.get("numeroCuentaEnmascarado")),
    saldoInicial: formData.get("saldoInicial") || 0,
    fechaSaldoInicial: opcional(formData.get("fechaSaldoInicial")),
  };
}

export async function crearMedioFinancieroAction(
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    await crearMedioFinanciero(usuario, datosMedioFinancieroDesdeFormData(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/contabilidad/cuentas");
  return { guardado: true };
}

export async function editarMedioFinancieroAction(
  id: string,
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    await editarMedioFinanciero(usuario, id, datosMedioFinancieroDesdeFormData(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/contabilidad/cuentas");
  return { guardado: true };
}

export async function cambiarEstatusMedioFinancieroAction(id: string, activo: boolean) {
  const usuario = await requireSession();
  await cambiarEstatusMedioFinanciero(usuario, id, activo);
  revalidatePath("/contabilidad/cuentas");
}

// ---------------------------------------------------------------------------
// Egresos
// ---------------------------------------------------------------------------


export async function guardarDecoracionEgresoAction(
  gastoObraId: string,
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    // Solo los campos que el usuario cambió (ver formulario-egreso.ts): lo no
    // modificado se omite y el servidor lo conserva.
    await guardarDecoracionEgreso(usuario, gastoObraId, decoracionEgresoDesdeFormulario(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/contabilidad/egresos");
  revalidatePath("/contabilidad");
  return { guardado: true };
}

// Campos contables de un egreso MANUAL (crear/editar) — todos explícitos;
// no usa el contrato parcial de la decoración de gastos.
function datosDecoracionEgresoDesdeFormData(formData: FormData) {
  return {
    medioFinancieroId: opcional(formData.get("medioFinancieroId")),
    facturaId: opcional(formData.get("facturaId")),
    notasContables: opcional(formData.get("notasContables")),
    // Eje 4 — null/ausente = todavía por pagar, nunca se asume pagado.
    fechaPago: opcional(formData.get("fechaPago")),
    referenciaPago: opcional(formData.get("referenciaPago")),
  };
}

function datosEgresoManualDesdeFormData(formData: FormData) {
  return {
    fecha: formData.get("fecha"),
    concepto: formData.get("concepto"),
    monto: formData.get("monto"),
    proyectoId: opcional(formData.get("proyectoId")),
    ...datosDecoracionEgresoDesdeFormData(formData),
    // Clasificación exclusiva — obligatoria en el servicio, nunca inferida
    // del concepto (invariante: una operación reconocida → una sola línea).
    clasificacionManual: formData.get("clasificacionManual"),
  };
}

export async function crearEgresoManualAction(
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    await crearEgresoManual(usuario, datosEgresoManualDesdeFormData(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function editarEgresoManualAction(
  id: string,
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    await editarEgresoManual(usuario, id, datosEgresoManualDesdeFormData(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function cancelarEgresoAction(id: string) {
  const usuario = await requireSession();
  await cancelarEgreso(usuario, id);
  revalidarContabilidad();
}

// ---------------------------------------------------------------------------
// Ingresos
// ---------------------------------------------------------------------------

function datosDecoracionIngresoDesdeFormData(formData: FormData) {
  return {
    clienteNombre: opcional(formData.get("clienteNombre")),
    metodoIngreso: opcional(formData.get("metodoIngreso")),
    cuentaReceptoraId: opcional(formData.get("cuentaReceptoraId")),
    facturaId: opcional(formData.get("facturaId")),
    facturaEsperada: formData.get("facturaEsperada") === "on",
    comentarios: opcional(formData.get("comentarios")),
  };
}

// Ingreso manual sin origen — aquí sí tiene sentido su propia referencia
// (no hay ningún MovimientoFinancieroCliente del que leerla), y también su
// propia fecha de cobro y clasificación exclusiva (eje 4 y clasificación de
// Estado de Resultados no aplican a un Ingreso que decora un movimiento ya
// real, ver ingresos.ts).
function datosIngresoManualDesdeFormData(formData: FormData) {
  return {
    ...datosDecoracionIngresoDesdeFormData(formData),
    referencia: opcional(formData.get("referencia")),
    fechaCobro: opcional(formData.get("fechaCobro")),
    clasificacionManual: formData.get("clasificacionManual"),
  };
}

export async function guardarDecoracionIngresoAction(
  movimientoFinancieroClienteId: string,
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    // undefined (no adjuntó archivo nuevo) = conservar el comprobante que ya
    // hubiera — nunca null, que borraría uno ya guardado (ver
    // guardarDecoracionIngreso, lib/server/contabilidad/ingresos.ts).
    let comprobanteRef: string | undefined;
    let comprobanteNombre: string | undefined;
    const archivo = formData.get("comprobante");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo("contabilidad/comprobantes", archivo);
      comprobanteRef = subido.ref;
      comprobanteNombre = subido.nombre;
    }
    // Contrato parcial (corrección de pérdida de datos, octubre 2026): solo
    // viaja lo que el usuario cambió — ver lib/contabilidad/formulario-ingreso.ts.
    await guardarDecoracionIngreso(usuario, movimientoFinancieroClienteId, {
      ...decoracionIngresoDesdeFormulario(formData),
      comprobanteRef,
      comprobanteNombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/contabilidad/ingresos");
  revalidatePath("/contabilidad");
  return { guardado: true };
}

export async function crearIngresoManualAction(
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    let comprobanteRef: string | null = null;
    let comprobanteNombre: string | null = null;
    const archivo = formData.get("comprobante");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo("contabilidad/comprobantes", archivo);
      comprobanteRef = subido.ref;
      comprobanteNombre = subido.nombre;
    }
    await crearIngresoManual(usuario, {
      fecha: formData.get("fecha"),
      concepto: formData.get("concepto"),
      monto: formData.get("monto"),
      proyectoId: opcional(formData.get("proyectoId")),
      ...datosIngresoManualDesdeFormData(formData),
      comprobanteRef,
      comprobanteNombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function editarIngresoManualAction(
  id: string,
  _state: ContabilidadFormState,
  formData: FormData
): Promise<ContabilidadFormState> {
  const usuario = await requireSession();
  try {
    // Contrato parcial: solo viaja lo que el usuario cambió (este formulario
    // todavía no permite reemplazar el comprobante — se conserva).
    await editarIngresoManual(usuario, id, ingresoManualDesdeFormulario(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function cancelarIngresoAction(id: string) {
  const usuario = await requireSession();
  await cancelarIngreso(usuario, id);
  revalidarContabilidad();
}

// ---------------------------------------------------------------------------
// Facturas (CFDI)
// ---------------------------------------------------------------------------

export type CargarFacturaFormState = { error?: string; facturaId?: string } | undefined;

export async function cargarFacturaAction(
  _state: CargarFacturaFormState,
  formData: FormData
): Promise<CargarFacturaFormState> {
  const usuario = await requireSession();
  if (!usuario.empresa) return { error: "Tu cuenta no tiene una empresa asignada." };

  const direccionCruda = formData.get("direccion");
  const direccion = direccionCruda === "EMITIDA" ? "EMITIDA" : "RECIBIDA";

  const xml = formData.get("xml");
  if (!(xml instanceof File) || xml.size === 0) {
    return { error: "Selecciona el archivo XML del CFDI." };
  }
  const pdf = formData.get("pdf");

  try {
    const xmlContenido = await xml.text();
    const carpeta = `contabilidad/${usuario.empresa.id}/facturas`;
    const [subidoXml, subidoPdf] = await Promise.all([
      subirArchivo(carpeta, xml),
      pdf instanceof File && pdf.size > 0 ? subirArchivo(carpeta, pdf) : Promise.resolve(null),
    ]);

    const factura = await cargarFactura(usuario, {
      direccion,
      xmlContenido,
      xmlRef: subidoXml.ref,
      xmlNombre: subidoXml.nombre,
      pdfRef: subidoPdf?.ref ?? null,
      pdfNombre: subidoPdf?.nombre ?? null,
    });

    revalidatePath("/contabilidad/facturas");
    return { facturaId: factura.id };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type VincularFacturaFormState = { error?: string; coincide?: boolean; diferenciaMonto?: number } | undefined;

export async function vincularFacturaAGastoAction(
  facturaId: string,
  gastoObraId: string
): Promise<VincularFacturaFormState> {
  const usuario = await requireSession();
  try {
    const resultado = await vincularFacturaAGasto(usuario, facturaId, gastoObraId);
    revalidarContabilidad();
    return resultado;
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export async function vincularFacturaAIngresoAction(
  facturaId: string,
  movimientoFinancieroClienteId: string
): Promise<VincularFacturaFormState> {
  const usuario = await requireSession();
  try {
    const resultado = await vincularFacturaAIngreso(usuario, facturaId, movimientoFinancieroClienteId);
    revalidarContabilidad();
    return resultado;
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Inclusión en Contabilidad (eje 1) — cambia qué línea del Estado de
// Resultados ve una operación, siempre auditado (ver
// lib/server/contabilidad/inclusion.ts).
// ---------------------------------------------------------------------------

export type InclusionFormState = { error?: string; guardado?: boolean } | undefined;

export async function marcarInclusionGastoAction(gastoObraId: string, incluido: boolean): Promise<InclusionFormState> {
  const usuario = await requireSession();
  try {
    await marcarInclusionGasto(usuario, gastoObraId, incluido);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function marcarInclusionCapaAction(capaId: string, incluido: boolean): Promise<InclusionFormState> {
  const usuario = await requireSession();
  try {
    await marcarInclusionCapa(usuario, capaId, incluido);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function marcarInclusionMovimientoFondoAction(
  movimientoId: string,
  incluido: boolean
): Promise<InclusionFormState> {
  const usuario = await requireSession();
  try {
    await marcarInclusionMovimientoFondo(usuario, movimientoId, incluido);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

// ---------------------------------------------------------------------------
// Carga inteligente de documentos (V1 — octubre 2026)
// ---------------------------------------------------------------------------

export type SubirDocumentosFormState =
  | { error?: string; loteId?: string; documentos?: { documentoEgresoId: string; duplicado: boolean; nombre: string }[] }
  | undefined;

export async function subirDocumentosEgresoAction(formData: FormData): Promise<SubirDocumentosFormState> {
  const usuario = await requireSession();
  const archivosForm = formData.getAll("documentos").filter((a): a is File => a instanceof File && a.size > 0);
  const contexto = formData.get("contexto");
  try {
    const archivos = await Promise.all(
      archivosForm.map(async (f) => ({ nombre: f.name, tipoMime: f.type, bytes: Buffer.from(await f.arrayBuffer()) }))
    );
    const resultado = await subirDocumentosEgreso(usuario, archivos, typeof contexto === "string" ? contexto : undefined);
    // Vía rápida: procesar después de responder (solo esta Empresa y estos
    // documentos). No es la única: si se corta, la consulta del lote avanza
    // el procesamiento (avanzarProcesamientoDeLote).
    const nuevos = resultado.documentos.filter((d) => !d.duplicado).map((d) => d.documentoEgresoId);
    const empresaId = usuario.empresa?.id;
    if (empresaId && nuevos.length > 0) {
      after(() => procesarDocumentosSubidos(empresaId, nuevos).catch(() => {}));
    }
    revalidarContabilidad();
    return resultado;
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export async function obtenerDocumentosDelLoteAction(loteId: string) {
  const usuario = await requireSession();
  // Avance garantizado: cada consulta procesa a lo más un trabajo pendiente
  // de este lote antes de leer. Un fallo aquí nunca impide leer el estado.
  try {
    await avanzarProcesamientoDeLote(usuario, loteId);
  } catch {
    // El estado del documento/trabajo refleja cualquier error de proceso.
  }
  return obtenerDocumentosDelLote(usuario, loteId);
}

export type ConfirmarPropuestaFormState =
  | { error?: string; guardado?: boolean; posiblesDuplicados?: PosibleDuplicado[] }
  | undefined;

// Errores de confirmación para el formulario: los posibles duplicados viajan
// con su lista para que quien confirma los revise y acepte explícitamente.
function estadoDeErrorConfirmacion(error: unknown): ConfirmarPropuestaFormState {
  if (error instanceof PosiblesDuplicadosError) return { error: error.message, posiblesDuplicados: error.candidatos };
  return { error: mensajeError(error) };
}

export async function confirmarComoGastoNuevoAction(
  documentoEgresoId: string,
  _state: ConfirmarPropuestaFormState,
  formData: FormData
): Promise<ConfirmarPropuestaFormState> {
  const usuario = await requireSession();
  try {
    await confirmarComoGastoNuevo(usuario, documentoEgresoId, Object.fromEntries(formData));
  } catch (error) {
    return estadoDeErrorConfirmacion(error);
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function confirmarVinculadoAExistenteAction(
  documentoEgresoId: string,
  _state: ConfirmarPropuestaFormState,
  formData: FormData
): Promise<ConfirmarPropuestaFormState> {
  const usuario = await requireSession();
  try {
    await confirmarVinculadoAExistente(usuario, documentoEgresoId, Object.fromEntries(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function confirmarComoEgresoManualDesdeDocumentoAction(
  documentoEgresoId: string,
  _state: ConfirmarPropuestaFormState,
  formData: FormData
): Promise<ConfirmarPropuestaFormState> {
  const usuario = await requireSession();
  try {
    await confirmarComoEgresoManual(usuario, documentoEgresoId, Object.fromEntries(formData));
  } catch (error) {
    return estadoDeErrorConfirmacion(error);
  }
  revalidarContabilidad();
  return { guardado: true };
}

export async function crearProveedorDesdeDocumentoAction(
  _state: ConfirmarPropuestaFormState,
  formData: FormData
): Promise<ConfirmarPropuestaFormState> {
  const usuario = await requireSession();
  try {
    await crearProveedorDesdeDocumento(usuario, Object.fromEntries(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  return { guardado: true };
}

// Bandeja «Recibidos por WhatsApp» (Fase 2A): descartar un comprobante
// recibido por error elimina su archivo. No depende de ARQENTO IA.
export async function descartarDocumentoRecibidoAction(
  documentoEgresoId: string
): Promise<{ error?: string; archivoEliminado?: boolean }> {
  const usuario = await requireSession();
  try {
    const resultado = await descartarDocumentoRecibido(usuario, documentoEgresoId);
    revalidarContabilidad();
    return resultado;
  } catch (error) {
    revalidarContabilidad();
    return { error: mensajeError(error) };
  }
}

// Reintento explícito de las recepciones sin terminar de la Empresa.
export async function reanudarRecepcionesRecibidasAction(): Promise<{ error?: string; resultado?: ResultadoReanudacion }> {
  const usuario = await requireSession();
  try {
    const resultado = await reanudarRecepcionesRecibidas(usuario);
    revalidarContabilidad();
    return { resultado };
  } catch (error) {
    revalidarContabilidad();
    return { error: mensajeError(error) };
  }
}

export async function descartarDocumentoEgresoAction(documentoEgresoId: string) {
  const usuario = await requireSession();
  await descartarDocumentoEgreso(usuario, documentoEgresoId);
  revalidarContabilidad();
}

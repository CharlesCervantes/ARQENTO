"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireSession } from "@/lib/server/auth/dal";
import {
  crearPartida,
  crearConcepto,
  crearContratoContratista,
  asignarConcepto,
  quitarConceptoAsignado,
  editarConceptoEstructural,
  editarConceptoPrivado,
  obtenerConceptoDetalle,
  eliminarConcepto,
  eliminarPartida,
  RegistroNoEncontradoError,
} from "@/lib/server/control-de-obra/estructura-contractual";
import {
  aprobarPropuesta,
  proponerConcepto,
  proponerPartida,
  rechazarPropuesta,
  retirarPropuesta,
} from "@/lib/server/control-de-obra/propuestas-contrato";
import { puedeProponerContrato } from "@/lib/server/permisos";
import {
  guardarAvanceSemanal,
  cambiarEstatusAprobacionAvance,
} from "@/lib/server/control-de-obra/avance";
import {
  cerrarSemana,
  reabrirSemana,
} from "@/lib/server/control-de-obra/cierre-semana";
import {
  generarRecibo,
  registrarEvidenciaRecibo,
  obtenerDetalleCorte,
  type DetalleCorte,
} from "@/lib/server/control-de-obra/recibos";
import {
  emitirEstimacion,
  configurarIvaEstimacion,
  materializarEstimacionHistorica,
} from "@/lib/server/control-de-obra/estimacion-cliente";
import { guardarEstimadoPrivado, eliminarEstimadoPrivado } from "@/lib/server/control-de-obra/estimado-privado";
import {
  registrarAportacionFondo,
  registrarPagoEstimacion,
  aplicarFondoAEstimacion,
  editarPagoEstimacion,
  editarMontoPagoEstimacion,
  editarAportacionFondo,
  editarMontoAportacionFondo,
  cancelarMovimientoFinancieroCliente,
  obtenerMovimientosCapa,
  type FilaMovimientoCapa,
} from "@/lib/server/control-de-obra/financiero-cliente";
import {
  crearGasto,
  editarGasto,
  enviarGastoARevision,
  aprobarGasto,
  rechazarGasto,
  cancelarGastoAprobado,
  registrarFacturaGasto,
} from "@/lib/server/control-de-obra/gastos";
import { registrarAbonoReposicion } from "@/lib/server/control-de-obra/reposiciones";
import {
  crearOrdenCompra,
  editarOrdenCompra,
  autorizarOrdenCompra,
  rechazarOrdenCompra,
  cancelarOrdenCompra,
  generarGastoDesdeOrdenCompra,
  marcarRecepcionOrdenCompra,
} from "@/lib/server/control-de-obra/ordenes-compra";
import {
  crearRequisicion,
  editarRequisicion,
  rechazarRequisicion,
  cancelarRequisicion,
  agregarCotizacion,
  seleccionarCotizacion,
} from "@/lib/server/control-de-obra/requisiciones";
import { subirArchivo } from "@/lib/server/archivos";
import { datosGastoDesdeFormData } from "@/lib/control-de-obra/gasto-form-data";
import {
  SinPermisoError,
  ProyectoNoEncontradoError,
  ValidacionError,
} from "@/lib/server/control-de-obra/proyectos";

export type FormState = { error?: string } | undefined;

function mensajeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Datos inválidos.";
  }
  if (
    error instanceof SinPermisoError ||
    error instanceof ProyectoNoEncontradoError ||
    error instanceof ValidacionError ||
    error instanceof RegistroNoEncontradoError
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

export async function crearPartidaAction(
  proyectoId: string,
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  const usuario = await requireSession();
  try {
    const crear = puedeProponerContrato(usuario) ? proponerPartida : crearPartida;
    await crear(usuario, proyectoId, {
      nombre: formData.get("nombre"),
      orden: formData.get("orden") || 0,
      icono: opcional(formData.get("icono")),
      color: opcional(formData.get("color")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/general`);
  return undefined;
}

export async function crearConceptoAction(
  partidaId: string,
  proyectoId: string,
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  const usuario = await requireSession();
  try {
    const datos = datosConceptoDeFormulario(formData);
    if (puedeProponerContrato(usuario)) await proponerConcepto(usuario, proyectoId, { partidaId }, datos);
    else await crearConcepto(usuario, partidaId, datos);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/general`);
  return undefined;
}

function datosConceptoDeFormulario(formData: FormData) {
  return {
    descripcion: formData.get("descripcion"),
    unidad: formData.get("unidad"),
    cantidadContratada: formData.get("cantidadContratada"),
    notas: opcional(formData.get("notas")),
    precioUnitarioContratista: opcional(formData.get("precioUnitarioContratista")),
    precioUnitarioMateriales: opcional(formData.get("precioUnitarioMateriales")),
  };
}

// Concepto dentro de una partida que todavía está por aprobar.
export async function proponerConceptoEnPropuestaAction(
  propuestaPartidaId: string,
  proyectoId: string,
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  const usuario = await requireSession();
  try {
    await proponerConcepto(usuario, proyectoId, { propuestaPartidaId }, datosConceptoDeFormulario(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/general`);
  return undefined;
}

export async function resolverPropuestaAction(
  proyectoId: string,
  propuestaId: string,
  decision: "APROBAR" | "RECHAZAR" | "RETIRAR",
  motivo?: string
): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    if (decision === "APROBAR") await aprobarPropuesta(usuario, proyectoId, propuestaId);
    else if (decision === "RECHAZAR") await rechazarPropuesta(usuario, proyectoId, propuestaId, motivo);
    else await retirarPropuesta(usuario, proyectoId, propuestaId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}`, "layout");
  return {};
}

export async function crearContratoAction(
  proyectoId: string,
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  const usuario = await requireSession();
  try {
    await crearContratoContratista(usuario, proyectoId, {
      beneficiarioId: opcional(formData.get("beneficiarioId")),
      nombreNuevoContratista: opcional(formData.get("nombreNuevoContratista")),
      numeroContrato: opcional(formData.get("numeroContrato")),
      descripcion: opcional(formData.get("descripcion")),
      fecha: opcional(formData.get("fecha")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  return undefined;
}

export type AvanceFormState = { error?: string; guardados?: number } | undefined;

const PREFIJO_CANTIDAD = "cantidad_";
const PREFIJO_MONTO = "monto_";

export async function guardarAvanceAction(
  proyectoId: string,
  semanaId: string,
  _state: AvanceFormState,
  formData: FormData
): Promise<AvanceFormState> {
  const usuario = await requireSession();

  // Monto exacto tecleado por concepto (cuando aplica) — ver
  // AvanceConcepto.montoEjecutado. Vacío/ausente = sin monto capturado, el
  // servidor deriva el importe de cantidad × P.U. como siempre.
  const montoPorConcepto = new Map(
    [...formData.entries()]
      .filter(([nombre]) => nombre.startsWith(PREFIJO_MONTO))
      .map(([nombre, valor]) => [nombre.slice(PREFIJO_MONTO.length), valor])
  );

  const filas = [...formData.entries()]
    .filter(([nombre]) => nombre.startsWith(PREFIJO_CANTIDAD))
    .map(([nombre, valor]) => {
      const conceptoId = nombre.slice(PREFIJO_CANTIDAD.length);
      const monto = montoPorConcepto.get(conceptoId);
      return {
        conceptoId,
        cantidadEjecutada: valor,
        montoEjecutado: monto && monto !== "" ? monto : undefined,
      };
    });

  let resultado;
  try {
    resultado = await guardarAvanceSemanal(usuario, proyectoId, { semanaId, filas });
  } catch (error) {
    return { error: mensajeError(error) };
  }

  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/avance`);
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  revalidatePath("/control-de-obra");
  return { guardados: resultado.guardados };
}

export async function cambiarEstatusAprobacionAvanceAction(
  proyectoId: string,
  conceptoId: string,
  semanaId: string,
  nuevoEstatus: "APROBADO" | "RECHAZADO",
  contratadoConfirmado?: number
): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await cambiarEstatusAprobacionAvance(usuario, conceptoId, semanaId, nuevoEstatus, contratadoConfirmado);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}`, "layout");
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/avance`);
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  revalidatePath("/control-de-obra");
  return {};
}

// A diferencia de FormState (undefined en éxito), este estado sí distingue
// éxito de "todavía no se ha enviado" — con undefined en los dos casos,
// useActionState nunca detectaba que la acción había terminado bien (el
// formulario de edición se quedaba abierto, dando la impresión de que hacía
// falta guardar otra vez). Ver tabla-privada-editable.tsx / tabla-administracion-editable.tsx.
export type EditarConceptoPrivadoFormState = { error?: string; guardado?: boolean } | undefined;

export async function editarConceptoPrivadoAction(
  conceptoId: string,
  proyectoId: string,
  _state: EditarConceptoPrivadoFormState,
  formData: FormData
): Promise<EditarConceptoPrivadoFormState> {
  const usuario = await requireSession();
  try {
    await editarConceptoPrivado(usuario, conceptoId, {
      descripcionPrivado: opcional(formData.get("descripcionPrivado")),
      unidadPrivado: opcional(formData.get("unidadPrivado")),
      cantidadContratadaPrivado: opcional(formData.get("cantidadContratadaPrivado")),
      precioUnitarioContratistaPrivado: opcional(formData.get("precioUnitarioContratistaPrivado")),
      precioUnitarioIndirectos: opcional(formData.get("precioUnitarioIndirectos")),
      precioUnitarioHerramienta: opcional(formData.get("precioUnitarioHerramienta")),
      porcentajeUtilidad: opcional(formData.get("porcentajeUtilidad")),
      porcentajeAdministracion: opcional(formData.get("porcentajeAdministracion")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/privado`);
  return { guardado: true };
}

// ---------------------------------------------------------------------------
// Modal "editar concepto" — dos modos reales, cada uno con su propia acción
// de guardado: "operativo" (abierto desde Contrato General, solo
// editarConceptoEstructural) y "privado" (abierto desde Contrato General
// Priv., solo editarConceptoPrivado). El modal NUNCA mezcla los dos — abrir
// desde Contrato General no debe mostrar ni poder tocar nada de Privado
// (decisión de sesión, agosto 2026). obtenerConceptoDetalleAction sí regresa
// todos los campos (los necesitan las dos vistas para mostrar contexto de
// solo lectura), pero cada modo solo envía a guardar lo que le corresponde.
// ---------------------------------------------------------------------------

function numOrNull(valor: { toString(): string } | null): number | null {
  return valor === null ? null : Number(valor);
}

export type ConceptoDetalle = {
  id: string;
  descripcion: string;
  partidaNombre: string;
  unidad: string;
  cantidadContratada: number;
  notas: string | null;
  precioUnitarioContratista: number | null;
  precioUnitarioMateriales: number | null;
  precioUnitarioIndirectos: number | null;
  precioUnitarioHerramienta: number | null;
  porcentajeUtilidad: number | null;
  porcentajeAdministracion: number | null;
  precioUnitarioContratistaPrivado: number | null;
  descripcionPrivado: string | null;
  unidadPrivado: string | null;
  cantidadContratadaPrivado: number | null;
  esquemaContractual: "PRECIO_ALZADO" | "ADMINISTRACION" | null;
};

export type BitacoraEntrada = {
  id: string;
  accion: string;
  usuarioNombre: string | null;
  createdAt: string;
  // Snapshots completos del Concepto antes/después de la acción — ya vienen
  // como JSON plano (registrarAuditoria los guarda con JSON.stringify, así
  // que un Decimal como precioUnitarioContratista llega aquí como string,
  // p. ej. "150.00"). El modal calcula el diff campo por campo a partir de
  // esto, en vez de guardar una etiqueta genérica por acción.
  valorAnterior: Record<string, unknown> | null;
  valorNuevo: Record<string, unknown> | null;
};

// Se llama directamente desde el modal cliente (no vía <form>) — por eso
// regresa { concepto, bitacoraOperativo, bitacoraPrivado } o { error }, en
// vez del patrón FormState de useActionState. Todos los campos Decimal se
// convierten a number aquí mismo — no son serializables cruzando de Server
// Action a Client Component (igual que Avance de obra). Las dos bitácoras
// vienen separadas de obtenerConceptoDetalle — el modo "operativo" del modal
// solo debe pintar bitacoraOperativo y el modo "privado" solo bitacoraPrivado.
export async function obtenerConceptoDetalleAction(
  conceptoId: string
): Promise<
  | { concepto: ConceptoDetalle; bitacoraOperativo: BitacoraEntrada[]; bitacoraPrivado: BitacoraEntrada[] }
  | { error: string }
> {
  const usuario = await requireSession();
  try {
    const { concepto, bitacoraOperativo, bitacoraPrivado } = await obtenerConceptoDetalle(
      usuario,
      conceptoId
    );
    const mapBitacora = (b: typeof bitacoraOperativo): BitacoraEntrada[] =>
      b.map((entrada) => ({
        id: entrada.id,
        accion: entrada.accion,
        usuarioNombre: entrada.usuario?.nombre ?? null,
        createdAt: entrada.createdAt.toISOString(),
        valorAnterior: (entrada.valorAnterior as Record<string, unknown> | null) ?? null,
        valorNuevo: (entrada.valorNuevo as Record<string, unknown> | null) ?? null,
      }));
    return {
      concepto: {
        id: concepto.id,
        descripcion: concepto.descripcion,
        partidaNombre: concepto.partida.nombre,
        unidad: concepto.unidad,
        cantidadContratada: Number(concepto.cantidadContratada),
        notas: concepto.notas,
        precioUnitarioContratista: numOrNull(concepto.precioUnitarioContratista),
        precioUnitarioMateriales: numOrNull(concepto.precioUnitarioMateriales),
        precioUnitarioIndirectos: numOrNull(concepto.precioUnitarioIndirectos),
        precioUnitarioHerramienta: numOrNull(concepto.precioUnitarioHerramienta),
        porcentajeUtilidad: numOrNull(concepto.porcentajeUtilidad),
        porcentajeAdministracion: numOrNull(concepto.porcentajeAdministracion),
        precioUnitarioContratistaPrivado: numOrNull(concepto.precioUnitarioContratistaPrivado),
        descripcionPrivado: concepto.descripcionPrivado,
        unidadPrivado: concepto.unidadPrivado,
        cantidadContratadaPrivado: numOrNull(concepto.cantidadContratadaPrivado),
        esquemaContractual: concepto.partida.proyecto.esquemaContractual,
      },
      bitacoraOperativo: mapBitacora(bitacoraOperativo),
      bitacoraPrivado: mapBitacora(bitacoraPrivado),
    };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type EditarConceptoEstructuralFormState = { error?: string; guardado?: boolean } | undefined;

// Modo "operativo" del modal — SOLO campos de Contrato General. Nunca toca
// ningún campo *Privado, Indirectos, Herramienta, %, ni override (eso es
// editarConceptoPrivadoAction, usado por el modo "privado").
export async function editarConceptoEstructuralAction(
  conceptoId: string,
  proyectoId: string,
  _state: EditarConceptoEstructuralFormState,
  formData: FormData
): Promise<EditarConceptoEstructuralFormState> {
  const usuario = await requireSession();
  try {
    await editarConceptoEstructural(usuario, conceptoId, {
      descripcion: formData.get("descripcion"),
      unidad: formData.get("unidad"),
      cantidadContratada: formData.get("cantidadContratada"),
      notas: opcional(formData.get("notas")),
      precioUnitarioContratista: opcional(formData.get("precioUnitarioContratista")),
      precioUnitarioMateriales: opcional(formData.get("precioUnitarioMateriales")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/general`);
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/privado`);
  return { guardado: true };
}

// ---------------------------------------------------------------------------
// Eliminar Partidas / Conceptos — Administrador/Director (septiembre 2026).
// Nunca se llama sin motivo: el permiso real se valida en eliminarConcepto/
// eliminarPartida (server-side), esto solo traduce FormData.
// ---------------------------------------------------------------------------

export type EliminarConceptoFormState =
  | { error?: string; resultado?: "ELIMINADO" | "CANCELADO" }
  | undefined;

export async function eliminarConceptoAction(
  conceptoId: string,
  proyectoId: string,
  _state: EliminarConceptoFormState,
  formData: FormData
): Promise<EliminarConceptoFormState> {
  const usuario = await requireSession();
  let resultado: "ELIMINADO" | "CANCELADO";
  try {
    ({ resultado } = await eliminarConcepto(usuario, conceptoId, formData.get("motivo")));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/general`);
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/privado`);
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/avance`);
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  return { resultado };
}

export type EliminarPartidaFormState =
  | { error?: string; resultado?: "ELIMINADO" | "CANCELADO"; conceptosAfectados?: number }
  | undefined;

export async function eliminarPartidaAction(
  partidaId: string,
  proyectoId: string,
  _state: EliminarPartidaFormState,
  formData: FormData
): Promise<EliminarPartidaFormState> {
  const usuario = await requireSession();
  let resultado: { resultado: "ELIMINADO" | "CANCELADO"; conceptosAfectados: number };
  try {
    resultado = await eliminarPartida(usuario, partidaId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/general`);
  revalidatePath(`/control-de-obra/${proyectoId}/contrato/privado`);
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/avance`);
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  return resultado;
}

export async function asignarConceptoAction(
  contratoId: string,
  proyectoId: string,
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  const usuario = await requireSession();
  try {
    await asignarConcepto(usuario, contratoId, {
      conceptoId: formData.get("conceptoId"),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  return undefined;
}

export async function quitarConceptoAsignadoAction(
  proyectoId: string,
  asignacionId: string,
  _state: FormState,
  _formData: FormData
): Promise<FormState> {
  const usuario = await requireSession();
  try {
    await quitarConceptoAsignado(usuario, proyectoId, asignacionId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Cierre semanal de Avance de Obra
// ---------------------------------------------------------------------------

export type CerrarSemanaFormState = { error?: string; cerrado?: boolean } | undefined;

export async function cerrarSemanaAction(
  proyectoId: string,
  semanaId: string,
  _state: CerrarSemanaFormState,
  _formData: FormData
): Promise<CerrarSemanaFormState> {
  const usuario = await requireSession();
  try {
    await cerrarSemana(usuario, proyectoId, semanaId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/avance`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/control-contractual`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/control-contractual`);
  revalidatePath("/reporte-general");
  return { cerrado: true };
}

export type ReabrirSemanaFormState = { error?: string; reabierta?: boolean } | undefined;

export async function reabrirSemanaAction(
  proyectoId: string,
  semanaId: string,
  _state: ReabrirSemanaFormState,
  formData: FormData
): Promise<ReabrirSemanaFormState> {
  const usuario = await requireSession();
  try {
    await reabrirSemana(usuario, proyectoId, semanaId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/avance`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/control-contractual`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/control-contractual`);
  return { reabierta: true };
}

// ---------------------------------------------------------------------------
// Recibos de pago
// ---------------------------------------------------------------------------

export type GenerarReciboFormState =
  | { error?: string; generado?: boolean; folio?: string }
  | undefined;

export async function generarReciboAction(
  corteSemanalId: string,
  proyectoId: string,
  _state: GenerarReciboFormState,
  _formData: FormData
): Promise<GenerarReciboFormState> {
  const usuario = await requireSession();
  try {
    const recibo = await generarRecibo(usuario, corteSemanalId);
    revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
    return { generado: true, folio: recibo.folio };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type SubirEvidenciaReciboFormState = { error?: string; subido?: boolean } | undefined;

// Sube el archivo directo a Vercel Blob (Next.js ya soporta File en
// FormData nativamente en Server Actions, no hace falta ningún parser de
// multipart aparte) y solo entonces persiste la URL resultante.
export async function subirEvidenciaReciboAction(
  reciboId: string,
  proyectoId: string,
  _state: SubirEvidenciaReciboFormState,
  formData: FormData
): Promise<SubirEvidenciaReciboFormState> {
  const usuario = await requireSession();

  const archivo = formData.get("archivo");
  if (!(archivo instanceof File) || archivo.size === 0) {
    return { error: "Selecciona un archivo (PDF o imagen)." };
  }

  try {
    const { ref, nombre } = await subirArchivo(`recibos/${reciboId}`, archivo);
    await registrarEvidenciaRecibo(usuario, reciboId, {
      archivoEvidenciaRef: ref,
      archivoEvidenciaNombre: nombre,
      fechaRecepcion: opcional(formData.get("fechaRecepcion")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/ejecucion/contratistas`);
  return { subido: true };
}

// Se llama directamente desde el modal cliente (no vía <form>) — mismo patrón
// que obtenerConceptoDetalleAction.
export async function obtenerDetalleCorteAction(
  corteSemanalId: string
): Promise<{ detalle: DetalleCorte } | { error: string }> {
  const usuario = await requireSession();
  try {
    const detalle = await obtenerDetalleCorte(usuario, corteSemanalId);
    return { detalle };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Estimación Cliente
// ---------------------------------------------------------------------------

export type EmitirEstimacionFormState = { error?: string; emitida?: boolean } | undefined;

export async function emitirEstimacionAction(
  proyectoId: string,
  estimacionId: string,
  _state: EmitirEstimacionFormState,
  formData: FormData
): Promise<EmitirEstimacionFormState> {
  const usuario = await requireSession();
  try {
    await emitirEstimacion(usuario, estimacionId, formData.get("aplicarFondo") === "on");
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/control-contractual`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/control-contractual`);
  return { emitida: true };
}

export type EstimadoPrivadoFormState = { error?: string; guardado?: boolean } | undefined;

// Cantidad estimada privada de una semana (noviembre 2026) — no toca avance
// físico, asignaciones, cortes ni contratistas.
export async function guardarEstimadoPrivadoAction(
  proyectoId: string,
  semanaId: string,
  _state: EstimadoPrivadoFormState,
  formData: FormData
): Promise<EstimadoPrivadoFormState> {
  const usuario = await requireSession();
  const importeTexto = String(formData.get("importeBase") ?? "").trim();
  try {
    await guardarEstimadoPrivado(usuario, proyectoId, semanaId, {
      conceptoId: String(formData.get("conceptoId") ?? ""),
      cantidad: Number(formData.get("cantidad")),
      importeBase: importeTexto === "" ? null : Number(importeTexto),
      motivo: String(formData.get("motivo") ?? ""),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
  return { guardado: true };
}

export async function eliminarEstimadoPrivadoAction(
  proyectoId: string,
  estimadoId: string
): Promise<{ error?: string } | undefined> {
  const usuario = await requireSession();
  try {
    await eliminarEstimadoPrivado(usuario, proyectoId, estimadoId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
  return undefined;
}

export type ConfigurarIvaFormState = { error?: string; guardado?: boolean } | undefined;

export async function configurarIvaEstimacionAction(
  proyectoId: string,
  estimacionId: string,
  _state: ConfigurarIvaFormState,
  formData: FormData
): Promise<ConfigurarIvaFormState> {
  const usuario = await requireSession();
  try {
    const aplicaIVA = formData.get("aplicaIVA") === "on";
    const porcentajeCrudo = opcional(formData.get("porcentajeIVA"));
    await configurarIvaEstimacion(usuario, estimacionId, {
      aplicaIVA,
      porcentajeIVA: aplicaIVA && porcentajeCrudo ? Number(porcentajeCrudo) : null,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/estimacion`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
  return { guardado: true };
}

export type MaterializarEstimacionFormState =
  | { error?: string; generada?: boolean; yaExistia?: boolean }
  | undefined;

export async function materializarEstimacionHistoricaAction(
  proyectoId: string,
  semanaId: string,
  _state: MaterializarEstimacionFormState,
  _formData: FormData
): Promise<MaterializarEstimacionFormState> {
  const usuario = await requireSession();
  try {
    const resultado = await materializarEstimacionHistorica(usuario, proyectoId, semanaId);
    revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/estimacion`);
    revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/control-contractual`);
    revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/estimacion`);
    revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/control-contractual`);
    return { generada: true, yaExistia: resultado.yaExistia };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Control Contractual — esquema financiero del cliente
// ---------------------------------------------------------------------------

function revalidarClienteControlContractual(proyectoId: string) {
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/general/control-contractual`);
  revalidatePath(`/control-de-obra/${proyectoId}/cliente/privado/control-contractual`);
}

// Decoración fiscal opcional, capturada en el MISMO paso que el cobro real
// (Cobros de cliente, septiembre 2026) — nunca bloquea el registro si no se
// tiene todavía (cuenta receptora/comprobante/factura esperada se pueden
// completar después desde Contabilidad). `comprobanteRef`/`comprobanteNombre`
// en `undefined` cuando no se adjuntó un archivo nuevo — nunca `null`, que en
// una edición borraría un comprobante ya guardado (mismo cuidado que
// guardarDecoracionIngresoAction, Contabilidad); al registrar por primera
// vez, `undefined` equivale a "sin comprobante todavía", el mismo resultado.
async function datosFiscalesDesdeFormData(formData: FormData) {
  let comprobanteRef: string | undefined;
  let comprobanteNombre: string | undefined;
  const archivo = formData.get("comprobante");
  if (archivo instanceof File && archivo.size > 0) {
    const subido = await subirArchivo("contabilidad/comprobantes", archivo);
    comprobanteRef = subido.ref;
    comprobanteNombre = subido.nombre;
  }
  return {
    cuentaReceptoraId: opcional(formData.get("cuentaReceptoraId")),
    comprobanteRef,
    comprobanteNombre,
    facturaEsperada: formData.get("facturaEsperada") === "on",
  };
}

export type RegistrarAportacionFormState = { error?: string; registrada?: boolean } | undefined;

export async function registrarAportacionFondoAction(
  proyectoId: string,
  _state: RegistrarAportacionFormState,
  formData: FormData
): Promise<RegistrarAportacionFormState> {
  const usuario = await requireSession();
  try {
    await registrarAportacionFondo(usuario, proyectoId, {
      monto: formData.get("monto"),
      fecha: formData.get("fecha"),
      referencia: opcional(formData.get("referencia")),
      notas: opcional(formData.get("notas")),
      ...(await datosFiscalesDesdeFormData(formData)),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { registrada: true };
}

export type RegistrarPagoFormState = { error?: string; registrado?: boolean } | undefined;

export async function registrarPagoEstimacionAction(
  proyectoId: string,
  estimacionId: string,
  _state: RegistrarPagoFormState,
  formData: FormData
): Promise<RegistrarPagoFormState> {
  const usuario = await requireSession();
  try {
    await registrarPagoEstimacion(usuario, estimacionId, {
      monto: formData.get("monto"),
      fecha: formData.get("fecha"),
      referencia: opcional(formData.get("referencia")),
      notas: opcional(formData.get("notas")),
      ...(await datosFiscalesDesdeFormData(formData)),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { registrado: true };
}

export type AplicarFondoFormState = { error?: string; aplicado?: number } | undefined;

// Acción manual "Aplicar fondo" — decisión explícita de Administrador/
// Director, nunca automática (ver aplicarFondoAEstimacion). `monto` vacío =
// aplicar el máximo posible. Nunca captura datos fiscales — no es dinero
// nuevo entrando (ver crearDecoracionIngresoSiAplica, financiero-cliente.ts).
export async function aplicarFondoEstimacionAction(
  proyectoId: string,
  estimacionId: string,
  _state: AplicarFondoFormState,
  formData: FormData
): Promise<AplicarFondoFormState> {
  const usuario = await requireSession();
  let resultado;
  try {
    resultado = await aplicarFondoAEstimacion(
      usuario,
      estimacionId,
      opcional(formData.get("monto")) ?? undefined
    );
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { aplicado: resultado.aplicado };
}

// ---------------------------------------------------------------------------
// Editar / cancelar pagos, aportaciones y aplicaciones de fondo — nunca
// DELETE (Cobros de cliente, septiembre 2026).
// ---------------------------------------------------------------------------

export type EditarMovimientoFormState = { error?: string; guardado?: boolean } | undefined;

export async function editarPagoEstimacionAction(
  proyectoId: string,
  movimientoId: string,
  _state: EditarMovimientoFormState,
  formData: FormData
): Promise<EditarMovimientoFormState> {
  const usuario = await requireSession();
  try {
    await editarPagoEstimacion(usuario, movimientoId, {
      fecha: formData.get("fecha") || undefined,
      referencia: opcional(formData.get("referencia")),
      notas: opcional(formData.get("notas")),
      ...(await datosFiscalesDesdeFormData(formData)),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { guardado: true };
}

export async function editarMontoPagoEstimacionAction(
  proyectoId: string,
  movimientoId: string,
  _state: EditarMovimientoFormState,
  formData: FormData
): Promise<EditarMovimientoFormState> {
  const usuario = await requireSession();
  try {
    await editarMontoPagoEstimacion(usuario, movimientoId, formData.get("monto"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { guardado: true };
}

export async function editarAportacionFondoAction(
  proyectoId: string,
  movimientoId: string,
  _state: EditarMovimientoFormState,
  formData: FormData
): Promise<EditarMovimientoFormState> {
  const usuario = await requireSession();
  try {
    await editarAportacionFondo(usuario, movimientoId, {
      fecha: formData.get("fecha") || undefined,
      referencia: opcional(formData.get("referencia")),
      notas: opcional(formData.get("notas")),
      ...(await datosFiscalesDesdeFormData(formData)),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { guardado: true };
}

export async function editarMontoAportacionFondoAction(
  proyectoId: string,
  movimientoId: string,
  _state: EditarMovimientoFormState,
  formData: FormData
): Promise<EditarMovimientoFormState> {
  const usuario = await requireSession();
  try {
    await editarMontoAportacionFondo(usuario, movimientoId, formData.get("monto"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { guardado: true };
}

export async function obtenerMovimientosCapaAction(
  estimacionClienteCapaId: string
): Promise<{ filas: FilaMovimientoCapa[] } | { error: string }> {
  const usuario = await requireSession();
  try {
    const filas = await obtenerMovimientosCapa(usuario, estimacionClienteCapaId);
    return { filas };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export type CancelarMovimientoFormState = { error?: string; cancelado?: boolean } | undefined;

export async function cancelarMovimientoFinancieroClienteAction(
  proyectoId: string,
  movimientoId: string,
  _state: CancelarMovimientoFormState,
  formData: FormData
): Promise<CancelarMovimientoFormState> {
  const usuario = await requireSession();
  try {
    await cancelarMovimientoFinancieroCliente(usuario, movimientoId, { motivo: formData.get("motivo") });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidarClienteControlContractual(proyectoId);
  return { cancelado: true };
}

// ---------------------------------------------------------------------------
// Gastos de Obra — Gastos
// ---------------------------------------------------------------------------

function rutaReposiciones(proyectoId: string): string {
  return `/control-de-obra/${proyectoId}/ejecucion/gastos/reposiciones`;
}
function rutaOrdenesCompra(proyectoId: string): string {
  return `/control-de-obra/${proyectoId}/ejecucion/gastos/ordenes-compra`;
}
function rutaRequisiciones(proyectoId: string): string {
  return `/control-de-obra/${proyectoId}/ejecucion/gastos/requisiciones`;
}


export type GastoFormState = { error?: string; guardado?: boolean } | undefined;

export async function crearGastoAction(
  proyectoId: string,
  semanaId: string,
  _state: GastoFormState,
  formData: FormData
): Promise<GastoFormState> {
  const usuario = await requireSession();
  try {
    let ticketRef: string | null = null;
    let ticketNombre: string | null = null;
    const archivo = formData.get("ticket");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`gastos/${proyectoId}`, archivo);
      ticketRef = subido.ref;
      ticketNombre = subido.nombre;
    }
    await crearGasto(usuario, proyectoId, semanaId, {
      ...datosGastoDesdeFormData(formData),
      ticketRef,
      ticketNombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaReposiciones(proyectoId));
  return { guardado: true };
}

export async function editarGastoAction(
  proyectoId: string,
  gastoId: string,
  _state: GastoFormState,
  formData: FormData
): Promise<GastoFormState> {
  const usuario = await requireSession();
  try {
    let ticketRef: string | null = null;
    let ticketNombre: string | null = null;
    const archivo = formData.get("ticket");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`gastos/${proyectoId}`, archivo);
      ticketRef = subido.ref;
      ticketNombre = subido.nombre;
    }
    await editarGasto(usuario, gastoId, {
      ...datosGastoDesdeFormData(formData),
      ticketRef,
      ticketNombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaReposiciones(proyectoId));
  return { guardado: true };
}

export async function enviarGastoARevisionAction(proyectoId: string, gastoId: string) {
  const usuario = await requireSession();
  await enviarGastoARevision(usuario, gastoId);
  revalidatePath(rutaReposiciones(proyectoId));
}

export type AprobarGastoFormState = { error?: string; aprobado?: boolean } | undefined;

export async function aprobarGastoAction(
  proyectoId: string,
  gastoId: string,
  _state: AprobarGastoFormState,
  _formData: FormData
): Promise<AprobarGastoFormState> {
  const usuario = await requireSession();
  try {
    await aprobarGasto(usuario, gastoId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  // Aprobar ya puede crear/reconciliar el MovimientoSemanal de la
  // reposición en la misma transacción — Reporte General también necesita
  // revalidarse, no solo la pantalla de Gastos (colapso de doble aprobación
  // Gastos→Reposiciones, agosto 2026).
  revalidatePath(rutaReposiciones(proyectoId));
  revalidatePath("/reporte-general");
  return { aprobado: true };
}

export type RechazarGastoFormState = { error?: string; rechazado?: boolean } | undefined;

export async function rechazarGastoAction(
  proyectoId: string,
  gastoId: string,
  _state: RechazarGastoFormState,
  formData: FormData
): Promise<RechazarGastoFormState> {
  const usuario = await requireSession();
  try {
    await rechazarGasto(usuario, gastoId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaReposiciones(proyectoId));
  return { rechazado: true };
}

export type CancelarGastoFormState = { error?: string; cancelado?: boolean } | undefined;

// Cancelar un gasto ya aprobado — puede sacar el gasto de su reposición y
// recalcular (o cancelar) su movimiento: Reporte General también se revalida.
export async function cancelarGastoAction(
  proyectoId: string,
  gastoId: string,
  _state: CancelarGastoFormState,
  formData: FormData
): Promise<CancelarGastoFormState> {
  const usuario = await requireSession();
  try {
    await cancelarGastoAprobado(usuario, gastoId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaReposiciones(proyectoId));
  revalidatePath("/reporte-general");
  revalidatePath("/gastos");
  return { cancelado: true };
}

export async function subirFacturaGastoAction(
  proyectoId: string,
  gastoId: string,
  _state: GastoFormState,
  formData: FormData
): Promise<GastoFormState> {
  const usuario = await requireSession();
  const archivo = formData.get("factura");
  if (!(archivo instanceof File) || archivo.size === 0) {
    return { error: "Selecciona un archivo (PDF o imagen)." };
  }
  try {
    const subido = await subirArchivo(`gastos/${proyectoId}/facturas`, archivo);
    await registrarFacturaGasto(usuario, gastoId, {
      facturaRef: subido.ref,
      facturaNombre: subido.nombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaReposiciones(proyectoId));
  return { guardado: true };
}

export type AbonoReposicionFormState = { error?: string; guardado?: boolean } | undefined;

export async function registrarAbonoReposicionAction(
  proyectoId: string,
  reposicionGastosId: string,
  _state: AbonoReposicionFormState,
  formData: FormData
): Promise<AbonoReposicionFormState> {
  const usuario = await requireSession();
  try {
    await registrarAbonoReposicion(usuario, reposicionGastosId, {
      monto: formData.get("monto"),
      fecha: formData.get("fecha"),
      metodoPago: formData.get("metodoPago"),
      referencia: opcional(formData.get("referencia")),
      notas: opcional(formData.get("notas")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaReposiciones(proyectoId));
  revalidatePath("/reporte-general");
  return { guardado: true };
}

// ---------------------------------------------------------------------------
// Gastos de Obra — Órdenes de Compra
// ---------------------------------------------------------------------------

function detalleOCDesdeFormData(formData: FormData): {
  concepto: string;
  descripcion: string | null;
  unidad: string;
  cantidad: string;
  precioUnitario: string;
}[] {
  const raw = formData.get("detalle");
  if (typeof raw !== "string" || raw.length === 0) return [];
  return JSON.parse(raw);
}

function datosOCDesdeFormData(formData: FormData) {
  return {
    proveedorBeneficiarioId: formData.get("proveedorBeneficiarioId"),
    fecha: formData.get("fecha"),
    metodoPago: opcional(formData.get("metodoPago")),
    requiereFactura: formData.get("requiereFactura") === "on",
    notas: opcional(formData.get("notas")),
    tratamientoCliente: formData.get("tratamientoCliente") || "NO_COBRABLE",
    detalle: detalleOCDesdeFormData(formData),
  };
}

export type OrdenCompraFormState = { error?: string; guardada?: boolean } | undefined;

export async function crearOrdenCompraAction(
  proyectoId: string,
  semanaId: string,
  _state: OrdenCompraFormState,
  formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    await crearOrdenCompra(usuario, proyectoId, semanaId, datosOCDesdeFormData(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaOrdenesCompra(proyectoId));
  return { guardada: true };
}

export async function editarOrdenCompraAction(
  proyectoId: string,
  ocId: string,
  _state: OrdenCompraFormState,
  formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    await editarOrdenCompra(usuario, ocId, datosOCDesdeFormData(formData));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaOrdenesCompra(proyectoId));
  return { guardada: true };
}

export async function autorizarOrdenCompraAction(
  proyectoId: string,
  ocId: string,
  _state: OrdenCompraFormState,
  _formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    await autorizarOrdenCompra(usuario, ocId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaOrdenesCompra(proyectoId));
  revalidatePath("/reporte-general");
  return { guardada: true };
}

export async function rechazarOrdenCompraAction(
  proyectoId: string,
  ocId: string,
  _state: OrdenCompraFormState,
  formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    await rechazarOrdenCompra(usuario, ocId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaOrdenesCompra(proyectoId));
  return { guardada: true };
}

export async function cancelarOrdenCompraAction(proyectoId: string, ocId: string) {
  const usuario = await requireSession();
  await cancelarOrdenCompra(usuario, ocId);
  revalidatePath(rutaOrdenesCompra(proyectoId));
}

export async function generarGastoDesdeOrdenCompraAction(
  proyectoId: string,
  ocId: string,
  _state: OrdenCompraFormState,
  formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    let comprobantePagoRef: string | null = null;
    let comprobantePagoNombre: string | null = null;
    const archivo = formData.get("comprobantePago");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`ordenes-compra/${proyectoId}`, archivo);
      comprobantePagoRef = subido.ref;
      comprobantePagoNombre = subido.nombre;
    }
    await generarGastoDesdeOrdenCompra(usuario, ocId, {
      fecha: formData.get("fecha"),
      categoria: formData.get("categoria") || "MATERIAL",
      metodoPago: formData.get("metodoPago"),
      comentario: opcional(formData.get("comentario")),
      comprobantePagoRef,
      comprobantePagoNombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaOrdenesCompra(proyectoId));
  revalidatePath(rutaReposiciones(proyectoId));
  return { guardada: true };
}

export async function marcarRecepcionOrdenCompraAction(
  proyectoId: string,
  ocId: string,
  _state: OrdenCompraFormState,
  formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    let evidenciaRecepcionRef: string | null = null;
    let evidenciaRecepcionNombre: string | null = null;
    const archivo = formData.get("evidenciaRecepcion");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`ordenes-compra/${proyectoId}/recepcion`, archivo);
      evidenciaRecepcionRef = subido.ref;
      evidenciaRecepcionNombre = subido.nombre;
    }
    await marcarRecepcionOrdenCompra(usuario, ocId, {
      estatusRecepcion: formData.get("estatusRecepcion"),
      evidenciaRecepcionRef,
      evidenciaRecepcionNombre,
      comentarioRecepcion: opcional(formData.get("comentarioRecepcion")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaOrdenesCompra(proyectoId));
  return { guardada: true };
}

// ---------------------------------------------------------------------------
// Compras — Requisiciones y Cotizaciones
// ---------------------------------------------------------------------------

function datosRequisicionDesdeFormData(formData: FormData, evidenciaRef: string | null, evidenciaNombre: string | null) {
  return {
    concepto: formData.get("concepto"),
    descripcion: opcional(formData.get("descripcion")),
    cantidad: formData.get("cantidad"),
    unidad: formData.get("unidad"),
    prioridad: formData.get("prioridad") || "NORMAL",
    fechaRequerida: opcional(formData.get("fechaRequerida")),
    comentarios: opcional(formData.get("comentarios")),
    conceptoContractualId: opcional(formData.get("conceptoContractualId")),
    evidenciaRef,
    evidenciaNombre,
  };
}

export type RequisicionFormState = { error?: string; guardada?: boolean } | undefined;

export async function crearRequisicionAction(
  proyectoId: string,
  _state: RequisicionFormState,
  formData: FormData
): Promise<RequisicionFormState> {
  const usuario = await requireSession();
  try {
    let evidenciaRef: string | null = null;
    let evidenciaNombre: string | null = null;
    const archivo = formData.get("evidencia");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`requisiciones/${proyectoId}`, archivo);
      evidenciaRef = subido.ref;
      evidenciaNombre = subido.nombre;
    }
    await crearRequisicion(usuario, proyectoId, datosRequisicionDesdeFormData(formData, evidenciaRef, evidenciaNombre));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaRequisiciones(proyectoId));
  return { guardada: true };
}

export async function editarRequisicionAction(
  proyectoId: string,
  requisicionId: string,
  _state: RequisicionFormState,
  formData: FormData
): Promise<RequisicionFormState> {
  const usuario = await requireSession();
  try {
    let evidenciaRef: string | null = null;
    let evidenciaNombre: string | null = null;
    const archivo = formData.get("evidencia");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`requisiciones/${proyectoId}`, archivo);
      evidenciaRef = subido.ref;
      evidenciaNombre = subido.nombre;
    }
    await editarRequisicion(usuario, requisicionId, datosRequisicionDesdeFormData(formData, evidenciaRef, evidenciaNombre));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaRequisiciones(proyectoId));
  return { guardada: true };
}

export async function rechazarRequisicionAction(
  proyectoId: string,
  requisicionId: string,
  _state: RequisicionFormState,
  formData: FormData
): Promise<RequisicionFormState> {
  const usuario = await requireSession();
  try {
    await rechazarRequisicion(usuario, requisicionId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaRequisiciones(proyectoId));
  return { guardada: true };
}

export async function cancelarRequisicionAction(
  proyectoId: string,
  requisicionId: string,
  _state: RequisicionFormState,
  formData: FormData
): Promise<RequisicionFormState> {
  const usuario = await requireSession();
  try {
    await cancelarRequisicion(usuario, requisicionId, formData.get("motivo"));
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaRequisiciones(proyectoId));
  return { guardada: true };
}

export async function agregarCotizacionAction(
  proyectoId: string,
  requisicionId: string,
  _state: RequisicionFormState,
  formData: FormData
): Promise<RequisicionFormState> {
  const usuario = await requireSession();
  try {
    let archivoRef: string | null = null;
    let archivoNombre: string | null = null;
    const archivo = formData.get("archivo");
    if (archivo instanceof File && archivo.size > 0) {
      const subido = await subirArchivo(`requisiciones/${proyectoId}/cotizaciones`, archivo);
      archivoRef = subido.ref;
      archivoNombre = subido.nombre;
    }
    await agregarCotizacion(usuario, requisicionId, {
      proveedorBeneficiarioId: formData.get("proveedorBeneficiarioId"),
      importe: formData.get("importe"),
      vigenciaHasta: opcional(formData.get("vigenciaHasta")),
      tiempoEntregaDias: opcional(formData.get("tiempoEntregaDias")),
      observaciones: opcional(formData.get("observaciones")),
      archivoRef,
      archivoNombre,
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaRequisiciones(proyectoId));
  return { guardada: true };
}

export async function seleccionarCotizacionAction(proyectoId: string, cotizacionId: string) {
  const usuario = await requireSession();
  await seleccionarCotizacion(usuario, cotizacionId);
  revalidatePath(rutaRequisiciones(proyectoId));
}

// Genera la Orden de Compra desde una Requisición con cotización
// seleccionada — proveedor y referencia de cotización se resuelven SIEMPRE
// en el servidor a partir de esa cotización (nunca del formulario), ver
// crearOrdenCompra. El formulario solo captura el detalle formal.
export async function generarOrdenCompraDesdeRequisicionAction(
  proyectoId: string,
  semanaId: string,
  requisicionId: string,
  _state: OrdenCompraFormState,
  formData: FormData
): Promise<OrdenCompraFormState> {
  const usuario = await requireSession();
  try {
    await crearOrdenCompra(usuario, proyectoId, semanaId, datosOCDesdeFormData(formData), requisicionId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(rutaRequisiciones(proyectoId));
  revalidatePath(rutaOrdenesCompra(proyectoId));
  return { guardada: true };
}

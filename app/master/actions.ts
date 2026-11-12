"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireSession } from "@/lib/server/auth/dal";
import { cambiarWhatsappEmpresa, reprocesarMensajesPendientesMaster, revocarVinculoWhatsappMaster } from "@/lib/server/master/whatsapp";
import { subirArchivo } from "@/lib/server/archivos";
import {
  crearEmpresa,
  editarEmpresaGeneral,
  cambiarEstatusEmpresa,
  cambiarPrivadoEmpresa,
  actualizarModuloEmpresa,
  actualizarLogoEmpresa,
  actualizarConfiguracionRecibosEmpresa,
  crearUsuarioEmpresa,
  cambiarEstatusUsuarioEmpresa,
  regenerarPasswordUsuarioEmpresa,
  SinPermisoMasterError,
  EmpresaNoEncontradaError,
  UsuarioNoEncontradoError,
  ValidacionMasterError,
} from "@/lib/server/master/empresas";
import {
  cambiarEstatusInteligenciaEmpresa,
  actualizarCapacidadInteligenciaEmpresa,
  actualizarLimiteInteligenciaEmpresa,
} from "@/lib/server/master/inteligencia";
import type { CapacidadInteligencia } from "@/lib/generated/prisma/client";

export type MasterFormState =
  | { error?: string; guardado?: boolean; passwordTemporal?: string; usuarioNombre?: string }
  | undefined;

function mensajeError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Datos inválidos.";
  if (
    error instanceof SinPermisoMasterError ||
    error instanceof EmpresaNoEncontradaError ||
    error instanceof UsuarioNoEncontradoError ||
    error instanceof ValidacionMasterError
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

const TIPOS_LOGO_PERMITIDOS = ["image/png", "image/jpeg", "image/webp"];
const TAMANO_LOGO_MAXIMO = 2 * 1024 * 1024; // 2MB

export async function crearEmpresaAction(
  _state: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const usuario = await requireSession();

  let resultado;
  try {
    resultado = await crearEmpresa(usuario, {
      nombre: formData.get("nombre"),
      razonSocial: opcional(formData.get("razonSocial")),
      rfc: opcional(formData.get("rfc")),
      planId: formData.get("planId"),
      usuarioInicial: {
        nombre: formData.get("usuarioNombre"),
        email: formData.get("usuarioEmail"),
        rol: formData.get("usuarioRol"),
      },
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }

  revalidatePath("/master/empresas");
  return {
    guardado: true,
    passwordTemporal: resultado.passwordTemporal,
    usuarioNombre: String(formData.get("usuarioNombre") ?? ""),
  };
}

export async function editarEmpresaGeneralAction(
  empresaId: string,
  _state: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const usuario = await requireSession();
  try {
    await editarEmpresaGeneral(usuario, empresaId, {
      nombre: formData.get("nombre"),
      razonSocial: opcional(formData.get("razonSocial")),
      rfc: opcional(formData.get("rfc")),
      planId: formData.get("planId"),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/master/empresas/${empresaId}`);
  revalidatePath("/master/empresas");
  return { guardado: true };
}

export async function cambiarEstatusEmpresaAction(empresaId: string, activa: boolean) {
  const usuario = await requireSession();
  await cambiarEstatusEmpresa(usuario, empresaId, activa);
  revalidatePath(`/master/empresas/${empresaId}`);
  revalidatePath("/master/empresas");
}

export async function cambiarPrivadoEmpresaAction(empresaId: string, privadoHabilitado: boolean) {
  const usuario = await requireSession();
  await cambiarPrivadoEmpresa(usuario, empresaId, privadoHabilitado);
  revalidatePath(`/master/empresas/${empresaId}`);
}

export async function actualizarModuloEmpresaAction(
  empresaId: string,
  moduloId: string,
  estado: "heredado" | "habilitado" | "deshabilitado"
) {
  const usuario = await requireSession();
  await actualizarModuloEmpresa(usuario, empresaId, moduloId, estado);
  revalidatePath(`/master/empresas/${empresaId}`);
  revalidatePath("/master/empresas");
}

export async function subirLogoEmpresaAction(
  empresaId: string,
  _state: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const usuario = await requireSession();
  const archivo = formData.get("logo");
  if (!(archivo instanceof File) || archivo.size === 0) {
    return { error: "Selecciona un archivo de imagen." };
  }
  if (!TIPOS_LOGO_PERMITIDOS.includes(archivo.type)) {
    return { error: "Formato no permitido — usa PNG, JPG o WEBP." };
  }
  if (archivo.size > TAMANO_LOGO_MAXIMO) {
    return { error: "El archivo pesa más de 2MB." };
  }

  try {
    const subido = await subirArchivo(`empresas/${empresaId}`, archivo);
    await actualizarLogoEmpresa(usuario, empresaId, subido.ref);
  } catch (error) {
    return { error: mensajeError(error) };
  }

  revalidatePath(`/master/empresas/${empresaId}`);
  revalidatePath("/master/empresas");
  return { guardado: true };
}

export async function quitarLogoEmpresaAction(empresaId: string) {
  const usuario = await requireSession();
  await actualizarLogoEmpresa(usuario, empresaId, null);
  revalidatePath(`/master/empresas/${empresaId}`);
  revalidatePath("/master/empresas");
}

export async function actualizarConfiguracionRecibosAction(
  empresaId: string,
  _state: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const usuario = await requireSession();
  try {
    await actualizarConfiguracionRecibosEmpresa(usuario, empresaId, {
      reciboMostrarLeyenda: formData.get("reciboMostrarLeyenda") === "on",
      reciboTituloLeyenda: formData.get("reciboTituloLeyenda"),
      reciboLeyenda: opcional(formData.get("reciboLeyenda")),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/master/empresas/${empresaId}`);
  return { guardado: true };
}

export async function crearUsuarioEmpresaAction(
  empresaId: string,
  _state: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const usuario = await requireSession();
  let resultado;
  try {
    resultado = await crearUsuarioEmpresa(usuario, empresaId, {
      nombre: formData.get("nombre"),
      email: formData.get("email"),
      rol: formData.get("rol"),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/master/empresas/${empresaId}`);
  return {
    guardado: true,
    passwordTemporal: resultado.passwordTemporal,
    usuarioNombre: String(formData.get("nombre") ?? ""),
  };
}

export async function cambiarEstatusUsuarioEmpresaAction(
  empresaId: string,
  usuarioObjetivoId: string,
  activo: boolean
) {
  const usuario = await requireSession();
  await cambiarEstatusUsuarioEmpresa(usuario, empresaId, usuarioObjetivoId, activo);
  revalidatePath(`/master/empresas/${empresaId}`);
}

// ---------------------------------------------------------------------------
// ARQENTO IA (Master → Empresa → ARQENTO IA, V1.3 — octubre 2026)
// ---------------------------------------------------------------------------

export async function cambiarEstatusInteligenciaEmpresaAction(empresaId: string, habilitado: boolean) {
  const usuario = await requireSession();
  await cambiarEstatusInteligenciaEmpresa(usuario, empresaId, habilitado);
  revalidatePath(`/master/empresas/${empresaId}`);
}

export async function actualizarCapacidadInteligenciaEmpresaAction(
  empresaId: string,
  capacidad: CapacidadInteligencia,
  habilitado: boolean
) {
  const usuario = await requireSession();
  await actualizarCapacidadInteligenciaEmpresa(usuario, empresaId, capacidad, habilitado);
  revalidatePath(`/master/empresas/${empresaId}`);
}

export async function actualizarLimiteInteligenciaEmpresaAction(
  empresaId: string,
  _state: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const usuario = await requireSession();
  try {
    await actualizarLimiteInteligenciaEmpresa(usuario, empresaId, {
      limiteOperacionesMensual: formData.get("limiteOperacionesMensual"),
      porcentajeAlerta: formData.get("porcentajeAlerta"),
      comportamientoLimite: formData.get("comportamientoLimite"),
    });
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath(`/master/empresas/${empresaId}`);
  return { guardado: true };
}

export type RegenerarPasswordState = { error?: string; passwordTemporal?: string } | undefined;

export async function regenerarPasswordUsuarioEmpresaAction(
  empresaId: string,
  usuarioObjetivoId: string
): Promise<RegenerarPasswordState> {
  const usuario = await requireSession();
  try {
    const passwordTemporal = await regenerarPasswordUsuarioEmpresa(usuario, empresaId, usuarioObjetivoId);
    revalidatePath(`/master/empresas/${empresaId}`);
    return { passwordTemporal };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp (Fase 1 WhatsApp + ARQENTO IA) — solo Master; los servicios
// validan el permiso y el alcance.
// ---------------------------------------------------------------------------

export async function cambiarWhatsappEmpresaAction(empresaId: string, habilitado: boolean): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await cambiarWhatsappEmpresa(usuario, empresaId, habilitado);
  } catch {
    return { error: "No se pudo cambiar la configuración de WhatsApp." };
  }
  revalidatePath(`/master/empresas/${empresaId}`);
  return {};
}

export async function reprocesarMensajesWhatsappAction(
  empresaId: string
): Promise<{ error?: string; resumen?: { revisados: number; procesados: number; reintentables: number; definitivos: number; detenidos: number } }> {
  const usuario = await requireSession();
  try {
    const { revisados, procesados, reintentables, definitivos, detenidos } = await reprocesarMensajesPendientesMaster(usuario);
    revalidatePath(`/master/empresas/${empresaId}`);
    return { resumen: { revisados, procesados, reintentables, definitivos, detenidos } };
  } catch {
    return { error: "No se pudieron reprocesar los mensajes." };
  }
}

export async function revocarVinculoWhatsappMasterAction(empresaId: string, vinculoId: string): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await revocarVinculoWhatsappMaster(usuario, empresaId, vinculoId);
  } catch {
    return { error: "No se pudo revocar el vínculo." };
  }
  revalidatePath(`/master/empresas/${empresaId}`);
  return {};
}

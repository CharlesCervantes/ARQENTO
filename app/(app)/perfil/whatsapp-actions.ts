"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/server/auth/dal";
import {
  autorizarWhatsappUsuario,
  iniciarVinculacionWhatsapp,
  revocarMiWhatsapp,
  revocarWhatsappDeUsuario,
  type InicioVinculacion,
} from "@/lib/server/whatsapp/vinculos";
import { WhatsappNoConfiguradoError } from "@/lib/server/whatsapp/config";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";

// Acciones de WhatsApp (Fase 1 WhatsApp + ARQENTO IA): el propio usuario
// vincula/revoca su número; Administrador/Director autorizan y revocan a
// usuarios de SU Empresa (los servicios lo validan). Errores inesperados
// nunca exponen detalles internos.

function mensajeError(error: unknown): string {
  if (
    error instanceof ValidacionError ||
    error instanceof SinPermisoError ||
    error instanceof RegistroNoEncontradoError ||
    error instanceof WhatsappNoConfiguradoError
  ) {
    return error.message;
  }
  return "No se pudo completar la operación. Inténtalo de nuevo.";
}

export type VinculacionState = { error?: string; inicio?: InicioVinculacion } | undefined;

export async function iniciarVinculacionWhatsappAction(_state: VinculacionState, formData: FormData): Promise<VinculacionState> {
  const usuario = await requireSession();
  try {
    const inicio = await iniciarVinculacionWhatsapp(usuario, formData.get("telefono"));
    revalidatePath("/perfil");
    return { inicio };
  } catch (error) {
    return { error: mensajeError(error) };
  }
}

export async function revocarMiWhatsappAction(): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await revocarMiWhatsapp(usuario);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/perfil");
  return {};
}

export async function autorizarWhatsappUsuarioAction(usuarioId: string, autorizado: boolean): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await autorizarWhatsappUsuario(usuario, usuarioId, autorizado);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/perfil/whatsapp");
  return {};
}

export async function revocarWhatsappDeUsuarioAction(usuarioId: string): Promise<{ error?: string }> {
  const usuario = await requireSession();
  try {
    await revocarWhatsappDeUsuario(usuario, usuarioId);
  } catch (error) {
    return { error: mensajeError(error) };
  }
  revalidatePath("/perfil/whatsapp");
  return {};
}

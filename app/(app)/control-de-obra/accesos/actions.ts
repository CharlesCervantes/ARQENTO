"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireSession } from "@/lib/server/auth/dal";
import { guardarAccesosSupervisor } from "@/lib/server/control-de-obra/accesos-obra";

export type AccesosFormState = { error?: string; guardado?: boolean } | undefined;

export async function guardarAccesosAction(supervisorId: string, _state: AccesosFormState, formData: FormData): Promise<AccesosFormState> {
  const usuario = await requireSession();
  try {
    await guardarAccesosSupervisor(usuario, { supervisorId, obraIds: formData.getAll("obra") });
  } catch (error) {
    if (error instanceof z.ZodError) return { error: "Datos inválidos." };
    return { error: error instanceof Error ? error.message : "No se pudo guardar." };
  }
  revalidatePath("/control-de-obra/accesos");
  return { guardado: true };
}

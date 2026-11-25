"use client";

import { useActionState, useState } from "react";
import { quitarConceptoAsignadoAction, type FormState } from "@/app/(proyecto)/control-de-obra/[id]/actions";

export function QuitarConcepto({ proyectoId, asignacionId, descripcion }: { proyectoId: string; asignacionId: string; descripcion: string }) {
  const [confirmando, setConfirmando] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    quitarConceptoAsignadoAction.bind(null, proyectoId, asignacionId),
    undefined
  );

  if (!confirmando) {
    return (
      <button
        type="button"
        onClick={() => setConfirmando(true)}
        aria-label={`Quitar ${descripcion.slice(0, 80)}`}
        className="text-xs font-medium text-red-700 hover:underline"
      >
        Quitar
      </button>
    );
  }

  return (
    <form action={formAction} className="min-w-[150px] space-y-1">
      <p className="text-xs text-[var(--foreground)]">¿Quitarlo de este contratista?</p>
      <div className="flex gap-3">
        <button type="submit" disabled={pending} className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50">
          {pending ? "Quitando…" : "Sí, quitar"}
        </button>
        <button type="button" disabled={pending} onClick={() => setConfirmando(false)} className="text-xs text-[var(--muted)] hover:underline">
          Cancelar
        </button>
      </div>
      {state?.error && <p className="text-xs text-red-700">{state.error}</p>}
    </form>
  );
}

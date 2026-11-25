"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { crearPartidaAction, type FormState } from "@/app/(proyecto)/control-de-obra/[id]/actions";
import { ICONOS_PARTIDA, COLORES_PARTIDA } from "@/lib/control-de-obra/iconos-partida";

export function FormNuevaPartida({ proyectoId, proponer = false }: { proyectoId: string; proponer?: boolean }) {
  const action = crearPartidaAction.bind(null, proyectoId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    action,
    undefined
  );
  const [icono, setIcono] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const paleta = (color && COLORES_PARTIDA[color]) || COLORES_PARTIDA.gris;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="icono" value={icono ?? ""} />
      <input type="hidden" name="color" value={color ?? ""} />

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">
            Nombre de la partida
          </label>
          <Input name="nombre" required placeholder="Ej. Obra Civil" />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Agregando…" : proponer ? "Proponer partida" : "+ Agregar partida"}
        </Button>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-[var(--muted)]">
          Icono (opcional)
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setIcono(null)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg border text-xs text-[var(--muted)]",
              icono === null
                ? "border-[var(--brand)] ring-2 ring-[var(--brand)]/20"
                : "border-[var(--border)] hover:bg-black/[0.03]"
            )}
            title="Sin icono"
          >
            —
          </button>
          {Object.entries(ICONOS_PARTIDA).map(([clave, Icono]) => (
            <button
              key={clave}
              type="button"
              onClick={() => setIcono(clave)}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg border",
                paleta.bg,
                paleta.text,
                icono === clave
                  ? "border-[var(--brand)] ring-2 ring-[var(--brand)]/20"
                  : "border-transparent hover:opacity-75"
              )}
              title={clave}
            >
              <Icono className="h-4 w-4" strokeWidth={2} />
            </button>
          ))}
        </div>
      </div>

      {icono !== null && (
        <div className="enter">
          <p className="mb-1.5 text-xs font-medium text-[var(--muted)]">Color</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(COLORES_PARTIDA).map(([clave, valores]) => (
              <button
                key={clave}
                type="button"
                onClick={() => setColor(clave)}
                className={cn(
                  "h-7 w-7 rounded-full border-2",
                  valores.bg,
                  color === clave ? "border-[var(--brand)]" : "border-transparent"
                )}
                title={clave}
              />
            ))}
          </div>
        </div>
      )}

      {proponer && <p className="text-xs text-[var(--muted)]">Quedará por aprobar. Mientras tanto puedes agregarle conceptos.</p>}
      {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
    </form>
  );
}

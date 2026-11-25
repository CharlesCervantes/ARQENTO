"use client";

import { useActionState, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { guardarAccesosAction, type AccesosFormState } from "@/app/(app)/control-de-obra/accesos/actions";
import type { ObraAsignable, SupervisorConAccesos } from "@/lib/server/control-de-obra/accesos-obra";

const ESTATUS: Record<string, string> = { PAUSADO: "Pausada", CERRADO: "Cerrada", CANCELADO: "Cancelada" };

export function AccesosSupervisorForm({ supervisor, obras }: { supervisor: SupervisorConAccesos; obras: ObraAsignable[] }) {
  const [state, action, pendiente] = useActionState<AccesosFormState, FormData>(guardarAccesosAction.bind(null, supervisor.id), undefined);
  const [marcadas, setMarcadas] = useState(() => new Set(supervisor.obraIds));
  const sinCambios = marcadas.size === supervisor.obraIds.length && supervisor.obraIds.every((id) => marcadas.has(id));
  const alternar = (id: string) =>
    setMarcadas((m) => {
      const n = new Set(m);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            {supervisor.nombre}
            {!supervisor.activo && <span className="ml-2 text-xs font-normal text-[var(--muted)]">Inactivo</span>}
          </h2>
          <div className="flex items-center gap-3 text-sm text-[var(--muted)]">
            <span>
              {marcadas.size} de {obras.length} obras
            </span>
            <button type="button" className="hover:text-[var(--foreground)]" onClick={() => setMarcadas(new Set(obras.map((o) => o.id)))}>
              Todas
            </button>
            <button type="button" className="hover:text-[var(--foreground)]" onClick={() => setMarcadas(new Set())}>
              Ninguna
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {obras.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
              <input type="checkbox" name="obra" value={o.id} checked={marcadas.has(o.id)} onChange={() => alternar(o.id)} />
              <span>{o.nombre}</span>
              {ESTATUS[o.estatus] && <span className="text-xs text-[var(--muted)]">{ESTATUS[o.estatus]}</span>}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pendiente || sinCambios}>
            {pendiente ? "Guardando…" : "Guardar accesos"}
          </Button>
          {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
          {state?.guardado && sinCambios && <p className="text-sm text-emerald-700">Guardado.</p>}
        </div>
      </form>
    </Card>
  );
}

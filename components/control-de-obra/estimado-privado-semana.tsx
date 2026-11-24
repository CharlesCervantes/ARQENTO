"use client";

import { useActionState, useTransition, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  guardarEstimadoPrivadoAction,
  eliminarEstimadoPrivadoAction,
  type EstimadoPrivadoFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";

type Estimado = {
  id: string;
  conceptoId: string;
  descripcionConcepto: string;
  unidad: string;
  cantidad: number;
  importeBase: number | null;
  fisicoEstaSemana: number;
  origen: string;
};

const claseInput =
  "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";

const numero = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 6 });
const pesos = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

// Cantidad estimada PRIVADA de esta semana (noviembre 2026): lo que Cliente
// Priv. estima al cliente cuando difiere del avance físico. No cambia el
// avance de obra, lo disponible para asignar, los cortes ni los contratistas.
export function EstimadoPrivadoSemana({
  proyectoId,
  semanaId,
  conceptos,
  estimados,
  editable,
}: {
  proyectoId: string;
  semanaId: string;
  conceptos: { id: string; descripcion: string; unidad: string }[];
  estimados: Estimado[];
  editable: boolean;
}) {
  const action = guardarEstimadoPrivadoAction.bind(null, proyectoId, semanaId);
  const [state, formAction, pending] = useActionState<EstimadoPrivadoFormState, FormData>(action, undefined);
  const [eliminando, iniciarEliminar] = useTransition();
  const [errorEliminar, setErrorEliminar] = useState<string | null>(null);

  return (
    <Card className="enter p-5">
      <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
        Cantidad estimada privada de esta semana
      </p>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Solo cambia lo que estima Cliente Priv. El avance físico, lo asignable a contratistas y los cortes no cambian.
      </p>

      {estimados.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--muted)]">
              <th className="py-1 pr-3 font-medium">Concepto</th>
              <th className="py-1 pr-3 text-right font-medium">Físico</th>
              <th className="py-1 pr-3 text-right font-medium">Estimado privado</th>
              <th className="py-1 pr-3 text-right font-medium">Importe fijo</th>
              <th className="py-1 pr-3 font-medium">Motivo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {estimados.map((e) => (
              <tr key={e.id} className="border-t border-[var(--border)]">
                <td className="py-1.5 pr-3">{e.descripcionConcepto}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {numero(e.fisicoEstaSemana)} {e.unidad}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {numero(e.cantidad)} {e.unidad}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {e.importeBase === null ? "—" : pesos(e.importeBase)}
                </td>
                <td className="py-1.5 pr-3 text-[var(--muted)]">{e.origen}</td>
                <td className="py-1.5 text-right">
                  {editable && (
                    <button
                      type="button"
                      disabled={eliminando}
                      onClick={() =>
                        iniciarEliminar(async () => {
                          const r = await eliminarEstimadoPrivadoAction(proyectoId, e.id);
                          setErrorEliminar(r?.error ?? null);
                        })
                      }
                      className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
                    >
                      Quitar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editable && (
        <form action={formAction} className="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_2fr_auto] sm:items-end">
          <label className="grid gap-1 text-xs text-[var(--muted)]">
            Concepto
            <select name="conceptoId" required className={claseInput}>
              {conceptos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.descripcion.slice(0, 80)} ({c.unidad})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-[var(--muted)]">
            Cantidad estimada
            <input name="cantidad" type="number" step="0.000001" min="0" required className={claseInput} />
          </label>
          <label className="grid gap-1 text-xs text-[var(--muted)]">
            Importe fijo (opcional)
            <input name="importeBase" type="number" step="0.01" min="0" className={claseInput} />
          </label>
          <label className="grid gap-1 text-xs text-[var(--muted)]">
            Motivo
            <input name="motivo" required minLength={3} className={claseInput} />
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </form>
      )}

      {state?.error && <p className="mt-2 text-sm text-red-700">{state.error}</p>}
      {errorEliminar && <p className="mt-2 text-sm text-red-700">{errorEliminar}</p>}
    </Card>
  );
}

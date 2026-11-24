"use client";

import { useActionState, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/dinero";
import {
  cerrarSemanaAction,
  type CerrarSemanaFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import type { ResumenCierreSemana } from "@/lib/server/control-de-obra/cierre-semana";

// Bloque al final de Avance de obra — semana todavía abierta (nunca se
// cerró, o se reabrió). El botón abre un modal de confirmación propio (no
// window.confirm(), para que se vea con la UI de la página, mismo patrón que
// BotonEliminarProyecto/ModalReabrir) — es reversible vía Reabrir, así que
// basta una confirmación simple, no un texto a escribir.
export function CierreSemanaAbierta({
  proyectoId,
  semanaId,
  numeroSemana,
  resumen,
  puedeCerrarSemana,
}: {
  proyectoId: string;
  semanaId: string;
  numeroSemana: number;
  resumen: ResumenCierreSemana;
  puedeCerrarSemana: boolean;
}) {
  const [modalAbierto, setModalAbierto] = useState(false);
  const bloqueado = !resumen.puedeCerrar;

  return (
    <Card className="enter p-5">
      <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
        Cierre de semana
      </p>
      <h3 className="mt-1 text-base font-semibold text-[var(--foreground)]">
        Resumen de la semana {numeroSemana}
      </h3>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Dato etiqueta="Conceptos con avance" valor={resumen.conceptosConAvance} />
        <Dato etiqueta="Avances aprobados" valor={resumen.avancesAprobados} />
        <Dato
          etiqueta="Pendientes por aprobar"
          valor={resumen.pendientesPorAprobar}
          resaltar={resumen.pendientesPorAprobar > 0}
        />
        <Dato etiqueta="Contratistas involucrados" valor={resumen.contratistasInvolucrados} />
        <Dato
          etiqueta="Monto de mano de obra aprobado"
          valor={formatMoney(resumen.montoManoDeObraAprobado)}
        />
      </dl>

      {bloqueado && (
        <div className="mt-4 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {resumen.motivoBloqueo && (
            <p>El cierre de semanas y las estimaciones de esta obra están bloqueados: {resumen.motivoBloqueo}</p>
          )}
          {resumen.pendientesPorAprobar > 0 && (
            <p>
              Hay {resumen.pendientesPorAprobar} avance
              {resumen.pendientesPorAprobar === 1 ? "" : "s"} pendiente
              {resumen.pendientesPorAprobar === 1 ? "" : "s"} por aprobar. Apruébalo
              {resumen.pendientesPorAprobar === 1 ? "" : "s"} o recházalo
              {resumen.pendientesPorAprobar === 1 ? "" : "s"} antes de cerrar.
            </p>
          )}
          {resumen.conceptosSinContratista.length > 0 && (
            <p>
              Conceptos con avance aprobado sin contratista asignado:{" "}
              {resumen.conceptosSinContratista.map((c) => c.descripcion).join(", ")}.
            </p>
          )}
        </div>
      )}

      {puedeCerrarSemana && (
        <div className="mt-4">
          <Button disabled={bloqueado} onClick={() => setModalAbierto(true)}>
            Cerrar semana {numeroSemana}
          </Button>
        </div>
      )}

      {modalAbierto && (
        <ModalConfirmarCierre
          proyectoId={proyectoId}
          semanaId={semanaId}
          numeroSemana={numeroSemana}
          onClose={() => setModalAbierto(false)}
        />
      )}
    </Card>
  );
}

function ModalConfirmarCierre({
  proyectoId,
  semanaId,
  numeroSemana,
  onClose,
}: {
  proyectoId: string;
  semanaId: string;
  numeroSemana: number;
  onClose: () => void;
}) {
  const action = cerrarSemanaAction.bind(null, proyectoId, semanaId);
  const [state, formAction, pending] = useActionState<CerrarSemanaFormState, FormData>(
    action,
    undefined
  );
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.cerrado) onClose();
  }

  useEffect(() => {
    function alTecla(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", alTecla);
    return () => document.removeEventListener("keydown", alTecla);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="enter w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">
          Cerrar semana {numeroSemana}
        </h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Esto genera los cortes y los movimientos de Reporte General de los contratistas con
          avance aprobado esta semana. Puedes reabrirla después si hace falta corregir algo.
        </p>

        <form action={formAction} className="mt-5 flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Cerrando…" : "Sí, cerrar semana"}
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
          >
            Cancelar
          </button>
        </form>
        {state?.error && <p className="mt-3 text-sm text-red-700">{state.error}</p>}
      </Card>
    </div>,
    document.body
  );
}

function Dato({
  etiqueta,
  valor,
  resaltar,
}: {
  etiqueta: string;
  valor: string | number;
  resaltar?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{etiqueta}</dt>
      <dd
        className={cn(
          "mt-0.5 text-lg font-semibold tabular-nums",
          resaltar ? "text-amber-600" : "text-[var(--foreground)]"
        )}
      >
        {valor}
      </dd>
    </div>
  );
}

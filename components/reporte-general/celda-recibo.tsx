"use client";

import { useActionState } from "react";
import {
  generarReciboReporteAction,
  type GenerarReciboReporteState,
} from "@/app/(app)/reporte-general/actions";

// Columna «Recibo» de Contratistas: descarga el recibo vigente del corte o,
// si el corte todavía no tiene recibo, lo genera (mismo flujo que
// Contratistas → Expediente). Solo aplica a movimientos que vienen de un corte.
export function CeldaRecibo({
  proyectoId,
  corteId,
  reciboId,
  reciboFirmado,
  puedeVerRecibos,
  puedeGenerarRecibos,
}: {
  proyectoId: string;
  corteId: string | null;
  reciboId: string | null;
  reciboFirmado: boolean;
  puedeVerRecibos: boolean;
  // Supervisor: descarga, pero no genera folios.
  puedeGenerarRecibos: boolean;
}) {
  if (!puedeVerRecibos || !corteId) {
    return <span className="text-[var(--muted)]">—</span>;
  }
  if (reciboId) {
    return (
      <a
        href={`/api/control-de-obra/proyectos/${proyectoId}/recibos/${reciboId}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-medium text-[var(--brand)] hover:underline"
      >
        Descargar{reciboFirmado ? " (firmado)" : ""}
      </a>
    );
  }
  if (!puedeGenerarRecibos) return <span className="text-xs text-[var(--muted)]">Sin recibo</span>;
  return <GenerarRecibo proyectoId={proyectoId} corteId={corteId} />;
}

function GenerarRecibo({ proyectoId, corteId }: { proyectoId: string; corteId: string }) {
  const action = generarReciboReporteAction.bind(null, corteId, proyectoId);
  const [state, formAction, pending] = useActionState<GenerarReciboReporteState, FormData>(
    action,
    undefined
  );
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-[var(--brand)] transition-colors duration-150 ease-out hover:underline disabled:opacity-50"
      >
        {pending ? "Generando…" : "Generar"}
      </button>
      {state?.error && <p className="mt-0.5 text-[10px] text-red-700">{state.error}</p>}
    </form>
  );
}

"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { EstimacionesYPagos } from "./expediente-financiero-contratista";
import type { CorteHistorial } from "@/lib/server/control-de-obra/recibos";

const TABS = ["contrato", "estimaciones"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  contrato: "Contrato",
  estimaciones: "Estimaciones",
};

// Cada contratista se ve como Contrato | Estimaciones dentro de su propia
// tarjeta — Contrato (conceptos asignados) se sigue armando en el servidor
// (contratistas-view.tsx, que ya es un componente de servidor) y llega aquí
// como children ya renderizado; Estimaciones vive enteramente del lado del
// cliente porque necesita alternar sin recargar la tarjeta (Contratistas:
// Control Contractual + Estimaciones, septiembre 2026).
export function ContratistaTabs({
  proyectoId,
  puedeVerRecibosFinancieros,
  puedeGestionarRecibos,
  historial,
  contratoBody,
}: {
  proyectoId: string;
  puedeVerRecibosFinancieros: boolean;
  puedeGestionarRecibos: boolean;
  historial: CorteHistorial[];
  contratoBody: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("contrato");

  // Un Supervisor (sin puedeVerRecibosFinancieros) no tiene nada que ver en
  // Estimaciones — se omiten las pestañas por completo y se muestra
  // directamente Contrato, igual que antes de este cambio.
  if (!puedeVerRecibosFinancieros) return <>{contratoBody}</>;

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
              tab === t
                ? "border-b-2 border-[var(--brand)] text-[var(--brand)]"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === "contrato" && contratoBody}
      {tab === "estimaciones" && <EstimacionesYPagos proyectoId={proyectoId} historial={historial} puedeGestionarRecibos={puedeGestionarRecibos} />}
    </div>
  );
}

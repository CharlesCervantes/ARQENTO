"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/dinero";
import { resolverPropuestaAction } from "@/app/(proyecto)/control-de-obra/[id]/actions";
import type { FilaPropuesta } from "@/lib/server/control-de-obra/propuestas-contrato";

export function EtiquetaPorAprobar() {
  return <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">Por aprobar</span>;
}

/** Conceptos propuestos dentro de una partida. */
export function ConceptosPropuestos({ proyectoId, propuestas, puedeResolver }: { proyectoId: string; propuestas: FilaPropuesta[]; puedeResolver: boolean }) {
  if (propuestas.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/40">
      <p className="px-4 pt-3 text-xs font-semibold text-amber-800">Conceptos por aprobar · no cuentan en el contrato todavía</p>
      <ul className="divide-y divide-amber-100">
        {propuestas.map((p) => {
          const pu = (p.precioUnitarioContratista ?? 0) + (p.precioUnitarioMateriales ?? 0);
          return (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1 basis-64">
                <p className="text-sm font-medium break-words whitespace-pre-line text-[var(--foreground)]">{p.descripcion}</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {(p.cantidad ?? 0).toLocaleString("es-MX", { maximumFractionDigits: 3 })} {p.unidad}
                  {" × "}
                  {pu > 0 ? <>{formatMoney(pu)} = <span className="font-medium text-[var(--foreground)]">{formatMoney((p.cantidad ?? 0) * pu)}</span></> : "sin P.U."}
                  {" · Propuso "}
                  {p.solicitadoPorNombre}
                </p>
              </div>
              <AccionesPropuesta proyectoId={proyectoId} propuesta={p} puedeResolver={puedeResolver} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AccionesPropuesta({ proyectoId, propuesta, puedeResolver }: { proyectoId: string; propuesta: FilaPropuesta; puedeResolver: boolean }) {
  const [enviando, setEnviando] = useState(false);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string>();

  async function enviar(decision: "APROBAR" | "RECHAZAR" | "RETIRAR") {
    setEnviando(true);
    setError(undefined);
    try {
      const r = await resolverPropuestaAction(proyectoId, propuesta.id, decision, motivo);
      setError(r.error);
    } finally {
      setEnviando(false);
    }
  }

  if (!puedeResolver && !propuesta.esMia) return <EtiquetaPorAprobar />;

  return (
    <div className="flex flex-col items-end gap-2">
      {rechazando ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo del rechazo" aria-label="Motivo del rechazo" />
          <Button type="button" disabled={enviando || motivo.trim() === ""} onClick={() => enviar("RECHAZAR")}>Rechazar</Button>
          <button type="button" className="text-xs text-[var(--muted)] hover:underline" onClick={() => setRechazando(false)}>Cancelar</button>
        </div>
      ) : puedeResolver ? (
        <div className="flex gap-3">
          <button type="button" disabled={enviando} onClick={() => enviar("APROBAR")} className="text-xs font-medium text-emerald-700 hover:underline disabled:opacity-50">
            {propuesta.tipo === "PARTIDA" ? "Aprobar partida" : "Aprobar"}
          </button>
          <button type="button" disabled={enviando} onClick={() => setRechazando(true)} className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50">
            Rechazar
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <EtiquetaPorAprobar />
          <button type="button" disabled={enviando} onClick={() => enviar("RETIRAR")} className="text-xs text-[var(--muted)] hover:underline disabled:opacity-50">
            Retirar
          </button>
        </div>
      )}
      {error && <p className="max-w-xs text-right text-xs text-red-700">{error}</p>}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Textarea } from "@/components/ui/textarea";
import { cancelarOrdenVentaAction, cerrarCotizacionAction } from "@/app/(app)/comercializacion/actions";
import type { EstadoCancelacionOrden } from "@/lib/server/comercializacion/cancelaciones";
import { PanelLateral } from "./panel-lateral";
import { MenuAcciones } from "./menu-acciones";
import { ACCION_EN_LINEA, BOTON_PELIGRO, BOTON_SECUNDARIO } from "./estilos";

// B8B — acciones de administración: registrar rechazo o cancelar una
// cotización y cancelar una OV sin dinero ni dependencias vigentes. Solo se
// muestran a administración; el servidor vuelve a validar permisos, estado y
// bloqueos (también por id directo). Desde el rediseño viven en paneles que
// se abren desde «Más acciones»: explican consecuencias, piden motivo y
// confirman; no ocupan el resumen de forma permanente.

/** Motivo obligatorio + confirmación. `onListo` se llama tras guardar. */
export function FormularioMotivo({
  consecuencias,
  boton,
  onConfirmar,
  onCancelar,
  onListo,
}: {
  consecuencias: string[];
  boton: string;
  onConfirmar: (motivo: string) => Promise<{ error?: string }>;
  onCancelar: () => void;
  onListo: () => void;
}) {
  const router = useRouter();
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  return (
    <div className="space-y-4" data-formulario-motivo>
      <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--foreground)]">
        {consecuencias.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Motivo (obligatorio)</span>
        <Textarea value={motivo} onChange={(ev) => setMotivo(ev.target.value)} maxLength={500} placeholder="Explica el motivo" aria-label="Motivo" rows={3} />
      </label>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={BOTON_PELIGRO}
          disabled={pendiente || motivo.trim().length < 3}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await onConfirmar(motivo);
              if (r.error) return setError(r.error);
              onListo();
              router.refresh();
            })
          }
        >
          {pendiente ? "Guardando…" : boton}
        </button>
        <button type="button" onClick={onCancelar} className={BOTON_SECUNDARIO} disabled={pendiente}>
          Volver
        </button>
      </div>
    </div>
  );
}

const CONSECUENCIAS_CIERRE = [
  "Es definitivo: después no se edita, emite ni acepta.",
  "Se conservan el folio, las partidas, el PDF emitido (si existe) y el historial.",
  "Para una nueva venta usa «Duplicar».",
];

/** Panel de rechazo (solo emitida) o cancelación (borrador o emitida) de una cotización. */
export function PanelCerrarCotizacion({
  accion,
  cotizacionId,
  folio,
  contexto,
  onCerrar,
}: {
  accion: "RECHAZAR" | "CANCELAR" | null;
  cotizacionId: string;
  folio: string;
  contexto?: string;
  onCerrar: () => void;
}) {
  const rechazo = accion === "RECHAZAR";
  return (
    <PanelLateral
      abierto={accion !== null}
      onCerrar={onCerrar}
      titulo={rechazo ? "Registrar rechazo del cliente" : "Cancelar cotización"}
      contexto={`${folio}${contexto ? ` · ${contexto}` : ""}`}
    >
      {accion && (
        <FormularioMotivo
          consecuencias={[rechazo ? "Registra que el cliente no aceptó la cotización." : "La cotización deja de estar disponible.", ...CONSECUENCIAS_CIERRE]}
          boton={rechazo ? "Registrar rechazo" : "Cancelar cotización"}
          onConfirmar={(motivo) => cerrarCotizacionAction({ id: cotizacionId, accion, motivo })}
          onCancelar={onCerrar}
          onListo={onCerrar}
        />
      )}
    </PanelLateral>
  );
}

/** «Más acciones» de un borrador (administración): cancelarlo con motivo. */
export function AccionesBorrador({ cotizacionId, folio }: { cotizacionId: string; folio: string }) {
  const [accion, setAccion] = useState<"CANCELAR" | null>(null);
  return (
    <div className="flex justify-end" data-cerrar-cotizacion>
      <MenuAcciones opciones={[{ id: "cancelar", etiqueta: "Cancelar cotización", peligro: true, alElegir: () => setAccion("CANCELAR") }]} />
      <PanelCerrarCotizacion accion={accion} cotizacionId={cotizacionId} folio={folio} onCerrar={() => setAccion(null)} />
    </div>
  );
}

/** Panel «Cancelar OV»: solo sin dinero ni dependencias vigentes; si no, muestra los bloqueos. */
export function PanelCancelarOrden({
  abierto,
  ordenId,
  folio,
  contexto,
  estado,
  onCerrar,
}: {
  abierto: boolean;
  ordenId: string;
  folio: string;
  contexto?: string;
  estado: EstadoCancelacionOrden;
  onCerrar: () => void;
}) {
  return (
    <PanelLateral abierto={abierto} onCerrar={onCerrar} titulo="Cancelar orden de venta" contexto={`${folio}${contexto ? ` · ${contexto}` : ""}`}>
      <div className="space-y-4" id="cancelar-ov">
        <p className="text-sm text-[var(--muted)]">
          Solo para una OV sin cobros ni pagos registrados (aunque estén anulados) y sin compras, gastos, entregas ni vínculos vigentes.
        </p>
        {estado.bloqueos.length > 0 ? (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-bloqueos-cancelacion>
            <p className="font-medium">No se puede cancelar {folio} todavía:</p>
            <ul className="list-disc space-y-1.5 pl-5">
              {estado.bloqueos.map((b) => (
                <li key={b.texto}>
                  {b.texto}{" "}
                  {b.enlaces.map((e, i) => (
                    <span key={e.href}>
                      {i > 0 && ", "}
                      <Link href={e.href} className={ACCION_EN_LINEA}>
                        {e.etiqueta}
                      </Link>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            <p className="text-xs">Atiende cada punto en su documento; esta acción no cancela ni anula dependencias por su cuenta.</p>
          </div>
        ) : (
          <FormularioMotivo
            consecuencias={[
              "Es definitiva: la cotización conserva su aceptación y no genera otra OV; para una nueva venta, duplícala.",
              "La cuenta por cobrar se anula conservando su total y calendario.",
              "No registra devoluciones ni notas de crédito.",
            ]}
            boton="Cancelar OV"
            onConfirmar={(motivo) => cancelarOrdenVentaAction({ ordenId, motivo })}
            onCancelar={onCerrar}
            onListo={onCerrar}
          />
        )}
      </div>
    </PanelLateral>
  );
}

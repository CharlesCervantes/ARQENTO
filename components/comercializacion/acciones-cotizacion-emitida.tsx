"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  duplicarCotizacionAction,
  registrarAceptacionAction,
  type AceptacionState,
} from "@/app/(app)/comercializacion/actions";
import { MB_POR_CARGA } from "@/lib/comercializacion/cargas";
import { AvisosArchivos, useArchivosDeCarga } from "./campo-archivos";
import { CerrarCotizacion } from "./cancelaciones";

// Acciones de una cotización emitida/aceptada (B3): ver PDF, duplicar y —solo
// si está EMITIDA y vigente— registrar la aceptación con evidencia. El
// servidor vuelve a validar permisos, estado, vigencia y archivo.

const claseEnlace = "text-sm font-medium text-[var(--brand)] hover:underline";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";

function claveNueva(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function AccionesCotizacionEmitida({
  cotizacionId,
  folio,
  estatus,
  esAdmin = false,
  sinPdf = false,
  vencida,
  fechaMinima,
  hoy,
}: {
  cotizacionId: string;
  folio: string;
  estatus: "BORRADOR" | "EMITIDA" | "ACEPTADA" | "RECHAZADA" | "CANCELADA";
  /** B8B: rechazo y cancelación solo para administración. */
  esAdmin?: boolean;
  /** B8B: un borrador cancelado nunca se emitió (no tiene PDF). */
  sinPdf?: boolean;
  vencida: boolean;
  fechaMinima: string;
  hoy: string;
}) {
  const router = useRouter();
  const [aceptando, setAceptando] = useState(false);
  const [claveDuplicado] = useState(claveNueva);
  const [errorDuplicar, setErrorDuplicar] = useState<string | null>(null);
  const [duplicando, startDuplicar] = useTransition();
  const [state, formAction, pendiente] = useActionState<AceptacionState, FormData>(
    registrarAceptacionAction.bind(null, cotizacionId),
    undefined
  );
  // Campos controlados: se conservan si el servidor rechaza la aceptación.
  const [fechaAceptacion, setFechaAceptacion] = useState(hoy);
  const [referenciaOc, setReferenciaOc] = useState("");
  const evidencia = useArchivosDeCarga(state, { maxArchivos: 1 });
  // Al registrar la aceptación se recarga la vista (ahora muestra la OV). En
  // un efecto, no durante el render: router.refresh() actualiza el Router y
  // React marca error si ocurre mientras se dibuja este componente
  // (encontrado en la verificación en navegador de B3).
  useEffect(() => {
    if (state?.folio) router.refresh();
  }, [state, router]);

  function duplicar() {
    setErrorDuplicar(null);
    startDuplicar(async () => {
      const r = await duplicarCotizacionAction({ id: cotizacionId, claveCreacion: claveDuplicado });
      if (r.error || !r.id) return setErrorDuplicar(r.error ?? "No se pudo duplicar.");
      const aviso = r.omitidos?.length ? `?omitidos=${encodeURIComponent(r.omitidos.join(","))}` : "";
      router.push(`/comercializacion/cotizaciones/${r.id}${aviso}`);
    });
  }

  return (
    <div className="space-y-4">
      {estatus === "EMITIDA" && vencida && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          La vigencia de esta cotización ya pasó. Por ahora no se registra la aceptación de una cotización vencida: duplícala,
          revisa precios y vigencia, y emite una nueva.
        </div>
      )}

      {aceptando && estatus === "EMITIDA" && !vencida && (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Registrar aceptación de {folio}</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Genera la orden de venta (OV). La evidencia es obligatoria: PDF, JPG o PNG de hasta {MB_POR_CARGA} MB (por ejemplo, la OC o el
            correo del cliente). Es un registro interno, no una firma electrónica.
          </p>
          <form action={formAction} className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">Fecha de aceptación</span>
              <Input type="date" name="fechaAceptacion" required value={fechaAceptacion} onChange={(ev) => setFechaAceptacion(ev.target.value)} min={fechaMinima} max={hoy} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">OC del cliente (opcional)</span>
              <Input name="referenciaOcCliente" value={referenciaOc} onChange={(ev) => setReferenciaOc(ev.target.value)} maxLength={100} placeholder="Número de OC del cliente" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">Evidencia</span>
              <input
                type="file"
                name="evidencia"
                required
                accept="application/pdf,image/jpeg,image/png"
                onChange={evidencia.onChange}
                className="block w-full text-sm text-[var(--foreground)] file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-2 file:text-sm"
              />
              <AvisosArchivos
                exceso={evidencia.exceso}
                reseleccionar={state?.error && evidencia.debeReseleccionar ? "Fecha y OC se conservaron; vuelve a seleccionar la evidencia." : null}
              />
            </label>
            {state?.error && (
              <p role="alert" className="md:col-span-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                {state.error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 md:col-span-3">
              <Button type="submit" disabled={pendiente || Boolean(evidencia.exceso)}>
                {pendiente ? "Registrando…" : "Registrar aceptación y generar OV"}
              </Button>
              <button type="button" onClick={() => setAceptando(false)} className={claseSecundaria} disabled={pendiente}>
                Cancelar
              </button>
            </div>
          </form>
        </Card>
      )}

      {errorDuplicar && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {errorDuplicar}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {estatus === "EMITIDA" && !vencida && !aceptando && (
          <Button type="button" onClick={() => setAceptando(true)}>
            Registrar aceptación
          </Button>
        )}
        <Button type="button" variant="outline" onClick={duplicar} disabled={duplicando}>
          {duplicando ? "Duplicando…" : "Duplicar"}
        </Button>
        {!sinPdf && (
          <a href={`/api/comercializacion/cotizaciones/${cotizacionId}/pdf`} target="_blank" rel="noopener" className={claseEnlace}>
            Ver PDF de la cotización
          </a>
        )}
      </div>
      {esAdmin && !aceptando && <CerrarCotizacion cotizacionId={cotizacionId} folio={folio} estatus={estatus} />}
    </div>
  );
}

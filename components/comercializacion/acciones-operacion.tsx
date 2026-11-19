"use client";

import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { duplicarCotizacionAction, registrarAceptacionAction, type AceptacionState } from "@/app/(app)/comercializacion/actions";
import type { OrdenVentaResumen } from "@/lib/server/comercializacion/cotizaciones";
import type { EstadoCancelacionOrden } from "@/lib/server/comercializacion/cancelaciones";
import { MB_POR_CARGA } from "@/lib/comercializacion/cargas";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { AvisosArchivos, useArchivosDeCarga } from "./campo-archivos";
import { PanelLateral } from "./panel-lateral";
import { MenuAcciones, type OpcionMenu } from "./menu-acciones";
import { PanelCancelarOrden, PanelCerrarCotizacion } from "./cancelaciones";
import { ACCION_EN_LINEA, BOTON_PRIMARIO, BOTON_SECUNDARIO } from "./estilos";

// Acciones del encabezado de la operación (rediseño §5/§7), con la lógica de
// B3/B8B sin cambios:
// - «Ver cotización PDF» (copia emitida) y, en una OV, «Ver aceptación».
// - «Registrar aceptación» solo si está EMITIDA y vigente; se captura en un
//   panel con evidencia obligatoria.
// - «Más acciones»: Duplicar y, para administración, rechazo/cancelación de
//   la cotización y «Cancelar OV», cada una en su panel con consecuencias,
//   motivo y confirmación. El servidor vuelve a validar todo.

const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });

function claveNueva(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

type Panel = "aceptar" | "verAceptacion" | "RECHAZAR" | "CANCELAR" | "cancelarOV" | null;

export function AccionesOperacion({
  cotizacionId,
  folio,
  estatus,
  esAdmin,
  sinPdf = false,
  vencida,
  fechaMinima,
  hoy,
  contexto,
  orden,
  cancelacionOrden,
}: {
  cotizacionId: string;
  folio: string;
  estatus: "BORRADOR" | "EMITIDA" | "ACEPTADA" | "RECHAZADA" | "CANCELADA";
  esAdmin: boolean;
  /** B8B: un borrador cancelado nunca se emitió (no tiene PDF). */
  sinPdf?: boolean;
  vencida: boolean;
  fechaMinima: string;
  hoy: string;
  /** «Cliente · Obra» para el encabezado de cada panel. */
  contexto?: string;
  orden?: OrdenVentaResumen | null;
  /** B8B — solo administración. */
  cancelacionOrden?: EstadoCancelacionOrden | null;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [claveDuplicado] = useState(claveNueva);
  const [errorDuplicar, setErrorDuplicar] = useState<string | null>(null);
  const [duplicando, startDuplicar] = useTransition();
  const cerrar = useCallback(() => setPanel(null), []);

  function duplicar() {
    setErrorDuplicar(null);
    startDuplicar(async () => {
      const r = await duplicarCotizacionAction({ id: cotizacionId, claveCreacion: claveDuplicado });
      if (r.error || !r.id) return setErrorDuplicar(r.error ?? "No se pudo duplicar.");
      const aviso = r.omitidos?.length ? `?omitidos=${encodeURIComponent(r.omitidos.join(","))}` : "";
      router.push(`/comercializacion/cotizaciones/${r.id}${aviso}`);
    });
  }

  const puedeAceptar = estatus === "EMITIDA" && !vencida;
  const opciones: OpcionMenu[] = [{ id: "duplicar", etiqueta: duplicando ? "Duplicando…" : "Duplicar cotización", alElegir: duplicar, deshabilitada: duplicando }];
  if (esAdmin && estatus === "EMITIDA") opciones.push({ id: "rechazar", etiqueta: "Registrar rechazo del cliente", alElegir: () => setPanel("RECHAZAR") });
  if (esAdmin && (estatus === "BORRADOR" || estatus === "EMITIDA")) opciones.push({ id: "cancelar", etiqueta: "Cancelar cotización", peligro: true, alElegir: () => setPanel("CANCELAR") });
  if (esAdmin && orden && orden.estatus === "VIGENTE" && cancelacionOrden && !cancelacionOrden.cancelada)
    opciones.push({ id: "cancelarOV", etiqueta: "Cancelar orden de venta", peligro: true, alElegir: () => setPanel("cancelarOV") });

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end" data-acciones-operacion>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {puedeAceptar && (
          <button type="button" className={BOTON_PRIMARIO} onClick={() => setPanel("aceptar")}>
            Registrar aceptación
          </button>
        )}
        {!sinPdf && (
          <a href={`/api/comercializacion/cotizaciones/${cotizacionId}/pdf`} target="_blank" rel="noopener" className={BOTON_SECUNDARIO}>
            <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
              <path d="M6 2.75h5.5L15.25 6.5v10.75H6z M11.25 2.75V6.75h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            Ver cotización PDF
          </a>
        )}
        {orden && (
          <button type="button" className={BOTON_SECUNDARIO} onClick={() => setPanel("verAceptacion")}>
            Ver aceptación
          </button>
        )}
        <MenuAcciones opciones={opciones} />
      </div>
      {estatus === "EMITIDA" && vencida && (
        <p role="status" className="max-w-md text-sm text-amber-900 sm:text-right">
          Vigencia vencida: no se registra su aceptación. Duplícala, revisa precios y vigencia, y emite una nueva.
        </p>
      )}
      {errorDuplicar && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorDuplicar}
        </p>
      )}

      <PanelLateral abierto={panel === "aceptar"} onCerrar={cerrar} titulo="Registrar aceptación" contexto={`${folio}${contexto ? ` · ${contexto}` : ""}`}>
        <FormularioAceptacion cotizacionId={cotizacionId} fechaMinima={fechaMinima} hoy={hoy} onListo={cerrar} />
      </PanelLateral>

      {orden && (
        <PanelLateral abierto={panel === "verAceptacion"} onCerrar={cerrar} titulo="Aceptación del cliente" contexto={`${orden.folio} · ${folio}`}>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2" data-aceptacion>
            <Dato etiqueta="Orden de venta">{orden.folio}</Dato>
            <Dato etiqueta="Cotización">{folio}</Dato>
            <Dato etiqueta="Fecha de aceptación">{formatearFechaCalendario(orden.fechaAceptacion)}</Dato>
            <Dato etiqueta="OC del cliente">{orden.referenciaOcCliente ?? <span className="text-[var(--muted)]">Sin referencia</span>}</Dato>
            <Dato etiqueta="Evidencia">
              <a href={`/api/comercializacion/ordenes/${orden.id}/evidencia`} target="_blank" rel="noopener" className={ACCION_EN_LINEA}>
                {orden.evidenciaNombre}
              </a>
            </Dato>
            <Dato etiqueta="Registró">
              {orden.registradaPorNombre} · {formatoFechaHora.format(new Date(orden.registradaEn))}
            </Dato>
          </dl>
          <p className="mt-4 text-xs text-[var(--muted)]">Registro interno de la evidencia de aceptación; no es una firma electrónica del cliente.</p>
        </PanelLateral>
      )}

      {esAdmin && (
        <PanelCerrarCotizacion
          accion={panel === "RECHAZAR" || panel === "CANCELAR" ? panel : null}
          cotizacionId={cotizacionId}
          folio={folio}
          contexto={contexto}
          onCerrar={cerrar}
        />
      )}
      {esAdmin && orden && cancelacionOrden && (
        <PanelCancelarOrden abierto={panel === "cancelarOV"} ordenId={orden.id} folio={orden.folio} contexto={contexto} estado={cancelacionOrden} onCerrar={cerrar} />
      )}
    </div>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{etiqueta}</dt>
      <dd className="mt-0.5 text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

function FormularioAceptacion({ cotizacionId, fechaMinima, hoy, onListo }: { cotizacionId: string; fechaMinima: string; hoy: string; onListo: () => void }) {
  const router = useRouter();
  const [state, formAction, pendiente] = useActionState<AceptacionState, FormData>(registrarAceptacionAction.bind(null, cotizacionId), undefined);
  // Campos controlados: se conservan si el servidor rechaza la aceptación.
  const [fechaAceptacion, setFechaAceptacion] = useState(hoy);
  const [referenciaOc, setReferenciaOc] = useState("");
  const evidencia = useArchivosDeCarga(state, { maxArchivos: 1 });
  // Al registrar la aceptación se recarga la vista (ahora muestra la OV). En
  // un efecto, no durante el render (verificación en navegador de B3).
  useEffect(() => {
    if (state?.folio) {
      onListo();
      router.refresh();
    }
  }, [state, router, onListo]);
  return (
    <form action={formAction} className="space-y-4">
      <p className="text-sm text-[var(--muted)]">Genera la orden de venta (OV). Es un registro interno, no una firma electrónica.</p>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Fecha de aceptación</span>
        <Input type="date" name="fechaAceptacion" required value={fechaAceptacion} onChange={(ev) => setFechaAceptacion(ev.target.value)} min={fechaMinima} max={hoy} />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">OC del cliente (opcional)</span>
        <Input name="referenciaOcCliente" value={referenciaOc} onChange={(ev) => setReferenciaOc(ev.target.value)} maxLength={100} placeholder="Número de OC del cliente" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Evidencia (obligatoria)</span>
        <input
          type="file"
          name="evidencia"
          required
          accept="application/pdf,image/jpeg,image/png"
          onChange={evidencia.onChange}
          className="block w-full text-sm text-[var(--foreground)] file:mr-3 file:min-h-11 file:rounded-xl file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:text-sm"
        />
        <AvisosArchivos
          exceso={evidencia.exceso}
          reseleccionar={state?.error && evidencia.debeReseleccionar ? "Fecha y OC se conservaron; vuelve a seleccionar la evidencia." : null}
          ayuda={`PDF, JPG o PNG de hasta ${MB_POR_CARGA} MB (por ejemplo, la OC o el correo del cliente).`}
        />
      </label>
      {state?.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={BOTON_PRIMARIO} disabled={pendiente || Boolean(evidencia.exceso)}>
          {pendiente ? "Registrando…" : "Registrar aceptación y generar OV"}
        </button>
        <button type="button" onClick={onListo} className={BOTON_SECUNDARIO} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

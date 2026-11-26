"use client";

import { useActionState, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { Table, Thead, Tr, Th, Td } from "@/components/ui/table";
import { formatMoney } from "@/lib/dinero";
import { EstadoPagoBadge } from "@/components/reporte-general/estado-pago-badge";
import {
  obtenerDetalleCorteAction,
  generarReciboAction,
  subirEvidenciaReciboAction,
  type GenerarReciboFormState,
  type SubirEvidenciaReciboFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import type { DetalleCorte } from "@/lib/server/control-de-obra/recibos";

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DetalleCorteModal({
  corteId,
  proyectoId,
  puedeGestionarRecibos,
  onClose,
}: {
  corteId: string;
  proyectoId: string;
  // Supervisor: ve y descarga el recibo y su evidencia; no genera ni sube.
  puedeGestionarRecibos: boolean;
  onClose: () => void;
}) {
  const [estado, setEstado] = useState<
    | { tipo: "cargando" }
    | { tipo: "error"; mensaje: string }
    | { tipo: "listo"; detalle: DetalleCorte }
  >({ tipo: "cargando" });

  useEffect(() => {
    let cancelado = false;
    obtenerDetalleCorteAction(corteId).then((resultado) => {
      if (cancelado) return;
      if ("error" in resultado) setEstado({ tipo: "error", mensaje: resultado.error });
      else setEstado({ tipo: "listo", detalle: resultado.detalle });
    });
    return () => {
      cancelado = true;
    };
  }, [corteId]);

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
      <Card className="enter max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6">
        {estado.tipo === "cargando" && (
          <p className="py-8 text-center text-sm text-[var(--muted)]">Cargando…</p>
        )}
        {estado.tipo === "error" && (
          <>
            <p className="py-4 text-sm text-red-700">{estado.mensaje}</p>
            <Button variant="outline" onClick={onClose}>
              Cerrar
            </Button>
          </>
        )}
        {estado.tipo === "listo" && (
          <ContenidoDetalleCorte
            proyectoId={proyectoId}
            puedeGestionarRecibos={puedeGestionarRecibos}
            detalle={estado.detalle}
            onClose={onClose}
          />
        )}
      </Card>
    </div>,
    document.body
  );
}

function ContenidoDetalleCorte({
  proyectoId,
  puedeGestionarRecibos,
  detalle,
  onClose,
}: {
  proyectoId: string;
  puedeGestionarRecibos: boolean;
  detalle: DetalleCorte;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            {detalle.numeroEstimacion} — Semana {detalle.semanaNumero}/{detalle.semanaAnio}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            {detalle.proyectoNombre} · {detalle.contratistaNombre}
            {detalle.especialidadContratista ? ` (${detalle.especialidadContratista})` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Dato etiqueta="Fecha del corte" valor={formatFecha(detalle.fechaCorte)} />
        <Dato etiqueta="Generado por" valor={detalle.generadoPorNombre} />
        <Dato etiqueta="Estado" valor={detalle.estatus === "GENERADO" ? "Generado" : "Anulado"} />
        <Dato
          etiqueta="Estado de pago"
          valor={<EstadoPagoBadge estatus={detalle.estatusPago} />}
        />
        <Dato etiqueta="Importe bruto" valor={formatMoney(detalle.montoBruto)} />
        <Dato etiqueta="Ajustes" valor={formatMoney(detalle.ajustes)} />
        <Dato etiqueta="Importe neto" valor={formatMoney(detalle.montoNeto)} destacar />
      </div>

      {detalle.resumenContractual && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="mb-3 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
            Resumen contractual
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Dato etiqueta="Monto contratado" valor={formatMoney(detalle.resumenContractual.montoContrato)} />
            <Dato etiqueta="Estimado anterior" valor={formatMoney(detalle.resumenContractual.estimadoAnterior)} />
            <Dato etiqueta="Esta estimación" valor={formatMoney(detalle.resumenContractual.estaEstimacion)} />
            <Dato etiqueta="Estimado acumulado" valor={formatMoney(detalle.resumenContractual.estimadoAcumulado)} />
            <Dato etiqueta="Saldo contractual" valor={formatMoney(detalle.resumenContractual.saldoContractual)} />
            <Dato
              etiqueta="% avance"
              valor={`${detalle.resumenContractual.porcentajeAvance.toLocaleString("es-MX", { maximumFractionDigits: 1 })}%`}
            />
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <p className="mb-3 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
          Detalle congelado (no se recalcula)
        </p>
        <Table>
          <Thead>
            <Tr>
              <Th>Partida</Th>
              <Th>Concepto</Th>
              <Th>Unidad</Th>
              <Th className="text-right">Contratada</Th>
              <Th className="text-right">Esta semana</Th>
              <Th className="text-right">Acumulada</Th>
              <Th className="text-right">P.U.</Th>
              <Th className="text-right">Importe</Th>
            </Tr>
          </Thead>
          <tbody>
            {detalle.detalle.map((d) => (
              <Tr key={d.id}>
                <Td className="text-[var(--muted)]">{d.partidaNombre ?? "—"}</Td>
                <Td className="font-medium">{d.descripcionConcepto}</Td>
                <Td className="text-[var(--muted)]">{d.unidad}</Td>
                <Td className="text-right tabular-nums">
                  {d.cantidadContratada.toLocaleString("es-MX", { maximumFractionDigits: 3 })}
                </Td>
                <Td className="text-right tabular-nums">
                  {d.cantidadEjecutada.toLocaleString("es-MX", { maximumFractionDigits: 3 })}
                </Td>
                <Td className="text-right tabular-nums">
                  {d.cantidadAcumulada.toLocaleString("es-MX", { maximumFractionDigits: 3 })}
                </Td>
                <Td className="text-right tabular-nums">{formatMoney(d.precioUnitarioContratista)}</Td>
                <Td className="text-right font-medium tabular-nums">{formatMoney(d.importe)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <p className="mb-3 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
          Recibo
        </p>
        <SeccionRecibo proyectoId={proyectoId} detalle={detalle} puedeGestionar={puedeGestionarRecibos} />
      </div>
    </div>
  );
}

function Dato({
  etiqueta,
  valor,
  destacar,
}: {
  etiqueta: string;
  valor: React.ReactNode;
  destacar?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{etiqueta}</dt>
      <dd
        className={
          destacar
            ? "mt-0.5 font-semibold tabular-nums text-[var(--foreground)]"
            : "mt-0.5 tabular-nums text-[var(--foreground)]"
        }
      >
        {valor}
      </dd>
    </div>
  );
}

function SeccionRecibo({
  proyectoId,
  detalle,
  puedeGestionar,
}: {
  proyectoId: string;
  detalle: DetalleCorte;
  puedeGestionar: boolean;
}) {
  const generarAction = generarReciboAction.bind(null, detalle.id, proyectoId);
  const [generarState, generarFormAction, generarPending] = useActionState<
    GenerarReciboFormState,
    FormData
  >(generarAction, undefined);

  if (!detalle.reciboVigente && generarState?.generado) {
    // El servidor ya revalidó la página, pero el modal sigue con el snapshot
    // viejo hasta que se cierre y se vuelva a abrir — se avisa en vez de
    // fingir que ya tiene los datos nuevos.
    return (
      <p className="text-sm text-emerald-700">
        Recibo {generarState.folio} generado ✓ — ciérralo y vuelve a abrir el corte para verlo.
      </p>
    );
  }

  if (!detalle.reciboVigente && !puedeGestionar) {
    return <p className="text-sm text-[var(--muted)]">Todavía no hay recibo generado para esta estimación.</p>;
  }

  if (!detalle.reciboVigente) {
    return (
      <form action={generarFormAction} className="flex items-center gap-3">
        <Button type="submit" disabled={generarPending}>
          {generarPending ? "Generando…" : "Generar recibo"}
        </Button>
        {generarState?.error && <p className="text-sm text-red-700">{generarState.error}</p>}
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`/api/control-de-obra/proyectos/${proyectoId}/recibos/${detalle.reciboVigente.id}/pdf`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="outline" className="px-3 py-1.5 text-xs">
            Ver / descargar {detalle.reciboVigente.folio}
          </Button>
        </a>
        {puedeGestionar && !detalle.reciboVigente.archivoEvidenciaRef && (
          <form action={generarFormAction}>
            <button
              type="submit"
              disabled={generarPending}
              className="text-xs font-medium text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)] disabled:opacity-50"
            >
              {generarPending ? "Regenerando…" : "Regenerar (folio nuevo)"}
            </button>
          </form>
        )}
      </div>
      {generarState?.error && <p className="text-sm text-red-700">{generarState.error}</p>}

      {detalle.reciboVigente.archivoEvidenciaRef ? (
        <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          Evidencia firmada cargada:{" "}
          <a
            href={`/api/control-de-obra/proyectos/${proyectoId}/recibos/${detalle.reciboVigente.id}/evidencia`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {detalle.reciboVigente.archivoEvidenciaNombre}
          </a>
          {detalle.reciboVigente.fechaRecepcion &&
            ` · recibido el ${formatFecha(detalle.reciboVigente.fechaRecepcion)}`}
        </div>
      ) : puedeGestionar ? (
        <SubirEvidencia proyectoId={proyectoId} reciboId={detalle.reciboVigente.id} />
      ) : (
        <p className="text-sm text-[var(--muted)]">Todavía no se ha subido el recibo firmado.</p>
      )}
    </div>
  );
}

function SubirEvidencia({ proyectoId, reciboId }: { proyectoId: string; reciboId: string }) {
  const action = subirEvidenciaReciboAction.bind(null, reciboId, proyectoId);
  const [state, formAction, pending] = useActionState<
    SubirEvidenciaReciboFormState,
    FormData
  >(action, undefined);

  if (state?.subido) {
    return <p className="text-sm text-emerald-700">Evidencia subida ✓</p>;
  }

  return (
    <form action={formAction} className="space-y-2">
      <label className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">
        Subir evidencia firmada (PDF o foto)
      </label>
      <FileInput
        name="archivo"
        accept="application/pdf,image/*"
        required
        className="block w-full text-sm text-[var(--foreground)] file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-1.5 file:text-sm file:font-medium"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className="px-3 py-1.5 text-xs">
          {pending ? "Subiendo…" : "Subir evidencia"}
        </Button>
        {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}

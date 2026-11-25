"use client";

import { useState, useEffect } from "react";
import { useActionState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { formatMoney } from "@/lib/dinero";
import { formatearFecha } from "@/lib/fecha";
import {
  crearRequisicionAction,
  editarRequisicionAction,
  rechazarRequisicionAction,
  cancelarRequisicionAction,
  agregarCotizacionAction,
  seleccionarCotizacionAction,
  type RequisicionFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import { FormularioOrdenCompra } from "./formulario-orden-compra";
import type { FilaRequisicion, FilaCotizacion } from "@/lib/server/control-de-obra/requisiciones";

const ESTATUS_ESTILO: Record<string, string> = {
  PENDIENTE: "bg-amber-100 text-amber-800",
  EN_COTIZACION: "bg-blue-100 text-blue-700",
  CONVERTIDA: "bg-emerald-100 text-emerald-700",
  RECHAZADA: "bg-red-100 text-red-700",
  CANCELADA: "bg-black/[0.05] text-[var(--muted)]",
};

const ESTATUS_LABEL: Record<string, string> = {
  PENDIENTE: "Pendiente",
  EN_COTIZACION: "En cotización",
  CONVERTIDA: "Convertida en OC",
  RECHAZADA: "Rechazada",
  CANCELADA: "Cancelada",
};

const PRIORIDAD_ESTILO: Record<string, string> = {
  NORMAL: "bg-black/[0.05] text-[var(--muted)]",
  URGENTE: "bg-red-100 text-red-700",
};

const ESTATUS_EDITABLES = ["PENDIENTE", "EN_COTIZACION"];

export function RequisicionesView({
  proyectoId,
  semanaId,
  requisiciones,
  proveedores,
  puedeAutorizar,
  verPrivado,
}: {
  proyectoId: string;
  semanaId: string;
  requisiciones: FilaRequisicion[];
  proveedores: { id: string; nombre: string }[];
  puedeAutorizar: boolean;
  verPrivado: boolean;
}) {
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<FilaRequisicion | null>(null);
  const [cotizandoPara, setCotizandoPara] = useState<FilaRequisicion | null>(null);
  const [generandoOCPara, setGenerandoOCPara] = useState<FilaRequisicion | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Requisiciones</h2>
        <Button onClick={() => setModalAbierto(true)}>+ Nueva requisición</Button>
      </div>

      {requisiciones.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">Todavía no hay requisiciones.</Card>
      ) : (
        <div className="space-y-3">
          {requisiciones.map((r) => {
            const seleccionada = r.cotizaciones.find((c) => c.seleccionada) ?? null;
            return (
              <Card key={r.id} className="enter overflow-hidden">
                <details>
                  <summary className="cursor-pointer list-none px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[var(--foreground)]">{r.concepto}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
                          {r.cantidad} {r.unidad} · {formatearFecha(new Date(r.fecha))} · {r.solicitantePorNombre}
                          <span className={`rounded-full px-2 py-0.5 ${ESTATUS_ESTILO[r.estatus]}`}>
                            {ESTATUS_LABEL[r.estatus]}
                          </span>
                          {r.prioridad === "URGENTE" && (
                            <span className={`rounded-full px-2 py-0.5 ${PRIORIDAD_ESTILO.URGENTE}`}>Urgente</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </summary>

                  <div className="space-y-4 border-t border-[var(--border)] px-5 py-4">
                    {r.descripcion && <p className="text-sm text-[var(--muted)]">{r.descripcion}</p>}
                    {r.comentarios && (
                      <p className="text-sm text-[var(--muted)]">
                        <span className="font-medium text-[var(--foreground)]">Comentarios: </span>
                        {r.comentarios}
                      </p>
                    )}
                    {r.evidenciaRef && (
                      <a
                        href={`/api/control-de-obra/proyectos/${proyectoId}/requisiciones/${r.id}/evidencia`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-[var(--brand)] hover:underline"
                      >
                        Ver evidencia
                      </a>
                    )}
                    {r.estatus === "RECHAZADA" && r.motivoRechazo && (
                      <p className="text-sm text-red-700">Rechazada: {r.motivoRechazo}</p>
                    )}
                    {r.estatus === "CANCELADA" && r.motivoRechazo && (
                      <p className="text-sm text-[var(--muted)]">Cancelada: {r.motivoRechazo}</p>
                    )}
                    {r.ordenCompraFolio && (
                      <p className="text-sm text-emerald-700">Orden de Compra generada: {r.ordenCompraFolio}</p>
                    )}

                    <div>
                      <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
                        Cotizaciones
                      </p>
                      {r.cotizaciones.length === 0 ? (
                        <p className="text-sm text-[var(--muted)]">Todavía no hay cotizaciones.</p>
                      ) : (
                        <div className="space-y-2">
                          {r.cotizaciones.map((c) => (
                            <FilaCotizacionUI
                              key={c.id}
                              proyectoId={proyectoId}
                              cotizacion={c}
                              puedeSeleccionar={puedeAutorizar && ESTATUS_EDITABLES.includes(r.estatus)}
                            />
                          ))}
                        </div>
                      )}
                      {ESTATUS_EDITABLES.includes(r.estatus) && (
                        <button
                          type="button"
                          onClick={() => setCotizandoPara(r)}
                          className="mt-2 text-sm font-medium text-[var(--brand)] hover:underline"
                        >
                          + Agregar cotización
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3">
                      {ESTATUS_EDITABLES.includes(r.estatus) && (
                        <button
                          type="button"
                          onClick={() => setEditando(r)}
                          className="text-sm font-medium text-[var(--brand)] hover:underline"
                        >
                          Editar
                        </button>
                      )}
                      {seleccionada && puedeAutorizar && ESTATUS_EDITABLES.includes(r.estatus) && (
                        <button
                          type="button"
                          onClick={() => setGenerandoOCPara(r)}
                          className="text-sm font-medium text-emerald-700 hover:underline"
                        >
                          Generar Orden de Compra
                        </button>
                      )}
                      {ESTATUS_EDITABLES.includes(r.estatus) && puedeAutorizar && (
                        <BotonMotivo
                          label="Rechazar"
                          claseTexto="text-red-700"
                          action={rechazarRequisicionAction.bind(null, proyectoId, r.id)}
                        />
                      )}
                      {ESTATUS_EDITABLES.includes(r.estatus) && (
                        <BotonMotivo
                          label="Cancelar"
                          claseTexto="text-[var(--muted)]"
                          action={cancelarRequisicionAction.bind(null, proyectoId, r.id)}
                        />
                      )}
                    </div>
                  </div>
                </details>
              </Card>
            );
          })}
        </div>
      )}

      {(modalAbierto || editando) && (
        <FormularioRequisicion
          proyectoId={proyectoId}
          requisicion={editando}
          onClose={() => {
            setModalAbierto(false);
            setEditando(null);
          }}
        />
      )}

      {cotizandoPara && (
        <FormularioCotizacion
          proyectoId={proyectoId}
          requisicionId={cotizandoPara.id}
          proveedores={proveedores}
          onClose={() => setCotizandoPara(null)}
        />
      )}

      {generandoOCPara && (() => {
        const seleccionada = generandoOCPara.cotizaciones.find((c) => c.seleccionada);
        if (!seleccionada) return null;
        return (
          <FormularioOrdenCompra
            proyectoId={proyectoId}
            semanaId={semanaId}
            proveedores={[]}
            orden={null}
          verPrivado={verPrivado}
            requisicion={{
              id: generandoOCPara.id,
              concepto: generandoOCPara.concepto,
              cantidad: generandoOCPara.cantidad,
              unidad: generandoOCPara.unidad,
              cotizacionSeleccionada: {
                proveedorBeneficiarioId: seleccionada.proveedorBeneficiarioId,
                proveedorNombre: seleccionada.proveedorNombre,
                importe: seleccionada.importe,
              },
            }}
            onClose={() => setGenerandoOCPara(null)}
          />
        );
      })()}
    </div>
  );
}

function FilaCotizacionUI({
  proyectoId,
  cotizacion,
  puedeSeleccionar,
}: {
  proyectoId: string;
  cotizacion: FilaCotizacion;
  puedeSeleccionar: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 ${
        cotizacion.seleccionada ? "border-emerald-300 bg-emerald-50" : "border-[var(--border)]"
      }`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--foreground)]">
          {cotizacion.proveedorNombre}
          {cotizacion.seleccionada && <span className="ml-2 text-xs font-medium text-emerald-700">Seleccionada</span>}
        </p>
        <p className="text-xs text-[var(--muted)]">
          {formatMoney(cotizacion.importe)}
          {cotizacion.tiempoEntregaDias && ` · Entrega: ${cotizacion.tiempoEntregaDias} días`}
          {cotizacion.vigenciaHasta && ` · Vigente hasta ${formatearFecha(new Date(cotizacion.vigenciaHasta))}`}
        </p>
        {cotizacion.observaciones && <p className="text-xs text-[var(--muted)]">{cotizacion.observaciones}</p>}
      </div>
      <div className="flex items-center gap-3">
        {cotizacion.archivoRef && (
          <a
            href={`/api/control-de-obra/proyectos/${proyectoId}/cotizaciones/${cotizacion.id}/archivo`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-[var(--brand)] hover:underline"
          >
            Ver archivo
          </a>
        )}
        {puedeSeleccionar && !cotizacion.seleccionada && (
          <button
            type="button"
            onClick={() => seleccionarCotizacionAction(proyectoId, cotizacion.id)}
            className="text-xs font-medium text-[var(--brand)] hover:underline"
          >
            Seleccionar
          </button>
        )}
      </div>
    </div>
  );
}

function BotonMotivo({
  label,
  claseTexto,
  action,
}: {
  label: string;
  claseTexto: string;
  action: (state: RequisicionFormState, formData: FormData) => Promise<RequisicionFormState>;
}) {
  const [mostrar, setMostrar] = useState(false);
  const [state, formAction, pending] = useActionState<RequisicionFormState, FormData>(action, undefined);

  if (!mostrar) {
    return (
      <button type="button" onClick={() => setMostrar(true)} className={`text-sm font-medium hover:underline ${claseTexto}`}>
        {label}
      </button>
    );
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input
        name="motivo"
        required
        placeholder="Motivo"
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs"
      />
      <button type="submit" disabled={pending} className={`text-sm font-medium hover:underline disabled:opacity-50 ${claseTexto}`}>
        {pending ? "Guardando…" : "Confirmar"}
      </button>
      {state?.error && <p className="text-xs text-red-700">{state.error}</p>}
    </form>
  );
}

function FormularioRequisicion({
  proyectoId,
  requisicion,
  onClose,
}: {
  proyectoId: string;
  requisicion: FilaRequisicion | null;
  onClose: () => void;
}) {
  const action = requisicion
    ? editarRequisicionAction.bind(null, proyectoId, requisicion.id)
    : crearRequisicionAction.bind(null, proyectoId);
  const [state, formAction, pending] = useActionState<RequisicionFormState, FormData>(action, undefined);
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.guardada) onClose();
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
          {requisicion ? "Editar requisición" : "Nueva requisición"}
        </h2>

        <form action={formAction} className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Concepto / necesidad</label>
            <input
              name="concepto"
              type="text"
              required
              defaultValue={requisicion?.concepto ?? ""}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Cantidad</label>
              <input
                name="cantidad"
                type="number"
                step="0.001"
                min="0.001"
                required
                defaultValue={requisicion?.cantidad ?? ""}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Unidad</label>
              <input
                name="unidad"
                type="text"
                required
                defaultValue={requisicion?.unidad ?? ""}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Descripción (opcional)</label>
            <textarea
              name="descripcion"
              rows={2}
              defaultValue={requisicion?.descripcion ?? ""}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Prioridad</label>
              <select
                name="prioridad"
                defaultValue={requisicion?.prioridad ?? "NORMAL"}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              >
                <option value="NORMAL">Normal</option>
                <option value="URGENTE">Urgente</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">
                Fecha requerida (opcional)
              </label>
              <input
                name="fechaRequerida"
                type="date"
                defaultValue={requisicion?.fechaRequerida?.slice(0, 10) ?? ""}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Comentarios (opcional)</label>
            <textarea
              name="comentarios"
              rows={2}
              defaultValue={requisicion?.comentarios ?? ""}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Foto/evidencia (opcional)</label>
            <FileInput
              name="evidencia"
              accept="image/*,application/pdf"
              className="w-full text-sm text-[var(--foreground)]"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : requisicion ? "Guardar cambios" : "Guardar requisición"}
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
            >
              Cancelar
            </button>
          </div>
          {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
        </form>
      </Card>
    </div>,
    document.body
  );
}

function FormularioCotizacion({
  proyectoId,
  requisicionId,
  proveedores,
  onClose,
}: {
  proyectoId: string;
  requisicionId: string;
  proveedores: { id: string; nombre: string }[];
  onClose: () => void;
}) {
  const action = agregarCotizacionAction.bind(null, proyectoId, requisicionId);
  const [state, formAction, pending] = useActionState<RequisicionFormState, FormData>(action, undefined);
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.guardada) onClose();
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
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Agregar cotización</h2>

        <form action={formAction} className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Proveedor</label>
            <select
              name="proveedorBeneficiarioId"
              required
              defaultValue=""
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
            >
              <option value="" disabled>
                Selecciona…
              </option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Importe</label>
              <input
                name="importe"
                type="number"
                step="0.01"
                min="0.01"
                required
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">
                Tiempo de entrega (días, opcional)
              </label>
              <input
                name="tiempoEntregaDias"
                type="number"
                step="1"
                min="1"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">Vigencia hasta (opcional)</label>
            <input
              name="vigenciaHasta"
              type="date"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">
              Observaciones/condiciones (opcional)
            </label>
            <textarea
              name="observaciones"
              rows={2}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">
              Archivo de cotización (opcional)
            </label>
            <FileInput
              name="archivo"
              accept="image/*,application/pdf"
              className="w-full text-sm text-[var(--foreground)]"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Guardar cotización"}
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
            >
              Cancelar
            </button>
          </div>
          {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
        </form>
      </Card>
    </div>,
    document.body
  );
}

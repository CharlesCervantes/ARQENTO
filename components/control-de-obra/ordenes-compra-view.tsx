"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/dinero";
import { formatearFecha } from "@/lib/fecha";
import {
  autorizarOrdenCompraAction,
  rechazarOrdenCompraAction,
  cancelarOrdenCompraAction,
  type OrdenCompraFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import { FormularioOrdenCompra } from "./formulario-orden-compra";
import { FormularioGastoDesdeOC } from "./formulario-gasto-desde-oc";
import { FormularioRecepcionOC } from "./formulario-recepcion-oc";
import type { FilaOrdenCompra } from "@/lib/server/control-de-obra/ordenes-compra";

const ESTATUS_ESTILO: Record<string, string> = {
  BORRADOR: "bg-black/[0.05] text-[var(--muted)]",
  PENDIENTE_AUTORIZACION: "bg-amber-100 text-amber-800",
  AUTORIZADA: "bg-emerald-100 text-emerald-700",
  RECHAZADA: "bg-red-100 text-red-700",
  CANCELADA: "bg-black/[0.05] text-[var(--muted)]",
};

const ESTATUS_LABEL: Record<string, string> = {
  BORRADOR: "Borrador",
  PENDIENTE_AUTORIZACION: "Pendiente de autorización",
  AUTORIZADA: "Autorizada",
  RECHAZADA: "Rechazada",
  CANCELADA: "Cancelada",
};

// Recepción — SIEMPRE un indicador separado de estatus/estatusPago (Compras,
// septiembre 2026), nunca combinado en una sola insignia.
const RECEPCION_ESTILO: Record<string, string> = {
  PENDIENTE: "bg-black/[0.05] text-[var(--muted)]",
  PARCIAL: "bg-amber-100 text-amber-800",
  COMPLETA: "bg-emerald-100 text-emerald-700",
};

const RECEPCION_LABEL: Record<string, string> = {
  PENDIENTE: "Recepción pendiente",
  PARCIAL: "Recibido parcial",
  COMPLETA: "Recibido completo",
};

export function OrdenesCompraView({
  proyectoId,
  semanaId,
  ordenes,
  proveedores,
  puedeAutorizar,
  verPrivado,
}: {
  proyectoId: string;
  semanaId: string;
  ordenes: FilaOrdenCompra[];
  proveedores: { id: string; nombre: string }[];
  puedeAutorizar: boolean;
  verPrivado: boolean;
}) {
  const [modalAbierto, setModalAbierto] = useState(false);
  const [ordenEditando, setOrdenEditando] = useState<FilaOrdenCompra | null>(null);
  const [ordenParaGasto, setOrdenParaGasto] = useState<FilaOrdenCompra | null>(null);
  const [ordenParaRecepcion, setOrdenParaRecepcion] = useState<FilaOrdenCompra | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Órdenes de compra</h2>
        <Button onClick={() => setModalAbierto(true)}>+ Nueva orden de compra</Button>
      </div>

      {ordenes.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay órdenes de compra esta semana.
        </Card>
      ) : (
        <div className="space-y-3">
          {ordenes.map((oc) => (
            <Card key={oc.id} className="enter overflow-hidden">
              <details>
                <summary className="cursor-pointer list-none px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[var(--foreground)]">
                        {oc.folio} · {oc.proveedorNombre}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
                        {formatearFecha(new Date(oc.fecha))}
                        <span className={`rounded-full px-2 py-0.5 ${ESTATUS_ESTILO[oc.estatus]}`}>
                          {ESTATUS_LABEL[oc.estatus]}
                        </span>
                        {oc.estatusPago && <span>Pago: {oc.estatusPago}</span>}
                        {oc.estatus === "AUTORIZADA" && (
                          <span className={`rounded-full px-2 py-0.5 ${RECEPCION_ESTILO[oc.estatusRecepcion]}`}>
                            {RECEPCION_LABEL[oc.estatusRecepcion]}
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="text-lg font-semibold tabular-nums text-[var(--foreground)]">
                      {formatMoney(oc.total)}
                    </p>
                  </div>
                </summary>

                <div className="border-t border-[var(--border)] px-5 py-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-[var(--muted)]">
                        <th className="pb-2 font-medium">Concepto</th>
                        <th className="pb-2 font-medium">Unidad</th>
                        <th className="pb-2 text-right font-medium">Cantidad</th>
                        <th className="pb-2 text-right font-medium">P.U.</th>
                        <th className="pb-2 text-right font-medium">Importe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {oc.detalle.map((l) => (
                        <tr key={l.id} className="border-t border-[var(--border)]/60">
                          <td className="py-1.5">{l.concepto}</td>
                          <td className="py-1.5 text-[var(--muted)]">{l.unidad}</td>
                          <td className="py-1.5 text-right tabular-nums">{l.cantidad}</td>
                          <td className="py-1.5 text-right tabular-nums">
                            {formatMoney(l.precioUnitario)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {formatMoney(l.importe)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {oc.estatus === "PENDIENTE_AUTORIZACION" && (
                      <button
                        type="button"
                        onClick={() => setOrdenEditando(oc)}
                        className="text-sm font-medium text-[var(--brand)] hover:underline"
                      >
                        Editar
                      </button>
                    )}
                    {oc.estatus === "PENDIENTE_AUTORIZACION" && puedeAutorizar && (
                      <>
                        <BotonAutorizar proyectoId={proyectoId} ocId={oc.id} />
                        <BotonRechazar proyectoId={proyectoId} ocId={oc.id} />
                      </>
                    )}
                    {oc.estatus === "PENDIENTE_AUTORIZACION" && (
                      <button
                        type="button"
                        onClick={() => cancelarOrdenCompraAction(proyectoId, oc.id)}
                        className="text-sm text-[var(--muted)] hover:underline"
                      >
                        Cancelar
                      </button>
                    )}
                    {oc.estatus === "AUTORIZADA" && puedeAutorizar && !oc.tieneGastoGenerado && (
                      <button
                        type="button"
                        onClick={() => setOrdenParaGasto(oc)}
                        className="text-sm font-medium text-[var(--brand)] hover:underline"
                      >
                        Registrar gasto real
                      </button>
                    )}
                    {oc.estatus === "AUTORIZADA" && oc.estatusRecepcion !== "COMPLETA" && (
                      <button
                        type="button"
                        onClick={() => setOrdenParaRecepcion(oc)}
                        className="text-sm font-medium text-[var(--brand)] hover:underline"
                      >
                        Marcar recepción
                      </button>
                    )}
                    <a
                      href={`/api/control-de-obra/proyectos/${proyectoId}/ordenes-compra/${oc.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-[var(--muted)] hover:underline"
                    >
                      Descargar PDF
                    </a>
                  </div>
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}

      {(modalAbierto || ordenEditando) && (
        <FormularioOrdenCompra
          proyectoId={proyectoId}
          semanaId={semanaId}
          proveedores={proveedores}
          orden={ordenEditando}
          verPrivado={verPrivado}
          onClose={() => {
            setModalAbierto(false);
            setOrdenEditando(null);
          }}
        />
      )}

      {ordenParaGasto && (
        <FormularioGastoDesdeOC
          proyectoId={proyectoId}
          orden={ordenParaGasto}
          onClose={() => setOrdenParaGasto(null)}
        />
      )}

      {ordenParaRecepcion && (
        <FormularioRecepcionOC
          proyectoId={proyectoId}
          orden={ordenParaRecepcion}
          onClose={() => setOrdenParaRecepcion(null)}
        />
      )}
    </div>
  );
}

function BotonAutorizar({ proyectoId, ocId }: { proyectoId: string; ocId: string }) {
  const action = autorizarOrdenCompraAction.bind(null, proyectoId, ocId);
  const [state, formAction, pending] = useActionState<OrdenCompraFormState, FormData>(
    action,
    undefined
  );
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="text-sm font-medium text-emerald-700 hover:underline disabled:opacity-50"
      >
        {pending ? "Autorizando…" : "Autorizar"}
      </button>
      {state?.error && <p className="mt-1 text-xs text-red-700">{state.error}</p>}
    </form>
  );
}

function BotonRechazar({ proyectoId, ocId }: { proyectoId: string; ocId: string }) {
  const [mostrarMotivo, setMostrarMotivo] = useState(false);
  const action = rechazarOrdenCompraAction.bind(null, proyectoId, ocId);
  const [state, formAction, pending] = useActionState<OrdenCompraFormState, FormData>(
    action,
    undefined
  );

  if (!mostrarMotivo) {
    return (
      <button
        type="button"
        onClick={() => setMostrarMotivo(true)}
        className="text-sm font-medium text-red-700 hover:underline"
      >
        Rechazar
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
      <button
        type="submit"
        disabled={pending}
        className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Confirmar"}
      </button>
      {state?.error && <p className="text-xs text-red-700">{state.error}</p>}
    </form>
  );
}

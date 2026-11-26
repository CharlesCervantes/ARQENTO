"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/dinero";
import { formatearFecha } from "@/lib/fecha";
import { CATEGORIA_GASTO_LABEL } from "@/lib/control-de-obra/categorias-gasto";
import { EstadoPagoBadge } from "@/components/reporte-general/estado-pago-badge";
import type { EstatusPago } from "@/lib/generated/prisma/enums";
import {
  enviarGastoARevisionAction,
  aprobarGastoAction,
  rechazarGastoAction,
  cancelarGastoAction,
  registrarAbonoReposicionAction,
  type AprobarGastoFormState,
  type RechazarGastoFormState,
  type CancelarGastoFormState,
  type AbonoReposicionFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import { FormularioGasto } from "./formulario-gasto";
import type { FilaGasto, DashboardGastos } from "@/lib/server/control-de-obra/gastos";
import type { FilaReposicion } from "@/lib/server/control-de-obra/reposiciones";

const METODO_PAGO_LABEL: Record<string, string> = {
  EFECTIVO: "Efectivo",
  TRANSFERENCIA: "Transferencia",
  TARJETA_DEBITO: "Tarjeta débito",
  TARJETA_CREDITO: "Tarjeta crédito",
};

const ESTATUS_GASTO_ESTILO: Record<string, string> = {
  BORRADOR: "bg-black/[0.05] text-[var(--muted)]",
  PENDIENTE_REVISION: "bg-amber-100 text-amber-800",
  APROBADO: "bg-emerald-100 text-emerald-700",
  RECHAZADO: "bg-red-100 text-red-700",
  CANCELADO: "bg-black/[0.05] text-[var(--muted)]",
};

const ESTATUS_GASTO_LABEL: Record<string, string> = {
  BORRADOR: "Borrador",
  PENDIENTE_REVISION: "Pendiente de revisión",
  APROBADO: "Aprobado",
  RECHAZADO: "Rechazado",
  CANCELADO: "Cancelado",
};

// La Reposición ya no es un segundo flujo de aprobación — es el agrupador de
// pago que aprobarGasto arma solo. Esta vista solo consulta/lee la sección
// Reposiciones; su única acción es Aprobar/Rechazar por gasto (colapso de
// doble aprobación Gastos→Reposiciones, agosto 2026).
export function GastosReposicionesView({
  proyectoId,
  semanaId,
  gastos,
  reposiciones,
  beneficiarios,
  beneficiarioVinculado,
  dashboard,
  puedeAprobar,
  pagadorFijo,
  puedeRegistrarAbono,
  usuarioId,
  verPrivado,
}: {
  proyectoId: string;
  semanaId: string;
  gastos: FilaGasto[];
  reposiciones: FilaReposicion[];
  beneficiarios: { id: string; nombre: string; tipo: string }[];
  beneficiarioVinculado: { id: string; nombre: string } | null;
  dashboard: DashboardGastos;
  puedeAprobar: boolean;
  // Supervisor: sus gastos siempre quedan pagados por él (lo fija el servidor).
  pagadorFijo: boolean;
  puedeRegistrarAbono: boolean;
  usuarioId: string;
  verPrivado: boolean;
}) {
  const [modalNuevoGasto, setModalNuevoGasto] = useState(false);
  const [gastoEditando, setGastoEditando] = useState<FilaGasto | null>(null);
  const [rechazandoGasto, setRechazandoGasto] = useState<string | null>(null);
  const [cancelandoGasto, setCancelandoGasto] = useState<FilaGasto | null>(null);

  // Un gasto ya asignado a una reposición vive visualmente en la sección
  // Reposiciones de abajo — mostrarlo también aquí lo duplicaría. Un
  // aprobado pagado directo por "La empresa" nunca genera reposición, así
  // que sigue viéndose aquí (es el único lugar donde vive).
  const gastosVisibles = gastos.filter((g) => !g.reposicionGastosId);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Indicador etiqueta="Capturados" valor={dashboard.capturados} />
        <Indicador
          etiqueta="Pendientes de revisión"
          valor={dashboard.pendientesRevision}
          resaltar={dashboard.pendientesRevision > 0}
        />
        <Indicador etiqueta="Aprobados" valor={dashboard.aprobados} />
        <Indicador etiqueta="Total aprobado" valor={formatMoney(dashboard.totalAprobado)} />
        <Indicador etiqueta="Reposiciones" valor={reposiciones.length} />
        <Indicador
          etiqueta="Reposiciones liquidadas"
          valor={reposiciones.filter((r) => r.estatusPago === "LIQUIDADO").length}
        />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Gastos</h2>
        <Button onClick={() => setModalNuevoGasto(true)}>+ Nuevo gasto</Button>
      </div>

      {gastosVisibles.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay gastos capturados esta semana.
        </Card>
      ) : (
        <div className="space-y-3">
          {gastosVisibles.map((g) => {
            const puedeEditar =
              (g.estatus === "BORRADOR" || g.estatus === "PENDIENTE_REVISION") &&
              (g.capturadoPorId === usuarioId || puedeAprobar);

            return (
              <Card key={g.id} className="enter p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-[var(--foreground)]">{g.descripcion}</p>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${ESTATUS_GASTO_ESTILO[g.estatus]}`}
                      >
                        {ESTATUS_GASTO_LABEL[g.estatus]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {formatearFecha(new Date(g.fecha))} ·{" "}
                      {CATEGORIA_GASTO_LABEL[g.categoria as keyof typeof CATEGORIA_GASTO_LABEL] ??
                        g.categoria}{" "}
                      · {METODO_PAGO_LABEL[g.metodoPago] ?? g.metodoPago}
                      {g.pagadorNombre && ` · Pagó: ${g.pagadorNombre}`}
                      {g.proveedorNombre && ` · Proveedor: ${g.proveedorNombre}`}
                    </p>
                    {g.comentario && (
                      <p className="mt-1 text-sm text-[var(--muted)]">{g.comentario}</p>
                    )}
                    {(g.estatus === "RECHAZADO" || g.estatus === "CANCELADO") && g.motivoRechazo && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-sm font-medium text-red-700 select-none">
                          Ver motivo
                        </summary>
                        <p className="mt-1 text-sm text-red-700">{g.motivoRechazo}</p>
                      </details>
                    )}
                    {g.detalle.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-sm font-medium text-[var(--brand)] select-none">
                          Ver detalle ({g.detalle.length} línea{g.detalle.length === 1 ? "" : "s"})
                        </summary>
                        <ul className="mt-1 space-y-0.5 text-xs text-[var(--muted)]">
                          {g.detalle.map((l, i) => (
                            <li key={i} className="flex justify-between gap-2">
                              <span>
                                {l.descripcion} — {l.cantidad} {l.unidad} × {formatMoney(l.precioUnitario)}
                              </span>
                              <span className="tabular-nums">
                                {formatMoney(l.cantidad * l.precioUnitario)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      {g.ticketRef && (
                        <a
                          href={`/api/control-de-obra/proyectos/${proyectoId}/gastos/${g.id}/ticket`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--brand)] hover:underline"
                        >
                          Ver ticket
                        </a>
                      )}
                      {g.requiereFactura && (
                        <span className="text-[var(--muted)]">
                          Factura: {g.estatusFiscal === "FACTURADO" ? "recibida" : "pendiente"}
                        </span>
                      )}
                      {puedeEditar && (
                        <button
                          type="button"
                          onClick={() => setGastoEditando(g)}
                          className="text-[var(--brand)] hover:underline"
                        >
                          Editar
                        </button>
                      )}
                      {g.estatus === "BORRADOR" && puedeEditar && (
                        <button
                          type="button"
                          onClick={() => enviarGastoARevisionAction(proyectoId, g.id)}
                          className="text-[var(--brand)] hover:underline"
                        >
                          Enviar a revisión
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold tabular-nums text-[var(--foreground)]">
                      {formatMoney(g.monto)}
                    </p>
                    {g.estatus === "PENDIENTE_REVISION" && puedeAprobar && (
                      <div className="mt-2 flex flex-col items-end gap-1">
                        <BotonAprobarGasto proyectoId={proyectoId} gastoId={g.id} />
                        <button
                          type="button"
                          onClick={() => setRechazandoGasto(g.id)}
                          className="text-xs font-medium text-red-700 hover:underline"
                        >
                          Rechazar
                        </button>
                      </div>
                    )}
                    {g.estatus === "APROBADO" && puedeAprobar && (
                      <button
                        type="button"
                        onClick={() => setCancelandoGasto(g)}
                        className="mt-2 text-xs font-medium text-red-700 hover:underline"
                      >
                        Cancelar gasto
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold text-[var(--foreground)]">Reposiciones</h2>
        {reposiciones.length === 0 ? (
          <Card className="p-6 text-sm text-[var(--muted)]">
            Todavía no hay reposiciones esta semana — se crean solas al aprobar un gasto pagado
            personalmente.
          </Card>
        ) : (
          <div className="space-y-3">
            {reposiciones.map((r) => (
              <Card key={r.id} className="enter p-4">
                <details>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 select-none [&::-webkit-details-marker]:hidden">
                    <div>
                      <p className="font-medium text-[var(--foreground)]">
                        {r.folio} · {r.beneficiarioNombre}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {r.cantidadGastos} gasto{r.cantidadGastos === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {r.esParcial && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          Reposición parcial
                        </span>
                      )}
                      {r.requiereRevision && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          Revisar abonos
                        </span>
                      )}
                      <p className="text-lg font-semibold tabular-nums text-[var(--foreground)]">
                        {formatMoney(r.total)}
                      </p>
                      <EstadoPagoBadge estatus={r.estatusPago as EstatusPago | null} />
                    </div>
                  </summary>

                  <div className="mt-3 border-t border-[var(--border)] pt-3">
                    {r.gastos.map((g) => (
                      <div key={g.id} className="flex items-center justify-between py-1 text-sm">
                        <span className="text-[var(--foreground)]">
                          {g.descripcion}{" "}
                          <span className="text-xs text-[var(--muted)]">
                            · {formatearFecha(new Date(g.fecha))}
                          </span>
                        </span>
                        <span className="tabular-nums text-[var(--foreground)]">
                          {formatMoney(g.monto)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* R2: una reposición con inconsistencias históricas (clase B)
                      muestra sus cifras tal cual, sin corregirlas, y no admite
                      abonos hasta revisarla. */}
                  {r.cerrada && !r.requiereRevision ? null : (
                    <div className="mt-3 border-t border-[var(--border)] pt-3">
                      <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="text-[var(--muted)]">Repuesto</span>
                        <span className="tabular-nums text-[var(--foreground)]">
                          {formatMoney(r.abonado)}
                        </span>
                      </div>
                      <div className="mb-2 flex items-center justify-between text-sm font-medium">
                        <span className="text-[var(--foreground)]">Saldo pendiente</span>
                        <span className="tabular-nums text-[var(--foreground)]">
                          {formatMoney(r.saldoPendiente)}
                        </span>
                      </div>
                      {r.abonos.length > 0 && (
                        <ul className="mb-2 space-y-0.5 text-xs text-[var(--muted)]">
                          {r.abonos.map((a) => (
                            <li key={a.id} className="flex items-center justify-between">
                              <span>
                                {formatearFecha(new Date(a.fecha))} · {a.registradoPorNombre}
                              </span>
                              <span className="tabular-nums">{formatMoney(a.monto)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {r.requiereRevision && (
                        <p className="mb-2 text-xs text-amber-800">
                          Los abonos, el cierre o el importe de esta reposición no coinciden. Requiere
                          revisión antes de registrar o liquidar pagos.
                        </p>
                      )}
                      {puedeRegistrarAbono && !r.requiereRevision && r.saldoPendiente > 0 && (
                        <FormularioAbonoReposicion
                          proyectoId={proyectoId}
                          reposicionGastosId={r.id}
                          saldoPendiente={r.saldoPendiente}
                        />
                      )}
                    </div>
                  )}
                </details>
              </Card>
            ))}
          </div>
        )}
      </div>

      {(modalNuevoGasto || gastoEditando) && (
        <FormularioGasto
          proyectoId={proyectoId}
          semanaId={semanaId}
          beneficiarios={beneficiarios}
          beneficiarioVinculado={beneficiarioVinculado}
          gasto={gastoEditando}
          verPrivado={verPrivado}
          pagadorFijo={pagadorFijo}
          onClose={() => {
            setModalNuevoGasto(false);
            setGastoEditando(null);
          }}
        />
      )}

      {rechazandoGasto && (
        <ModalMotivoRechazo
          proyectoId={proyectoId}
          gastoId={rechazandoGasto}
          onClose={() => setRechazandoGasto(null)}
        />
      )}

      {cancelandoGasto && (
        <ModalCancelarGasto
          proyectoId={proyectoId}
          gasto={cancelandoGasto}
          onClose={() => setCancelandoGasto(null)}
        />
      )}
    </div>
  );
}

function Indicador({
  etiqueta,
  valor,
  resaltar,
}: {
  etiqueta: string;
  valor: string | number;
  resaltar?: boolean;
}) {
  return (
    <Card className="p-3">
      <p className="text-[11px] text-[var(--muted)]">{etiqueta}</p>
      <p
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          resaltar ? "text-amber-600" : "text-[var(--foreground)]"
        }`}
      >
        {valor}
      </p>
    </Card>
  );
}

function BotonAprobarGasto({ proyectoId, gastoId }: { proyectoId: string; gastoId: string }) {
  const action = aprobarGastoAction.bind(null, proyectoId, gastoId);
  const [state, formAction, pending] = useActionState<AprobarGastoFormState, FormData>(
    action,
    undefined
  );
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-emerald-700 hover:underline disabled:opacity-50"
      >
        {pending ? "Aprobando…" : "Aprobar"}
      </button>
      {state?.error && <p className="mt-1 text-[10px] text-red-700">{state.error}</p>}
    </form>
  );
}

function FormularioAbonoReposicion({
  proyectoId,
  reposicionGastosId,
  saldoPendiente,
}: {
  proyectoId: string;
  reposicionGastosId: string;
  saldoPendiente: number;
}) {
  const action = registrarAbonoReposicionAction.bind(null, proyectoId, reposicionGastosId);
  const [state, formAction, pending] = useActionState<AbonoReposicionFormState, FormData>(
    action,
    undefined
  );
  const hoy = new Date().toISOString().slice(0, 10);

  if (state?.guardado) {
    return <p className="text-sm text-emerald-700">Abono registrado ✓</p>;
  }

  return (
    <form action={formAction} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <input
        name="monto"
        type="number"
        step="0.01"
        min="0.01"
        max={saldoPendiente}
        required
        placeholder={`Monto (máx. ${formatMoney(saldoPendiente)})`}
        className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm sm:col-span-1"
      />
      <input
        name="fecha"
        type="date"
        required
        defaultValue={hoy}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm"
      />
      <select
        name="metodoPago"
        required
        defaultValue=""
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm"
      >
        <option value="" disabled>
          Método
        </option>
        {Object.entries(METODO_PAGO_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={pending} className="px-3 py-2 text-xs">
        {pending ? "Guardando…" : "Registrar abono"}
      </Button>
      {state?.error && <p className="col-span-full text-xs text-red-700">{state.error}</p>}
    </form>
  );
}

function ModalMotivoRechazo({
  proyectoId,
  gastoId,
  onClose,
}: {
  proyectoId: string;
  gastoId: string;
  onClose: () => void;
}) {
  const bound = rechazarGastoAction.bind(null, proyectoId, gastoId);
  const [state, formAction, pending] = useActionState<RechazarGastoFormState, FormData>(
    bound,
    undefined
  );
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state && !state.error) onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="enter w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Rechazar gasto</h2>
        <form action={formAction} className="mt-4 space-y-3">
          <textarea
            name="motivo"
            rows={3}
            required
            placeholder="Motivo del rechazo"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
          />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Rechazar"}
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

// Cancelar un gasto ya aprobado (Administrador/Director). El servidor decide
// si se puede: lo niega si su reposición ya tiene pagos, si ya se cobró en
// una estimación emitida, si viene de una orden de compra o si Contabilidad
// ya registró su pago — y en ese caso no cambia nada.
function ModalCancelarGasto({ proyectoId, gasto, onClose }: { proyectoId: string; gasto: FilaGasto; onClose: () => void }) {
  const bound = cancelarGastoAction.bind(null, proyectoId, gasto.id);
  const [state, formAction, pending] = useActionState<CancelarGastoFormState, FormData>(bound, undefined);
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.cancelado) onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="enter w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Cancelar gasto aprobado</h2>
        <p className="mt-1 text-sm text-[var(--foreground)]">
          {gasto.descripcion} · <span className="tabular-nums">{formatMoney(gasto.monto)}</span>
          {gasto.pagadorNombre && ` · Pagó: ${gasto.pagadorNombre}`}
        </p>
        <p className="mt-2 text-xs text-[var(--muted)]">
          El gasto no se borra: queda «Cancelado» con este motivo. Si estaba en una reposición sin pagar, sale de
          ella y se ajusta lo pendiente en Reporte General. Quien lo capturó puede volver a subirlo bien.
        </p>
        <form action={formAction} className="mt-4 space-y-3">
          <label htmlFor="motivo-cancelacion" className="block text-sm font-medium text-[var(--foreground)]">
            Motivo de la cancelación
          </label>
          <textarea
            id="motivo-cancelacion"
            name="motivo"
            rows={3}
            required
            maxLength={500}
            placeholder="Ej. No se indicó quién lo pagó; se vuelve a capturar."
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
          />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending} className="bg-red-700 hover:brightness-110">
              {pending ? "Cancelando…" : "Cancelar gasto"}
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
            >
              Volver
            </button>
          </div>
          {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
        </form>
      </Card>
    </div>,
    document.body
  );
}

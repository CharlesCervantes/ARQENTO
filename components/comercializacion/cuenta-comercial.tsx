"use client";

import { useActionState, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { AvisosArchivos, useArchivosDeCarga } from "./campo-archivos";
import { PanelLateral } from "./panel-lateral";
import { ACCION_EN_LINEA, BOTON_PRIMARIO, BOTON_SECUNDARIO } from "./estilos";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DetalleCuenta } from "@/lib/server/comercializacion/cuentas";
import { aCentavos, deCentavos, formatearImporte, normalizarImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { generarMensualidades, PLAZOS_MENSUALES, type CuotaGenerada, type PlazoMensual } from "@/lib/comercializacion/mensualidades";
import {
  ETIQUETA_LIQUIDACION,
  ETIQUETA_METODO,
  ETIQUETA_SITUACION,
  METODOS_PAGO,
  proponerAplicacion,
} from "@/lib/comercializacion/cuentas";
import {
  anularMovimientoAction,
  cambiarVencimientoAction,
  definirCondicionesAction,
  registrarMovimientoAction,
  type MovimientoState,
} from "@/app/(app)/comercializacion/actions";

// Cuenta por cobrar (OV) o por pagar (compra) — B5. Solo se arma para
// administración (las páginas no la consultan para el vendedor). Muestra
// saldos REALES: guardar condiciones no registra dinero; solo los cobros/pagos
// registrados reducen el saldo. El servidor recalcula y valida todo.
// Rediseño: registrar cobro/pago, definir condiciones y cambiar vencimiento
// se capturan en un panel que se abre al pedir la acción (mismos formularios
// y validaciones).

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });
const clave = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const ESTILO_SITUACION: Record<string, string> = {
  SIN_CALENDARIO: "bg-black/[0.06] text-[var(--muted)]",
  AL_CORRIENTE: "bg-emerald-50 text-emerald-800",
  VENCE_HOY: "bg-amber-50 text-amber-800",
  VENCIDA: "bg-red-50 text-red-700",
  LIQUIDADA: "bg-emerald-50 text-emerald-800",
};

function Etiqueta({ texto, estilo }: { texto: string; estilo: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${estilo}`}>{texto}</span>;
}

// El bloque de un gasto (B7) va dentro de su gasto, que ya lleva el ancla y el marco.
function Marco({ esGasto, id, children }: { esGasto: boolean; id: string; children: React.ReactNode }) {
  if (esGasto) return <div className="space-y-4">{children}</div>;
  return (
    <Card id={id} className="scroll-mt-6 space-y-4 p-5">
      {children}
    </Card>
  );
}

export function CuentaComercialView({ cuenta, contexto }: { cuenta: DetalleCuenta; contexto?: string }) {
  const esCobro = cuenta.tipo === "POR_COBRAR";
  const esGasto = cuenta.origen === "GASTO";
  const e = cuenta.estado;
  const [editandoCondiciones, setEditandoCondiciones] = useState(false);
  const [registrando, setRegistrando] = useState(false);
  const [cambiandoCuota, setCambiandoCuota] = useState<string | null>(null);
  const cerrarCondiciones = useCallback(() => setEditandoCondiciones(false), []);
  const cerrarRegistro = useCallback(() => setRegistrando(false), []);
  const cerrarVencimiento = useCallback(() => setCambiandoCuota(null), []);
  const cuotaEnCambio = e.cuotas.find((q) => q.id === cambiandoCuota) ?? null;
  const documento = contexto ?? cuenta.documento.folio;
  const activa = cuenta.estatus === "VIGENTE";
  const sinCalendario = e.situacion === "SIN_CALENDARIO";

  return (
    <Marco esGasto={esGasto} id={esCobro ? "cobros" : "pagos"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className={`${esGasto ? "text-base" : "text-lg"} font-semibold text-[var(--foreground)]`}>{esCobro ? "Cobros del cliente" : esGasto ? "Pagos del gasto" : "Pagos al proveedor"}</h2>
          <p className="text-sm text-[var(--muted)]">
            {esCobro
              ? "Aceptar la OV no significa que esté cobrada."
              : esGasto
                ? "Pagarlo no cambia el resultado estimado."
                : "Confirmar la compra no significa que esté pagada."}{" "}
            El saldo solo baja con {esCobro ? "cobros" : "pagos"} registrados.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activa && !sinCalendario && e.liquidacion !== "LIQUIDADA" && (
            <button type="button" className={BOTON_PRIMARIO} onClick={() => setRegistrando(true)}>
              {esCobro ? "Registrar cobro" : "Registrar pago"}
            </button>
          )}
          {!activa ? (
            <Etiqueta texto="Cuenta anulada" estilo="bg-red-50 text-red-700" />
          ) : (
            <>
              <Etiqueta texto={ETIQUETA_LIQUIDACION[e.liquidacion]} estilo={e.liquidacion === "LIQUIDADA" ? ESTILO_SITUACION.LIQUIDADA : "bg-black/[0.06] text-[var(--muted)]"} />
              {e.liquidacion !== "LIQUIDADA" && <Etiqueta texto={ETIQUETA_SITUACION[e.situacion]} estilo={ESTILO_SITUACION[e.situacion]} />}
            </>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          [esCobro ? "Total de venta" : esGasto ? "Total del gasto" : "Total de compra", e.total],
          [esCobro ? "Cobrado" : "Pagado", e.aplicado],
          ["Saldo", e.saldo],
          ["Vencido", e.vencido],
        ].map(([etiqueta, valor]) => (
          <div key={etiqueta}>
            <dt className="text-xs text-[var(--muted)]">{etiqueta}</dt>
            <dd className={`text-sm font-semibold tabular-nums ${etiqueta === "Vencido" && valor !== "0.00" ? "text-red-700" : ""}`}>{formatearImporte(valor)}</dd>
          </div>
        ))}
      </dl>
      {!activa && <p className="text-sm text-red-700">Cuenta anulada junto con {esGasto ? "el gasto" : "la compra"}: {cuenta.motivoAnulacion}. No suma al saldo por pagar.</p>}

      {/* Condiciones y calendario */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Condiciones:{" "}
            {cuenta.modalidad === "CONTADO" ? "contado" : cuenta.modalidad === "CREDITO" ? "crédito" : <span className="text-amber-800">por definir</span>}
          </h3>
          {activa && !cuenta.tuvoMovimientos && (
            <button type="button" onClick={() => setEditandoCondiciones(true)} className={sinCalendario ? BOTON_SECUNDARIO : ACCION_EN_LINEA}>
              {sinCalendario ? "Definir condiciones" : "Cambiar condiciones"}
            </button>
          )}
        </div>
        <PanelLateral abierto={editandoCondiciones} onCerrar={cerrarCondiciones} titulo={sinCalendario ? "Definir condiciones" : "Cambiar condiciones"} contexto={documento}>
          <FormularioCondiciones cuenta={cuenta} onListo={cerrarCondiciones} />
        </PanelLateral>
        {sinCalendario ? (
          <p className="text-sm text-[var(--muted)]">
            Condiciones por definir: el saldo completo sigue pendiente y no se considera vencido. Define contado o crédito para registrar{" "}
            {esCobro ? "cobros" : "pagos"}.
          </p>
        ) : (
          (
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead className="bg-black/[0.02]">
                  <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    <th className="border-b border-[var(--border)] px-3 py-2">Cuota</th>
                    <th className="border-b border-[var(--border)] px-3 py-2">Vence</th>
                    <th className="border-b border-[var(--border)] px-3 py-2 text-right">Importe</th>
                    <th className="border-b border-[var(--border)] px-3 py-2 text-right">{esCobro ? "Cobrado" : "Pagado"}</th>
                    <th className="border-b border-[var(--border)] px-3 py-2 text-right">Saldo</th>
                    <th className="border-b border-[var(--border)] px-3 py-2">Situación</th>
                    {activa && <th className="border-b border-[var(--border)] px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {e.cuotas.map((q) => (
                    <tr key={q.id} className="border-b border-[var(--border)] last:border-0" data-cuota={q.numero}>
                      <td className="px-3 py-2">{q.numero}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatearFechaCalendario(q.fechaVencimiento)}
                        {cuenta.vencimientos[q.id]?.cambios.length > 0 && (
                          <span className="block text-xs text-[var(--muted)]">Pactada: {formatearFechaCalendario(cuenta.vencimientos[q.id].fechaPactada)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatearImporte(q.importe)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatearImporte(q.aplicado)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatearImporte(q.saldo)}</td>
                      <td className="px-3 py-2">
                        <Etiqueta
                          texto={q.situacion === "LIQUIDADA" ? "Liquidada" : ETIQUETA_SITUACION[q.situacion]}
                          estilo={ESTILO_SITUACION[q.situacion]}
                        />
                      </td>
                      {activa && (
                        <td className="px-3 py-2 text-right">
                          {aCentavos(q.saldo) > BigInt(0) && (
                            <button type="button" onClick={() => setCambiandoCuota(q.id)} className={`${ACCION_EN_LINEA} whitespace-nowrap text-xs`}>
                              Cambiar vencimiento
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {cuenta.tuvoMovimientos && activa && (
          <p className="text-xs text-[var(--muted)]">
            El calendario completo ya no se sustituye porque la cuenta tiene {esCobro ? "cobros" : "pagos"} registrados; sí puedes cambiar el vencimiento de
            una cuota con saldo (sin cambiar importes ni aplicaciones).
          </p>
        )}
        {Object.values(cuenta.vencimientos).some((v) => v.cambios.length > 0) && (
          <details className="text-xs text-[var(--muted)]" data-historial-vencimientos>
            <summary className="cursor-pointer">
              Cambios de vencimiento ({Object.values(cuenta.vencimientos).reduce((s, v) => s + v.cambios.length, 0)})
            </summary>
            <ul className="mt-1 ml-4 list-disc">
              {e.cuotas.flatMap((q) =>
                (cuenta.vencimientos[q.id]?.cambios ?? []).map((h) => (
                  <li key={h.id}>
                    Cuota {q.numero}: {formatearFechaCalendario(h.fechaAnterior)} → {formatearFechaCalendario(h.fechaNueva)} · {h.motivo} · {h.porNombre},{" "}
                    {formatoFechaHora.format(new Date(h.en))}
                  </li>
                ))
              )}
            </ul>
          </details>
        )}
        {cuenta.calendariosAnteriores.length > 0 && (
          <details className="text-xs text-[var(--muted)]">
            <summary className="cursor-pointer">Calendarios anteriores ({cuenta.calendariosAnteriores.length} cuotas sustituidas)</summary>
            <ul className="mt-1 ml-4 list-disc">
              {cuenta.calendariosAnteriores.map((q, i) => (
                <li key={i}>
                  Cuota {q.numero}: {formatearFechaCalendario(q.fechaVencimiento)} · {formatearImporte(q.importe)} (sustituida{" "}
                  {formatoFechaHora.format(new Date(q.sustituidaEn))})
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <PanelLateral abierto={registrando} onCerrar={cerrarRegistro} titulo={esCobro ? "Registrar cobro" : "Registrar pago"} contexto={documento}>
        <FormularioMovimiento cuenta={cuenta} onListo={cerrarRegistro} />
      </PanelLateral>
      <PanelLateral abierto={cuotaEnCambio !== null} onCerrar={cerrarVencimiento} titulo="Cambiar vencimiento" contexto={cuotaEnCambio ? `${documento} · cuota ${cuotaEnCambio.numero}` : documento}>
        {cuotaEnCambio && <FormularioVencimiento cuenta={cuenta} cuota={cuotaEnCambio} onListo={cerrarVencimiento} />}
      </PanelLateral>

      {/* Historial */}
      <div className="space-y-2">
        <h3 className="text-base font-semibold">Historial de {esCobro ? "cobros" : "pagos"}</h3>
        {cuenta.movimientos.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Sin {esCobro ? "cobros" : "pagos"} registrados.</p>
        ) : (
          <ul className="space-y-2">
            {cuenta.movimientos.map((m) => (
              <Movimiento key={m.id} m={m} esCobro={esCobro} />
            ))}
          </ul>
        )}
      </div>
    </Marco>
  );
}

// B8B — cambiar el vencimiento de UNA cuota con saldo. Solo la fecha; el
// servidor valida (hoy en adelante, distinta, motivo) y detecta cambios
// simultáneos con la fecha leída.
function FormularioVencimiento({ cuenta, cuota, onListo }: { cuenta: DetalleCuenta; cuota: DetalleCuenta["estado"]["cuotas"][number]; onListo: () => void }) {
  const router = useRouter();
  const [nuevaFecha, setNuevaFecha] = useState("");
  const [motivo, setMotivo] = useState("");
  const [claveRegistro] = useState(clave);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  return (
    <div className="flex flex-col gap-4 text-sm" data-formulario-vencimiento>
      <p className="text-sm text-[var(--muted)]">
        Cuota {cuota.numero}: vence {formatearFechaCalendario(cuota.fechaVencimiento)}, saldo {formatearImporte(cuota.saldo)}. Solo cambia esta fecha: el importe,
        las demás cuotas y los {cuenta.tipo === "POR_COBRAR" ? "cobros" : "pagos"} aplicados no cambian.
      </p>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Nueva fecha</span>
          <Input type="date" value={nuevaFecha} min={cuenta.hoy} onChange={(ev) => setNuevaFecha(ev.target.value)} aria-label={`Nueva fecha de la cuota ${cuota.numero}`} className="w-44" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Motivo (obligatorio)</span>
          <Input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} maxLength={500} placeholder="Motivo (obligatorio)" aria-label={`Motivo del cambio de la cuota ${cuota.numero}`} />
        </label>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={BOTON_PRIMARIO}
          disabled={pendiente || !nuevaFecha || motivo.trim().length < 3}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await cambiarVencimientoAction({ cuotaId: cuota.id, fechaLeida: cuota.fechaVencimiento, nuevaFecha, motivo, clave: claveRegistro });
              if (r.error) return setError(r.error);
              onListo();
              router.refresh();
            })
          }
        >
          {pendiente ? "Guardando…" : "Guardar vencimiento"}
        </button>
        <button type="button" onClick={onListo} className={BOTON_SECUNDARIO} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function FormularioCondiciones({ cuenta, onListo }: { cuenta: DetalleCuenta; onListo: () => void }) {
  const router = useRouter();
  const [modalidad, setModalidad] = useState<"CONTADO" | "CREDITO">(cuenta.modalidad ?? "CREDITO");
  const [fechaContado, setFechaContado] = useState(cuenta.estado.cuotas[0]?.fechaVencimiento ?? cuenta.hoy);
  const [cuotas, setCuotas] = useState<{ fecha: string; importe: string }[]>(() =>
    cuenta.estado.cuotas.length > 0 ? cuenta.estado.cuotas.map((q) => ({ fecha: q.fechaVencimiento, importe: q.importe })) : [{ fecha: cuenta.hoy, importe: cuenta.estado.total }]
  );
  // Crédito de compras a proveedor: mensualidades automáticas o cuotas manuales.
  const admiteMensualidades = cuenta.origen === "COMPRA";
  const [plazo, setPlazo] = useState<PlazoMensual | "MANUAL">("MANUAL");
  const [primerVencimiento, setPrimerVencimiento] = useState("");
  const automatico = admiteMensualidades && modalidad === "CREDITO" && plazo !== "MANUAL";
  const propuesta = useMemo((): { cuotas: CuotaGenerada[] } | { error: string } | null => {
    if (!automatico || !primerVencimiento) return null;
    try {
      return { cuotas: generarMensualidades(cuenta.estado.total, plazo, primerVencimiento) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "No se pudo generar el calendario." };
    }
  }, [automatico, plazo, primerVencimiento, cuenta.estado.total]);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  const suma = cuotas.reduce((s, q) => {
    const n = normalizarImporte(q.importe, { permitirCero: false });
    return n ? s + aCentavos(n) : s;
  }, BigInt(0));
  const diferencia = aCentavos(cuenta.estado.total) - suma;

  function guardar() {
    setError(null);
    // En automático solo se envían plazo y fecha: el servidor genera los importes.
    const datos =
      modalidad === "CONTADO"
        ? { modalidad, cuotas: [{ fechaVencimiento: fechaContado, importe: cuenta.estado.total }] }
        : automatico
          ? { modalidad, mensualidades: { plazo, primerVencimiento } }
          : { modalidad, cuotas: cuotas.map((q) => ({ fechaVencimiento: q.fecha, importe: q.importe })) };
    start(async () => {
      const r = await definirCondicionesAction({ cuentaId: cuenta.id, version: cuenta.version, datos });
      if (r.error) return setError(r.error);
      onListo();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 text-sm">
        {(["CONTADO", "CREDITO"] as const).map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input type="radio" name={`modalidad-${cuenta.id}`} checked={modalidad === m} onChange={() => setModalidad(m)} />
            {m === "CONTADO" ? "Contado (una fecha por el total)" : "Crédito (una o varias cuotas)"}
          </label>
        ))}
      </div>
      {modalidad === "CONTADO" ? (
        <label className="block max-w-xs">
          <span className="mb-1.5 block text-sm font-medium">Fecha de pago ({formatearImporte(cuenta.estado.total)})</span>
          <Input type="date" value={fechaContado} onChange={(ev) => setFechaContado(ev.target.value)} aria-label="Fecha de contado" />
        </label>
      ) : (
        <div className="space-y-2">
          {admiteMensualidades && (
            <label className="block max-w-xs">
              <span className="mb-1.5 block text-sm font-medium">Plazo</span>
              <select
                value={plazo}
                onChange={(ev) => setPlazo(ev.target.value === "MANUAL" ? "MANUAL" : (Number(ev.target.value) as PlazoMensual))}
                className={claseSelect}
                aria-label="Plazo del crédito"
              >
                {PLAZOS_MENSUALES.map((p) => (
                  <option key={p} value={p}>
                    {p} meses
                  </option>
                ))}
                <option value="MANUAL">Cuotas manuales</option>
              </select>
            </label>
          )}
          {automatico ? (
            <div className="space-y-2" data-mensualidades>
              <label className="block max-w-xs">
                <span className="mb-1.5 block text-sm font-medium">Primer vencimiento</span>
                <Input type="date" value={primerVencimiento} onChange={(ev) => setPrimerVencimiento(ev.target.value)} aria-label="Fecha del primer vencimiento" />
              </label>
              <p className="text-xs text-[var(--muted)]">
                {plazo} mensualidades por el total de {formatearImporte(cuenta.estado.total)} (incluye el impuesto de la compra), sin intereses ni comisiones. Cada mes vence el mismo
                día; si un mes no lo tiene, vence su último día. La última cuota ajusta los centavos.
              </p>
              {!propuesta ? (
                <p className="text-xs text-amber-800">Indica el primer vencimiento para ver el calendario.</p>
              ) : "error" in propuesta ? (
                <p className="text-xs text-red-700">{propuesta.error}</p>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                    <table className="w-full text-sm" aria-label="Calendario propuesto">
                      <thead className="bg-black/[0.02] text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                        <tr>
                          <th className="border-b border-[var(--border)] px-3 py-1.5">Cuota</th>
                          <th className="border-b border-[var(--border)] px-3 py-1.5">Vence</th>
                          <th className="border-b border-[var(--border)] px-3 py-1.5 text-right">Importe</th>
                        </tr>
                      </thead>
                      <tbody>
                        {propuesta.cuotas.map((q) => (
                          <tr key={q.numero} className="border-b border-[var(--border)] last:border-0" data-mensualidad={q.numero}>
                            <td className="px-3 py-1.5">{q.numero}</td>
                            <td className="px-3 py-1.5">{formatearFechaCalendario(q.fechaVencimiento)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatearImporte(q.importe)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCuotas(propuesta.cuotas.map((q) => ({ fecha: q.fechaVencimiento, importe: q.importe })));
                      setPlazo("MANUAL");
                    }}
                    className="text-sm font-medium text-[var(--brand)] hover:underline"
                  >
                    Editar como cuotas manuales
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
          {cuotas.map((q, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-16 text-sm text-[var(--muted)]">Cuota {i + 1}</span>
              <Input type="date" value={q.fecha} onChange={(ev) => setCuotas((cs) => cs.map((x, j) => (j === i ? { ...x, fecha: ev.target.value } : x)))} className="w-44" aria-label={`Fecha de la cuota ${i + 1}`} />
              <Input
                value={q.importe}
                onChange={(ev) => setCuotas((cs) => cs.map((x, j) => (j === i ? { ...x, importe: ev.target.value } : x)))}
                inputMode="decimal"
                placeholder="0.00"
                className="w-36"
                aria-label={`Importe de la cuota ${i + 1}`}
              />
              {cuotas.length > 1 && (
                <button type="button" onClick={() => setCuotas((cs) => cs.filter((_, j) => j !== i))} className={claseSecundaria}>
                  Quitar
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setCuotas((cs) => [...cs, { fecha: cuenta.hoy, importe: diferencia > BigInt(0) ? deCentavos(diferencia) : "" }])} className="text-sm font-medium text-[var(--brand)] hover:underline">
            + Agregar fecha
          </button>
          <p className={`text-xs ${diferencia === BigInt(0) ? "text-[var(--muted)]" : "text-amber-800"}`}>
            Suma de cuotas: {formatearImporte(deCentavos(suma))} de {formatearImporte(cuenta.estado.total)}
            {diferencia !== BigInt(0) && ` · diferencia ${formatearImporte(deCentavos(diferencia))}`}. Se admiten fechas pasadas para compromisos ya existentes.
          </p>
            </>
          )}
        </div>
      )}
      <p className="text-xs text-[var(--muted)]">Guardar las condiciones no registra dinero recibido ni pagado.</p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="button" onClick={guardar} disabled={pendiente || (automatico && !(propuesta && "cuotas" in propuesta))}>
          {pendiente ? "Guardando…" : "Guardar condiciones"}
        </Button>
        <button type="button" onClick={onListo} className={claseSecundaria} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function FormularioMovimiento({ cuenta, onListo }: { cuenta: DetalleCuenta; onListo: () => void }) {
  const router = useRouter();
  const esCobro = cuenta.tipo === "POR_COBRAR";
  const [claveRegistro] = useState(clave);
  const [importe, setImporte] = useState("");
  const [ajustes, setAjustes] = useState<Record<string, string> | null>(null);
  // Campos controlados: se conservan si el servidor rechaza el registro.
  const [fecha, setFecha] = useState(cuenta.hoy);
  const [metodo, setMetodo] = useState("TRANSFERENCIA");
  const [referencia, setReferencia] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [state, formAction, pendiente] = useActionState<MovimientoState, FormData>(registrarMovimientoAction.bind(null, cuenta.id), undefined);
  const comprobante = useArchivosDeCarga(state, { maxArchivos: 1 });
  useEffect(() => {
    if (state?.ok) {
      onListo();
      router.refresh();
    }
  }, [state, onListo, router]);

  const normal = normalizarImporte(importe, { permitirCero: false });
  const conSaldo = cuenta.estado.cuotas.filter((q) => aCentavos(q.saldo) > BigInt(0));
  const propuesta = useMemo(() => (normal ? proponerAplicacion(conSaldo, normal) : null), [normal, conSaldo]);
  const excede = normal !== null && aCentavos(normal) > aCentavos(cuenta.estado.saldo);
  const distribucion = conSaldo.map((q) => ({
    q,
    valor: ajustes?.[q.id] ?? propuesta?.find((p) => p.cuotaId === q.id)?.importe ?? "",
  }));
  const sumaDist = distribucion.reduce((s, d) => {
    const n = normalizarImporte(d.valor || "0", { permitirCero: true });
    return n ? s + aCentavos(n) : s;
  }, BigInt(0));
  const aplicacionesJson = JSON.stringify(distribucion.filter((d) => d.valor && d.valor !== "0.00").map((d) => ({ cuotaId: d.q.id, importe: d.valor })));

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="clave" value={claveRegistro} />
      <input type="hidden" name="aplicaciones" value={aplicacionesJson} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Importe</span>
          <Input
            name="importe"
            value={importe}
            onChange={(ev) => {
              setImporte(ev.target.value);
              setAjustes(null);
            }}
            inputMode="decimal"
            placeholder="0.00"
            required
          />
          <span className="mt-0.5 block text-xs text-[var(--muted)]">Saldo disponible: {formatearImporte(cuenta.estado.saldo)}</span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Fecha real</span>
          <Input type="date" name="fecha" value={fecha} onChange={(ev) => setFecha(ev.target.value)} max={cuenta.hoy} required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Método</span>
          <select name="metodo" value={metodo} onChange={(ev) => setMetodo(ev.target.value)} className={claseSelect}>
            {METODOS_PAGO.map((m) => (
              <option key={m} value={m}>
                {ETIQUETA_METODO[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Referencia (opcional)</span>
          <Input name="referencia" value={referencia} onChange={(ev) => setReferencia(ev.target.value)} maxLength={100} placeholder="Folio, SPEI…" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Observaciones (opcional)</span>
          <Input name="observaciones" value={observaciones} onChange={(ev) => setObservaciones(ev.target.value)} maxLength={1000} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Comprobante (opcional, PDF/JPG/PNG)</span>
          <input
            type="file"
            name="comprobante"
            accept="application/pdf,image/jpeg,image/png"
            onChange={comprobante.onChange}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-2 file:text-sm"
          />
          <AvisosArchivos
            exceso={comprobante.exceso}
            reseleccionar={state?.error && comprobante.debeReseleccionar ? "Los datos se conservaron; vuelve a seleccionar el comprobante (si no, se registrará sin él)." : null}
          />
        </label>
      </div>

      {normal && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Distribución por cuota (propuesta: la más antigua primero; puedes ajustarla)</p>
          {excede ? (
            <p className="text-sm text-red-700">El importe supera el saldo disponible; no se registran saldos a favor.</p>
          ) : (
            <table className="text-sm">
              <tbody>
                {distribucion.map(({ q, valor }) => (
                  <tr key={q.id}>
                    <td className="pr-3 py-1">Cuota {q.numero}</td>
                    <td className="pr-3 py-1 text-[var(--muted)]">vence {formatearFechaCalendario(q.fechaVencimiento)}</td>
                    <td className="pr-3 py-1 text-[var(--muted)]">saldo {formatearImporte(q.saldo)}</td>
                    <td className="py-1">
                      <Input
                        value={valor}
                        onChange={(ev) => setAjustes((a) => ({ ...(a ?? Object.fromEntries(distribucion.map((d) => [d.q.id, d.valor]))), [q.id]: ev.target.value }))}
                        inputMode="decimal"
                        className="w-32"
                        aria-label={`Aplicar a la cuota ${q.numero}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!excede && sumaDist !== aCentavos(normal) && (
            <p className="text-xs text-amber-800">
              La distribución suma {formatearImporte(deCentavos(sumaDist))}; debe sumar {formatearImporte(normal)}.
            </p>
          )}
        </div>
      )}
      <p className="text-xs text-[var(--muted)]">
        Registra dinero {esCobro ? "realmente recibido del cliente" : "realmente pagado al proveedor"}. Para corregir un error se anula con motivo; no se edita.
      </p>
      {state?.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pendiente || !normal || excede || Boolean(comprobante.exceso)}>
          {pendiente ? "Registrando…" : esCobro ? "Registrar cobro" : "Registrar pago"}
        </Button>
        <button type="button" onClick={onListo} className={claseSecundaria} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function Movimiento({ m, esCobro }: { m: DetalleCuenta["movimientos"][number]; esCobro: boolean }) {
  const router = useRouter();
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  const anulado = m.estatus === "ANULADO";
  return (
    <li className={`rounded-lg border border-[var(--border)] p-3 text-sm ${anulado ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className={`font-semibold tabular-nums ${anulado ? "line-through" : ""}`}>{formatearImporte(m.importe)}</span>{" "}
          <span className="text-[var(--muted)]">
            · {formatearFechaCalendario(m.fecha)} · {ETIQUETA_METODO[m.metodo]}
            {m.referencia && ` · ${m.referencia}`}
          </span>
          {anulado && <Etiqueta texto="Anulado" estilo="ml-2 bg-red-50 text-red-700" />}
        </div>
        {!anulado && !anulando && (
          <button type="button" onClick={() => setAnulando(true)} className={claseSecundaria}>
            Anular por error
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Aplicado a: {m.aplicaciones.map((a) => `cuota ${a.cuotaNumero} (${formatearImporte(a.importe)})`).join(", ")} · registró {m.registradoPorNombre} el{" "}
        {formatoFechaHora.format(new Date(m.registradoEn))}
        {m.comprobanteNombre && (
          <>
            {" · "}
            <a href={`/api/comercializacion/movimientos/${m.id}/comprobante`} target="_blank" rel="noopener" className="font-medium text-[var(--brand)] hover:underline">
              {m.comprobanteNombre}
            </a>
          </>
        )}
      </p>
      {m.observaciones && <p className="mt-0.5 text-xs text-[var(--muted)]">{m.observaciones}</p>}
      {m.anulado && (
        <p className="mt-0.5 text-xs text-red-700">
          Anulado por {m.anulado.porNombre} el {formatoFechaHora.format(new Date(m.anulado.en))}: {m.anulado.motivo}. Sus aplicaciones ya no cuentan (corrección de registro, no una devolución).
        </p>
      )}
      {anulando && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Motivo (obligatorio)" maxLength={500} className="sm:max-w-md" />
          <Button
            type="button"
            variant="outline"
            disabled={pendiente || motivo.trim().length < 3}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await anularMovimientoAction({ movimientoId: m.id, motivo });
                if (r.error) return setError(r.error);
                setAnulando(false);
                router.refresh();
              })
            }
          >
            {pendiente ? "Anulando…" : `Anular ${esCobro ? "cobro" : "pago"}`}
          </Button>
          <button type="button" onClick={() => setAnulando(false)} className={claseSecundaria}>
            Cancelar
          </button>
          {error && <span className="text-sm text-red-700">{error}</span>}
        </div>
      )}
    </li>
  );
}

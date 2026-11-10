"use client";

import { useState, useEffect, useRef } from "react";
import { modoPagadorInicial, pagadorElegido, type QuienPagoModo } from "@/lib/control-de-obra/pagador-gasto";
import { useActionState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { formatMoney } from "@/lib/dinero";
import {
  categoriasParaAmbito,
  CATEGORIA_GASTO_LABEL,
  type AmbitoGasto,
} from "@/lib/control-de-obra/categorias-gasto";
import {
  crearGastoAction,
  editarGastoAction,
  type GastoFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import {
  crearGastoGlobalAction,
  editarGastoGlobalAction,
  type GastoGlobalFormState,
} from "@/app/(app)/gastos/actions";
import type { FilaGasto } from "@/lib/server/control-de-obra/gastos";

type LineaDetalle = { descripcion: string; unidad: string; cantidad: string; precioUnitario: string };
const LINEA_VACIA: LineaDetalle = { descripcion: "", unidad: "", cantidad: "1", precioUnitario: "0" };

const METODOS_PAGO = [
  { value: "EFECTIVO", label: "Efectivo" },
  { value: "TRANSFERENCIA", label: "Transferencia" },
  { value: "TARJETA_DEBITO", label: "Tarjeta débito" },
  { value: "TARJETA_CREDITO", label: "Tarjeta crédito" },
];

const TRATAMIENTOS_CLIENTE = [
  { value: "NO_COBRABLE", label: "No cobrable al cliente" },
  { value: "COBRABLE_EN_ESTIMACION", label: "Cobrable en estimación" },
  { value: "INCLUIDO_EN_CONTRATO", label: "Incluido en contrato" },
];

// Modal tipo wizard — Destino (solo desde el acceso global, sin proyecto de
// contexto) → Gasto → Quién/cómo se pagó → Evidencia. Pensado para llenarse
// desde el celular en obra — campos mínimos, input de archivo con
// `capture="environment"` para tomar la foto del ticket directo con la
// cámara (Gastos transversal, septiembre 2026 — evoluciona el formulario
// corto ya existente en vez de duplicarlo: mismos campos, mismo <form>, un
// solo submit al final; los pasos ocultos con `hidden` para que el HTML
// nativo no los valide hasta que sean visibles).
type Paso = "destino" | "gasto" | "quien" | "evidencia";

export function FormularioGasto({
  proyectoId,
  semanaId,
  proyectosDisponibles,
  beneficiarios,
  beneficiarioVinculado,
  gasto,
  onClose,
}: {
  // Ausentes = modal abierto desde el acceso global "+ Registrar gasto" (sin
  // proyecto de contexto) — aparece el Paso 1 Destino. Presentes = abierto
  // desde Proyecto → Gastos, el Paso 1 se salta (mismo comportamiento de
  // siempre).
  proyectoId?: string;
  semanaId?: string;
  // Solo necesario en modo global, para el selector de Proyecto del Paso 1.
  proyectosDisponibles?: { id: string; nombre: string }[];
  beneficiarios: { id: string; nombre: string; tipo: string }[];
  beneficiarioVinculado: { id: string; nombre: string } | null;
  gasto: FilaGasto | null;
  onClose: () => void;
}) {
  const esGlobal = !proyectoId;

  const action = esGlobal
    ? gasto
      ? editarGastoGlobalAction.bind(null, gasto.proyectoId, gasto.id)
      : crearGastoGlobalAction
    : gasto
      ? editarGastoAction.bind(null, proyectoId, gasto.id)
      : crearGastoAction.bind(null, proyectoId, semanaId!);
  const [state, formAction, pending] = useActionState<
    GastoFormState | GastoGlobalFormState,
    FormData
  >(action, undefined);
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.guardado) onClose();
  }

  // --- Paso 1: Destino (solo modo global, solo al crear) ------------------
  const [destino, setDestino] = useState<"proyecto" | "empresa">("proyecto");
  const [proyectoElegidoId, setProyectoElegidoId] = useState("");
  const ambito: AmbitoGasto = esGlobal && destino === "empresa" ? "empresa" : "obra";
  const categoriasDisponibles = categoriasParaAmbito(ambito);

  const pasos: Paso[] = esGlobal && !gasto ? ["destino", "gasto", "quien", "evidencia"] : ["gasto", "quien", "evidencia"];
  const [pasoIndex, setPasoIndex] = useState(0);
  const pasoActual = pasos[pasoIndex];
  const esUltimoPaso = pasoIndex === pasos.length - 1;

  function puedeAvanzar(): boolean {
    if (pasoActual === "destino") return destino === "empresa" || Boolean(proyectoElegidoId);
    if (pasoActual === "quien") return pagadorElegido(quienPagoModo);
    return true;
  }

  // Gasto nuevo: sin pagador preseleccionado — se elige explícitamente
  // (nunca se asume Empresa). Al editar se infiere del gasto existente para
  // no perder la selección — pero la resolución real de "YO" siempre vuelve
  // a ocurrir server-side al enviar (nunca se confía en el id de este campo
  // para ese caso). Ver lib/control-de-obra/pagador-gasto.ts.
  const [quienPagoModo, setQuienPagoModo] = useState<QuienPagoModo | "">(() =>
    modoPagadorInicial(gasto, beneficiarioVinculado?.id)
  );

  // Siempre por líneas — cada gasto se captura como una o más líneas con su
  // propia descripción (nunca una "Descripción" genérica aparte); mínimo una
  // línea, forzado por que el botón de quitar se deshabilita en la última.
  const [lineas, setLineas] = useState<LineaDetalle[]>(
    gasto && gasto.detalle.length > 0
      ? gasto.detalle.map((l) => ({
          descripcion: l.descripcion,
          unidad: l.unidad,
          cantidad: String(l.cantidad),
          precioUnitario: String(l.precioUnitario),
        }))
      : [{ ...LINEA_VACIA }]
  );
  const totalDetalle = lineas.reduce(
    (t, l) => t + (Number(l.cantidad) || 0) * (Number(l.precioUnitario) || 0),
    0
  );
  function actualizarLinea(i: number, campo: keyof LineaDetalle, valor: string) {
    setLineas((prev) => prev.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));
  }

  useEffect(() => {
    function alTecla(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", alTecla);
    return () => document.removeEventListener("keydown", alTecla);
  }, [onClose]);

  const hoy = new Date().toISOString().slice(0, 10);
  const formRef = useRef<HTMLFormElement>(null);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="enter max-h-[90vh] w-full max-w-5xl overflow-y-auto p-6">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            {gasto ? "Editar gasto" : "Nuevo gasto"}
          </h2>
          {pasos.length > 1 && (
            <p className="text-xs font-medium text-[var(--muted)]">
              Paso {pasoIndex + 1} de {pasos.length}
            </p>
          )}
        </div>

        <form ref={formRef} action={formAction} className="mt-3 space-y-3">
          <input type="hidden" name="detalle" value={JSON.stringify(lineas)} />
          {esGlobal && !gasto && (
            <>
              <input type="hidden" name="destino" value={destino} />
              {destino === "proyecto" && (
                <input type="hidden" name="proyectoId" value={proyectoElegidoId} />
              )}
            </>
          )}

          {/* Paso 1 — Destino (Proyecto/Obra o Empresa) */}
          {pasoActual === "destino" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--foreground)]">¿A dónde corresponde este gasto?</p>
              <div className="flex gap-1.5">
                <BotonModo activo={destino === "proyecto"} onClick={() => setDestino("proyecto")}>
                  Proyecto / Obra
                </BotonModo>
                <BotonModo activo={destino === "empresa"} onClick={() => setDestino("empresa")}>
                  Empresa
                </BotonModo>
              </div>
              {destino === "proyecto" && (
                <select
                  value={proyectoElegidoId}
                  onChange={(e) => setProyectoElegidoId(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
                >
                  <option value="">Selecciona un proyecto…</option>
                  {(proyectosDisponibles ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Paso 2 — Gasto */}
          <div hidden={pasoActual !== "gasto"} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Campo label="Fecha">
                <input
                  name="fecha"
                  type="date"
                  required={pasoActual === "gasto"}
                  defaultValue={gasto ? gasto.fecha.slice(0, 10) : hoy}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
                />
              </Campo>
              <Campo label="Monto">
                <input
                  name="monto"
                  type="number"
                  readOnly
                  value={totalDetalle.toFixed(2)}
                  className="w-full rounded-lg border border-[var(--border)] bg-black/[0.03] px-3.5 py-2.5 text-sm text-[var(--foreground)]"
                />
                <p className="mt-1 text-xs text-[var(--muted)]">Suma de los gastos de abajo.</p>
              </Campo>
            </div>

            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">Gastos</p>
              <div className="mt-2 space-y-2">
                {lineas.map((l, i) => (
                  <div key={i} className="grid grid-cols-12 gap-1.5">
                    <input
                      placeholder="Descripción"
                      required={pasoActual === "gasto"}
                      value={l.descripcion}
                      onChange={(e) => actualizarLinea(i, "descripcion", e.target.value)}
                      className="col-span-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm"
                    />
                    <input
                      placeholder="Unidad"
                      required={pasoActual === "gasto"}
                      value={l.unidad}
                      onChange={(e) => actualizarLinea(i, "unidad", e.target.value)}
                      className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm"
                    />
                    <input
                      type="number"
                      step="0.001"
                      placeholder="Cant."
                      required={pasoActual === "gasto"}
                      value={l.cantidad}
                      onChange={(e) => actualizarLinea(i, "cantidad", e.target.value)}
                      className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="P.U."
                      required={pasoActual === "gasto"}
                      value={l.precioUnitario}
                      onChange={(e) => actualizarLinea(i, "precioUnitario", e.target.value)}
                      className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setLineas((prev) => prev.filter((_, idx) => idx !== i))}
                      disabled={lineas.length === 1}
                      className="col-span-1 text-sm text-red-700 disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setLineas((prev) => [...prev, { ...LINEA_VACIA }])}
                  className="text-sm font-medium text-[var(--brand)] hover:underline"
                >
                  + Agregar gasto
                </button>
                <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-2 text-sm font-semibold text-[var(--foreground)]">
                  Total <span className="tabular-nums">{formatMoney(totalDetalle)}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Campo label="Categoría">
                <select
                  name="categoria"
                  required={pasoActual === "gasto"}
                  defaultValue={gasto?.categoria ?? ""}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
                >
                  <option value="" disabled>
                    Selecciona…
                  </option>
                  {categoriasDisponibles.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORIA_GASTO_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Método de pago">
                <select
                  name="metodoPago"
                  required={pasoActual === "gasto"}
                  defaultValue={gasto?.metodoPago ?? ""}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
                >
                  <option value="" disabled>
                    Selecciona…
                  </option>
                  {METODOS_PAGO.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Campo>
            </div>
          </div>

          {/* Paso 3 — Quién / cómo se pagó */}
          <div hidden={pasoActual !== "quien"} className="space-y-3">
            <Campo label="¿Quién pagó?">
              <input type="hidden" name="quienPagoModo" value={quienPagoModo} />
              <div className="flex flex-wrap gap-1.5">
                <BotonModo activo={quienPagoModo === "EMPRESA"} onClick={() => setQuienPagoModo("EMPRESA")}>
                  La empresa
                </BotonModo>
                <BotonModo
                  activo={quienPagoModo === "YO"}
                  disabled={!beneficiarioVinculado}
                  onClick={() => setQuienPagoModo("YO")}
                >
                  Yo pagué
                </BotonModo>
                <BotonModo activo={quienPagoModo === "OTRO"} onClick={() => setQuienPagoModo("OTRO")}>
                  Otro beneficiario
                </BotonModo>
              </div>
              {!pagadorElegido(quienPagoModo) && (
                <p className="mt-1.5 text-xs text-amber-700">Elige quién pagó para continuar.</p>
              )}

              {quienPagoModo === "YO" && beneficiarioVinculado && (
                <p className="mt-1.5 text-xs text-[var(--muted)]">
                  Se registrará como pagado por <strong>{beneficiarioVinculado.nombre}</strong>.
                </p>
              )}
              {!beneficiarioVinculado && (
                <p className="mt-1.5 text-xs text-[var(--muted)]">
                  Este usuario no tiene un beneficiario de pago relacionado. Configúralo antes de
                  generar la reposición.
                </p>
              )}
              {quienPagoModo === "OTRO" && (
                <select
                  name="pagadorBeneficiarioId"
                  required={pasoActual === "quien"}
                  defaultValue={gasto?.pagadorBeneficiarioId ?? ""}
                  className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
                >
                  <option value="" disabled>
                    Selecciona…
                  </option>
                  {beneficiarios.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.nombre}
                    </option>
                  ))}
                </select>
              )}
            </Campo>

            <Campo label="Proveedor (opcional)">
              <select
                name="proveedorBeneficiarioId"
                defaultValue={gasto?.proveedorBeneficiarioId ?? ""}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              >
                <option value="">Sin proveedor</option>
                {beneficiarios
                  .filter((b) => b.tipo === "PROVEEDOR")
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.nombre}
                    </option>
                  ))}
              </select>
            </Campo>

            {/* Cobrar al cliente solo tiene sentido para un gasto de obra —
                Empresa no tiene cliente a quién facturarle (Gastos
                transversal, septiembre 2026). */}
            {ambito === "obra" && (
              <Campo label="Tratamiento para cliente">
                <select
                  name="tratamientoCliente"
                  defaultValue={gasto?.tratamientoCliente ?? "NO_COBRABLE"}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
                >
                  {TRATAMIENTOS_CLIENTE.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Campo>
            )}
          </div>

          {/* Paso 4 — Evidencia */}
          <div hidden={pasoActual !== "evidencia"} className="space-y-3">
            <Campo label="Comentario (opcional)">
              <textarea
                name="comentario"
                rows={2}
                defaultValue={gasto?.comentario ?? undefined}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
              />
            </Campo>

            <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
              <input
                type="checkbox"
                name="requiereFactura"
                defaultChecked={gasto?.requiereFactura ?? false}
              />
              Este gasto lleva factura
            </label>

            <Campo label={gasto?.ticketRef ? "Reemplazar ticket (opcional)" : "Ticket / foto"}>
              <FileInput
                name="ticket"
                accept="image/*,application/pdf"
                capture="environment"
                className="block w-full text-sm text-[var(--muted)] file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--foreground)] file:transition-colors file:duration-150 file:ease-out hover:file:bg-black/[0.03]"
              />
              {gasto?.ticketRef && (
                <a
                  href={`/api/control-de-obra/proyectos/${gasto.proyectoId}/gastos/${gasto.id}/ticket`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-xs text-[var(--brand)] hover:underline"
                >
                  Ver ticket actual
                </a>
              )}
            </Campo>
          </div>

          <div className="flex items-center gap-3 pt-1">
            {pasoIndex > 0 && (
              <button
                type="button"
                onClick={() => setPasoIndex((i) => i - 1)}
                className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
              >
                ← Atrás
              </button>
            )}
            {/* Un solo botón, SIEMPRE type="button" — nunca cambia a
                type="submit" en el mismo elemento. Pasar de Paso 2 a Paso 3
                (el último) cambiaba `esUltimoPaso` a true en el mismo click
                que ya estaba procesando el navegador: React re-renderizaba
                este mismo <button> como type="submit" antes de que el click
                terminara de resolverse, y el navegador enviaba el formulario
                de inmediato — el usuario nunca alcanzaba a capturar el Paso 3
                (bug reportado, septiembre 2026). Al enviar explícitamente con
                requestSubmit() solo cuando en verdad es el último paso, el
                <button> nunca cambia de tipo y no hay carrera posible. */}
            <Button
              type="button"
              disabled={esUltimoPaso ? pending : !puedeAvanzar()}
              onClick={() => {
                if (esUltimoPaso) {
                  formRef.current?.requestSubmit();
                } else {
                  setPasoIndex((i) => i + 1);
                }
              }}
            >
              {esUltimoPaso
                ? pending
                  ? "Guardando…"
                  : gasto
                    ? "Guardar cambios"
                    : "Guardar gasto"
                : "Siguiente"}
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

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">{label}</label>
      {children}
    </div>
  );
}

function BotonModo({
  activo,
  disabled,
  onClick,
  children,
}: {
  activo: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
        activo
          ? "border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--brand)]"
          : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
      }`}
    >
      {children}
    </button>
  );
}

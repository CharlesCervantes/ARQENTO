"use client";

import { startTransition, useRef, useState } from "react";
import { useActionState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/dinero";
import { formatearFecha } from "@/lib/fecha";
import { CATEGORIA_GASTO_LABEL, categoriasParaAmbito } from "@/lib/control-de-obra/categorias-gasto";
import { confirmarComoGastoNuevoAction, type ConfirmarPropuestaFormState } from "@/app/(app)/contabilidad/actions";
import type { PosibleDuplicado } from "@/lib/server/contabilidad/documentos/duplicados";

// "Registrar como gasto de obra" desde un documento de Captura Inteligente
// (Fase 0 WhatsApp + ARQENTO IA, octubre 2026). Crea un gasto PENDIENTE de
// revisión con las reglas de siempre (Gastos → aprobarGasto → reposición,
// R2). Quién pagó es obligatorio — nunca se asume la Empresa — y "pagó quien
// envió el comprobante" se resuelve en el servidor con el beneficiario
// vinculado al remitente.

export type RemitenteDocumento = { nombre: string; tieneBeneficiario: boolean };

export type SemanasRegistro = {
  semanaActualId: string;
  semanas: { id: string; numero: number; anio: number; fechaInicio: string; fechaFin: string }[];
};

export type PrellenadoGasto = {
  documentoEgresoId: string;
  fecha: string | null;
  monto: number | null;
  descripcion: string | null;
  proyectoId: string | null;
  remitente: RemitenteDocumento;
};

const METODOS_PAGO: [string, string][] = [
  ["EFECTIVO", "Efectivo"],
  ["TRANSFERENCIA", "Transferencia"],
  ["TARJETA_DEBITO", "Tarjeta de débito"],
  ["TARJETA_CREDITO", "Tarjeta de crédito"],
];

// Mismas opciones y etiquetas que el formulario de Gastos.
const TRATAMIENTOS_CLIENTE: [string, string][] = [
  ["NO_COBRABLE", "No cobrable al cliente"],
  ["COBRABLE_EN_ESTIMACION", "Cobrable en estimación"],
  ["INCLUIDO_EN_CONTRATO", "Incluido en contrato"],
];

const CAMPO = "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)]";

// Aviso de posibles duplicados — compartido por "gasto de obra" y "egreso
// de empresa". Solo muestra fecha, importe, descripción y obra.
export function AvisoPosiblesDuplicados({
  candidatos,
  pendiente,
  onConfirmar,
}: {
  candidatos: PosibleDuplicado[];
  pendiente: boolean;
  onConfirmar: () => void;
}) {
  const [revisado, setRevisado] = useState(false);
  const NIVEL: Record<PosibleDuplicado["nivel"], string> = { FUERTE: "Muy probable", MEDIO: "Probable", DEBIL: "Posible" };
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-800">Posibles duplicados</p>
      <ul className="space-y-1.5">
        {candidatos.map((c) => (
          <li key={`${c.tipo}:${c.id}`} className="text-xs text-amber-900">
            <span className="font-medium">{NIVEL[c.nivel]}</span> — {c.motivo}: {c.descripcion}
            {c.proyectoNombre && ` · ${c.proyectoNombre}`}
            {c.fecha && ` · ${formatearFecha(new Date(c.fecha))}`} · {formatMoney(c.monto)}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-sm text-amber-900">
        <input type="checkbox" checked={revisado} onChange={(e) => setRevisado(e.target.checked)} />
        Revisé la lista y es un registro distinto
      </label>
      <Button type="button" disabled={!revisado || pendiente} onClick={onConfirmar}>
        {pendiente ? "Guardando…" : "Confirmar de todas formas"}
      </Button>
    </div>
  );
}

export function ModalGastoDesdeDocumento({
  prellenado,
  proyectosDisponibles,
  beneficiarios,
  semanasRegistro,
  onClose,
}: {
  prellenado: PrellenadoGasto;
  proyectosDisponibles: { id: string; nombre: string }[];
  beneficiarios: { id: string; nombre: string; tipo: string }[];
  semanasRegistro: SemanasRegistro;
  onClose: () => void;
}) {
  // El último envío se conserva para reenviarlo tal cual, con la aceptación
  // explícita de posibles duplicados, sin volver a capturar nada.
  const ultimoEnvio = useRef<FormData | null>(null);
  const accion = confirmarComoGastoNuevoAction.bind(null, prellenado.documentoEgresoId);
  const [state, formAction, pending] = useActionState<ConfirmarPropuestaFormState, FormData>(async (previo, formData) => {
    ultimoEnvio.current = formData;
    return accion(previo, formData);
  }, undefined);
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.guardado) onClose();
  }
  const [pagadorModo, setPagadorModo] = useState<"" | "EMPRESA" | "YO" | "OTRO">("");
  // Destino — mismo Paso 1 que Gastos: una obra, o la Empresa (Oficina).
  const [destino, setDestino] = useState<"OBRA" | "EMPRESA">("OBRA");
  const proveedores = beneficiarios.filter((b) => b.tipo === "PROVEEDOR");
  const { remitente } = prellenado;

  // Envío explícito, sin el reinicio automático que React aplica a
  // <form action={…}>: si el servidor responde con un error de validación,
  // lo capturado (incluidas casillas y opciones) se conserva para corregirlo.
  function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const datos = new FormData(evento.currentTarget);
    startTransition(() => formAction(datos));
  }

  function confirmarConDuplicados() {
    if (!ultimoEnvio.current) return;
    const copia = new FormData();
    for (const [k, v] of ultimoEnvio.current.entries()) copia.append(k, v);
    copia.set("aceptaPosiblesDuplicados", "on");
    startTransition(() => formAction(copia));
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="enter max-h-[90vh] w-full max-w-lg overflow-y-auto p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Registrar como gasto</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Se crea un gasto pendiente de revisión: aprobarlo (y generar la reposición, si la pagó una persona) sigue
          siendo un paso aparte en Gastos. Enviado por {remitente.nombre}.
        </p>

        <form onSubmit={enviar} className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(["OBRA", "EMPRESA"] as const).map((opcion) => (
              <label
                key={opcion}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${destino === opcion ? "border-[var(--brand)]" : "border-[var(--border)]"}`}
              >
                <input type="radio" name="destino" value={opcion} checked={destino === opcion} onChange={() => setDestino(opcion)} />
                {opcion === "OBRA" ? "Gasto de una obra" : "Gasto de la Empresa"}
              </label>
            ))}
          </div>

          {destino === "OBRA" ? (
            <div className="grid grid-cols-2 gap-3">
              <select name="proyectoId" required defaultValue={prellenado.proyectoId ?? ""} className={CAMPO}>
                <option value="" disabled>
                  Obra
                </option>
                {proyectosDisponibles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
              <select name="tratamientoCliente" defaultValue="NO_COBRABLE" className={CAMPO} aria-label="Tratamiento para cliente">
                {TRATAMIENTOS_CLIENTE.map(([valor, etiqueta]) => (
                  <option key={valor} value={valor}>
                    {etiqueta}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              Gasto general de la Empresa (oficina): no se cobra al cliente. Usa las categorías de gastos de Empresa.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <input name="fecha" type="date" required defaultValue={prellenado.fecha ?? ""} className={CAMPO} />
            <input
              name="monto"
              type="number"
              step="0.01"
              min="0.01"
              required
              placeholder="Importe"
              defaultValue={prellenado.monto ?? ""}
              className={CAMPO}
            />
          </div>

          {/* Semana en la que se reporta el gasto: se propone la actual y se
              puede elegir otra. La fecha del comprobante no la decide. */}
          <label className="block text-xs text-[var(--muted)]">
            Semana en la que se reporta
            <select name="semanaId" required defaultValue={semanasRegistro.semanaActualId} className={`mt-1 ${CAMPO}`}>
              {semanasRegistro.semanas.map((s) => (
                <option key={s.id} value={s.id}>
                  Semana {s.numero} · {formatearFecha(new Date(s.fechaInicio))} – {formatearFecha(new Date(s.fechaFin))}
                  {s.id === semanasRegistro.semanaActualId ? " (actual)" : ""}
                </option>
              ))}
            </select>
          </label>

          <input
            name="descripcion"
            required
            placeholder="Descripción"
            defaultValue={prellenado.descripcion ?? ""}
            className={CAMPO}
          />

          <div className="grid grid-cols-2 gap-3">
            <select key={destino} name="categoria" required defaultValue="" className={CAMPO}>
              <option value="" disabled>
                Categoría
              </option>
              {categoriasParaAmbito(destino === "OBRA" ? "obra" : "empresa").map((c) => (
                <option key={c} value={c}>
                  {CATEGORIA_GASTO_LABEL[c]}
                </option>
              ))}
            </select>
            <select name="metodoPago" required defaultValue="" className={CAMPO}>
              <option value="" disabled>
                Método de pago
              </option>
              {METODOS_PAGO.map(([valor, etiqueta]) => (
                <option key={valor} value={valor}>
                  {etiqueta}
                </option>
              ))}
            </select>
          </div>

          <select name="proveedorBeneficiarioId" defaultValue="" className={CAMPO}>
            <option value="">Proveedor (opcional)</option>
            {proveedores.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nombre}
              </option>
            ))}
          </select>

          <fieldset className="space-y-1.5 rounded-lg border border-[var(--border)] p-3">
            <legend className="px-1 text-sm font-medium text-[var(--foreground)]">¿Quién pagó?</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="pagadorModo" value="EMPRESA" required onChange={() => setPagadorModo("EMPRESA")} />
              La Empresa (sin reposición)
            </label>
            <label className={`flex items-center gap-2 text-sm ${remitente.tieneBeneficiario ? "" : "text-[var(--muted)]"}`}>
              <input
                type="radio"
                name="pagadorModo"
                value="YO"
                disabled={!remitente.tieneBeneficiario}
                onChange={() => setPagadorModo("YO")}
              />
              {remitente.nombre}, quien envió el comprobante (se le repone)
            </label>
            {!remitente.tieneBeneficiario && (
              <p className="pl-6 text-xs text-amber-700">
                {remitente.nombre} no tiene un beneficiario de pago vinculado. Vincúlalo en Catálogos para poder
                reponerle este gasto.
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="pagadorModo" value="OTRO" onChange={() => setPagadorModo("OTRO")} />
              Otra persona (se le repone)
            </label>
            {pagadorModo === "OTRO" && (
              <select name="pagadorBeneficiarioId" required defaultValue="" className={CAMPO}>
                <option value="" disabled>
                  ¿Quién pagó?
                </option>
                {beneficiarios.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nombre}
                  </option>
                ))}
              </select>
            )}
          </fieldset>

          <textarea name="comentario" rows={2} placeholder="Comentario (opcional)" className={CAMPO} />
          <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
            <input type="checkbox" name="requiereFactura" />
            Requiere factura
          </label>

          {state?.posiblesDuplicados && state.posiblesDuplicados.length > 0 ? (
            <AvisoPosiblesDuplicados candidatos={state.posiblesDuplicados} pendiente={pending} onConfirmar={confirmarConDuplicados} />
          ) : (
            state?.error && <p className="text-sm text-red-700">{state.error}</p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Registrar gasto"}
            </Button>
            <button type="button" onClick={onClose} className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
              Cancelar
            </button>
          </div>
        </form>
      </Card>
    </div>,
    document.body
  );
}

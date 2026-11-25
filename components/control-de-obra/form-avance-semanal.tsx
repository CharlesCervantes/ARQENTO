"use client";

import { useActionState, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tr, Th, Td } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { BarraAvance } from "./barra-avance";
import { EstatusAprobacionAvanceBadge } from "./estatus-aprobacion-avance-badge";
import { IconoPartida } from "./icono-partida";
import { useDirtyAvance } from "./dirty-avance-context";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/dinero";
import { Prisma } from "@/lib/generated/prisma/browser";
import {
  cantidadDesdeMonto,
  cantidadInicial,
  montoAEnviar,
  montoDesdeCantidad,
  montoInicial,
  precioDeCaptura,
} from "@/lib/control-de-obra/captura-avance";
import {
  guardarAvanceAction,
  cambiarEstatusAprobacionAvanceAction,
  type AvanceFormState,
} from "@/app/(proyecto)/control-de-obra/[id]/actions";
import type { obtenerAvanceSemanal } from "@/lib/server/control-de-obra/avance";

type Partidas = Awaited<ReturnType<typeof obtenerAvanceSemanal>>;
type ConceptoConAvance = Partidas[number]["conceptos"][number];

function formatCantidad(valor: InstanceType<typeof Prisma.Decimal> | number): string {
  const n = typeof valor === "number" ? valor : valor.toNumber();
  return n.toLocaleString("es-MX", { maximumFractionDigits: 3 });
}

export function FormAvanceSemanal({
  proyectoId,
  semanaId,
  partidas,
  puedeAprobar,
  soloLectura = false,
  mensajeVacio,
}: {
  proyectoId: string;
  semanaId: string;
  partidas: Partidas;
  puedeAprobar: boolean;
  soloLectura?: boolean;
  mensajeVacio?: string;
}) {
  return (
    <div className="space-y-3">
      {partidas.length === 0 && (
        <Card className="p-6 text-sm text-[var(--muted)]">
          {mensajeVacio ??
            "Todavía no hay partidas en este proyecto. Créalas primero en Partidas de obra."}
        </Card>
      )}

      {partidas.map((partida, i) => (
        <PartidaAvance
          key={partida.id}
          proyectoId={proyectoId}
          semanaId={semanaId}
          partida={partida}
          puedeAprobar={puedeAprobar}
          soloLectura={soloLectura}
          indiceEntrada={i}
        />
      ))}
    </div>
  );
}

function PartidaAvance({
  proyectoId,
  semanaId,
  partida,
  puedeAprobar,
  soloLectura,
  indiceEntrada,
}: {
  proyectoId: string;
  semanaId: string;
  partida: Partidas[number];
  puedeAprobar: boolean;
  soloLectura: boolean;
  indiceEntrada: number;
}) {
  const action = guardarAvanceAction.bind(null, proyectoId, semanaId);
  const [state, formAction, pending] = useActionState<AvanceFormState, FormData>(
    action,
    undefined
  );
  const { marcarPartida } = useDirtyAvance();

  const [baseline, setBaseline] = useState<Record<string, string>>(() =>
    Object.fromEntries(partida.conceptos.map((c) => [c.id, cantidadInicial(c)]))
  );
  const [valores, setValores] = useState<Record<string, string>>(baseline);

  // Mismo patrón que baseline/valores, para el Monto — necesario para que
  // "hay cambios sin guardar" también detecte cuando SOLO se corrigió el
  // Monto (la cantidad redondeada puede quedar idéntica a la de antes, ver
  // bug reportado: corregir 120000.96 → 120000 no cambiaba la cantidad
  // guardada, así que el botón de guardar nunca aparecía). Sin esto, editar
  // el Monto no se detectaba como cambio y la fila nunca se reenviaba al
  // servidor.
  const [baselineMonto, setBaselineMonto] = useState<Record<string, string>>(() =>
    Object.fromEntries(partida.conceptos.map((c) => [c.id, montoInicial(c)]))
  );
  const [valoresMonto, setValoresMonto] = useState<Record<string, string>>(baselineMonto);

  const conceptosModificados = partida.conceptos.filter(
    (c) =>
      (valores[c.id] ?? "") !== (baseline[c.id] ?? "") ||
      (valoresMonto[c.id] ?? "") !== (baselineMonto[c.id] ?? "")
  );
  const dirty = conceptosModificados.length > 0;

  useEffect(() => {
    marcarPartida(partida.id, dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, partida.id]);

  // Al desmontar (navegación confirmada, etc.) no dejar la partida marcada.
  useEffect(() => {
    return () => marcarPartida(partida.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partida.id]);

  // Al terminar un guardado exitoso, el baseline pasa a ser lo recién
  // guardado — se ajusta durante el render (no en un efecto) siguiendo el
  // patrón de React para "adaptar estado cuando cambia una prop/valor".
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.guardados !== undefined && !state.error) {
      setBaseline(valores);
      setBaselineMonto(valoresMonto);
    }
  }

  function actualizarValor(conceptoId: string, nuevaCantidad: string) {
    setValores((prev) => ({ ...prev, [conceptoId]: nuevaCantidad }));
  }

  function actualizarMonto(conceptoId: string, nuevoMonto: string) {
    setValoresMonto((prev) => ({ ...prev, [conceptoId]: nuevoMonto }));
  }

  const conMovimiento = partida.conceptos.filter((c) => c.estaSemana > 0).length;

  return (
    <Card
      className="enter overflow-hidden"
      style={{ transitionDelay: `${Math.min(indiceEntrada, 6) * 30}ms` }}
    >
      <details>
        <summary className="group flex cursor-pointer list-none items-center justify-between px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-3">
            <IconoPartida icono={partida.icono} color={partida.color} />
            <span className="text-sm font-semibold text-[var(--foreground)]">
              {partida.nombre}
            </span>
          </span>
          <span className="text-xs text-[var(--muted)]">
            {partida.conceptos.length} concepto
            {partida.conceptos.length === 1 ? "" : "s"}
            {conMovimiento > 0 && ` · ${conMovimiento} con movimiento esta semana`}
          </span>
        </summary>

        <div className="border-t border-[var(--border)] px-5 py-4">
          {partida.conceptos.length === 0 ? (
            <p className="py-2 text-sm text-[var(--muted)]">
              Esta partida todavía no tiene conceptos.
            </p>
          ) : (
            <form action={formAction}>
              <Table>
                <Thead>
                  <Tr>
                    <Th rowSpan={2} className="align-bottom">Concepto</Th>
                    <Th rowSpan={2} className="align-bottom">Unidad</Th>
                    <Th rowSpan={2} className="text-right align-bottom">Total contratado</Th>
                    <Th rowSpan={2} className="text-right align-bottom">
                      P.U. Contratista
                    </Th>
                    <Th rowSpan={2} className="text-right align-bottom">Anterior</Th>
                    <Th colSpan={2} className="text-center bg-[var(--brand)]/[0.04]">
                      Esta semana
                    </Th>
                    <Th rowSpan={2} className="text-right align-bottom">Acumulado</Th>
                    <Th rowSpan={2} className="text-right align-bottom">Pendiente</Th>
                    <Th rowSpan={2} className="text-right align-bottom">Avance</Th>
                    <Th rowSpan={2} className="align-bottom">Estado</Th>
                  </Tr>
                  <Tr>
                    <Th className="text-right bg-[var(--brand)]/[0.04]">Cantidad</Th>
                    <Th className="text-right bg-[var(--brand)]/[0.04]">Monto</Th>
                  </Tr>
                </Thead>
                <tbody>
                  {partida.conceptos.map((concepto) => (
                    <FilaConcepto
                      key={concepto.id}
                      proyectoId={proyectoId}
                      semanaId={semanaId}
                      concepto={concepto}
                      valor={valores[concepto.id] ?? ""}
                      valorMonto={valoresMonto[concepto.id] ?? ""}
                      onCambiar={(v) => actualizarValor(concepto.id, v)}
                      onCambiarMonto={(v) => actualizarMonto(concepto.id, v)}
                      puedeAprobar={puedeAprobar}
                      soloLectura={soloLectura}
                    />
                  ))}
                </tbody>
              </Table>

              {dirty ? (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
                  {state?.error && (
                    <p className="enter text-sm text-red-700">{state.error}</p>
                  )}
                  <span className="text-sm text-[var(--muted)]">
                    Cambios sin guardar: {conceptosModificados.length} concepto
                    {conceptosModificados.length === 1 ? "" : "s"}
                  </span>
                  <Button type="submit" disabled={pending}>
                    {pending ? "Guardando…" : "Guardar cambios"}
                  </Button>
                </div>
              ) : (
                state?.guardados !== undefined &&
                !state.error && (
                  <p className="enter mt-3 text-right text-sm text-emerald-700">
                    Guardado ✓
                  </p>
                )
              )}
            </form>
          )}
        </div>
      </details>
    </Card>
  );
}

function FilaConcepto({
  proyectoId,
  semanaId,
  concepto,
  valor,
  valorMonto,
  onCambiar,
  onCambiarMonto,
  puedeAprobar,
  soloLectura,
}: {
  proyectoId: string;
  semanaId: string;
  concepto: ConceptoConAvance;
  valor: string;
  valorMonto: string;
  onCambiar: (nuevaCantidad: string) => void;
  onCambiarMonto: (nuevoMonto: string) => void;
  puedeAprobar: boolean;
  soloLectura: boolean;
}) {
  const cantidadActual = new Prisma.Decimal(valor || 0);
  const anterior = new Prisma.Decimal(concepto.anterior);
  const total = new Prisma.Decimal(concepto.cantidadTotal);
  const acumulado = anterior.plus(cantidadActual);
  const pendiente = total.minus(acumulado);
  const avancePorcentaje = total.gt(0)
    ? acumulado.div(total).times(100).toNumber()
    : 0;
  const excede = acumulado.gt(total);

  const precio = precioDeCaptura(concepto);
  const tienePrecio = precio !== null;

  // Cantidad y Monto ahora viven en el padre (PartidaAvance) — cada input
  // maneja el otro explícitamente al cambiar, sin estado local propio que
  // pudiera perder de vista si el Monto realmente cambió (ver comentario en
  // PartidaAvance sobre la detección de "cambios sin guardar").
  const [montoEnfocado, setMontoEnfocado] = useState(false);

  function alCambiarCantidad(texto: string) {
    onCambiar(texto);
    onCambiarMonto(montoDesdeCantidad(texto, precio));
  }

  function alCambiarMonto(textoCrudo: string) {
    if (!tienePrecio || precio === null) return;
    // Deja escribir libremente — incluso números a medio terminar (ej. "12.").
    const texto = textoCrudo.replace(/[^0-9.]/g, "");
    onCambiarMonto(texto);

    if (texto === "") {
      onCambiar("");
      return;
    }
    if (texto === "." || Number.isNaN(Number(texto))) {
      return; // número incompleto — espera a que termine de escribir
    }

    // Aritmética con Decimal exacta (no float de JS) — la cantidad
    // resultante se redondea al mismo límite de precisión que el resto del
    // sistema (Concepto.cantidadContratada / ContratoConcepto.cantidad = 3
    // decimales). El monto EXACTO tecleado se conserva tal cual en
    // valorMonto — nunca se vuelve a derivar de esta cantidad ya redondeada
    // (ver AvanceConcepto.montoEjecutado).
    onCambiar(cantidadDesdeMonto(texto, precio));
  }

  return (
    <Tr>
      <Td className="align-top font-medium whitespace-pre-line">{concepto.descripcion}</Td>
      <Td className="text-[var(--muted)]">{concepto.unidad}</Td>
      <Td className="text-right tabular-nums">{formatCantidad(concepto.cantidadTotal)}</Td>
      <Td className="text-right tabular-nums text-[var(--muted)]">
        {precio !== null ? formatMoney(precio) : "—"}
        {precio !== null && concepto.precioUnitarioContratistaContratado === null && (
          <span className="block text-[11px]">Sin contratista</span>
        )}
      </Td>
      <Td className="text-right tabular-nums text-[var(--muted)]">
        {formatCantidad(concepto.anterior)}
      </Td>
      <Td className="bg-[var(--brand)]/[0.02]">
        <input
          type="number"
          name={`cantidad_${concepto.id}`}
          min={0}
          step="0.001"
          value={valor}
          onChange={(e) => alCambiarCantidad(e.target.value)}
          disabled={soloLectura}
          placeholder="0"
          className={cn(
            soloLectura && "opacity-60",
            "w-24 rounded-md border bg-[var(--surface)] px-2.5 py-1.5 text-right text-sm tabular-nums text-[var(--foreground)] transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/15",
            excede
              ? "border-red-300 focus:border-red-400"
              : "border-[var(--border)] focus:border-[var(--brand)]"
          )}
        />
      </Td>
      <Td className="bg-[var(--brand)]/[0.02]">
        {tienePrecio ? (
          <>
            {/* Monto exacto tecleado, sin el formato de despliegue — el
                servidor lo guarda tal cual (AvanceConcepto.montoEjecutado) y
                lo usa como importe real del corte, en vez de recalcularlo
                desde la cantidad ya redondeada a 3 decimales (evita perder
                centavos frente a lo que el contratista realmente pidió). */}
            <input type="hidden" name={`monto_${concepto.id}`} value={montoAEnviar(concepto, valor, valorMonto)} />
            <input
              type="text"
              inputMode="decimal"
              value={
                montoEnfocado
                  ? valorMonto
                  : valorMonto === ""
                    ? ""
                    : formatMoney(valorMonto)
              }
              onFocus={(e) => {
                // Al enfocar cambia «$10,000.00» por «10000»; se selecciona
                // todo para que teclear reemplace y no agregue dígitos.
                const campo = e.currentTarget;
                setMontoEnfocado(true);
                requestAnimationFrame(() => campo.select());
              }}
              onBlur={() => setMontoEnfocado(false)}
              onChange={(e) => alCambiarMonto(e.target.value)}
              disabled={soloLectura}
              placeholder="$0.00"
              className={cn(
                soloLectura && "opacity-60",
                "w-28 rounded-md border bg-[var(--surface)] px-2.5 py-1.5 text-right text-sm tabular-nums text-[var(--foreground)] transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/15",
                excede
                  ? "border-red-300 focus:border-red-400"
                  : "border-[var(--border)] focus:border-[var(--brand)]"
              )}
            />
          </>
        ) : (
          <span className="block text-right text-sm text-[var(--muted)]">—</span>
        )}
      </Td>
      <Td className="text-right font-medium tabular-nums">{formatCantidad(acumulado)}</Td>
      <Td
        className={cn(
          "text-right tabular-nums",
          excede ? "text-red-700" : "text-[var(--muted)]"
        )}
      >
        {excede ? `Excede ${formatCantidad(pendiente.abs())}` : formatCantidad(pendiente)}
      </Td>
      <Td>
        <BarraAvance porcentaje={avancePorcentaje} />
      </Td>
      <Td>
        <div className="space-y-1">
          <EstatusAprobacionAvanceBadge estatus={concepto.estatusAprobacion} />
          {puedeAprobar && !soloLectura && concepto.estatusAprobacion === "PENDIENTE" && (
            <ControlesAprobacion
              proyectoId={proyectoId}
              conceptoId={concepto.id}
              semanaId={semanaId}
            />
          )}
        </div>
      </Td>
    </Tr>
  );
}

// Botones en línea, no un desplegable: dentro de una tabla ancha con scroll
// horizontal un <details>/absolute quedaba recortado por el contenedor con
// overflow (había que hacer scroll para verlo). Además, un <form> aquí no
// puede anidarse dentro del <form> grande de captura de la partida — un
// <form> dentro de otro <form> es HTML inválido y el navegador lo descarta en
// silencio, por eso los botones no hacían nada. Se invoca la Server Action
// directamente, sin <form>.
function ControlesAprobacion({
  proyectoId,
  conceptoId,
  semanaId,
}: {
  proyectoId: string;
  conceptoId: string;
  semanaId: string;
}) {
  const [enviando, setEnviando] = useState(false);

  async function cambiarEstatus(nuevoEstatus: "APROBADO" | "RECHAZADO") {
    setEnviando(true);
    try {
      await cambiarEstatusAprobacionAvanceAction(
        proyectoId,
        conceptoId,
        semanaId,
        nuevoEstatus
      );
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={enviando}
        onClick={() => cambiarEstatus("APROBADO")}
        className="text-[11px] font-medium text-emerald-700 transition-colors duration-150 ease-out hover:underline disabled:opacity-50"
      >
        Aprobar
      </button>
      <button
        type="button"
        disabled={enviando}
        onClick={() => cambiarEstatus("RECHAZADO")}
        className="text-[11px] font-medium text-red-700 transition-colors duration-150 ease-out hover:underline disabled:opacity-50"
      >
        Rechazar
      </button>
    </div>
  );
}

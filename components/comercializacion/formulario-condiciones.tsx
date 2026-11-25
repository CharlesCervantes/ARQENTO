"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DetalleCuenta } from "@/lib/server/comercializacion/cuentas";
import { aCentavos, deCentavos, formatearImporte, normalizarImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { esPlazoMensual } from "@/lib/comercializacion/mensualidades";
import { anticipoYSaldo, CondicionesError, cuotasIguales, ETIQUETA_FRECUENCIA, pagoAPlazo, sumarDias, type CuotaPropuesta, type Frecuencia } from "@/lib/comercializacion/condiciones";
import { definirCondicionesAction } from "@/app/(app)/comercializacion/actions";

// Condiciones de cobro o pago: se elige una forma, se ven las fechas y los
// importes que resultan y se guarda. Guardar no registra dinero; el servidor
// valida todo otra vez.

type Forma = "CONTADO" | "PLAZO" | "ANTICIPO" | "CUOTAS" | "MANO";
const PLAZOS = [15, 30, 60, 90];

const claseCampo =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";

function Campo({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{etiqueta}</span>
      {children}
    </label>
  );
}

export function FormularioCondiciones({ cuenta, onListo, textoCancelar = "Cancelar" }: { cuenta: DetalleCuenta; onListo: () => void; textoCancelar?: string }) {
  const router = useRouter();
  const esCobro = cuenta.tipo === "POR_COBRAR";
  const total = cuenta.estado.total;
  const previas = cuenta.estado.cuotas;
  // Primera vez: se elige la forma. Al cambiar: parte de lo ya guardado.
  const [forma, setForma] = useState<Forma | null>(previas.length === 0 ? null : cuenta.modalidad === "CONTADO" ? "CONTADO" : "MANO");
  const [fechaContado, setFechaContado] = useState(previas[0]?.fechaVencimiento ?? cuenta.hoy);
  const [desde, setDesde] = useState(cuenta.hoy);
  const [dias, setDias] = useState("30");
  const [porcentaje, setPorcentaje] = useState("50");
  const [fechaAnticipo, setFechaAnticipo] = useState(cuenta.hoy);
  const [fechaSaldo, setFechaSaldo] = useState(sumarDias(cuenta.hoy, 30));
  const [numero, setNumero] = useState("3");
  const [primera, setPrimera] = useState(cuenta.hoy);
  const [frecuencia, setFrecuencia] = useState<Frecuencia>("MENSUAL");
  const [mano, setMano] = useState<CuotaPropuesta[]>(() =>
    previas.length > 0 ? previas.map((q) => ({ fecha: q.fechaVencimiento, importe: q.importe })) : [{ fecha: cuenta.hoy, importe: total }]
  );
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();

  const propuesta = useMemo((): { cuotas: CuotaPropuesta[] } | { error: string } | null => {
    if (forma === null || forma === "MANO") return null;
    try {
      if (forma === "CONTADO") return fechaContado ? { cuotas: [{ fecha: fechaContado, importe: total }] } : { error: "Indica la fecha." };
      if (forma === "PLAZO") return { cuotas: pagoAPlazo(total, desde, dias.trim() === "" ? NaN : Number(dias)) };
      if (forma === "ANTICIPO") return { cuotas: anticipoYSaldo(total, Number(porcentaje), fechaAnticipo, fechaSaldo) };
      return { cuotas: cuotasIguales(total, Number(numero), primera, frecuencia) };
    } catch (e) {
      return { error: e instanceof CondicionesError ? e.message : "Revisa los datos." };
    }
  }, [forma, fechaContado, desde, dias, porcentaje, fechaAnticipo, fechaSaldo, numero, primera, frecuencia, total]);

  const suma = mano.reduce((s, q) => {
    const n = normalizarImporte(q.importe, { permitirCero: false });
    return n ? s + aCentavos(n) : s;
  }, BigInt(0));
  const diferencia = aCentavos(total) - suma;
  const listo = forma === "MANO" ? diferencia === BigInt(0) && mano.every((q) => q.fecha) : Boolean(propuesta && "cuotas" in propuesta);

  function guardar() {
    setError(null);
    const cuotas = forma === "MANO" ? mano : propuesta && "cuotas" in propuesta ? propuesta.cuotas : [];
    // Mensualidades de una compra a proveedor: el servidor genera el calendario.
    const mensual = cuenta.origen === "COMPRA" && forma === "CUOTAS" && frecuencia === "MENSUAL" && esPlazoMensual(Number(numero));
    const datos = mensual
      ? { modalidad: "CREDITO", mensualidades: { plazo: Number(numero), primerVencimiento: primera } }
      : { modalidad: forma === "CONTADO" ? "CONTADO" : "CREDITO", cuotas: cuotas.map((q) => ({ fechaVencimiento: q.fecha, importe: q.importe })) };
    start(async () => {
      const r = await definirCondicionesAction({ cuentaId: cuenta.id, version: cuenta.version, datos });
      if (r.error) return setError(r.error);
      onListo();
      router.refresh();
    });
  }

  function ajustarAMano() {
    if (propuesta && "cuotas" in propuesta) setMano(propuesta.cuotas);
    setForma("MANO");
  }

  const opciones: { clave: string; etiqueta: string; detalle: string; activa: boolean; elegir: () => void }[] = [
    { clave: "CONTADO", etiqueta: "De contado", detalle: "Un solo pago", activa: forma === "CONTADO", elegir: () => setForma("CONTADO") },
    ...PLAZOS.map((d) => ({
      clave: `D${d}`,
      etiqueta: `A ${d} días`,
      detalle: `Vence ${formatearFechaCalendario(sumarDias(forma === "PLAZO" && desde ? desde : cuenta.hoy, d))}`,
      activa: forma === "PLAZO" && dias === String(d),
      elegir: () => {
        setForma("PLAZO");
        setDias(String(d));
        if (!desde) setDesde(cuenta.hoy);
      },
    })),
    { clave: "ANTICIPO", etiqueta: "Anticipo y saldo", detalle: "50 % y 50 %, ajustable", activa: forma === "ANTICIPO", elegir: () => setForma("ANTICIPO") },
    { clave: "CUOTAS", etiqueta: "Varias cuotas", detalle: "Iguales, se calculan solas", activa: forma === "CUOTAS", elegir: () => setForma("CUOTAS") },
    { clave: "MANO", etiqueta: "A mano", detalle: "Fechas e importes libres", activa: forma === "MANO", elegir: ajustarAMano },
  ];

  return (
    <div className="space-y-5" data-condiciones>
      <p className="text-sm">
        {esCobro ? "Total por cobrar" : "Total por pagar"}: <span className="font-semibold tabular-nums">{formatearImporte(total)}</span>
      </p>
      <div role="radiogroup" aria-label={esCobro ? "¿Cómo paga el cliente?" : "¿Cómo se paga?"}>
        <p className="mb-2 text-sm font-medium">{esCobro ? "¿Cómo paga el cliente?" : "¿Cómo se paga?"}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {opciones.map((o) => (
            <button
              key={o.clave}
              type="button"
              role="radio"
              aria-checked={o.activa}
              data-forma={o.clave}
              onClick={o.elegir}
              className={`min-h-11 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
                o.activa ? "border-[var(--brand)] bg-[var(--brand)]/[0.06] ring-1 ring-[var(--brand)]" : "border-[var(--border)] hover:bg-black/[0.03]"
              }`}
            >
              <span className="block text-sm font-medium">{o.etiqueta}</span>
              <span className="block text-xs text-[var(--muted)]">{o.detalle}</span>
            </button>
          ))}
        </div>
      </div>

      {forma === "CONTADO" && (
        <div className="max-w-xs">
          <Campo etiqueta={esCobro ? "Fecha de cobro" : "Fecha de pago"}>
            <Input type="date" value={fechaContado} onChange={(ev) => setFechaContado(ev.target.value)} aria-label="Fecha de contado" />
          </Campo>
        </div>
      )}
      {forma === "PLAZO" && (
        <div className="grid max-w-md grid-cols-2 gap-3">
          <Campo etiqueta="Contar desde">
            <Input type="date" value={desde} onChange={(ev) => setDesde(ev.target.value)} />
          </Campo>
          <Campo etiqueta="Días">
            <Input type="number" min={0} max={730} value={dias} onChange={(ev) => setDias(ev.target.value)} />
          </Campo>
        </div>
      )}
      {forma === "ANTICIPO" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Campo etiqueta="Anticipo (%)">
            <Input type="number" min={1} max={99} step="0.01" value={porcentaje} onChange={(ev) => setPorcentaje(ev.target.value)} />
          </Campo>
          <Campo etiqueta="Fecha del anticipo">
            <Input type="date" value={fechaAnticipo} onChange={(ev) => setFechaAnticipo(ev.target.value)} />
          </Campo>
          <Campo etiqueta="Fecha del saldo">
            <Input type="date" value={fechaSaldo} onChange={(ev) => setFechaSaldo(ev.target.value)} />
          </Campo>
        </div>
      )}
      {forma === "CUOTAS" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Campo etiqueta="Número de cuotas">
            <Input type="number" min={2} max={60} value={numero} onChange={(ev) => setNumero(ev.target.value)} />
          </Campo>
          <Campo etiqueta="Frecuencia">
            <select value={frecuencia} onChange={(ev) => setFrecuencia(ev.target.value as Frecuencia)} className={claseCampo}>
              {(Object.keys(ETIQUETA_FRECUENCIA) as Frecuencia[]).map((f) => (
                <option key={f} value={f}>
                  {ETIQUETA_FRECUENCIA[f]}
                </option>
              ))}
            </select>
          </Campo>
          <Campo etiqueta="Primera cuota">
            <Input type="date" value={primera} onChange={(ev) => setPrimera(ev.target.value)} />
          </Campo>
        </div>
      )}

      {propuesta && "error" in propuesta && <p className="text-sm text-amber-800">{propuesta.error}</p>}
      {propuesta && "cuotas" in propuesta && (
        <div className="space-y-2">
          <ul className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)]" aria-label="Así quedará">
            {propuesta.cuotas.map((q, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm" data-cuota-propuesta={i + 1}>
                <span className="text-[var(--muted)]">
                  {propuesta.cuotas.length === 1 ? (esCobro ? "Se cobra" : "Se paga") : `Cuota ${i + 1}`} el <span className="text-[var(--foreground)]">{formatearFechaCalendario(q.fecha)}</span>
                </span>
                <span className="font-medium tabular-nums">{formatearImporte(q.importe)}</span>
              </li>
            ))}
          </ul>
          {forma !== "CONTADO" && (
            <button type="button" onClick={ajustarAMano} className="text-sm font-medium text-[var(--brand)] hover:underline">
              Ajustar fechas o importes
            </button>
          )}
        </div>
      )}

      {forma === "MANO" && (
        <div className="space-y-2">
          {mano.map((q, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-16 text-sm text-[var(--muted)]">Cuota {i + 1}</span>
              <Input type="date" value={q.fecha} onChange={(ev) => setMano((cs) => cs.map((x, j) => (j === i ? { ...x, fecha: ev.target.value } : x)))} className="w-44" aria-label={`Fecha de la cuota ${i + 1}`} />
              <Input
                value={q.importe}
                onChange={(ev) => setMano((cs) => cs.map((x, j) => (j === i ? { ...x, importe: ev.target.value } : x)))}
                inputMode="decimal"
                placeholder="0.00"
                className="w-36"
                aria-label={`Importe de la cuota ${i + 1}`}
              />
              {mano.length > 1 && (
                <button type="button" onClick={() => setMano((cs) => cs.filter((_, j) => j !== i))} className={claseSecundaria}>
                  Quitar
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setMano((cs) => [...cs, { fecha: cuenta.hoy, importe: diferencia > BigInt(0) ? deCentavos(diferencia) : "" }])} className="text-sm font-medium text-[var(--brand)] hover:underline">
            + Agregar fecha
          </button>
          <p className={`text-xs ${diferencia === BigInt(0) ? "text-[var(--muted)]" : "text-amber-800"}`}>
            Suma {formatearImporte(deCentavos(suma))} de {formatearImporte(total)}
            {diferencia !== BigInt(0) && (diferencia > BigInt(0) ? ` · faltan ${formatearImporte(deCentavos(diferencia))}` : ` · sobran ${formatearImporte(deCentavos(-diferencia))}`)}. Se admiten fechas pasadas.
          </p>
        </div>
      )}

      <p className="text-xs text-[var(--muted)]">Guardar las condiciones no registra dinero {esCobro ? "recibido" : "pagado"}.</p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="button" onClick={guardar} disabled={pendiente || !listo}>
          {pendiente ? "Guardando…" : "Guardar condiciones"}
        </Button>
        <button type="button" onClick={onListo} className={claseSecundaria} disabled={pendiente}>
          {textoCancelar}
        </button>
      </div>
    </div>
  );
}

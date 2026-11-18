"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EntregaDetalle, ResumenEntregasOrden } from "@/lib/server/comercializacion/entregas";
import { aMilesimas, formatearCantidad, normalizarCantidad } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { ETIQUETA_ESTADO_ENTREGA, MAX_EVIDENCIAS_POR_CARGA, MAX_EVIDENCIAS_POR_ENTREGA, type EstadoEntrega } from "@/lib/comercializacion/entregas";
import { MB_POR_CARGA } from "@/lib/comercializacion/cargas";
import { agregarEvidenciasAction, anularEntregaAction, registrarEntregaAction, type EntregaState, type EvidenciasState } from "@/app/(app)/comercializacion/actions";
import { AvisosArchivos, useArchivosDeCarga } from "./campo-archivos";

// Entregas y documentos de una OV — B6A. Lo ven administración y el vendedor
// asignado (el servidor aplica el alcance). Solo cantidades y evidencias de
// ENTREGA AL CLIENTE: sin costos, compras, proveedores, cobros ni pagos.
// El servidor recalcula pendientes y valida todo; aquí solo se orienta.

const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";
const claseEnlace = "font-medium text-[var(--brand)] hover:underline";
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Monterrey",
});
const clave = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const AYUDA_EVIDENCIAS = `Hasta ${MAX_EVIDENCIAS_POR_CARGA} archivos y ${MB_POR_CARGA} MB por carga; una entrega acumula máximo ${MAX_EVIDENCIAS_POR_ENTREGA} evidencias.`;

const ESTILO_ESTADO: Record<EstadoEntrega, string> = {
  PENDIENTE: "bg-black/[0.06] text-[var(--muted)]",
  PARCIAL: "bg-amber-50 text-amber-800",
  COMPLETA: "bg-emerald-50 text-emerald-700",
};

function Etiqueta({ texto, estilo }: { texto: string; estilo: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${estilo}`}>{texto}</span>;
}

const cant = (c: string, unidad: string) => `${formatearCantidad(c)} ${unidad}`;

export function EntregasOrden({ resumen }: { resumen: ResumenEntregasOrden }) {
  const [registrando, setRegistrando] = useState(false);
  const hayPendiente = resumen.partidas.some((p) => !p.completa);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Entregas y documentos</h2>
          <p className="text-xs text-[var(--muted)]">
            Material entregado al cliente en obra, con fotografías o remisión. No acredita la recepción de una compra ni modifica precios, compras, cobros o
            pagos: una venta puede estar entregada y pendiente de cobro.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Etiqueta texto={`Entrega: ${ETIQUETA_ESTADO_ENTREGA[resumen.estado]}`} estilo={ESTILO_ESTADO[resumen.estado]} />
          <span className="text-xs text-[var(--muted)]">
            {resumen.completas} de {resumen.totalPartidas} partidas completas
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-black/[0.02]">
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              <th className="border-b border-[var(--border)] px-3 py-2">Material</th>
              <th className="border-b border-[var(--border)] px-3 py-2 text-right">Vendido</th>
              <th className="border-b border-[var(--border)] px-3 py-2 text-right">Entregado</th>
              <th className="border-b border-[var(--border)] px-3 py-2 text-right">Pendiente</th>
            </tr>
          </thead>
          <tbody>
            {resumen.partidas.map((p) => (
              <tr key={p.partidaVentaId} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{p.codigo}</span> <span className="text-[var(--muted)]">{p.descripcion}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cant(p.vendido, p.unidad)}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cant(p.entregado, p.unidad)}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {p.completa ? <Etiqueta texto="Completa" estilo={ESTILO_ESTADO.COMPLETA} /> : cant(p.pendiente, p.unidad)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {registrando ? (
        <FormularioEntrega resumen={resumen} onListo={() => setRegistrando(false)} />
      ) : hayPendiente ? (
        <Button type="button" onClick={() => setRegistrando(true)}>
          Registrar entrega
        </Button>
      ) : (
        <p className="text-sm text-[var(--muted)]">Todo lo vendido está entregado.</p>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Historial de entregas</h3>
        {resumen.entregas.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Sin entregas registradas.</p>
        ) : (
          <ul className="space-y-2">
            {resumen.entregas.map((e) => (
              <Entrega key={e.id} e={e} puedeAnular={resumen.puedeAnular} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function FormularioEntrega({ resumen, onListo }: { resumen: ResumenEntregasOrden; onListo: () => void }) {
  const router = useRouter();
  const [claveRegistro] = useState(clave);
  const [fecha, setFecha] = useState(resumen.hoy);
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [recibidoPor, setRecibidoPor] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [state, formAction, pendiente] = useActionState<EntregaState, FormData>(registrarEntregaAction.bind(null, resumen.ordenVentaId), undefined);
  // Tras cada respuesta, React restablece el formulario y el campo de archivos
  // queda vacío: la selección solo vale para la respuesta con la que se hizo.
  const archivos = useArchivosDeCarga(state, { maxArchivos: MAX_EVIDENCIAS_POR_CARGA });
  const debeReadjuntar = Boolean(state?.error) && archivos.n === 0;
  useEffect(() => {
    if (state?.ok) {
      onListo();
      router.refresh();
    }
  }, [state, onListo, router]);

  const abiertas = resumen.partidas.filter((p) => !p.completa);
  const filas = abiertas.map((p) => {
    const valor = cantidades[p.partidaVentaId] ?? "";
    const normal = valor.trim() ? normalizarCantidad(valor) : null;
    const invalida = valor.trim() !== "" && !normal && !/^\s*0*(\.0*)?\s*$/.test(valor);
    const excede = normal !== null && aMilesimas(normal) > aMilesimas(p.pendiente);
    return { p, valor, normal, invalida, excede };
  });
  const conCantidad = filas.filter((f) => f.normal);
  const avisoArchivos = archivos.exceso;
  const partidasJson = JSON.stringify(filas.filter((f) => f.valor.trim()).map((f) => ({ partidaVentaId: f.p.partidaVentaId, cantidad: f.valor })));

  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-[var(--border)] p-4">
      <input type="hidden" name="clave" value={claveRegistro} />
      <input type="hidden" name="partidas" value={partidasJson} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Fecha real de entrega</span>
          <Input type="date" name="fechaEntrega" value={fecha} max={resumen.hoy} onChange={(ev) => setFecha(ev.target.value)} required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Recibe (opcional)</span>
          <Input
            name="recibidoPor"
            value={recibidoPor}
            onChange={(ev) => setRecibidoPor(ev.target.value)}
            maxLength={150}
            placeholder="Nombre de quien recibe"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Observaciones (opcional)</span>
          <Input name="observaciones" value={observaciones} onChange={(ev) => setObservaciones(ev.target.value)} maxLength={1000} />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Cantidades entregadas (deja vacío lo que no se entregó)</p>
        {filas.map(({ p, valor, invalida, excede }) => (
          <div key={p.partidaVentaId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="min-w-[14rem] flex-1">
              <span className="font-medium">{p.codigo}</span> <span className="text-[var(--muted)]">{p.descripcion}</span>
              <span className="block text-xs text-[var(--muted)]">Pendiente: {cant(p.pendiente, p.unidad)}</span>
            </span>
            <div className="w-32 shrink-0">
              <Input
                value={valor}
                onChange={(ev) =>
                  setCantidades((c) => ({
                    ...c,
                    [p.partidaVentaId]: ev.target.value,
                  }))
                }
                inputMode="decimal"
                placeholder="0"
                aria-label={`Cantidad entregada de ${p.codigo}`}
              />
            </div>
            <span className="text-[var(--muted)]">{p.unidad}</span>
            <button
              type="button"
              className={claseSecundaria}
              onClick={() =>
                setCantidades((c) => ({
                  ...c,
                  [p.partidaVentaId]: formatearCantidad(p.pendiente).replace(/,/g, ""),
                }))
              }
            >
              Todo lo pendiente
            </button>
            {invalida && <span className="w-full text-xs text-red-700">Cantidad positiva con máximo 3 decimales.</span>}
            {excede && (
              <span className="w-full text-xs text-red-700">
                Supera lo pendiente por entregar ({cant(p.pendiente, p.unidad)}
                ).
              </span>
            )}
          </div>
        ))}
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Evidencias (obligatorio): fotografías JPG/PNG o remisión PDF</span>
        <input
          type="file"
          name="evidencias"
          multiple
          accept="image/jpeg,image/png,application/pdf"
          required
          onChange={archivos.onChange}
          className="block text-sm"
        />
        <AvisosArchivos
          exceso={avisoArchivos}
          reseleccionar={debeReadjuntar ? "Cantidades y datos se conservaron; vuelve a adjuntar las evidencias antes de registrar." : null}
          ayuda={`${AYUDA_EVIDENCIAS} Si un archivo no es válido, no se registra la entrega.`}
        />
      </label>

      <p className="text-xs text-[var(--muted)]">
        Una entrega registrada no se edita. Si se capturó por error, administración la anula con motivo y se registra la correcta.
      </p>
      {state?.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pendiente || conCantidad.length === 0 || archivos.n === 0 || Boolean(avisoArchivos) || filas.some((f) => f.invalida)}>
          {pendiente ? "Registrando…" : "Registrar entrega"}
        </Button>
        <button type="button" onClick={onListo} className={claseSecundaria} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function Entrega({ e, puedeAnular }: { e: EntregaDetalle; puedeAnular: boolean }) {
  const router = useRouter();
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  const anulada = e.estatus === "ANULADA";
  return (
    <li className={`rounded-lg border border-[var(--border)] p-3 text-sm ${anulada ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className={`font-semibold ${anulada ? "line-through" : ""}`}>Entrega {e.numero}</span>{" "}
          <span className="text-[var(--muted)]">
            · {formatearFechaCalendario(e.fechaEntrega)}
            {e.recibidoPor && ` · recibió ${e.recibidoPor}`}
          </span>
          {anulada && <Etiqueta texto="Anulada" estilo="ml-2 bg-red-50 text-red-700" />}
        </div>
        {puedeAnular && !anulada && !anulando && (
          <button type="button" onClick={() => setAnulando(true)} className={claseSecundaria}>
            Anular por error
          </button>
        )}
      </div>
      <p className={`mt-1 ${anulada ? "line-through" : ""}`}>{e.partidas.map((p) => `${p.codigo}: ${cant(p.cantidad, p.unidad)}`).join(" · ")}</p>
      <p className="mt-0.5 text-xs text-[var(--muted)]">
        Evidencias:{" "}
        {e.evidencias.map((ev, i) => (
          <span key={ev.id}>
            {i > 0 && ", "}
            <a href={`/api/comercializacion/evidencias-entrega/${ev.id}`} target="_blank" rel="noopener" className={claseEnlace}>
              {ev.nombre}
            </a>{" "}
            ({ev.clase === "REMISION" ? "remisión" : "foto"}
            {ev.agregada && `, agregada por ${ev.agregada.porNombre} el ${formatoFechaHora.format(new Date(ev.agregada.en))}`})
          </span>
        ))}{" "}
        · registró {e.registradaPorNombre} el {formatoFechaHora.format(new Date(e.registradaEn))}
      </p>
      {e.observaciones && <p className="mt-0.5 text-xs text-[var(--muted)]">{e.observaciones}</p>}
      {!anulada && <AgregarEvidencias e={e} />}
      {e.anulada && (
        <p className="mt-0.5 text-xs text-red-700">
          Anulada por {e.anulada.porNombre ?? "administración"} el {formatoFechaHora.format(new Date(e.anulada.en))}: {e.anulada.motivo}. Sus cantidades ya no
          cuentan como entregadas (corrección de captura, no una devolución); el registro y sus evidencias se conservan.
        </p>
      )}
      {anulando && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-[var(--muted)]">
            Anular corrige una captura errónea: las cantidades de esta entrega vuelven a quedar pendientes. No registra una devolución física.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Motivo (obligatorio)" maxLength={500} className="sm:max-w-md" />
            <Button
              type="button"
              variant="outline"
              disabled={pendiente || motivo.trim().length < 3}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await anularEntregaAction({
                    entregaId: e.id,
                    motivo,
                  });
                  if (r.error) return setError(r.error);
                  setAnulando(false);
                  router.refresh();
                })
              }
            >
              {pendiente ? "Anulando…" : "Anular entrega"}
            </Button>
            <button type="button" onClick={() => setAnulando(false)} className={claseSecundaria}>
              Cancelar
            </button>
            {error && <span className="text-sm text-red-700">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

/** Agregar fotografías o remisiones a una entrega vigente (no cambia cantidades ni estado). */
function AgregarEvidencias({ e }: { e: EntregaDetalle }) {
  const router = useRouter();
  const [state, formAction, pendiente] = useActionState<EvidenciasState, FormData>(agregarEvidenciasAction.bind(null, e.id), undefined);
  // Se abre «con» la respuesta vigente; una respuesta exitosa posterior lo cierra.
  const [abiertoCon, setAbiertoCon] = useState<{ respuesta: EvidenciasState } | null>(null);
  const abierto = abiertoCon !== null && !(state?.ok && state !== abiertoCon.respuesta);
  // Una clave por apertura: los reintentos de la misma carga no duplican; otra carga es otra operación.
  const [claveCarga, setClaveCarga] = useState(clave);
  const archivos = useArchivosDeCarga(state, { maxArchivos: Math.min(MAX_EVIDENCIAS_POR_CARGA, e.evidenciasDisponibles) });
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const abrir = () => {
    setClaveCarga(clave());
    setAbiertoCon({ respuesta: state });
  };
  if (e.evidenciasDisponibles <= 0) {
    return <p className="mt-1 text-xs text-[var(--muted)]">Esta entrega ya tiene el máximo de {MAX_EVIDENCIAS_POR_ENTREGA} evidencias.</p>;
  }
  if (!abierto) {
    return (
      <div className="mt-1 flex items-center gap-3">
        <button type="button" onClick={abrir} className={claseEnlace + " text-xs"}>
          + Agregar evidencia
        </button>
        {state?.ok && <span className="text-xs text-emerald-700">Se agregaron {state.agregadas} evidencia(s).</span>}
      </div>
    );
  }
  return (
    <form action={formAction} className="mt-2 space-y-2 rounded-lg border border-[var(--border)] p-3">
      <input type="hidden" name="clave" value={claveCarga} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Evidencias adicionales: fotografías JPG/PNG o remisión PDF</span>
        <input type="file" name="evidencias" multiple required accept="image/jpeg,image/png,application/pdf" onChange={archivos.onChange} className="block text-sm" />
        <AvisosArchivos
          exceso={archivos.exceso}
          reseleccionar={state?.error && archivos.debeReseleccionar ? "Vuelve a seleccionar los archivos." : null}
          ayuda={`Solo agrega: no cambia cantidades, fecha ni estado, y no reemplaza ni borra evidencias. Admite ${e.evidenciasDisponibles} más (hasta ${MAX_EVIDENCIAS_POR_CARGA} y ${MB_POR_CARGA} MB por carga).`}
        />
      </label>
      {state?.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pendiente || archivos.n === 0 || Boolean(archivos.exceso)}>
          {pendiente ? "Agregando…" : "Agregar evidencias"}
        </Button>
        <button type="button" onClick={() => setAbiertoCon(null)} className={claseSecundaria} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

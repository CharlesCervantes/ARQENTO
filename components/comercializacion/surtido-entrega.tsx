"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SurtidoEntrega, VinculoDetalle } from "@/lib/server/comercializacion/surtido";
import { aMilesimas, formatearCantidad, normalizarCantidad } from "@/lib/comercializacion/importes";
import { anularVinculoSurtidoAction, vincularSurtidoAction } from "@/app/(app)/comercializacion/actions";

// Surtido directo a obra de una entrega — B8A. SOLO administración: la página
// no envía estos datos al vendedor. Identifica qué compra (proveedor) surtió
// lo entregado; no es inventario ni recepción en almacén y no cambia
// cantidades, importes ni saldos.

const claseSecundaria = "text-xs text-[var(--muted)] hover:text-[var(--foreground)]";
const claseEnlace = "text-xs font-medium text-[var(--brand)] hover:underline";
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });
const clave = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const cant = (c: string, u: string) => `${formatearCantidad(c)} ${u}`;

export function SurtidoEntregaView({ surtido }: { surtido: SurtidoEntrega }) {
  const [vinculando, setVinculando] = useState(false);
  const [claveCaptura, setClaveCaptura] = useState(clave);
  const pendientes = surtido.partidas.filter((p) => aMilesimas(p.pendiente) > BigInt(0));
  const abrir = () => {
    setClaveCaptura(clave());
    setVinculando(true);
  };
  return (
    <div className="mt-2 space-y-1.5 rounded-lg bg-black/[0.02] p-2.5" data-surtido>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">
          Surtido a obra (compras que lo surtieron)
          {!surtido.vigente && <span className="ml-1 font-normal text-[var(--muted)]">· entrega anulada: sus vínculos ya no cuentan</span>}
        </span>
        {surtido.vigente &&
          (pendientes.length > 0 ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" data-origen-pendiente>
              Origen por identificar: {pendientes.map((p) => `${cant(p.pendiente, p.unidad)} de ${p.codigo}`).join(", ")}
            </span>
          ) : (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Origen identificado</span>
          ))}
      </div>
      <ul className="space-y-1 text-xs">
        {surtido.partidas.map((p) => (
          <li key={p.partidaEntregaId}>
            <span className="font-medium">{p.codigo}</span>: entregado {cant(p.entregado, p.unidad)} · vinculado {cant(p.vinculado, p.unidad)}
            {surtido.vigente && <> · pendiente {cant(p.pendiente, p.unidad)}</>}
            {p.vinculos.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 pl-3">
                {p.vinculos.map((v) => (
                  <Vinculo key={v.id} v={v} unidad={p.unidad} />
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {surtido.vigente && pendientes.length > 0 && !vinculando && (
        <button type="button" onClick={abrir} className={claseEnlace}>
          Vincular compras
        </button>
      )}
      {vinculando && <FormularioVinculos surtido={surtido} claveCaptura={claveCaptura} onListo={() => setVinculando(false)} />}
    </div>
  );
}

function Vinculo({ v, unidad }: { v: VinculoDetalle; unidad: string }) {
  const router = useRouter();
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  return (
    <li className={v.vigente ? "" : "text-[var(--muted)]"}>
      <span className={v.estatus === "ANULADO" ? "line-through" : ""}>
        {cant(v.cantidad, unidad)} de{" "}
        <a href={`/comercializacion/compras/${v.compraId}`} className={claseEnlace}>
          {v.compraFolio}
        </a>{" "}
        ({v.proveedorNombre})
      </span>{" "}
      · registró {v.registradoPorNombre} el {formatoFechaHora.format(new Date(v.registradoEn))}
      {v.anulado && (
        <span className="text-red-700">
          {" "}
          · anulado por {v.anulado.porNombre} el {formatoFechaHora.format(new Date(v.anulado.en))}: {v.anulado.motivo}
        </span>
      )}
      {v.estatus === "VIGENTE" && v.vigente && !anulando && (
        <button type="button" onClick={() => setAnulando(true)} className={`${claseSecundaria} ml-2`}>
          Anular vínculo
        </button>
      )}
      {anulando && (
        <span className="mt-1 flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <Input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Motivo (obligatorio)" maxLength={500} className="sm:max-w-xs" />
          <Button
            type="button"
            variant="outline"
            disabled={pendiente || motivo.trim().length < 3}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await anularVinculoSurtidoAction({ vinculoId: v.id, motivo });
                if (r.error) return setError(r.error);
                setAnulando(false);
                router.refresh();
              })
            }
          >
            {pendiente ? "Anulando…" : "Anular vínculo"}
          </Button>
          <button type="button" onClick={() => setAnulando(false)} className={claseSecundaria}>
            Cancelar
          </button>
          {error && <span className="text-red-700">{error}</span>}
          <span className="text-[var(--muted)]">Libera la cantidad; no es una devolución ni cambia lo comprado o entregado.</span>
        </span>
      )}
    </li>
  );
}

function FormularioVinculos({ surtido, claveCaptura, onListo }: { surtido: SurtidoEntrega; claveCaptura: string; onListo: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  const abiertas = surtido.partidas.filter((p) => aMilesimas(p.pendiente) > BigInt(0));
  // Con una sola compra elegible se PROPONE la cantidad compatible; el usuario
  // la revisa y confirma (nada se vincula sin «Confirmar vínculos»).
  const [valores, setValores] = useState<Record<string, string>>(() => {
    const inicial: Record<string, string> = {};
    for (const p of abiertas) {
      const conDisponible = p.elegibles.filter((c) => aMilesimas(c.disponible) > BigInt(0));
      if (conDisponible.length === 1) {
        const c = conDisponible[0];
        const propuesta = aMilesimas(p.pendiente) < aMilesimas(c.disponible) ? p.pendiente : c.disponible;
        inicial[`${p.partidaEntregaId}|${c.partidaCompraId}`] = formatearCantidad(propuesta).replace(/,/g, "");
      }
    }
    return inicial;
  });
  const lineas = Object.entries(valores)
    .filter(([, v]) => v.trim() !== "")
    .map(([k, cantidad]) => {
      const [partidaEntregaId, partidaCompraId] = k.split("|");
      return { partidaEntregaId, partidaCompraId, cantidad };
    });
  const invalidas = lineas.filter((l) => !normalizarCantidad(l.cantidad) && !/^\s*0*(\.0*)?\s*$/.test(l.cantidad));
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-xs text-[var(--muted)]">
        Indica qué compra surtió cada cantidad entregada. Puedes vincular una parte y completar después. No cambia cantidades, importes ni pagos.
      </p>
      {abiertas.map((p) => (
        <div key={p.partidaEntregaId} className="space-y-1">
          <p className="text-xs font-medium">
            {p.codigo} {p.descripcion} · entregado {cant(p.entregado, p.unidad)} · vinculado {cant(p.vinculado, p.unidad)} · pendiente{" "}
            {cant(p.pendiente, p.unidad)}
          </p>
          {p.elegibles.length === 0 ? (
            <p className="text-xs text-amber-800">No hay compras confirmadas de este material. Registra la compra para identificar su origen.</p>
          ) : (
            p.elegibles.map((c) => {
              const k = `${p.partidaEntregaId}|${c.partidaCompraId}`;
              const sinDisponible = aMilesimas(c.disponible) <= BigInt(0);
              return (
                <div key={c.partidaCompraId} className="flex flex-wrap items-center gap-2 pl-3 text-xs">
                  <span className="min-w-[16rem]">
                    {c.folio} ({c.proveedorNombre}) · comprado {cant(c.comprado, p.unidad)} · disponible {cant(c.disponible, p.unidad)}
                  </span>
                  <div className="w-28">
                    <Input
                      value={valores[k] ?? ""}
                      onChange={(ev) => setValores((vs) => ({ ...vs, [k]: ev.target.value }))}
                      inputMode="decimal"
                      placeholder="0"
                      disabled={sinDisponible}
                      aria-label={`Cantidad de ${p.codigo} surtida por ${c.folio}`}
                    />
                  </div>
                  <span className="text-[var(--muted)]">{p.unidad}</span>
                </div>
              );
            })
          )}
        </div>
      ))}
      {invalidas.length > 0 && <p className="text-xs text-red-700">Cantidades positivas con máximo 3 decimales.</p>}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={pendiente || lineas.length === 0 || invalidas.length > 0}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await vincularSurtidoAction({ entregaId: surtido.entregaId, lineas, clave: claveCaptura });
              if (r.error) return setError(r.error);
              onListo();
              router.refresh();
            })
          }
        >
          {pendiente ? "Vinculando…" : "Confirmar vínculos"}
        </Button>
        <button type="button" onClick={onListo} className={claseSecundaria} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EVENTO_CERRAR_PANELES } from "./panel-lateral";

// Vistas internas del expediente (plan §5): Resumen / Compras y entregas /
// Cobros y pagos (el vendedor: Resumen / Entregas). Todas llegan dibujadas
// desde el servidor —solo con lo que el usuario puede ver— y aquí solo se
// alterna cuál se muestra:
// - La vista activa vive en `?vista=` (replaceState): Recargar y Atrás la
//   conservan sin pedir otra vez los datos.
// - Un ancla (#cobros, #gasto-…, #entrega-…) abre la vista que la contiene,
//   despliega el bloque si estaba plegado y lleva a él: así siguen
//   funcionando los enlaces de «Por atender» y de los bloqueos.

export type VistaOperacion = { id: string; etiqueta: string; detalle?: string };

function vistaDe(el: Element | null): string | null {
  return el?.closest<HTMLElement>("[data-vista]")?.dataset.vista ?? null;
}

function abrirPlegados(el: HTMLElement) {
  for (let p = el.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.querySelectorAll<HTMLDetailsElement>("details[data-abrir-con-ancla]").forEach((d) => (d.open = true));
}

function escribirUrl(vista: string, hash?: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("vista", vista);
  if (hash !== undefined) url.hash = hash;
  window.history.replaceState(window.history.state, "", url);
}

export function VistasOperacion({ vistas, inicial, paneles }: { vistas: VistaOperacion[]; inicial: string; paneles: Record<string, ReactNode> }) {
  const [activa, setActiva] = useState(vistas.some((v) => v.id === inicial) ? inicial : vistas[0].id);

  const irAAncla = useCallback(
    (hash: string) => {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      if (!id) return false;
      const el = document.getElementById(id);
      if (!el) return false;
      const vista = vistaDe(el);
      if (vista && vistas.some((v) => v.id === vista)) {
        setActiva(vista);
        escribirUrl(vista, `#${id}`);
      }
      abrirPlegados(el);
      // Después de mostrar la vista (siguiente cuadro).
      requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: "start" })));
      return true;
    },
    [vistas]
  );

  useEffect(() => {
    // Al entrar con un ancla (p. ej. desde «Por atender»), después del primer cuadro.
    const inicial = window.location.hash ? requestAnimationFrame(() => irAAncla(window.location.hash)) : 0;
    const alCambiarHash = () => irAAncla(window.location.hash);
    // Enlaces a un ancla de esta misma página (también dentro de un panel).
    const alClic = (ev: MouseEvent) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = (ev.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank") return;
      const url = new URL(a.href, window.location.href);
      if (url.pathname !== window.location.pathname || !url.hash) return;
      if (!document.getElementById(decodeURIComponent(url.hash.slice(1)))) return;
      ev.preventDefault();
      window.dispatchEvent(new Event(EVENTO_CERRAR_PANELES));
      irAAncla(url.hash);
    };
    window.addEventListener("hashchange", alCambiarHash);
    document.addEventListener("click", alClic, true);
    return () => {
      cancelAnimationFrame(inicial);
      window.removeEventListener("hashchange", alCambiarHash);
      document.removeEventListener("click", alClic, true);
    };
  }, [irAAncla]);

  const elegir = (id: string) => {
    setActiva(id);
    escribirUrl(id, "");
  };

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Vistas de la operación"
        data-vistas
        className="-mx-1 flex gap-1 overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        onKeyDown={(ev) => {
          if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
          const i = vistas.findIndex((v) => v.id === activa);
          const sig = vistas[(i + (ev.key === "ArrowRight" ? 1 : vistas.length - 1)) % vistas.length];
          elegir(sig.id);
          document.getElementById(`pestana-${sig.id}`)?.focus();
        }}
      >
        {vistas.map((v) => {
          const sel = v.id === activa;
          return (
            <button
              key={v.id}
              id={`pestana-${v.id}`}
              type="button"
              role="tab"
              aria-selected={sel}
              aria-controls={`vista-${v.id}`}
              tabIndex={sel ? 0 : -1}
              onClick={() => elegir(v.id)}
              className={`min-h-11 flex-1 whitespace-nowrap rounded-xl px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
                sel ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "text-[var(--foreground)] hover:bg-black/[0.04]"
              }`}
            >
              {v.etiqueta}
              {v.detalle && <span className={`ml-2 text-xs font-normal ${sel ? "opacity-80" : "text-[var(--muted)]"}`}>{v.detalle}</span>}
            </button>
          );
        })}
      </div>
      {vistas.map((v) => (
        <div key={v.id} id={`vista-${v.id}`} role="tabpanel" aria-labelledby={`pestana-${v.id}`} data-vista={v.id} hidden={v.id !== activa} className="space-y-6">
          {paneles[v.id]}
        </div>
      ))}
    </div>
  );
}

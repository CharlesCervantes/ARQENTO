"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BOTON_SECUNDARIO } from "./estilos";

// «Más acciones»: agrupa acciones poco frecuentes (duplicar, rechazar,
// cancelar) para que no compitan con las principales. Cada opción abre su
// propio panel con explicación y confirmación; el menú no ejecuta nada solo.
export type OpcionMenu = { id: string; etiqueta: string; peligro?: boolean; alElegir: () => void; deshabilitada?: boolean };

export function MenuAcciones({ opciones, etiqueta = "Más acciones" }: { opciones: OpcionMenu[]; etiqueta?: string }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!abierto) return;
    const fuera = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) setAbierto(false);
    };
    const tecla = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", tecla);
    // Foco a la primera opción al abrir.
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierto]);
  if (opciones.length === 0) return null;
  return (
    <div ref={ref} className="relative" data-menu-acciones>
      <button type="button" className={BOTON_SECUNDARIO} aria-haspopup="menu" aria-expanded={abierto} aria-controls={id} onClick={() => setAbierto((a) => !a)}>
        {etiqueta}
        <svg viewBox="0 0 20 20" className={`size-4 transition-transform ${abierto ? "rotate-180" : ""}`} aria-hidden="true">
          <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {abierto && (
        <ul
          id={id}
          role="menu"
          className="absolute right-0 z-20 mt-2 min-w-[14rem] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[0_12px_32px_-12px_rgba(22,25,28,0.3)]"
          onKeyDown={(ev) => {
            if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
            ev.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
          }}
        >
          {opciones.map((o) => (
            <li key={o.id} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={o.deshabilitada}
                onClick={() => {
                  setAbierto(false);
                  o.alElegir();
                }}
                className={`flex min-h-11 w-full items-center px-4 text-left text-sm focus-visible:bg-black/[0.05] focus-visible:outline-none disabled:opacity-50 ${
                  o.peligro ? "text-red-700 hover:bg-red-50" : "text-[var(--foreground)] hover:bg-black/[0.04]"
                }`}
              >
                {o.etiqueta}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

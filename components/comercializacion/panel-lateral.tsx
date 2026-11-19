"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";

// Panel para capturas cortas (plan §7): lateral en escritorio y a pantalla
// completa en móvil. <dialog> nativo: atrapa el foco, Escape lo cierra y el
// contenido de fondo queda inerte. Solo dibuja su contenido mientras está
// abierto, así que cada apertura empieza con el formulario limpio.
// - Si hubo captura (cualquier input) y se intenta cerrar sin guardar, pide
//   confirmación. Un formulario que se guarda llama a `onCerrar` directamente.
// - Cuando aparece un mensaje de error (role="alert"), lleva el foco a él.
// - Un enlace interno de la operación (evento "comercial:cerrar-paneles")
//   cierra el panel antes de llevar a su destino.

export const EVENTO_CERRAR_PANELES = "comercial:cerrar-paneles";

export function PanelLateral({
  abierto,
  onCerrar,
  titulo,
  contexto,
  ancho = "normal",
  children,
}: {
  abierto: boolean;
  onCerrar: () => void;
  titulo: string;
  /** Documento y destinatario: «OV-000019 · Constructora Norte». */
  contexto?: ReactNode;
  ancho?: "normal" | "amplio";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const sucio = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (abierto && !d.open) {
      sucio.current = false;
      d.showModal();
    } else if (!abierto && d.open) {
      d.close();
    }
  }, [abierto]);

  const intentarCerrar = useCallback(() => {
    if (sucio.current && !window.confirm("Hay datos capturados sin guardar. ¿Descartar la captura?")) return;
    onCerrar();
  }, [onCerrar]);

  useEffect(() => {
    if (!abierto) return;
    const cerrar = () => onCerrar();
    window.addEventListener(EVENTO_CERRAR_PANELES, cerrar);
    return () => window.removeEventListener(EVENTO_CERRAR_PANELES, cerrar);
  }, [abierto, onCerrar]);

  // Foco al mensaje de error cuando aparece.
  useEffect(() => {
    const d = ref.current;
    if (!abierto || !d) return;
    const obs = new MutationObserver((cambios) => {
      for (const c of cambios) {
        for (const n of c.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          const alerta = n.matches('[role="alert"]') ? n : n.querySelector<HTMLElement>('[role="alert"]');
          if (alerta) {
            alerta.tabIndex = -1;
            alerta.focus();
            return;
          }
        }
      }
    });
    obs.observe(d, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [abierto]);

  return (
    <dialog
      ref={ref}
      className="comercial-panel"
      data-ancho={ancho}
      aria-label={titulo}
      onCancel={(ev) => {
        ev.preventDefault();
        intentarCerrar();
      }}
      onInput={() => {
        sucio.current = true;
      }}
      onChange={() => {
        sucio.current = true;
      }}
      onClick={(ev) => {
        // Clic en el fondo (fuera del contenido) = intentar cerrar.
        if (ev.target === ref.current) intentarCerrar();
      }}
    >
      {abierto && (
        <div className="flex h-full flex-col" data-panel={titulo}>
          <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">{titulo}</h2>
              {contexto && <div className="mt-0.5 text-sm text-[var(--muted)]">{contexto}</div>}
            </div>
            <button
              type="button"
              onClick={intentarCerrar}
              className="-mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] hover:bg-black/[0.05] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              aria-label="Cerrar panel"
            >
              <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

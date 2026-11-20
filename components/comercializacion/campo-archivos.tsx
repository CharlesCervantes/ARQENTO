"use client";

import { useState, type ChangeEvent } from "react";
import { MB_POR_CARGA, revisarCarga } from "@/lib/comercializacion/cargas";

// Selección de archivos de una carga de Comercialización (un formulario = una
// solicitud). Revisa en el navegador el mismo límite que aplica el servidor
// (lib/comercializacion/cargas.ts) ANTES de enviar: así una carga excesiva no
// llega a fallar en el camino (proxy o plataforma) y el formulario conserva lo
// capturado. Tras una respuesta del servidor, React restablece el formulario y
// el campo de archivos queda vacío: `debeReseleccionar` avisa que hay que
// volver a elegirlos (los demás campos se mantienen porque son controlados).

export function useArchivosDeCarga<S>(respuesta: S, opciones: { maxArchivos?: number } = {}) {
  const [sel, setSel] = useState<{ tamanos: number[]; respuesta: S }>({ tamanos: [], respuesta });
  const vigentes = sel.respuesta === respuesta ? sel.tamanos : [];
  return {
    n: vigentes.length,
    exceso: revisarCarga(vigentes, opciones),
    debeReseleccionar: sel.respuesta !== respuesta && sel.tamanos.length > 0,
    onChange: (ev: ChangeEvent<HTMLInputElement>) => setSel({ tamanos: Array.from(ev.target.files ?? []).map((f) => f.size), respuesta }),
  };
}

export function AvisosArchivos({ exceso, reseleccionar, ayuda }: { exceso: string | null; reseleccionar: string | null; ayuda?: string }) {
  return (
    <>
      <span className="mt-0.5 block text-xs text-[var(--muted)]">{ayuda ?? `Máximo ${MB_POR_CARGA} MB por carga.`}</span>
      {exceso && (
        <span role="alert" className="mt-0.5 block text-xs text-red-700">
          {exceso} No se envió nada; lo demás que capturaste se conserva.
        </span>
      )}
      {reseleccionar && <span className="mt-0.5 block text-xs text-amber-800">{reseleccionar}</span>}
    </>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { hoyEnZona } from "@/lib/comercializacion/cuentas";

// Mantiene vigente una consulta calculada en el servidor (B6B, «Por
// atender»): vuelve a pedirla al servidor —que sigue siendo la autoridad
// para clasificar vencimientos— cuando:
// - se regresa a la página y se muestra una versión ya vista (historial del
//   navegador o caché del enrutador),
// - la pestaña vuelve a estar visible,
// - cambia el día en la zona de la Empresa con la página abierta.
// No clasifica nada en el navegador.

const MIN_ENTRE_ACTUALIZACIONES_MS = 15_000;
const VISTA_REUTILIZADA_MS = 3_000;

// Cuándo vio este navegador por primera vez cada respuesta del servidor
// (identificada por su marca `generadoEn`). Se compara con el reloj del
// navegador, así que no depende de que coincida con el del servidor.
const vistas = new Map<string, number>();

export function ActualizarConsulta({ hoy, zona, generadoEn }: { hoy: string; zona: string | null; generadoEn: string }) {
  const router = useRouter();
  const ultima = useRef(0);

  useEffect(() => {
    const vistaEn = vistas.get(generadoEn);
    if (vistaEn === undefined) {
      if (vistas.size > 50) vistas.clear();
      vistas.set(generadoEn, Date.now());
    } else if (Date.now() - vistaEn > VISTA_REUTILIZADA_MS) {
      // Se volvió a mostrar una respuesta antigua (regreso a la página).
      ultima.current = Date.now();
      router.refresh();
    }

    const refrescar = (forzar = false) => {
      if (!forzar && Date.now() - ultima.current < MIN_ENTRE_ACTUALIZACIONES_MS) return;
      ultima.current = Date.now();
      router.refresh();
    };
    const alVolver = () => {
      if (document.visibilityState === "visible") refrescar();
    };
    const alMostrar = (e: PageTransitionEvent) => {
      if (e.persisted) refrescar(true);
    };
    const reloj = window.setInterval(() => {
      if (hoyEnZona(zona) !== hoy) refrescar(true);
    }, 60_000);
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("pageshow", alMostrar);
    return () => {
      window.clearInterval(reloj);
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("pageshow", alMostrar);
    };
  }, [hoy, zona, generadoEn, router]);

  return null;
}

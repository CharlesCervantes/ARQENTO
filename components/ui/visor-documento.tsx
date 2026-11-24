"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  NIVELES_ZOOM,
  ajustarAlContenedor,
  desplazamientoAnclado,
  vistaDeDocumento,
  zoomAnterior,
  zoomSiguiente,
  type Medidas,
} from "@/lib/documentos/visor";

// Visor de documentos dentro de ARQENTO (fotografía o PDF de un comprobante),
// sin salir de la pantalla. Reutilizable: bandeja «Recibidos por WhatsApp» y,
// más adelante, la revisión de propuestas de ARQENTO IA.
//
// Seguridad: `url` SIEMPRE es un endpoint propio y autenticado
// (p. ej. /api/contabilidad/documentos-recibidos/[id]/archivo), que en cada
// carga revalida sesión, Empresa y permiso y solo entonces redirige a una URL
// temporal del almacenamiento privado. Nunca se le pasa una URL firmada ni
// pública: así el visor no amplía quién puede ver un archivo ni por cuánto
// tiempo, y «Abrir en otra pestaña» pasa por la misma verificación.

export type DocumentoParaVisor = { url: string; tipoMime: string; nombre: string };

type Estado = { tipo: "VERIFICANDO" } | { tipo: "LISTO" } | { tipo: "ERROR"; mensaje: string };

const MENSAJE_ERROR = "No fue posible abrir el archivo. Vuelve a intentarlo en unos momentos.";
const RELLENO = 16; // p-4 del área de la imagen

export function VisorDocumento({ documento, onClose }: { documento: DocumentoParaVisor; onClose: () => void }) {
  const vista = vistaDeDocumento(documento.tipoMime);
  const dialogo = useRef<HTMLDivElement>(null);
  const botonCerrar = useRef<HTMLButtonElement>(null);
  const [estado, setEstado] = useState<Estado>({ tipo: "VERIFICANDO" });
  const [cargado, setCargado] = useState(false);
  const [zoom, setZoom] = useState(1);

  // Comprobación previa SIN descargar el archivo: el endpoint responde con una
  // redirección si el usuario puede verlo, o con un error legible si no (el
  // archivo ya no existe, se descartó, cambió el permiso…). Así el visor nunca
  // muestra un JSON de error dentro del marco del PDF.
  useEffect(() => {
    const control = new AbortController();
    fetch(documento.url, { redirect: "manual", cache: "no-store", signal: control.signal })
      .then(async (r) => {
        if (r.type === "opaqueredirect" || r.ok) return setEstado({ tipo: "LISTO" });
        const cuerpo = (await r.json().catch(() => null)) as { error?: unknown } | null;
        setEstado({ tipo: "ERROR", mensaje: typeof cuerpo?.error === "string" ? cuerpo.error : MENSAJE_ERROR });
      })
      .catch(() => {
        if (!control.signal.aborted) setEstado({ tipo: "ERROR", mensaje: MENSAJE_ERROR });
      });
    return () => control.abort();
  }, [documento.url]);

  // Bloquea el desplazamiento de la página y devuelve el foco al cerrar.
  useEffect(() => {
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    botonCerrar.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previo?.focus();
    };
  }, []);

  // ---- Imagen: ajuste a la pantalla y ampliación anclada a un punto ----
  const marco = useRef<HTMLDivElement>(null);
  const imagen = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<Medidas | null>(null);
  const [espacio, setEspacio] = useState<Medidas>({ ancho: 0, alto: 0 });
  const ancla = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const arrastre = useRef<{ x: number; y: number; izquierda: number; arriba: number; movido: boolean } | null>(null);
  const huboArrastre = useRef(false);
  const ruedaAcumulada = useRef(0);
  const zoomActual = useRef(1);
  useEffect(() => {
    zoomActual.current = zoom;
  }, [zoom]);

  const mostrarImagen = vista === "IMAGEN" && estado.tipo === "LISTO";

  useLayoutEffect(() => {
    const el = marco.current;
    if (!mostrarImagen || !el) return;
    // Medidas del borde exterior: no cambian cuando aparecen las barras de
    // desplazamiento al ampliar (evita que el ajuste "rebote").
    const medir = () => {
      const r = el.getBoundingClientRect();
      const nuevo = { ancho: Math.floor(r.width) - RELLENO * 2, alto: Math.floor(r.height) - RELLENO * 2 };
      setEspacio((p) => (p.ancho === nuevo.ancho && p.alto === nuevo.alto ? p : nuevo));
    };
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, [mostrarImagen]);

  const base = natural ? ajustarAlContenedor(natural, espacio) : null;

  const aplicarZoom = useCallback((nuevo: number, punto?: { x: number; y: number }) => {
    const m = marco.current;
    const i = imagen.current;
    if (m && i && i.offsetWidth > 0 && i.offsetHeight > 0) {
      const r = m.getBoundingClientRect();
      const px = punto ? punto.x - r.left : m.clientWidth / 2;
      const py = punto ? punto.y - r.top : m.clientHeight / 2;
      const acotar = (v: number) => Math.min(1, Math.max(0, v));
      ancla.current = {
        fx: acotar((m.scrollLeft + px - i.offsetLeft) / i.offsetWidth),
        fy: acotar((m.scrollTop + py - i.offsetTop) / i.offsetHeight),
        px,
        py,
      };
    }
    zoomActual.current = nuevo;
    setZoom(nuevo);
  }, []);

  useLayoutEffect(() => {
    const a = ancla.current;
    const m = marco.current;
    const i = imagen.current;
    if (!a || !m || !i) return;
    ancla.current = null;
    m.scrollLeft = desplazamientoAnclado({ fraccion: a.fx, tamanoNuevo: i.offsetWidth, desfaseNuevo: i.offsetLeft, puntoEnPantalla: a.px });
    m.scrollTop = desplazamientoAnclado({ fraccion: a.fy, tamanoNuevo: i.offsetHeight, desfaseNuevo: i.offsetTop, puntoEnPantalla: a.py });
  }, [zoom]);

  // Pellizco en panel táctil / Ctrl + rueda: amplía alrededor del cursor.
  useEffect(() => {
    const m = marco.current;
    if (!mostrarImagen || !m) return;
    const alGirar = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      ruedaAcumulada.current += e.deltaY;
      if (Math.abs(ruedaAcumulada.current) < 40) return;
      const acercar = ruedaAcumulada.current < 0;
      ruedaAcumulada.current = 0;
      const actual = zoomActual.current;
      const nuevo = acercar ? zoomSiguiente(actual) : zoomAnterior(actual);
      if (nuevo !== actual) aplicarZoom(nuevo, { x: e.clientX, y: e.clientY });
    };
    m.addEventListener("wheel", alGirar, { passive: false });
    return () => m.removeEventListener("wheel", alGirar);
  }, [mostrarImagen, aplicarZoom]);

  // Teclado: Escape cierra (antes que cualquier modal de abajo), Tab no sale
  // del visor, y + / − / 0 controlan la ampliación de una imagen.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogo.current) {
        const enfocables = [...dialogo.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), iframe, [tabindex='0']")];
        if (enfocables.length === 0) return;
        const primero = enfocables[0];
        const ultimo = enfocables[enfocables.length - 1];
        if (e.shiftKey && document.activeElement === primero) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
          e.preventDefault();
          primero.focus();
        } else if (!dialogo.current.contains(document.activeElement)) {
          e.preventDefault();
          primero.focus();
        }
        return;
      }
      if (!mostrarImagen || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") aplicarZoom(zoomSiguiente(zoom));
      else if (e.key === "-") aplicarZoom(zoomAnterior(zoom));
      else if (e.key === "0") aplicarZoom(1);
    };
    document.addEventListener("keydown", alTeclear, true);
    return () => document.removeEventListener("keydown", alTeclear, true);
  }, [onClose, mostrarImagen, zoom, aplicarZoom]);

  const ampliado = zoom > 1;
  const maximo = NIVELES_ZOOM[NIVELES_ZOOM.length - 1];
  const puedeIncrustarPdf = typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;

  const abrirEnPestana = (
    <a
      href={documento.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Abrir en otra pestaña"
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    >
      <ExternalLink className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">Abrir en otra pestaña</span>
      <span className="sr-only sm:hidden">Abrir en otra pestaña</span>
    </a>
  );

  let contenido: ReactNode;
  if (estado.tipo === "VERIFICANDO") {
    contenido = <p className="m-auto text-sm text-[var(--muted)]">Cargando el archivo…</p>;
  } else if (estado.tipo === "ERROR") {
    contenido = <p className="m-auto max-w-sm px-4 text-center text-sm text-red-700">{estado.mensaje}</p>;
  } else if (vista === "IMAGEN") {
    contenido = (
      <div
        ref={marco}
        tabIndex={0}
        aria-label="Imagen del documento. Usa las flechas para desplazarte cuando esté ampliada."
        className={`relative flex h-full w-full overflow-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] ${ampliado ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={(e) => {
          huboArrastre.current = false;
          if (!ampliado || e.pointerType !== "mouse" || e.button !== 0 || !marco.current) return;
          arrastre.current = { x: e.clientX, y: e.clientY, izquierda: marco.current.scrollLeft, arriba: marco.current.scrollTop, movido: false };
          marco.current.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const a = arrastre.current;
          const m = marco.current;
          if (!a || !m) return;
          const dx = e.clientX - a.x;
          const dy = e.clientY - a.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) a.movido = true;
          m.scrollLeft = a.izquierda - dx;
          m.scrollTop = a.arriba - dy;
        }}
        onPointerUp={(e) => {
          huboArrastre.current = arrastre.current?.movido ?? false;
          arrastre.current = null;
          if (marco.current?.hasPointerCapture(e.pointerId)) marco.current.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          arrastre.current = null;
        }}
      >
        {!cargado && <p className="absolute inset-0 m-auto h-fit text-center text-sm text-[var(--muted)]">Cargando el archivo…</p>}
        {/* eslint-disable-next-line @next/next/no-img-element -- archivo privado detrás de un endpoint autenticado; no pasa por el optimizador de imágenes */}
        <img
          ref={imagen}
          src={documento.url}
          alt={documento.nombre}
          draggable={false}
          onLoad={(e) => {
            setNatural({ ancho: e.currentTarget.naturalWidth, alto: e.currentTarget.naturalHeight });
            setCargado(true);
          }}
          onError={() => setEstado({ tipo: "ERROR", mensaje: MENSAJE_ERROR })}
          onClick={(e: MouseEvent<HTMLImageElement>) => {
            if (huboArrastre.current) return;
            aplicarZoom(ampliado ? 1 : 2, ampliado ? undefined : { x: e.clientX, y: e.clientY });
          }}
          title={ampliado ? undefined : "Haz clic para ampliar"}
          className={`m-auto block max-w-none shrink-0 select-none bg-white shadow-sm ${ampliado ? "" : "cursor-zoom-in"} ${cargado ? "" : "invisible"}`}
          style={base ? { width: base.ancho * zoom, height: base.alto * zoom } : { maxWidth: "100%", maxHeight: "100%" }}
        />
      </div>
    );
  } else if (vista === "PDF" && puedeIncrustarPdf) {
    contenido = (
      <div className="relative h-full w-full">
        {!cargado && <p className="absolute inset-0 m-auto h-fit text-center text-sm text-[var(--muted)]">Cargando el archivo…</p>}
        <iframe
          src={documento.url}
          title={documento.nombre}
          onLoad={() => setCargado(true)}
          className="relative h-full w-full border-0 bg-white"
        />
      </div>
    );
  } else {
    contenido = (
      <div className="m-auto max-w-sm space-y-3 px-4 text-center">
        <p className="text-sm text-[var(--muted)]">
          {vista === "PDF"
            ? "Este navegador no puede mostrar el PDF dentro de ARQENTO."
            : "Este tipo de archivo no se puede mostrar dentro de ARQENTO."}
        </p>
        <a
          href={documento.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--foreground)] underline underline-offset-2"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          Abrir en otra pestaña
        </a>
      </div>
    );
  }

  const botonIcono =
    "inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--foreground)] hover:bg-black/[0.04] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogo}
        role="dialog"
        aria-modal="true"
        aria-labelledby="visor-documento-titulo"
        className="enter flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--surface)] shadow-xl sm:h-[90vh] sm:max-w-5xl sm:rounded-xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 sm:px-4">
          <div className="min-w-0 flex-1">
            <h2 id="visor-documento-titulo" className="truncate text-sm font-semibold text-[var(--foreground)]">
              {documento.nombre}
            </h2>
            {mostrarImagen && (
              <p className="hidden text-xs text-[var(--muted)] sm:block">
                {ampliado ? "Arrastra para moverte. Haz clic para volver a ver la imagen completa." : "Haz clic en la imagen para ampliarla."}
              </p>
            )}
          </div>
          {mostrarImagen && (
            <div className="flex items-center" role="group" aria-label="Ampliación">
              <button type="button" className={botonIcono} onClick={() => aplicarZoom(zoomAnterior(zoom))} disabled={zoom <= 1} aria-label="Reducir">
                <ZoomOut className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => aplicarZoom(1)}
                disabled={!ampliado}
                className="min-w-16 rounded-lg px-1 py-1.5 text-center text-xs tabular-nums text-[var(--muted)] hover:bg-black/[0.04] disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                aria-label={ampliado ? `Ampliado ${Math.round(zoom * 100)}%. Ver imagen completa` : "Imagen completa"}
              >
                {ampliado ? `${Math.round(zoom * 100)}%` : "Completa"}
              </button>
              <button type="button" className={botonIcono} onClick={() => aplicarZoom(zoomSiguiente(zoom))} disabled={zoom >= maximo} aria-label="Ampliar">
                <ZoomIn className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}
          {abrirEnPestana}
          <button ref={botonCerrar} type="button" className={botonIcono} onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 bg-[var(--background)]">{contenido}</div>
      </div>
    </div>,
    document.body
  );
}

// Enlace «Ver archivo» que abre el visor. Sigue siendo un enlace real: con
// Ctrl/⌘/Mayús o clic central se abre en otra pestaña como antes.
export function EnlaceVerDocumento({
  documento,
  children = "Ver archivo",
  className,
}: {
  documento: DocumentoParaVisor;
  children?: ReactNode;
  className?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <a
        href={documento.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={(e) => {
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setAbierto(true);
        }}
      >
        {children}
      </a>
      {abierto && <VisorDocumento documento={documento} onClose={() => setAbierto(false)} />}
    </>
  );
}

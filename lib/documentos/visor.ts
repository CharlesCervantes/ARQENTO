// Lógica pura del visor de documentos (components/ui/visor-documento.tsx):
// qué tipo de vista usar y cómo ajustar/ampliar una imagen. Sin React ni DOM,
// para poder probarla aparte.

export type Medidas = { ancho: number; alto: number };

export type VistaDocumento = "IMAGEN" | "PDF" | "OTRO";

const IMAGENES = new Set(["image/jpeg", "image/jpg", "image/png"]);

export function vistaDeDocumento(tipoMime: string): VistaDocumento {
  const tipo = tipoMime.trim().toLowerCase();
  if (IMAGENES.has(tipo)) return "IMAGEN";
  if (tipo === "application/pdf") return "PDF";
  return "OTRO";
}

// Niveles relativos al tamaño "ajustado a la pantalla" (1 = imagen completa).
export const NIVELES_ZOOM = [1, 1.5, 2, 3, 4] as const;

export function zoomSiguiente(actual: number): number {
  return NIVELES_ZOOM.find((n) => n > actual + 1e-6) ?? NIVELES_ZOOM[NIVELES_ZOOM.length - 1];
}

export function zoomAnterior(actual: number): number {
  return [...NIVELES_ZOOM].reverse().find((n) => n < actual - 1e-6) ?? NIVELES_ZOOM[0];
}

// Tamaño en el que la imagen cabe COMPLETA en el contenedor conservando su
// proporción. Nunca la agranda por encima de su tamaño real (una foto pequeña
// no se pixela al abrirla); ampliar es siempre una acción explícita.
export function ajustarAlContenedor(natural: Medidas, contenedor: Medidas): Medidas {
  if (natural.ancho <= 0 || natural.alto <= 0 || contenedor.ancho <= 0 || contenedor.alto <= 0) {
    return { ancho: 0, alto: 0 };
  }
  const escala = Math.min(1, contenedor.ancho / natural.ancho, contenedor.alto / natural.alto);
  return { ancho: Math.max(1, Math.round(natural.ancho * escala)), alto: Math.max(1, Math.round(natural.alto * escala)) };
}

// Posición de desplazamiento que mantiene bajo el mismo punto de la pantalla
// la parte de la imagen que estaba ahí antes de cambiar el zoom.
// `fraccion` es la posición relativa (0..1) del punto dentro de la imagen.
export function desplazamientoAnclado(args: {
  fraccion: number;
  tamanoNuevo: number;
  desfaseNuevo: number;
  puntoEnPantalla: number;
}): number {
  return Math.max(0, args.fraccion * args.tamanoNuevo + args.desfaseNuevo - args.puntoEnPantalla);
}

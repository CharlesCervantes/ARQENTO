// Límites de carga de archivos de Comercialización — un solo lugar, usado por
// el navegador (aviso antes de enviar) y por el servidor (rechazo).
// docs/negocio/comercializacion.md §20 «Cargas de archivos».
//
// Recorrido actual: navegador → Server Action (multipart, una solicitud con
// todos los campos y archivos) → servidor de la app → almacenamiento (R2).
// Límites del recorrido:
// - Vercel Functions: 4.5 MB por cuerpo de solicitud; si se excede responde
//   413 FUNCTION_PAYLOAD_TOO_LARGE antes de ejecutar la app
//   (https://vercel.com/docs/functions/limitations, «Request body size»).
// - proxy.ts de Next (experimental.proxyClientMaxBodySize, 10 MB por
//   omisión): por encima trunca el cuerpo y la acción falla (500 en local).
// - serverActions.bodySizeLimit (55 MB en next.config.ts) no es el límite
//   efectivo: los dos anteriores son menores.
// Por eso cada carga (UNA solicitud) se limita a 4 MB de archivos en total,
// dejando margen para los demás campos y la envoltura multipart.

export const MAX_BYTES_POR_CARGA = 4 * 1024 * 1024; // 4 MB por solicitud (suma de archivos)
export const MB_POR_CARGA = MAX_BYTES_POR_CARGA / (1024 * 1024);

/** Formato corto y legible: "3.2 MB", "850 KB". */
export function formatearTamano(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Revisa los tamaños de una carga (archivos de UNA solicitud). Devuelve el
 * mensaje para la persona o null si cabe. `maxArchivos` limita la cantidad.
 */
export function revisarCarga(tamanos: number[], opciones: { maxArchivos?: number; maxBytes?: number } = {}): string | null {
  const max = opciones.maxBytes ?? MAX_BYTES_POR_CARGA;
  const mb = max / (1024 * 1024);
  if (opciones.maxArchivos !== undefined && tamanos.length > opciones.maxArchivos) {
    return `Selecciona máximo ${opciones.maxArchivos} archivos por carga (elegiste ${tamanos.length}).`;
  }
  const mayor = Math.max(0, ...tamanos);
  if (mayor > max) {
    return `Un archivo pesa ${formatearTamano(mayor)}; el máximo por carga es ${mb} MB. Reduce su tamaño (por ejemplo, una foto en menor resolución o un PDF comprimido).`;
  }
  const total = tamanos.reduce((s, t) => s + t, 0);
  if (total > max) {
    return `Los archivos suman ${formatearTamano(total)}; el máximo por carga es ${mb} MB. Quita archivos o reduce su tamaño.`;
  }
  return null;
}

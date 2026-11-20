import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { UsuarioSesion } from "@/lib/server/session";
import { obtenerArchivo } from "@/lib/server/archivos";
import { obtenerDocumentoParaPdf } from "@/lib/server/comercializacion/emision";
import { CotizacionVentaDocumento } from "@/lib/pdf/cotizacion-venta";

// PDF de una cotización de venta (B3). El alcance (Empresa + vendedor) lo
// aplica obtenerDocumentoParaPdf: fuera de alcance = "no existe", también
// por URL directa. Emitida/aceptada → copia histórica; borrador → vista
// previa marcada BORRADOR.
export async function generarPdfCotizacion(
  usuario: UsuarioSesion,
  cotizacionId: string
): Promise<{ buffer: Buffer; nombreArchivo: string; borrador: boolean }> {
  const { documento, borrador } = await obtenerDocumentoParaPdf(usuario, cotizacionId);
  // Logo de la copia (la referencia queda congelada al emitir; reemplazar el
  // logo de la Empresa no borra el archivo anterior). Si no se puede leer, el
  // PDF usa el nombre de la Empresa de la copia.
  const logoBuffer = documento.empresa.logoRef ? await obtenerArchivo(documento.empresa.logoRef).catch(() => null) : null;
  const buffer = await renderToBuffer(CotizacionVentaDocumento({ documento, borrador, logoBuffer }));
  return { buffer, nombreArchivo: `${documento.folio}${borrador ? "-BORRADOR" : ""}.pdf`, borrador };
}

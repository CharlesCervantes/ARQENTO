// Renderiza el PDF REAL de una cotización (lib/pdf/cotizacion-venta.tsx) en un
// proceso aparte. Motivo: las pruebas corren con la condición "react-server"
// (necesaria para importar módulos `server-only`), y con ella React expone su
// build de servidor, incompatible con el reconciliador de @react-pdf/renderer.
// En la aplicación el PDF se genera en un route handler, como los demás PDFs
// del sistema. Entrada: JSON { documento, borrador } por stdin. Salida: el PDF
// en base64 por stdout. Solo datos ficticios de prueba.
import { renderToBuffer } from "@react-pdf/renderer";
import { CotizacionVentaDocumento } from "@/lib/pdf/cotizacion-venta";

let entrada = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (entrada += c));
process.stdin.on("end", async () => {
  const { documento, borrador } = JSON.parse(entrada);
  const buffer = await renderToBuffer(CotizacionVentaDocumento({ documento, borrador, logoBuffer: null }));
  process.stdout.write(Buffer.from(buffer).toString("base64"));
});

// Archivos COMPLETAMENTE FICTICIOS para pruebas (Fase 2A WhatsApp): un PDF
// mínimo válido generado en memoria e "imágenes" que solo llevan la firma
// real del formato seguida de texto de relleno. Nunca contienen datos reales.

const FIRMA_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const jpgFicticio = (semilla: string) => Buffer.concat([FIRMA_JPG, Buffer.from(`fotografia-ficticia-${semilla}`)]);
export const pngFicticio = (semilla: string) => Buffer.concat([FIRMA_PNG, Buffer.from(`imagen-ficticia-${semilla}`)]);

// PDF válido de `paginas` páginas con un texto corto en cada una (solo ASCII).
export function pdfFicticio(texto = "Comprobante ficticio", paginas = 1): Buffer {
  const objetos: string[] = [];
  objetos[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objetos[2] = `<< /Type /Pages /Kids [${Array.from({ length: paginas }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${paginas} >>`;
  objetos[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < paginas; i++) {
    const contenido = `BT /F1 12 Tf 72 720 Td (${texto} pagina ${i + 1}) Tj ET`;
    objetos[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objetos[5 + i * 2] = `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`;
  }
  let pdf = "%PDF-1.4\n";
  const posiciones: number[] = [];
  for (let n = 1; n < objetos.length; n++) {
    posiciones[n] = pdf.length;
    pdf += `${n} 0 obj\n${objetos[n]}\nendobj\n`;
  }
  const inicioXref = pdf.length;
  pdf += `xref\n0 ${objetos.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objetos.length; n++) pdf += `${String(posiciones[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// Meta SIMULADO: sustituye `fetch` para la consulta y la descarga de archivos
// y para el envío de respuestas. Nada sale a la red.
export type ArchivoEnMeta = { bytes: Buffer; tipo: string; tamanoDeclarado?: number; url?: string };

export function simularMeta() {
  const original = globalThis.fetch;
  const estado = {
    archivos: new Map<string, ArchivoEnMeta>(),
    consultas: 0,
    descargas: 0,
    enviados: [] as { to: string; texto: string; tipo: string }[],
    autorizaciones: [] as (string | null)[],
    urls: [] as string[],
    // Respuestas forzadas (para simular fallas): status HTTP o una excepción.
    fallaConsulta: null as number | Error | null,
    fallaDescarga: null as number | Error | null,
    fallaEnvio: null as number | null,
    // Redirecciones pendientes de la descarga: cada petición de descarga
    // consume una y responde 302 hacia ese destino.
    redirecciones: [] as string[],
  };
  const forzada = (falla: number | Error | null): Response | null => {
    if (falla === null) return null;
    if (falla instanceof Error) throw falla;
    return new Response(JSON.stringify({ error: { code: falla === 401 ? 190 : 1 } }), { status: falla });
  };
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    const url = new URL(String(entrada));
    estado.urls.push(url.toString());
    estado.autorizaciones.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? null);
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/messages")) {
      if (estado.fallaEnvio !== null) return new Response(JSON.stringify({ error: { code: 131030 } }), { status: estado.fallaEnvio });
      const cuerpo = JSON.parse(String(init?.body));
      estado.enviados.push({ to: cuerpo.to, tipo: cuerpo.type, texto: cuerpo.type === "text" ? cuerpo.text.body : cuerpo.interactive.body.text });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.salida" }] }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com") {
      estado.consultas++;
      const falla = forzada(estado.fallaConsulta);
      if (falla) return falla;
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const archivo = estado.archivos.get(id);
      if (!archivo) return new Response(JSON.stringify({ error: { code: 100 } }), { status: 404 });
      return new Response(
        JSON.stringify({
          url: archivo.url ?? `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${encodeURIComponent(id)}`,
          mime_type: archivo.tipo,
          file_size: archivo.tamanoDeclarado ?? archivo.bytes.length,
          id,
        }),
        { status: 200 }
      );
    }
    estado.descargas++;
    const falla = forzada(estado.fallaDescarga);
    if (falla) return falla;
    const destino = estado.redirecciones.shift();
    if (destino !== undefined) return new Response(null, { status: 302, headers: { location: destino } });
    const archivo = estado.archivos.get(url.searchParams.get("mid") ?? "");
    if (!archivo) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(archivo.bytes), { status: 200 });
  }) as typeof fetch;
  return Object.assign(estado, { restaurar: () => void (globalThis.fetch = original) });
}

import { verifySession } from "@/lib/server/auth/dal";
import { generarPdfCotizacion } from "@/lib/server/comercializacion/pdf";
import { manejarErrorApi } from "@/app/api/control-de-obra/_lib/manejar-error";

// PDF de una cotización de venta — sesión, Empresa y alcance del vendedor se
// validan en el servicio (fuera de alcance responde 404, igual que inexistente).
export async function GET(_request: Request, ctx: RouteContext<"/api/comercializacion/cotizaciones/[id]/pdf">) {
  const usuario = await verifySession();
  if (!usuario) return Response.json({ error: "No autenticado." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { buffer, nombreArchivo } = await generarPdfCotizacion(usuario, id);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${nombreArchivo}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

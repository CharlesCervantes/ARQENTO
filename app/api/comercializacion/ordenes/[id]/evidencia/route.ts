import { verifySession } from "@/lib/server/auth/dal";
import { obtenerEvidenciaOrdenVenta } from "@/lib/server/comercializacion/ordenes";
import { manejarErrorApi } from "@/app/api/control-de-obra/_lib/manejar-error";

// Evidencia de aceptación de una orden de venta. Se sirve a través de la
// app (nunca una URL directa del almacenamiento) para aplicar siempre
// Empresa + alcance del vendedor, también por URL directa.
export async function GET(_request: Request, ctx: RouteContext<"/api/comercializacion/ordenes/[id]/evidencia">) {
  const usuario = await verifySession();
  if (!usuario) return Response.json({ error: "No autenticado." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { bytes, tipo, nombre } = await obtenerEvidenciaOrdenVenta(usuario, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": tipo,
        "Content-Disposition": `inline; filename="${nombre}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

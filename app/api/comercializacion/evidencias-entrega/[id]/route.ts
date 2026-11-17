import { verifySession } from "@/lib/server/auth/dal";
import { obtenerEvidenciaEntrega } from "@/lib/server/comercializacion/entregas";
import { manejarErrorApi } from "@/app/api/control-de-obra/_lib/manejar-error";

// Evidencia de una entrega al cliente (B6A): administración de la Empresa y
// el vendedor asignado a la OV (el servicio aplica el alcance; fuera de él,
// 404 también por URL directa). Ruta propia, separada de los documentos de
// compra y de los comprobantes de cobro/pago.
export async function GET(_request: Request, ctx: RouteContext<"/api/comercializacion/evidencias-entrega/[id]">) {
  const usuario = await verifySession();
  if (!usuario) return Response.json({ error: "No autenticado." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { bytes, tipo, nombre } = await obtenerEvidenciaEntrega(usuario, id);
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

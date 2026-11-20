import { verifySession } from "@/lib/server/auth/dal";
import { obtenerComprobanteGasto } from "@/lib/server/comercializacion/gastos";
import { manejarErrorApi } from "@/app/api/control-de-obra/_lib/manejar-error";

// Comprobante de un gasto adicional (B7) — SOLO administración de la
// Empresa (el servicio lo exige); un vendedor recibe 403 también por URL directa.
export async function GET(_request: Request, ctx: RouteContext<"/api/comercializacion/gastos/[id]/comprobante">) {
  const usuario = await verifySession();
  if (!usuario) return Response.json({ error: "No autenticado." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { bytes, tipo, nombre } = await obtenerComprobanteGasto(usuario, id);
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

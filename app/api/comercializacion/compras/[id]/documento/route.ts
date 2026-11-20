import { verifySession } from "@/lib/server/auth/dal";
import { obtenerDocumentoCompra } from "@/lib/server/comercializacion/compras";
import { manejarErrorApi } from "@/app/api/control-de-obra/_lib/manejar-error";

// Documento del proveedor de una compra comercial — SOLO administración de la
// Empresa (el servicio lo exige); un vendedor recibe 403 también por URL directa.
export async function GET(_request: Request, ctx: RouteContext<"/api/comercializacion/compras/[id]/documento">) {
  const usuario = await verifySession();
  if (!usuario) return Response.json({ error: "No autenticado." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { bytes, tipo, nombre } = await obtenerDocumentoCompra(usuario, id);
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

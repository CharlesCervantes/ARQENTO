import { NextResponse } from "next/server";
import { verifySession } from "@/lib/server/auth/dal";
import { obtenerRefDocumentoRecibido } from "@/lib/server/contabilidad/documentos/recibidos-whatsapp";
import { obtenerUrlTemporal } from "@/lib/server/archivos";
import { manejarErrorApi } from "../../../../control-de-obra/_lib/manejar-error";

// Archivo de un comprobante recibido por WhatsApp (bandeja de Contabilidad →
// Egresos, Fase 2A). El bucket es privado: tras verificar sesión, Empresa,
// permiso de Contabilidad y WhatsApp habilitado (obtenerRefDocumentoRecibido),
// se redirige a una URL temporal de corta duración.
export async function GET(_request: Request, ctx: RouteContext<"/api/contabilidad/documentos-recibidos/[id]/archivo">) {
  const usuario = await verifySession();
  if (!usuario) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ref = await obtenerRefDocumentoRecibido(usuario, id);
    return NextResponse.redirect(await obtenerUrlTemporal(ref));
  } catch (error) {
    return manejarErrorApi(error);
  }
}

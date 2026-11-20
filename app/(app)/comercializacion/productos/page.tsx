import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarProductosAdministracion, listarProductosParaVenta } from "@/lib/server/comercializacion/productos";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { ProductosAdministracionView } from "@/components/comercializacion/productos-administracion-view";
import { ProductosVentaView } from "@/components/comercializacion/productos-venta-view";

// Panel de Productos (§5.1, acceso secundario dentro del módulo). Dos vistas
// alimentadas por DOS consultas distintas: el vendedor recibe solo productos
// activos y campos de venta desde el servidor — el costo de referencia nunca
// viaja a su navegador, ni siquiera oculto.
export default async function ProductosComercialesPage() {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  if (esAdministradorComercial(usuario)) {
    const productos = await listarProductosAdministracion(usuario);
    return <ProductosAdministracionView productos={productos} />;
  }

  const productos = await listarProductosParaVenta(usuario);
  return <ProductosVentaView productos={productos} />;
}

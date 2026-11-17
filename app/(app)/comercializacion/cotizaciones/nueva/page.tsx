import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarClientesYObras } from "@/lib/server/comercializacion/clientes";
import { listarProductosParaVenta } from "@/lib/server/comercializacion/productos";
import { listarVendedoresElegibles } from "@/lib/server/comercializacion/cotizaciones";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { FormularioCotizacion } from "@/components/comercializacion/formulario-cotizacion";

export default async function NuevaCotizacionPage() {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  // Productos: solo activos y solo campos de venta (sin costos), para
  // administración y vendedor por igual.
  const [{ clientes, obras }, productos, vendedores] = await Promise.all([
    listarClientesYObras(usuario),
    listarProductosParaVenta(usuario),
    listarVendedoresElegibles(usuario),
  ]);

  return (
    <FormularioCotizacion
      esAdmin={esAdministradorComercial(usuario)}
      usuarioActual={{ id: usuario.id, nombre: usuario.nombre }}
      clientesIniciales={clientes}
      obrasIniciales={obras}
      vendedores={vendedores}
      productos={productos}
      hoy={hoyNegocio()}
    />
  );
}

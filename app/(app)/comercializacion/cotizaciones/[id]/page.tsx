import { notFound } from "next/navigation";
import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarClientesYObras } from "@/lib/server/comercializacion/clientes";
import { listarProductosParaVenta } from "@/lib/server/comercializacion/productos";
import { listarVendedoresElegibles, obtenerCotizacionVenta } from "@/lib/server/comercializacion/cotizaciones";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { hoyNegocio } from "@/lib/comercializacion/fechas";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { FormularioCotizacion } from "@/components/comercializacion/formulario-cotizacion";

// Detalle del borrador: se consulta y se sigue editando en la misma vista.
// Una cotización fuera del alcance del usuario (otra Empresa u otro
// vendedor) responde 404, igual que una inexistente.
export default async function CotizacionPage(props: PageProps<"/comercializacion/cotizaciones/[id]">) {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  const { id } = await props.params;
  let cotizacion;
  try {
    cotizacion = await obtenerCotizacionVenta(usuario, id);
  } catch (error) {
    if (error instanceof RegistroNoEncontradoError) notFound();
    throw error;
  }

  const [{ clientes, obras }, productos, vendedores] = await Promise.all([
    listarClientesYObras(usuario),
    listarProductosParaVenta(usuario),
    listarVendedoresElegibles(usuario),
  ]);
  // El vendedor guardado puede ya no ser elegible (p. ej. perdió la función):
  // se conserva como opción para no reasignarlo en silencio.
  const opcionesVendedor = vendedores.some((v) => v.id === cotizacion.vendedor.id) ? vendedores : [cotizacion.vendedor, ...vendedores];

  return (
    <FormularioCotizacion
      // Remonta con datos frescos del servidor después de cada guardado.
      key={`${cotizacion.id}-${cotizacion.version}`}
      esAdmin={esAdministradorComercial(usuario)}
      usuarioActual={{ id: usuario.id, nombre: usuario.nombre }}
      clientesIniciales={clientes}
      obrasIniciales={obras}
      vendedores={opcionesVendedor}
      productos={productos}
      hoy={hoyNegocio()}
      cotizacion={cotizacion}
    />
  );
}

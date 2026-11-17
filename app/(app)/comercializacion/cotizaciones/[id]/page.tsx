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
import { CotizacionEmitidaView } from "@/components/comercializacion/cotizacion-emitida";

// Detalle único: un BORRADOR se consulta y edita en el formulario; una
// cotización EMITIDA/ACEPTADA se muestra de solo lectura desde su copia
// histórica, con sus acciones (PDF, aceptación, duplicar). Fuera del alcance
// del usuario (otra Empresa u otro vendedor) responde 404.
export default async function CotizacionPage(props: PageProps<"/comercializacion/cotizaciones/[id]">) {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  const { id } = await props.params;
  const sp = await props.searchParams;
  let cotizacion;
  try {
    cotizacion = await obtenerCotizacionVenta(usuario, id);
  } catch (error) {
    if (error instanceof RegistroNoEncontradoError) notFound();
    throw error;
  }
  const esAdmin = esAdministradorComercial(usuario);
  const hoy = hoyNegocio();

  if (cotizacion.estatus !== "BORRADOR" && cotizacion.emision) {
    return <CotizacionEmitidaView cotizacion={cotizacion} esAdmin={esAdmin} hoy={hoy} />;
  }

  const [{ clientes, obras }, productos, vendedores] = await Promise.all([
    listarClientesYObras(usuario),
    listarProductosParaVenta(usuario),
    listarVendedoresElegibles(usuario),
  ]);
  // El vendedor guardado puede ya no ser elegible (p. ej. perdió la función):
  // se conserva como opción para no reasignarlo en silencio.
  const opcionesVendedor = vendedores.some((v) => v.id === cotizacion.vendedor.id) ? vendedores : [cotizacion.vendedor, ...vendedores];
  const omitidos = typeof sp.omitidos === "string" ? sp.omitidos.split(",").filter(Boolean).slice(0, 50) : [];

  return (
    <div className="space-y-4">
      {omitidos.length > 0 && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          Al duplicar se omitieron materiales desactivados en el catálogo: {omitidos.join(", ")}.
        </p>
      )}
      <FormularioCotizacion
        // Remonta con datos frescos del servidor después de cada guardado.
        key={`${cotizacion.id}-${cotizacion.version}`}
        esAdmin={esAdmin}
        usuarioActual={{ id: usuario.id, nombre: usuario.nombre }}
        clientesIniciales={clientes}
        obrasIniciales={obras}
        vendedores={opcionesVendedor}
        productos={productos}
        hoy={hoy}
        cotizacion={cotizacion}
      />
    </div>
  );
}

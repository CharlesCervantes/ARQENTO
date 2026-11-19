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
import { resumenComprasOrden } from "@/lib/server/comercializacion/compras";
import { detalleCuentaDeOrden, estadoPagoDeCompras, resumenFinancieroOrden } from "@/lib/server/comercializacion/cuentas";
import { resumenEntregasOrden } from "@/lib/server/comercializacion/entregas";
import { listarBeneficiariosGasto, resultadoOrden, resumenGastosOrden } from "@/lib/server/comercializacion/gastos";
import { surtidoDeOrden } from "@/lib/server/comercializacion/surtido";
import { estadoCancelacionOrden } from "@/lib/server/comercializacion/cancelaciones";
import { CotizacionCanceladaBorradorView } from "@/components/comercializacion/cotizacion-cancelada-borrador";
import { AccionesBorrador } from "@/components/comercializacion/cancelaciones";

// Detalle único: un BORRADOR se consulta y edita en el formulario; una
// cotización EMITIDA/ACEPTADA se muestra de solo lectura desde su copia
// histórica, con sus acciones (PDF, aceptación, duplicar). Con OV es el
// expediente de la operación con vistas internas (?vista=…). Fuera del alcance
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

  // B8B: un borrador cancelado (nunca emitido) se consulta de solo lectura.
  if (cotizacion.estatus === "CANCELADA" && !cotizacion.emision) {
    // Nombres actuales de cliente y obra (el borrador no tiene copia emitida).
    const { clientes, obras } = await listarClientesYObras(usuario);
    return (
      <CotizacionCanceladaBorradorView
        cotizacion={cotizacion}
        esAdmin={esAdmin}
        hoy={hoy}
        clienteNombre={clientes.find((c) => c.id === cotizacion.clienteId)?.nombre ?? null}
        obraNombre={obras.find((o) => o.id === cotizacion.obraId)?.nombre ?? null}
      />
    );
  }

  if (cotizacion.estatus !== "BORRADOR" && cotizacion.emision) {
    // Compras (B4): solo se consultan para administración; el vendedor nunca
    // recibe proveedores, costos ni documentos de compra.
    const ovId = esAdmin && cotizacion.orden ? cotizacion.orden.id : null;
    // B5: cuentas, calendarios y movimientos tampoco se consultan para el vendedor.
    const [compras, cuenta, financiero] = ovId
      ? await Promise.all([resumenComprasOrden(usuario, ovId), detalleCuentaDeOrden(usuario, ovId), resumenFinancieroOrden(usuario, ovId)])
      : [null, null, null];
    // B7: gastos, costos y resultado — tampoco se consultan para el vendedor.
    const [gastosOrden, beneficiarios, resultado, surtido] = ovId
      ? await Promise.all([resumenGastosOrden(usuario, ovId), listarBeneficiariosGasto(usuario), resultadoOrden(usuario, ovId), surtidoDeOrden(usuario, ovId)])
      : [null, null, null, null];
    // B8B: bloqueos para «Cancelar OV» — solo administración.
    const cancelacionOrden = ovId ? await estadoCancelacionOrden(usuario, ovId) : null;
    // Rediseño: estado de pago de cada compra para «Cobros y pagos» — solo administración.
    const pagosCompras = compras ? await estadoPagoDeCompras(usuario, compras.compras.filter((c) => c.estatus !== "BORRADOR").map((c) => c.id)) : null;
    // B6A: entregas — administración y el vendedor asignado (alcance en el servicio).
    const entregas = cotizacion.orden ? await resumenEntregasOrden(usuario, cotizacion.orden.id) : null;
    return (
      <CotizacionEmitidaView cotizacion={cotizacion} esAdmin={esAdmin} hoy={hoy} vistaInicial={typeof sp.vista === "string" ? sp.vista : "resumen"} compras={compras} cuenta={cuenta} financiero={financiero}
        pagosCompras={pagosCompras}
        entregas={entregas}
        gastos={gastosOrden && beneficiarios ? { resumen: gastosOrden, beneficiarios } : null}
        resultado={resultado}
        surtido={surtido}
        cancelacionOrden={cancelacionOrden}
      />
    );
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
        accionesEncabezado={esAdmin && cotizacion.estatus === "BORRADOR" ? <AccionesBorrador cotizacionId={cotizacion.id} folio={cotizacion.folio} /> : null}
      />
    </div>
  );
}

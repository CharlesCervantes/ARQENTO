import { notFound } from "next/navigation";
import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarProveedoresComerciales, obtenerCompraComercial } from "@/lib/server/comercializacion/compras";
import { detalleCuentaDeCompra } from "@/lib/server/comercializacion/cuentas";
import { CuentaComercialView } from "@/components/comercializacion/cuenta-comercial";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { Card } from "@/components/ui/card";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { FormularioCompra } from "@/components/comercializacion/formulario-compra";
import { bloqueosSurtidoDeCompra, surtidoDeCompra } from "@/lib/server/comercializacion/surtido";
import { SurtidoCompraView } from "@/components/comercializacion/surtido-compra";

// Compra a proveedor (B4) — SOLO administración. Fuera de la Empresa = 404.
// No es una sección del menú: se llega desde el detalle de la OV.
export default async function CompraPage(props: PageProps<"/comercializacion/compras/[id]">) {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;
  if (!esAdministradorComercial(usuario)) {
    return <Card className="p-6 text-sm text-[var(--muted)]">Las compras a proveedores solo están disponibles para administración.</Card>;
  }
  const { id } = await props.params;
  let compra;
  try {
    compra = await obtenerCompraComercial(usuario, id);
  } catch (error) {
    if (error instanceof RegistroNoEncontradoError) notFound();
    throw error;
  }
  const proveedores = compra.estatus === "BORRADOR" ? await listarProveedoresComerciales(usuario) : [];
  const cuenta = compra.estatus === "BORRADOR" ? null : await detalleCuentaDeCompra(usuario, compra.id);
  // B8A: surtido a obra y bloqueos de la anulación simple (el servidor los vuelve a exigir al anular).
  const [surtido, bloqueosSurtido] = compra.estatus === "BORRADOR" ? [null, []] : await Promise.all([surtidoDeCompra(usuario, compra.id), bloqueosSurtidoDeCompra(usuario, compra.id)]);
  const bloqueosAnulacion = [
    ...(cuenta?.tuvoMovimientos ? [{ texto: "la compra tiene historial de pagos al proveedor (aunque estén anulados)", enlaces: [] }] : []),
    ...bloqueosSurtido.map((b) => ({
      texto: b.texto,
      enlaces: b.entregas.map((e) => ({ href: `/comercializacion/cotizaciones/${compra.orden.cotizacionId}#entrega-${e.entregaId}`, etiqueta: `Entrega ${e.numero}` })),
    })),
  ];
  return (
    <div className="space-y-6">
      <FormularioCompra key={`${compra.id}-${compra.version}`} compra={compra} proveedoresIniciales={proveedores} bloqueosAnulacion={bloqueosAnulacion} />
      {surtido && <SurtidoCompraView surtido={surtido} />}
      {cuenta && <CuentaComercialView cuenta={cuenta} contexto={`Compra ${compra.folio}${(compra.proveedorConfirmado?.nombre ?? compra.proveedorNombre) ? ` · ${compra.proveedorConfirmado?.nombre ?? compra.proveedorNombre}` : ""}`} />}
    </div>
  );
}

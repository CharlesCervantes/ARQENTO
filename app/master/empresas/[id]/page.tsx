import { notFound } from "next/navigation";
import { requireSession } from "@/lib/server/auth/dal";
import {
  obtenerEmpresa,
  listarPlanesCatalogo,
  EmpresaNoEncontradaError,
} from "@/lib/server/master/empresas";
import {
  obtenerConfiguracionInteligenciaEmpresa,
  obtenerDashboardInteligenciaEmpresa,
  resolverRangoInteligencia,
  type TipoRangoInteligencia,
} from "@/lib/server/master/inteligencia";
import { obtenerWhatsappEmpresaMaster } from "@/lib/server/master/whatsapp";
import { EmpresaDetalleView } from "@/components/master/empresa-detalle-view";

export default async function MasterEmpresaDetallePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ periodo?: string; desde?: string; hasta?: string }>;
}) {
  const usuario = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  let empresa;
  try {
    empresa = await obtenerEmpresa(usuario, id);
  } catch (error) {
    if (error instanceof EmpresaNoEncontradaError) notFound();
    throw error;
  }

  const tipoRango = (sp.periodo as TipoRangoInteligencia | undefined) ?? "ESTE_MES";
  const rango = resolverRangoInteligencia(tipoRango, { desde: sp.desde, hasta: sp.hasta });

  const [planes, configuracionInteligencia, dashboardInteligencia, whatsapp] = await Promise.all([
    listarPlanesCatalogo(usuario),
    obtenerConfiguracionInteligenciaEmpresa(usuario, id),
    obtenerDashboardInteligenciaEmpresa(usuario, id, rango),
    obtenerWhatsappEmpresaMaster(usuario, id),
  ]);

  return (
    <EmpresaDetalleView
      empresa={empresa}
      planes={planes}
      inteligencia={{ configuracion: configuracionInteligencia, dashboard: dashboardInteligencia, rango, tipoRango }}
      whatsapp={whatsapp}
    />
  );
}

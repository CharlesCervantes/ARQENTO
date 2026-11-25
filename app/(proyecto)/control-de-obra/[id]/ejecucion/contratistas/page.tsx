import { requireSession } from "@/lib/server/auth/dal";
import { puedeAdministrarProyectos, puedeAsignarConceptos, puedeVerRecibosFinancieros } from "@/lib/server/permisos";
import {
  obtenerContratistasProyecto,
  listarContratistasDisponibles,
} from "@/lib/server/control-de-obra/estructura-contractual";
import { obtenerAvanceAcumuladoPorConcepto } from "@/lib/server/control-de-obra/avance";
import {
  obtenerResumenFinancieroContratistas,
  obtenerHistorialCortesPorProyecto,
} from "@/lib/server/control-de-obra/recibos";
import { ContratistasView } from "@/components/control-de-obra/contratistas-view";

export default async function ContratistasPage({
  params,
}: PageProps<"/control-de-obra/[id]/ejecucion/contratistas">) {
  const usuario = await requireSession();
  const { id } = await params;
  const puedeAdministrar = puedeAdministrarProyectos(usuario);
  const puedeVerRecibos = puedeVerRecibosFinancieros(usuario);

  const [
    { partidas, contratos },
    contratistasDisponibles,
    avancePorConcepto,
    resumenFinancieroPorBeneficiario,
    historialPorBeneficiario,
  ] = await Promise.all([
    obtenerContratistasProyecto(usuario, id),
    puedeAdministrar ? listarContratistasDisponibles(usuario) : Promise.resolve([]),
    obtenerAvanceAcumuladoPorConcepto(usuario, id),
    puedeVerRecibos
      ? obtenerResumenFinancieroContratistas(usuario, id)
      : Promise.resolve(new Map()),
    puedeVerRecibos
      ? obtenerHistorialCortesPorProyecto(usuario, id)
      : Promise.resolve(new Map()),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">Contratistas</h1>

      <ContratistasView
        proyectoId={id}
        partidas={partidas}
        contratos={contratos}
        contratistasDisponibles={contratistasDisponibles}
        avancePorConcepto={avancePorConcepto}
        puedeAdministrar={puedeAdministrar}
        puedeAsignar={puedeAsignarConceptos(usuario)}
        puedeVerRecibosFinancieros={puedeVerRecibos}
        resumenFinancieroPorBeneficiario={resumenFinancieroPorBeneficiario}
        historialPorBeneficiario={historialPorBeneficiario}
      />
    </div>
  );
}

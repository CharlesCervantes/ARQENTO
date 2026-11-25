import { requireSession } from "@/lib/server/auth/dal";
import { puedeAdministrarProyectos, puedeEliminarEstructuraContractual, puedeProponerContrato, puedeResolverPropuestas } from "@/lib/server/permisos";
import {
  obtenerPartidasProyecto,
} from "@/lib/server/control-de-obra/estructura-contractual";
import { obtenerPropuestas } from "@/lib/server/control-de-obra/propuestas-contrato";
import { obtenerProyecto } from "@/lib/server/control-de-obra/proyectos";
import { ContratoGeneralView } from "@/components/control-de-obra/contrato-general-view";

export default async function ContratoGeneralPage({
  params,
}: PageProps<"/control-de-obra/[id]/contrato/general">) {
  const usuario = await requireSession();
  const { id } = await params;

  const [proyecto, partidas, propuestas] = await Promise.all([
    obtenerProyecto(usuario, id),
    obtenerPartidasProyecto(usuario, id),
    obtenerPropuestas(usuario, id),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">Contrato General</h1>

      <ContratoGeneralView
        proyectoId={id}
        partidas={partidas}
        esquemaContractual={proyecto.esquemaContractual}
        porcentajeAdministracionDefault={
          proyecto.porcentajeAdministracionDefault
            ? Number(proyecto.porcentajeAdministracionDefault)
            : null
        }
        puedeAdministrar={puedeAdministrarProyectos(usuario)}
        puedeEliminar={puedeEliminarEstructuraContractual(usuario)}
        propuestas={propuestas}
        puedeProponer={puedeProponerContrato(usuario)}
        puedeResolver={puedeResolverPropuestas(usuario)}
      />
    </div>
  );
}

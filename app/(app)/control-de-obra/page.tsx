import { requireSession } from "@/lib/server/auth/dal";
import {
  empresaTieneModulo,
  puedeAdministrarProyectos,
  puedeAsignarObras,
  puedeEliminarProyectos,
  puedeVerContabilidad,
  puedeVerInicio,
} from "@/lib/server/permisos";
import { listarProyectos } from "@/lib/server/control-de-obra/proyectos";
import { contarPendientesPorProyecto } from "@/lib/server/control-de-obra/avance";
import { obtenerResumenEjecutivo, type FilaProyectoDashboard } from "@/lib/server/dashboard";
import {
  aBusqueda,
  aFiltroProyectos,
  aVistaProyectos,
  coincideBusqueda,
  contarPorFiltro,
  cumpleFiltro,
  ordenarProyectos,
} from "@/lib/control-de-obra/listado-proyectos";
import { Card } from "@/components/ui/card";
import { RANGO_SALUD } from "@/components/dashboard/inicio/obras";
import { ProyectosView, type ProyectoListado } from "@/components/control-de-obra/proyectos-view";

// Proyectos (diseño de tarjetas, noviembre 2026). Filtros por estatus
// (?estatus=), vista tarjetas/lista (?vista=) y búsqueda (?q=) viajan en la
// URL: la página es de servidor y no guarda estado en el navegador.
export default async function ControlDeObraPage({
  searchParams,
}: {
  searchParams: Promise<{ estatus?: string; vista?: string; q?: string }>;
}) {
  const usuario = await requireSession();

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  if (!empresaTieneModulo(usuario, "control_de_obra")) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu plan no incluye el módulo de Control de Obra.
      </Card>
    );
  }

  const parametros = await searchParams;
  const filtro = aFiltroProyectos(parametros.estatus);
  const vista = aVistaProyectos(parametros.vista);
  const busqueda = aBusqueda(parametros.q);

  const puedeAdministrar = puedeAdministrarProyectos(usuario);
  // Mismo corte que Inicio: sin permiso de Contabilidad (Supervisor) no hay
  // montos ni porcentajes financieros, y la salud no se muestra.
  const esSupervisor = !puedeVerContabilidad(usuario);

  const [proyectos, pendientesPorProyecto, resumen] = await Promise.all([
    listarProyectos(usuario),
    // Solo quien puede aprobar necesita ver el aviso — nadie más puede actuar
    // sobre él (mismo criterio que P.U./Monto en Avance de obra).
    puedeAdministrar ? contarPendientesPorProyecto(usuario.empresa.id) : Promise.resolve(new Map<string, number>()),
    // Cifras por obra: exactamente las de Inicio, en vista General (nunca
    // información privada). Sin el módulo Inicio, las tarjetas se muestran
    // sin cifras.
    puedeVerInicio(usuario) ? obtenerResumenEjecutivo(usuario, "general", "semana") : Promise.resolve(null),
  ]);

  const filas = new Map<string, FilaProyectoDashboard>((resumen?.proyectos ?? []).map((f) => [f.id, f]));
  const todos: (ProyectoListado & { rangoSalud: number | null })[] = proyectos.map((p) => {
    const fila = filas.get(p.id) ?? null;
    return {
      id: p.id,
      nombre: p.nombre,
      tipo: p.tipo,
      cliente: p.cliente,
      estatus: p.estatus,
      pendientesAprobar: pendientesPorProyecto.get(p.id) ?? 0,
      fila,
      rangoSalud: fila && p.estatus === "ACTIVO" && !esSupervisor ? RANGO_SALUD[fila.salud] : null,
    };
  });

  const visibles = ordenarProyectos(
    todos.filter((p) => cumpleFiltro(p.estatus, filtro) && coincideBusqueda(p, busqueda))
  );

  return (
    <ProyectosView
      proyectos={visibles}
      conteos={contarPorFiltro(todos)}
      filtro={filtro}
      vista={vista}
      busqueda={busqueda}
      esSupervisor={esSupervisor}
      puedeAdministrar={puedeAdministrar}
      puedeEliminar={puedeEliminarProyectos(usuario)}
      puedeAsignar={puedeAsignarObras(usuario)}
    />
  );
}

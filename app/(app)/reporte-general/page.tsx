import { requireSession } from "@/lib/server/auth/dal";
import { empresaTieneModulo, puedeLiquidarPagos } from "@/lib/server/permisos";
import {
  obtenerOCrearSemana,
  formatearRangoSemana,
  fechaAParametro,
  parametroAFecha,
} from "@/lib/server/semanas";
import { obtenerReporteSemana } from "@/lib/server/reporte-general/queries";
import { obtenerMiReporte } from "@/lib/server/reporte-general/mi-reporte";
import { limitadoASusObras } from "@/lib/server/control-de-obra/obras-visibles";
import { MiReporteView } from "@/components/reporte-general/mi-reporte-view";
import {
  obraTieneEstado,
  obraCoincideBusqueda,
} from "@/lib/reporte-general/estado";
import { asegurarGastosRecurrentesGenerados } from "@/lib/server/control-de-obra/gastos-recurrentes";
import { obtenerResumenGastosEmpresaPorCategoria } from "@/lib/server/control-de-obra/gastos";
import { obtenerProyectoOficinaId } from "@/lib/server/control-de-obra/proyecto-oficina";
import { ResumenSemana } from "@/components/reporte-general/resumen-semana";
import { NavegacionSemana } from "@/components/reporte-general/navegacion-semana";
import { FiltrosProyectos } from "@/components/reporte-general/filtros-proyectos";
import { TablaProyectosHeader } from "@/components/reporte-general/tabla-proyectos-header";
import { ObraCard } from "@/components/reporte-general/obra-card";
import { GastosEmpresaCard } from "@/components/reporte-general/gastos-empresa-card";
import { Card } from "@/components/ui/card";
import type { EstatusPago } from "@/lib/generated/prisma/enums";

const ESTADO_A_ESTATUS: Record<string, EstatusPago> = {
  pendientes: "PENDIENTE_PAGO",
  puente: "PAGADO_PUENTE",
  liquidados: "LIQUIDADO",
};

export default async function ReporteGeneralPage(
  props: PageProps<"/reporte-general">
) {
  const usuario = await requireSession();

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  if (!empresaTieneModulo(usuario, "reporte_general")) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu plan no incluye el módulo de Reporte General.
      </Card>
    );
  }

  const searchParams = await props.searchParams;
  const fechaParam =
    typeof searchParams.fecha === "string" ? searchParams.fecha : undefined;
  const estadoParam =
    typeof searchParams.estado === "string" ? searchParams.estado : "todos";
  const qParam = typeof searchParams.q === "string" ? searchParams.q : "";

  const semana = await obtenerOCrearSemana(
    usuario.empresa.id,
    parametroAFecha(fechaParam)
  );
  // Perezoso e idempotente — asegura que los gastos recurrentes de esta
  // semana ya existan aunque nadie haya entrado antes a Gastos (Gastos
  // transversal — recurrentes, septiembre 2026).
  await asegurarGastosRecurrentesGenerados(usuario.empresa.id, semana.id);

  const fechaAnterior = new Date(semana.fechaInicio);
  fechaAnterior.setDate(fechaAnterior.getDate() - 7);
  const fechaSiguiente = new Date(semana.fechaInicio);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 7);

  // Supervisor: solo lo suyo. Se resuelve antes de consultar cualquier obra.
  if (limitadoASusObras(usuario)) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Reporte General</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Mis pagos y mis gastos · {formatearRangoSemana(semana)}</p>
        </div>
        <NavegacionSemana
          etiquetaSemana={`Semana ${semana.numero}`}
          fechaAnteriorParametro={fechaAParametro(fechaAnterior)}
          fechaSiguienteParametro={fechaAParametro(fechaSiguiente)}
        />
        <MiReporteView reporte={await obtenerMiReporte(usuario, semana.id)} />
      </div>
    );
  }

  const proyectoOficinaId = await obtenerProyectoOficinaId(usuario.empresa.id);
  const [reporteCompleto, resumenGastosEmpresa] = await Promise.all([
    obtenerReporteSemana(usuario.empresa.id, semana.id),
    proyectoOficinaId
      ? obtenerResumenGastosEmpresaPorCategoria(usuario, proyectoOficinaId, semana.id)
      : Promise.resolve(null),
  ]);

  // El Proyecto(tipo=OFICINA) es el vehículo interno de Gastos de Empresa —
  // nunca se pinta como una obra más (su agregación por beneficiario está
  // incompleta a propósito: un gasto de Empresa pagado directo, sin
  // pagador, nunca genera MovimientoSemanal — obtenerResumenGastosEmpresaPorCategoria
  // es la fuente correcta y completa para este bloque, ver ese comentario en
  // gastos.ts). Se excluye por completo de la lista de obras (Gastos
  // transversal, septiembre 2026).
  const todasLasObras = reporteCompleto.filter((o) => o.proyecto.tipo !== "OFICINA");

  const totalEntreSemana = todasLasObras.reduce((t, o) => t + o.totalEntreSemana, 0);
  const totalFinSemana = todasLasObras.reduce((t, o) => t + o.totalFinSemana, 0);
  const pendienteDePago = todasLasObras.reduce((t, o) => t + o.pendienteSemana, 0);

  const totalProyectos = todasLasObras.reduce((t, o) => t + o.totalSemana, 0);
  const totalGastosEmpresa = resumenGastosEmpresa?.total ?? 0;

  const estatusFiltro = ESTADO_A_ESTATUS[estadoParam];
  const obrasFiltradas = todasLasObras.filter((obra) => {
    if (qParam && !obraCoincideBusqueda(obra, qParam)) return false;
    if (estatusFiltro && !obraTieneEstado(obra, estatusFiltro)) return false;
    return true;
  });

  const conMovimientos = obrasFiltradas.filter((o) => o.totalSemana > 0);
  // Los filtros de estatus solo tienen sentido sobre movimientos existentes.
  const sinMovimientos = estatusFiltro
    ? []
    : obrasFiltradas.filter((o) => o.totalSemana === 0);

  const puedeLiquidar = puedeLiquidarPagos(usuario);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          Reporte General
        </h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Control y planeación semanal de pagos · {formatearRangoSemana(semana)}
        </p>
      </div>

      {resumenGastosEmpresa && (
        <GastosEmpresaCard
          totalProyectos={totalProyectos}
          resumen={resumenGastosEmpresa}
          totalGeneral={totalProyectos + totalGastosEmpresa}
        />
      )}

      <ResumenSemana
        totalEntreSemana={totalEntreSemana}
        totalFinSemana={totalFinSemana}
        pendienteDePago={pendienteDePago}
      />

      <div className="space-y-3">
        <NavegacionSemana
          etiquetaSemana={`Semana ${semana.numero}`}
          fechaAnteriorParametro={fechaAParametro(fechaAnterior)}
          fechaSiguienteParametro={fechaAParametro(fechaSiguiente)}
          estado={estadoParam}
          q={qParam}
        />
        <FiltrosProyectos estadoActivo={estadoParam} fecha={fechaParam} q={qParam} />
      </div>

      {todasLasObras.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay obras registradas para {usuario.empresa.nombre}.
        </Card>
      ) : obrasFiltradas.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Ningún proyecto coincide con el filtro o la búsqueda actual.
        </Card>
      ) : (
        <div className="space-y-6">
          {conMovimientos.length > 0 && (
            <section className="space-y-2">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Con movimientos esta semana
              </h2>
              <TablaProyectosHeader />
              <div className="space-y-2">
                {conMovimientos.map((obra, i) => (
                  <ObraCard key={obra.proyecto.id} obra={obra} index={i} puedeLiquidar={puedeLiquidar} />
                ))}
              </div>
            </section>
          )}

          {sinMovimientos.length > 0 && (
            <details>
              <summary className="group flex cursor-pointer list-none items-center gap-1.5 px-1 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] select-none [&::-webkit-details-marker]:hidden">
                <svg
                  viewBox="0 0 20 20"
                  className="h-3 w-3 shrink-0 transition-transform duration-200 ease-out group-open:rotate-90"
                  fill="currentColor"
                >
                  <path d="M7 4l6 6-6 6V4z" />
                </svg>
                Sin movimientos · {sinMovimientos.length} proyecto
                {sinMovimientos.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-2 space-y-2">
                <TablaProyectosHeader />
                {sinMovimientos.map((obra, i) => (
                  <ObraCard key={obra.proyecto.id} obra={obra} index={i} puedeLiquidar={puedeLiquidar} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

import { capturaSoloGastosPropios, puedeVerInformacionPrivada } from "@/lib/server/permisos";
import { requireSession } from "@/lib/server/auth/dal";
import {
  puedeCapturarGastos,
  puedeAprobarGastos,
  puedeRegistrarAbonoReposicion,
} from "@/lib/server/permisos";
import { asegurarGastosRecurrentesGenerados } from "@/lib/server/control-de-obra/gastos-recurrentes";
import {
  obtenerOCrearSemana,
  formatearRangoSemana,
  fechaAParametro,
  parametroAFecha,
} from "@/lib/server/semanas";
import {
  obtenerGastos,
  calcularDashboardGastos,
  listarBeneficiariosParaGasto,
} from "@/lib/server/control-de-obra/gastos";
import { obtenerReposiciones } from "@/lib/server/control-de-obra/reposiciones";
import { obtenerBeneficiarioVinculado } from "@/lib/server/catalogos";
import { NavegacionSemana } from "@/components/control-de-obra/navegacion-semana";
import { GastosReposicionesView } from "@/components/control-de-obra/gastos-reposiciones-view";
import { Card } from "@/components/ui/card";

export default async function ReposicionesPage({
  params,
  searchParams,
}: PageProps<"/control-de-obra/[id]/ejecucion/gastos/reposiciones">) {
  const usuario = await requireSession();

  if (!puedeCapturarGastos(usuario)) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        No tienes permiso para ver Gastos de Obra.
      </Card>
    );
  }

  const { id } = await params;
  const { fecha } = await searchParams;
  const fechaParam = typeof fecha === "string" ? fecha : undefined;

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  const semana = await obtenerOCrearSemana(usuario.empresa.id, parametroAFecha(fechaParam));
  // Perezoso e idempotente — asegura que los gastos recurrentes de esta
  // semana ya existan aunque nadie haya entrado antes a Reporte General
  // (Gastos transversal — recurrentes, septiembre 2026).
  await asegurarGastosRecurrentesGenerados(usuario.empresa.id, semana.id);

  const [gastos, reposiciones, beneficiarios, beneficiarioVinculado] = await Promise.all([
    obtenerGastos(usuario, id, semana.id),
    obtenerReposiciones(usuario, id, semana.id),
    listarBeneficiariosParaGasto(usuario),
    obtenerBeneficiarioVinculado(usuario),
  ]);
  const dashboard = calcularDashboardGastos(gastos);

  const fechaAnterior = new Date(semana.fechaInicio);
  fechaAnterior.setDate(fechaAnterior.getDate() - 7);
  const fechaSiguiente = new Date(semana.fechaInicio);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 7);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Gastos de obra</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Reposiciones de gastos · {formatearRangoSemana(semana)}
        </p>
      </div>

      <NavegacionSemana
        proyectoId={id}
        rutaBase="ejecucion/gastos/reposiciones"
        etiquetaSemana={`Semana ${semana.numero}`}
        fechaAnteriorParametro={fechaAParametro(fechaAnterior)}
        fechaSiguienteParametro={fechaAParametro(fechaSiguiente)}
      />

      <GastosReposicionesView
        verPrivado={puedeVerInformacionPrivada(usuario)}
        proyectoId={id}
        semanaId={semana.id}
        gastos={gastos}
        reposiciones={reposiciones}
        beneficiarios={beneficiarios}
        beneficiarioVinculado={beneficiarioVinculado}
        dashboard={dashboard}
        puedeAprobar={puedeAprobarGastos(usuario)}
        pagadorFijo={capturaSoloGastosPropios(usuario)}
        puedeRegistrarAbono={puedeRegistrarAbonoReposicion(usuario)}
        usuarioId={usuario.id}
      />
    </div>
  );
}

import { capturaSoloGastosPropios, puedeVerInformacionPrivada } from "@/lib/server/permisos";
import { requireSession } from "@/lib/server/auth/dal";
import { empresaTieneModulo } from "@/lib/server/permisos";
import {
  obtenerOCrearSemana,
  formatearRangoSemana,
  fechaAParametro,
  parametroAFecha,
} from "@/lib/server/semanas";
import { asegurarGastosRecurrentesGenerados } from "@/lib/server/control-de-obra/gastos-recurrentes";
import { obtenerGastosGlobal, listarBeneficiariosParaGasto } from "@/lib/server/control-de-obra/gastos";
import { listarProyectos } from "@/lib/server/control-de-obra/proyectos";
import { obtenerBeneficiarioVinculado } from "@/lib/server/catalogos";
import { GastosGlobalView } from "@/components/control-de-obra/gastos-global-view";
import { Card } from "@/components/ui/card";
import Link from "next/link";

export default async function GastosGlobalPage(props: PageProps<"/gastos">) {
  const usuario = await requireSession();

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  if (!empresaTieneModulo(usuario, "gastos")) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu plan no incluye el módulo de Gastos.
      </Card>
    );
  }

  const searchParams = await props.searchParams;
  const fechaParam = typeof searchParams.fecha === "string" ? searchParams.fecha : undefined;

  const semana = await obtenerOCrearSemana(usuario.empresa.id, parametroAFecha(fechaParam));
  // Perezoso e idempotente — asegura que los gastos recurrentes de esta
  // semana ya existan aunque nadie haya entrado antes a Reporte General
  // (Gastos transversal — recurrentes, septiembre 2026).
  await asegurarGastosRecurrentesGenerados(usuario.empresa.id, semana.id);

  const [gastos, proyectos, beneficiarios, beneficiarioVinculado] = await Promise.all([
    obtenerGastosGlobal(usuario, semana.id),
    listarProyectos(usuario),
    listarBeneficiariosParaGasto(usuario),
    obtenerBeneficiarioVinculado(usuario),
  ]);

  const fechaAnterior = new Date(semana.fechaInicio);
  fechaAnterior.setDate(fechaAnterior.getDate() - 7);
  const fechaSiguiente = new Date(semana.fechaInicio);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 7);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Gastos</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Proyectos y Empresa · {formatearRangoSemana(semana)}
          </p>
        </div>
        <Link
          href="/gastos/recurrentes"
          className="text-sm font-medium text-[var(--brand)] hover:underline"
        >
          Gastos recurrentes →
        </Link>
      </div>

      <div className="flex items-center gap-1 text-sm">
        <Link
          href={`/gastos?fecha=${fechaAParametro(fechaAnterior)}`}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium text-[var(--muted)] transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-[var(--foreground)]"
        >
          ← Semana anterior
        </Link>
        <span className="px-2 font-semibold text-[var(--foreground)]">Semana {semana.numero}</span>
        <Link
          href={`/gastos?fecha=${fechaAParametro(fechaSiguiente)}`}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium text-[var(--muted)] transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-[var(--foreground)]"
        >
          Semana siguiente →
        </Link>
      </div>

      <GastosGlobalView
        verPrivado={puedeVerInformacionPrivada(usuario)}
        gastos={gastos}
        proyectosDisponibles={proyectos.map((p) => ({ id: p.id, nombre: p.nombre }))}
        beneficiarios={beneficiarios}
        beneficiarioVinculado={beneficiarioVinculado}
        pagadorFijo={capturaSoloGastosPropios(usuario)}
      />
    </div>
  );
}

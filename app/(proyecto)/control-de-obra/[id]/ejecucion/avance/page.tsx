import { requireSession } from "@/lib/server/auth/dal";
import {
  obtenerOCrearSemana,
  formatearRangoSemana,
  fechaAParametro,
  parametroAFecha,
} from "@/lib/server/semanas";
import { obtenerAvanceSemanal, filtrarPartidasConMovimiento } from "@/lib/server/control-de-obra/avance";
import { obtenerResumenCierreSemana } from "@/lib/server/control-de-obra/cierre-semana";
import {
  puedeAdministrarProyectos,
  puedeCerrarSemana,
  puedeReabrirSemana,
  puedeVerRecibosFinancieros,
} from "@/lib/server/permisos";
import { ResumenAvance } from "@/components/control-de-obra/resumen-avance";
import { NavegacionSemana } from "@/components/control-de-obra/navegacion-semana";
import { FormAvanceSemanal } from "@/components/control-de-obra/form-avance-semanal";
import { CierreSemanaAbierta } from "@/components/control-de-obra/cierre-semana-abierta";
import { CierreSemanaCerrada } from "@/components/control-de-obra/cierre-semana-cerrada";
import { Card } from "@/components/ui/card";

export default async function AvanceObraPage({
  params,
  searchParams,
}: PageProps<"/control-de-obra/[id]/ejecucion/avance">) {
  const usuario = await requireSession();
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

  // Semana compartida con toda la empresa (la misma entidad que Reporte
  // General) — no se crea un ciclo semanal independiente para este módulo.
  const semana = await obtenerOCrearSemana(usuario.empresa.id, parametroAFecha(fechaParam));
  const [partidas, resumenCierre] = await Promise.all([
    obtenerAvanceSemanal(usuario, id, semana),
    obtenerResumenCierreSemana(usuario, id, semana.id),
  ]);
  const semanaCerrada = resumenCierre.estatus === "CERRADA";

  // Los indicadores de arriba siempre se calculan sobre TODOS los conceptos
  // del proyecto, sin importar si la tabla de abajo está filtrada — no
  // cambian de significado solo porque la semana esté cerrada (decisión de
  // sesión, agosto 2026): "Conceptos pendientes/terminados" sigue siendo
  // sobre el total contractual, "Con movimiento esta semana" ya se basaba en
  // AvanceConcepto real de esta semana (nunca en el acumulado).
  const todosLosConceptos = partidas.flatMap((p) => p.conceptos);
  const conMovimiento = todosLosConceptos.filter((c) => c.estaSemana > 0).length;
  const terminados = todosLosConceptos.filter((c) => c.estado === "TERMINADO").length;
  const pendientes = todosLosConceptos.filter((c) => c.estado !== "TERMINADO").length;

  // Semana cerrada = vista histórica de solo lo que de verdad se ejecutó esa
  // semana (AvanceConcepto real de esa semana vía `estaSemana`, nunca el
  // acumulado) — una partida sin ningún concepto con movimiento tampoco se
  // muestra. Al reabrir, semanaCerrada pasa a false y reaparece todo solo.
  const partidasVisibles = semanaCerrada ? filtrarPartidasConMovimiento(partidas) : partidas;

  const fechaAnterior = new Date(semana.fechaInicio);
  fechaAnterior.setDate(fechaAnterior.getDate() - 7);
  const fechaSiguiente = new Date(semana.fechaInicio);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 7);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          Avance de obra
        </h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Avance físico real por concepto · {formatearRangoSemana(semana)}
        </p>
      </div>

      <ResumenAvance
        conMovimiento={conMovimiento}
        terminados={terminados}
        pendientes={pendientes}
      />

      <NavegacionSemana
        proyectoId={id}
        etiquetaSemana={`Semana ${semana.numero}`}
        fechaAnteriorParametro={fechaAParametro(fechaAnterior)}
        fechaSiguienteParametro={fechaAParametro(fechaSiguiente)}
      />

      <FormAvanceSemanal
        key={semana.id}
        proyectoId={id}
        semanaId={semana.id}
        partidas={partidasVisibles}
        puedeAprobar={puedeAdministrarProyectos(usuario)}
        soloLectura={semanaCerrada}
        mensajeVacio={
          semanaCerrada ? "Ningún concepto tuvo avance registrado en esta semana." : undefined
        }
      />

      {semanaCerrada ? (
        <CierreSemanaCerrada
          proyectoId={id}
          semanaId={semana.id}
          numeroSemana={semana.numero}
          resumen={resumenCierre}
          puedeReabrir={puedeReabrirSemana(usuario) && !resumenCierre.historicoImportado}
          puedeVerRecibosFinancieros={puedeVerRecibosFinancieros(usuario)}
        />
      ) : (
        <CierreSemanaAbierta
          proyectoId={id}
          semanaId={semana.id}
          numeroSemana={semana.numero}
          resumen={resumenCierre}
          puedeCerrarSemana={puedeCerrarSemana(usuario)}
        />
      )}
    </div>
  );
}

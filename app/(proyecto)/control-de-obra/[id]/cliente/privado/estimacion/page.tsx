import { requireSession } from "@/lib/server/auth/dal";
import {
  puedeVerContratoGeneralPrivado,
  puedeEmitirEstimacionCliente,
  puedeMaterializarEstimacionHistorica,
} from "@/lib/server/permisos";
import { obtenerProyecto } from "@/lib/server/control-de-obra/proyectos";
import {
  obtenerOCrearSemana,
  formatearRangoSemana,
  fechaAParametro,
  parametroAFecha,
} from "@/lib/server/semanas";
import { obtenerResumenCierreSemana } from "@/lib/server/control-de-obra/cierre-semana";
import {
  obtenerEstimacionSemanalEnVivo,
  obtenerEstimacionCliente,
  agruparPorPartida,
  type FilaEstimacion,
  type FilaEstimacionCapa,
} from "@/lib/server/control-de-obra/estimacion-cliente";
import { obtenerControlContractual } from "@/lib/server/control-de-obra/financiero-cliente";
import { NavegacionSemana } from "@/components/control-de-obra/navegacion-semana";
import { TablaEstimacion, type FilaTablaEstimacion } from "@/components/control-de-obra/tabla-estimacion";
import { TablaGastosEstimacion } from "@/components/control-de-obra/tabla-gastos-estimacion";
import { ResumenEstimacionPrivada } from "@/components/control-de-obra/resumen-estimacion";
import { ConfigurarIvaEstimacion } from "@/components/control-de-obra/configurar-iva-estimacion";
import { EmitirEstimacion } from "@/components/control-de-obra/emitir-estimacion";
import { MaterializarEstimacionHistorica } from "@/components/control-de-obra/materializar-estimacion-historica";
import { Card } from "@/components/ui/card";

// Semana abierta: capa base (antes de administración/utilidad), para que
// cantidad × P.U. mostrado siempre cuadre con el importe mostrado en cada
// columna — la administración/utilidad se ve únicamente en
// ResumenEstimacionPrivada.
function aFilaTablaEnVivo(f: FilaEstimacion): FilaTablaEstimacion {
  return {
    conceptoId: f.conceptoId,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    precioUnitario: f.precioUnitarioBasePrivado,
    importeContratado: f.importeContratadoBasePrivado,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    importeEstaSemana: f.importeEstaSemanaBasePrivado,
    importeAcumulado: f.importeAcumuladoBasePrivado,
    cantidadPorEjercer: f.cantidadPorEjercer,
    importePorEjercer: f.importePorEjercerBasePrivado,
    avancePorcentaje: f.avancePorcentaje,
    porcentajeAplicado: f.porcentajeAplicadoPrivado,
  };
}

// Semana cerrada: la capa ya viene en su forma base (precioUnitarioBase) —
// misma razón de siempre, cantidad × P.U. mostrado debe cuadrar exacto con
// el importe.
function aFilaTablaCapa(f: FilaEstimacionCapa): FilaTablaEstimacion {
  return {
    conceptoId: f.conceptoId,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    precioUnitario: f.precioUnitarioBase,
    importeContratado: f.importeContratado,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    importeEstaSemana: f.importeEstaSemana,
    importeAcumulado: f.importeAcumulado,
    cantidadPorEjercer: f.cantidadPorEjercer,
    importePorEjercer: f.importePorEjercer,
    avancePorcentaje: f.avancePorcentaje,
    porcentajeAplicado: f.porcentajeAplicado,
  };
}

export default async function ClientePrivadoEstimacionPage({
  params,
  searchParams,
}: PageProps<"/control-de-obra/[id]/cliente/privado/estimacion">) {
  const usuario = await requireSession();

  if (!puedeVerContratoGeneralPrivado(usuario)) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        No tienes permiso para ver Cliente Priv.
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

  const [proyecto, resumenCierre, controlContractual, congeladoCandidato, enVivoCandidato] =
    await Promise.all([
      obtenerProyecto(usuario, id),
      obtenerResumenCierreSemana(usuario, id, semana.id),
      obtenerControlContractual(usuario, id, "privado"),
      obtenerEstimacionCliente(usuario, id, semana.id, "PRIVADO"),
      obtenerEstimacionSemanalEnVivo(usuario, id, semana),
    ]);
  const fondoDisponible = controlContractual.financiero?.fondo?.disponible ?? 0;
  const semanaCerrada = resumenCierre.estatus === "CERRADA";

  const congelado = semanaCerrada ? congeladoCandidato : null;
  const sinSnapshot = semanaCerrada && congelado === null;

  // Semana abierta: avance + gastos cobrables que entrarían al cerrar
  // (mismos criterios que el cierre; solo lectura).
  const preliminar = enVivoCandidato.preliminar.PRIVADO;

  const partidas = semanaCerrada
    ? agruparPorPartida(congelado?.filas ?? []).map((p) => ({
        partidaNombre: p.partidaNombre,
        conceptos: p.conceptos.map(aFilaTablaCapa),
      }))
    : agruparPorPartida(enVivoCandidato.filas).map((p) => ({
        partidaNombre: p.partidaNombre,
        conceptos: p.conceptos.map(aFilaTablaEnVivo),
      }));

  const fechaAnterior = new Date(semana.fechaInicio);
  fechaAnterior.setDate(fechaAnterior.getDate() - 7);
  const fechaSiguiente = new Date(semana.fechaInicio);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 7);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Cliente Priv.</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Valorización del avance físico con la lógica de Contrato General Privado ·{" "}
          {formatearRangoSemana(semana)}
        </p>
      </div>

      <NavegacionSemana
        proyectoId={id}
        rutaBase="cliente/privado/estimacion"
        etiquetaSemana={`Semana ${semana.numero}`}
        fechaAnteriorParametro={fechaAParametro(fechaAnterior)}
        fechaSiguienteParametro={fechaAParametro(fechaSiguiente)}
      />

      {semanaCerrada ? (
        <p className="text-xs font-medium text-emerald-700">
          Semana cerrada · corte oficial de esta semana
        </p>
      ) : (
        <p className="text-xs font-medium text-amber-700">
          Semana abierta · información preliminar — no se puede emitir todavía
        </p>
      )}

      {sinSnapshot ? (
        puedeMaterializarEstimacionHistorica(usuario) ? (
          <MaterializarEstimacionHistorica
            proyectoId={id}
            semanaId={semana.id}
            numeroSemana={semana.numero}
          />
        ) : (
          <Card className="p-6 text-sm text-[var(--muted)]">
            Esta semana no tiene una estimación generada todavía.
          </Card>
        )
      ) : (
        <>
          <TablaEstimacion
            partidas={partidas}
            mostrarPorcentajeAplicado
            etiquetaPorcentajeAplicado={proyecto.esquemaContractual === "ADMINISTRACION" ? "ADM" : "UTIL"}
          />

          {congelado ? (
            <>
              <TablaGastosEstimacion gastos={congelado.gastos} />
              <ResumenEstimacionPrivada
                esquemaContractual={proyecto.esquemaContractual}
                subtotalTrabajos={congelado.estimacion.subtotal}
                gastosCobrables={congelado.estimacion.subtotalGastosCobrables}
                administracion={congelado.estimacion.montoAdministracionTotal}
                aplicaIVA={congelado.estimacion.aplicaIVA}
                montoIVA={congelado.estimacion.montoIVA}
                total={congelado.estimacion.total}
              />

              {congelado.estimacion.estatus === "BORRADOR" && puedeEmitirEstimacionCliente(usuario) && (
                <ConfigurarIvaEstimacion
                  proyectoId={id}
                  estimacionId={congelado.estimacion.id}
                  aplicaIVA={congelado.estimacion.aplicaIVA}
                  porcentajeIVA={congelado.estimacion.porcentajeIVA}
                />
              )}

              <EmitirEstimacion
                proyectoId={id}
                estimacionId={congelado.estimacion.id}
                numero={congelado.estimacion.numero}
                estatus={congelado.estimacion.estatus}
                total={congelado.estimacion.total}
                generadoPorNombre={congelado.estimacion.generadoPorNombre}
                emitidoPorNombre={congelado.estimacion.emitidoPorNombre}
                emitidoEn={congelado.estimacion.emitidoEn}
                puedeEmitir={puedeEmitirEstimacionCliente(usuario)}
                fondoDisponible={fondoDisponible}
              />
            </>
          ) : (
            <>
              <TablaGastosEstimacion gastos={preliminar.gastos} />
              <ResumenEstimacionPrivada
                esquemaContractual={proyecto.esquemaContractual}
                subtotalTrabajos={preliminar.totales.subtotal}
                gastosCobrables={preliminar.totales.subtotalGastosCobrables}
                administracion={preliminar.totales.montoAdministracionTotal}
                aplicaIVA={preliminar.aplicaIVA}
                montoIVA={preliminar.totales.montoIVA}
                total={preliminar.totales.total}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

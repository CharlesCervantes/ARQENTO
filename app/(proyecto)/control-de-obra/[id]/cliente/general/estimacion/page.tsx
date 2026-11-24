import { requireSession } from "@/lib/server/auth/dal";
import { puedeEmitirEstimacionCliente } from "@/lib/server/permisos";
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
  soloOperativo,
  agruparPorPartida,
  type FilaEstimacionCapa,
} from "@/lib/server/control-de-obra/estimacion-cliente";
import { obtenerControlContractual } from "@/lib/server/control-de-obra/financiero-cliente";
import { NavegacionSemana } from "@/components/control-de-obra/navegacion-semana";
import { TablaEstimacion, type FilaTablaEstimacion } from "@/components/control-de-obra/tabla-estimacion";
import { TablaGastosEstimacion } from "@/components/control-de-obra/tabla-gastos-estimacion";
import { ResumenEstimacionOperativa } from "@/components/control-de-obra/resumen-estimacion";
import { ConfigurarIvaEstimacion } from "@/components/control-de-obra/configurar-iva-estimacion";
import { EmitirEstimacion } from "@/components/control-de-obra/emitir-estimacion";
import { Card } from "@/components/ui/card";

function aFilaTablaEnVivo(f: {
  conceptoId: string;
  descripcionConcepto: string;
  unidad: string;
  cantidadContratada: number;
  precioUnitarioOperativo: number;
  importeContratadoOperativo: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  importeEstaSemanaOperativo: number;
  importeAcumuladoOperativo: number;
  cantidadPorEjercer: number;
  importePorEjercerOperativo: number;
  avancePorcentaje: number;
}): FilaTablaEstimacion {
  return {
    conceptoId: f.conceptoId,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    precioUnitario: f.precioUnitarioOperativo,
    importeContratado: f.importeContratadoOperativo,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    importeEstaSemana: f.importeEstaSemanaOperativo,
    importeAcumulado: f.importeAcumuladoOperativo,
    cantidadPorEjercer: f.cantidadPorEjercer,
    importePorEjercer: f.importePorEjercerOperativo,
    avancePorcentaje: f.avancePorcentaje,
  };
}

function aFilaTablaCapa(f: FilaEstimacionCapa): FilaTablaEstimacion {
  return {
    conceptoId: f.conceptoId,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    precioUnitario: f.precioUnitario,
    importeContratado: f.importeContratado,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    importeEstaSemana: f.importeEstaSemana,
    importeAcumulado: f.importeAcumulado,
    cantidadPorEjercer: f.cantidadPorEjercer,
    importePorEjercer: f.importePorEjercer,
    avancePorcentaje: f.avancePorcentaje,
  };
}

export default async function ClienteGeneralEstimacionPage({
  params,
  searchParams,
}: PageProps<"/control-de-obra/[id]/cliente/general/estimacion">) {
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

  const semana = await obtenerOCrearSemana(usuario.empresa.id, parametroAFecha(fechaParam));

  const [resumenCierre, controlContractual, congeladoCandidato, enVivoCandidato] = await Promise.all([
    obtenerResumenCierreSemana(usuario, id, semana.id),
    obtenerControlContractual(usuario, id, "operativo"),
    obtenerEstimacionCliente(usuario, id, semana.id, "OPERATIVO"),
    obtenerEstimacionSemanalEnVivo(usuario, id, semana),
  ]);
  const fondoDisponible = controlContractual.financiero?.fondo?.disponible ?? 0;
  const semanaCerrada = resumenCierre.estatus === "CERRADA";
  const preliminar = enVivoCandidato.preliminar.OPERATIVO;

  const congelado = semanaCerrada ? congeladoCandidato : null;
  const sinSnapshot = semanaCerrada && congelado === null;

  const partidas = semanaCerrada
    ? agruparPorPartida(congelado?.filas ?? []).map((p) => ({
        partidaNombre: p.partidaNombre,
        conceptos: p.conceptos.map(aFilaTablaCapa),
      }))
    : agruparPorPartida(soloOperativo(enVivoCandidato.filas)).map((p) => ({
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
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Cliente</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Valorización del avance físico con la lógica de Contrato General ·{" "}
          {formatearRangoSemana(semana)}
        </p>
      </div>

      <NavegacionSemana
        proyectoId={id}
        rutaBase="cliente/general/estimacion"
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
          Semana abierta · información preliminar
        </p>
      )}

      {sinSnapshot ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Esta semana no tiene una estimación generada todavía.
        </Card>
      ) : (
        <>
          <TablaEstimacion partidas={partidas} />

          {congelado ? (
            <>
              <TablaGastosEstimacion gastos={congelado.gastos} />
              <ResumenEstimacionOperativa
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
            // Semana abierta: avance + gastos cobrables que entrarían al
            // cerrar (mismos criterios que el cierre; solo lectura).
            <>
              <TablaGastosEstimacion gastos={preliminar.gastos} />
              <ResumenEstimacionOperativa
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

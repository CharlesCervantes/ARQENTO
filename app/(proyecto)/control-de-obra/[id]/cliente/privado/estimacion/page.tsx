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
import { DetalleExterna } from "@/components/control-de-obra/estimaciones-externas";
import { obtenerDetalleEstimacionExterna } from "@/lib/server/control-de-obra/estimaciones-externas";
import { EstimadoPrivadoSemana } from "@/components/control-de-obra/estimado-privado-semana";
import {
  obtenerEstimadosPrivadosSemana,
  listarConceptosParaEstimadoPrivado,
} from "@/lib/server/control-de-obra/estimado-privado";
import { puedeCapturarEstimadoPrivado } from "@/lib/server/permisos";
import { etiquetaCargo, tasasDeTrabajos } from "@/lib/control-de-obra/presentacion-estimacion-privada";

// Semana abierta y cerrada usan la misma fila de capa, en importes base (sin
// administración ni IVA). Sus cantidades pueden diferir del avance físico
// (cantidad estimada privada) y un importe histórico fijo no se recalcula.
function aFilaTablaCapa(f: FilaEstimacionCapa): FilaTablaEstimacion {
  return {
    conceptoId: f.conceptoId,
    descripcionConcepto: f.descripcionConcepto,
    unidad: f.unidad,
    cantidadContratada: f.cantidadContratada,
    precioUnitario: f.precioUnitarioBase,
    importeContratado: f.importeContratadoBase,
    cantidadAnterior: f.cantidadAnterior,
    cantidadEstaSemana: f.cantidadEstaSemana,
    cantidadAcumulada: f.cantidadAcumulada,
    importeEstaSemana: f.importeEstaSemanaBase,
    importeAcumulado: f.importeAcumuladoBase,
    cantidadPorEjercer: f.cantidadPorEjercer,
    importePorEjercer: f.importePorEjercerBase,
    avancePorcentaje: f.avancePorcentaje,
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
    : agruparPorPartida(enVivoCandidato.capas.PRIVADO).map((p) => ({
        partidaNombre: p.partidaNombre,
        conceptos: p.conceptos.map(aFilaTablaCapa),
      }));

  // Captura privada independiente: semana no histórica y capa privada sin emitir.
  const capturaPrivada =
    puedeCapturarEstimadoPrivado(usuario) && !resumenCierre.historicoImportado
      ? await Promise.all([
          obtenerEstimadosPrivadosSemana(usuario, id, semana.id),
          listarConceptosParaEstimadoPrivado(usuario, id),
        ])
      : null;
  const capturaEditable =
    !!capturaPrivada && (semanaCerrada ? congelado?.estimacion.estatus === "BORRADOR" : true);

  const esquemaContractual = congelado?.estimacion.esquemaContractualUsado ?? proyecto.esquemaContractual;

  const externa = resumenCierre.historicoImportado
    ? await obtenerDetalleEstimacionExterna(usuario, id, semana.id, "privado")
    : null;

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

      {resumenCierre.motivoBloqueo && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          El cierre de semanas y las estimaciones de esta obra están bloqueados: {resumenCierre.motivoBloqueo}
        </p>
      )}

      {sinSnapshot && externa ? (
        <DetalleExterna
          detalle={externa}
          porcentajeAdministracion={Number(proyecto.porcentajeAdministracionPrivadoDefault ?? proyecto.porcentajeAdministracionDefault ?? 0)}
          hrefControl={`/control-de-obra/${id}/cliente/privado/control-contractual`}
        />
      ) : sinSnapshot ? (
        resumenCierre.historicoImportado ? (
          <Card className="p-6 text-sm text-[var(--muted)]">
            Semana histórica migrada desde Excel: su estimación se emitió fuera de ARQENTO.
          </Card>
        ) : puedeMaterializarEstimacionHistorica(usuario) && !resumenCierre.motivoBloqueo ? (
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
            ocultarAnterior
            nota={`Importes sin ${etiquetaCargo(esquemaContractual).toLowerCase()} y sin IVA.`}
          />

          {congelado ? (
            <>
              <TablaGastosEstimacion gastos={congelado.gastos} />
              <ResumenEstimacionPrivada
                esquemaContractual={esquemaContractual}
                subtotalTrabajos={congelado.estimacion.subtotal}
                gastosCobrables={congelado.estimacion.subtotalGastosCobrables}
                administracionTrabajos={congelado.estimacion.montoAdministracionTrabajos}
                tasasTrabajos={tasasDeTrabajos(congelado.filas)}
                administracionGastos={congelado.estimacion.montoAdministracionGastos}
                porcentajeAdministracionGastos={congelado.estimacion.porcentajeAdministracionGastos}
                aplicaIVA={congelado.estimacion.aplicaIVA}
                porcentajeIVA={congelado.estimacion.porcentajeIVA}
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
                puedeEmitir={puedeEmitirEstimacionCliente(usuario) && !resumenCierre.motivoBloqueo}
                fondoDisponible={fondoDisponible}
              />
            </>
          ) : (
            <>
              <TablaGastosEstimacion gastos={preliminar.gastos} />
              <ResumenEstimacionPrivada
                esquemaContractual={esquemaContractual}
                subtotalTrabajos={preliminar.totales.subtotal}
                gastosCobrables={preliminar.totales.subtotalGastosCobrables}
                administracionTrabajos={preliminar.totales.montoAdministracionTrabajos}
                tasasTrabajos={tasasDeTrabajos(enVivoCandidato.capas.PRIVADO)}
                administracionGastos={preliminar.totales.montoAdministracionGastos}
                porcentajeAdministracionGastos={preliminar.totales.porcentajeAdministracionGastos}
                aplicaIVA={preliminar.aplicaIVA}
                porcentajeIVA={preliminar.porcentajeIVA}
                montoIVA={preliminar.totales.montoIVA}
                total={preliminar.totales.total}
              />
            </>
          )}
        </>
      )}

      {capturaPrivada && (capturaEditable || capturaPrivada[0].length > 0) && (
        <EstimadoPrivadoSemana
          proyectoId={id}
          semanaId={semana.id}
          conceptos={capturaPrivada[1]}
          estimados={capturaPrivada[0]}
          editable={capturaEditable}
        />
      )}
    </div>
  );
}

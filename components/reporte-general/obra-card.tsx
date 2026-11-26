import { Card } from "@/components/ui/card";
import { Table, Thead, Tr, Th, Td } from "@/components/ui/table";
import { EstadoPagoBadge } from "./estado-pago-badge";
import { BotonLiquidar } from "./boton-liquidar";
import { CeldaRecibo } from "./celda-recibo";
import { GRID_PROYECTOS } from "./grid-proyectos";
import { cn } from "@/lib/cn";
import { formatMoney, formatMoneyOrDash } from "@/lib/dinero";
import { calcularEstadoProyecto } from "@/lib/reporte-general/estado";
import type {
  ConceptoContratadoFila,
  ReporteObra,
  ResumenReposicionFila,
} from "@/lib/server/reporte-general/queries";
import type { EstatusPago } from "@/lib/generated/prisma/enums";

function formatFechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Celda de Estado compartida por las 3 secciones (Contratistas/Proveedores/
// Administración) — un movimiento LIQUIDADO muestra su fecha discreta debajo
// del badge; uno PENDIENTE_PAGO ofrece "Liquidar" solo si el usuario tiene
// permiso, sin llenar la tabla de botones para el resto de los estados.
// R2: una reposición con abonos parciales muestra, discreto, lo abonado y el
// saldo (lo que realmente se liquidará); una con inconsistencias históricas
// (clase B) muestra "Revisar abonos" en lugar de "Liquidar". El importe de la
// fila y los totales no cambian.
function CeldaEstado({
  fila,
  puedeLiquidar,
}: {
  fila: {
    estatusPago: EstatusPago | null;
    fechaPago: string | null;
    movimientoId: string | null;
    reposicion: ResumenReposicionFila | null;
  };
  puedeLiquidar: boolean;
}) {
  const reposicion = fila.reposicion;
  const requiereRevision = reposicion?.requiereRevision ?? false;
  const conAbonosParciales =
    fila.estatusPago === "PENDIENTE_PAGO" &&
    reposicion !== null &&
    !requiereRevision &&
    reposicion.abonado > 0 &&
    reposicion.saldoPendiente > 0;
  return (
    <div>
      <EstadoPagoBadge estatus={fila.estatusPago} />
      {fila.estatusPago === "LIQUIDADO" && fila.fechaPago && (
        <p className="mt-0.5 text-[11px] text-[var(--muted)]">
          {formatFechaCorta(fila.fechaPago)}
        </p>
      )}
      {conAbonosParciales && (
        <p className="mt-0.5 text-[11px] text-[var(--muted)]">
          Abonado {formatMoney(reposicion.abonado)} · Saldo {formatMoney(reposicion.saldoPendiente)}
        </p>
      )}
      {requiereRevision && (
        <p
          className="mt-0.5 text-[11px] font-medium text-amber-700"
          title="Los abonos, el cierre o el importe de esta reposición no coinciden. Revísala en Reposiciones antes de liquidar."
        >
          Revisar abonos
        </p>
      )}
      {fila.estatusPago === "PENDIENTE_PAGO" && puedeLiquidar && fila.movimientoId && !requiereRevision && (
        <BotonLiquidar movimientoId={fila.movimientoId} reposicion={reposicion} />
      )}
    </div>
  );
}

const TIPO_LABEL: Record<string, string> = {
  FORMAL: "Obra",
  MOMENTANEA: "Obra momentánea",
  OFICINA: "Oficina",
};

// Solo se muestra cuando el origen NO es el corte de contratista de siempre
// — la fila normal (95%+ de los casos) no cambia visualmente en nada; esto
// solo aparece cuando un beneficiario tiene más de un movimiento la misma
// semana (p. ej. corte + reposición de gastos).
const ORIGEN_LABEL: Record<string, string> = {
  REPOSICION_GASTOS: "Reposición",
  ORDEN_COMPRA: "Orden de compra",
  MANUAL: "Manual",
};

function EtiquetaOrigen({ origen }: { origen: string | null }) {
  if (!origen || origen === "CORTE_CONTRATISTA") return null;
  return (
    <span className="ml-1.5 rounded-full bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted)]">
      {ORIGEN_LABEL[origen] ?? origen}
    </span>
  );
}

// «Ver concepto»: mismo estilo que el desglose de Contrato vigente. Muestra
// los conceptos del contrato del contratista en esta obra; un beneficiario
// antiguo sin contrato por conceptos muestra su texto de concepto.
function VerConcepto({
  conceptos,
  conceptoLegado,
}: {
  conceptos: ConceptoContratadoFila[];
  conceptoLegado: string | null;
}) {
  if (conceptos.length === 0 && !conceptoLegado) {
    return <span className="text-[var(--muted)]">—</span>;
  }
  return (
    <details className="relative inline-block text-left">
      <summary className="cursor-pointer list-none underline decoration-dotted underline-offset-4 [&::-webkit-details-marker]:hidden">
        Ver concepto
      </summary>
      <div className="absolute left-0 z-20 mt-1.5 max-h-72 w-80 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.16)]">
        {conceptos.length === 0 ? (
          <p className="whitespace-normal text-[var(--foreground)]">{conceptoLegado}</p>
        ) : (
          <ul className="space-y-2">
            {conceptos.map((c, i) => (
              <li key={i} className="whitespace-normal">
                <p className="text-[var(--foreground)]">{c.descripcion}</p>
                <p className="mt-0.5 flex justify-between gap-4 tabular-nums text-[var(--muted)]">
                  <span>
                    {c.cantidad.toLocaleString("es-MX", { maximumFractionDigits: 3 })} {c.unidad}
                  </span>
                  <span>{formatMoney(c.importe)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function ObraCard({
  obra,
  index,
  puedeLiquidar,
  puedeVerRecibos,
}: {
  obra: ReporteObra;
  index: number;
  puedeLiquidar: boolean;
  puedeVerRecibos: boolean;
}) {
  const sinParticipantes =
    obra.contratistas.length === 0 &&
    obra.proveedores.length === 0 &&
    obra.administracion.length === 0;
  const estadoProyecto = calcularEstadoProyecto(obra);

  return (
    <Card
      className="enter overflow-hidden"
      style={{ transitionDelay: `${Math.min(index, 6) * 30}ms` }}
    >
      <details className="group">
        <summary
          className={cn(
            GRID_PROYECTOS,
            "cursor-pointer list-none px-5 py-3.5 select-none [&::-webkit-details-marker]:hidden"
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <svg
              viewBox="0 0 20 20"
              className="h-3.5 w-3.5 shrink-0 text-[var(--muted)] transition-transform duration-200 ease-out group-open:rotate-90"
              fill="currentColor"
            >
              <path d="M7 4l6 6-6 6V4z" />
            </svg>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-[var(--foreground)]">
                {obra.proyecto.nombre}
              </h3>
              <p className="truncate text-xs text-[var(--muted)]">
                {TIPO_LABEL[obra.proyecto.tipo] ?? obra.proyecto.tipo}
                {obra.proyecto.estatus === "PAUSADO" && " · Pausada"}
              </p>
            </div>
          </div>
          <span className="text-right text-sm tabular-nums text-[var(--foreground)]">
            {formatMoneyOrDash(obra.totalFinSemana)}
          </span>
          <span className="text-right text-base font-semibold tabular-nums text-[var(--foreground)]">
            {formatMoney(obra.totalSemana)}
          </span>
          <span
            className={cn(
              "text-right text-sm tabular-nums",
              obra.pendienteSemana > 0
                ? "font-medium text-red-700"
                : "text-[var(--muted)]"
            )}
          >
            {formatMoneyOrDash(obra.pendienteSemana)}
          </span>
          <span className="flex justify-end">
            <EstadoPagoBadge estatus={estadoProyecto} />
          </span>
        </summary>

        <div className="border-t border-[var(--border)] px-5 py-4">
          {sinParticipantes ? (
            <p className="py-2 text-sm text-[var(--muted)]">
              Todavía no hay contratistas, proveedores ni personal asignado a
              esta obra.
            </p>
          ) : (
            <div className="space-y-5">
              {obra.contratistas.length > 0 && (
                <Seccion titulo="Contratistas">
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Contratista</Th>
                        <Th>Concepto</Th>
                        <Th className="text-right">Contrato vigente</Th>
                        <Th className="text-right">Pagado acumulado</Th>
                        <Th className="text-right">Saldo</Th>
                        <Th className="text-right">Fin de semana</Th>
                        <Th>Recibo</Th>
                        <Th>Estado</Th>
                      </Tr>
                    </Thead>
                    <tbody>
                      {obra.contratistas.map((fila) => (
                        <Tr key={fila.movimientoId ?? fila.id}>
                          <Td className="font-medium">
                            {fila.nombre}
                            <EtiquetaOrigen origen={fila.origen} />
                          </Td>
                          <Td>
                            <VerConcepto conceptos={fila.conceptos} conceptoLegado={fila.concepto} />
                          </Td>
                          <Td className="text-right tabular-nums">
                            <details className="group/vigente relative inline-block text-left">
                              <summary className="cursor-pointer list-none underline decoration-dotted underline-offset-4 [&::-webkit-details-marker]:hidden">
                                {formatMoney(fila.montoContractualVigente)}
                              </summary>
                              <div className="absolute right-0 z-20 mt-1.5 w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.16)]">
                                <div className="flex items-center justify-between gap-4 text-[var(--muted)]">
                                  <span>Contrato base</span>
                                  <span className="tabular-nums text-[var(--foreground)]">
                                    {formatMoney(fila.montoContrato)}
                                  </span>
                                </div>
                                <div className="mt-1.5 flex items-center justify-between gap-4 text-[var(--muted)]">
                                  <span>Aditivas autorizadas</span>
                                  <span className="tabular-nums text-[var(--foreground)]">
                                    {formatMoneyOrDash(fila.aditivasAutorizadas)}
                                  </span>
                                </div>
                                <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-1.5 font-semibold text-[var(--foreground)]">
                                  <span>Total vigente</span>
                                  <span className="tabular-nums">
                                    {formatMoney(fila.montoContractualVigente)}
                                  </span>
                                </div>
                              </div>
                            </details>
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatMoneyOrDash(fila.pagadoHistorico)}
                          </Td>
                          <Td className="text-right font-medium tabular-nums">
                            {formatMoney(fila.saldo)}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatMoneyOrDash(fila.montoFinSemana)}
                          </Td>
                          <Td>
                            <CeldaRecibo
                              proyectoId={obra.proyecto.id}
                              corteId={fila.corteId}
                              reciboId={fila.reciboId}
                              reciboFirmado={fila.reciboFirmado}
                              puedeVerRecibos={puedeVerRecibos}
                            />
                          </Td>
                          <Td>
                            <CeldaEstado fila={fila} puedeLiquidar={puedeLiquidar} />
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </Seccion>
              )}

              {obra.proveedores.length > 0 && (
                <Seccion titulo="Proveedores y servicios">
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Proveedor</Th>
                        <Th>Giro</Th>
                        <Th className="text-right">Fin de semana</Th>
                        <Th>Estado</Th>
                      </Tr>
                    </Thead>
                    <tbody>
                      {obra.proveedores.map((fila) => (
                        <Tr key={fila.movimientoId ?? fila.id}>
                          <Td className="font-medium">
                            {fila.nombre}
                            <EtiquetaOrigen origen={fila.origen} />
                          </Td>
                          <Td className="text-[var(--muted)]">
                            {fila.giro ?? "—"}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatMoneyOrDash(fila.montoFinSemana)}
                          </Td>
                          <Td>
                            <CeldaEstado fila={fila} puedeLiquidar={puedeLiquidar} />
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </Seccion>
              )}

              {obra.administracion.length > 0 && (
                <Seccion titulo="Administración">
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Persona</Th>
                        <Th>Puesto</Th>
                        <Th className="text-right">Fin de semana</Th>
                        <Th>Estado</Th>
                      </Tr>
                    </Thead>
                    <tbody>
                      {obra.administracion.map((fila) => (
                        <Tr key={fila.movimientoId ?? fila.id}>
                          <Td className="font-medium">
                            {fila.nombre}
                            <EtiquetaOrigen origen={fila.origen} />
                          </Td>
                          <Td className="text-[var(--muted)]">
                            {fila.puesto ?? "—"}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatMoneyOrDash(fila.montoFinSemana)}
                          </Td>
                          <Td>
                            <CeldaEstado fila={fila} puedeLiquidar={puedeLiquidar} />
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </Seccion>
              )}
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}

function Seccion({
  titulo,
  children,
}: {
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {titulo}
      </h4>
      {children}
    </div>
  );
}

import { ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tr, Th, Td } from "@/components/ui/table";
import { FormNuevoContrato } from "./form-nuevo-contrato";
import { FormAsignarConcepto } from "./form-asignar-concepto";
import { BarraAvance } from "./barra-avance";
import { ResumenFinancieroIndicadores } from "./expediente-financiero-contratista";
import { ContratistaTabs } from "./contratista-tabs";
import { formatMoney } from "@/lib/dinero";
import type {
  obtenerContratistasProyecto,
  listarContratistasDisponibles,
} from "@/lib/server/control-de-obra/estructura-contractual";
import type { AvanceContratista } from "@/lib/server/control-de-obra/avance";
import type {
  ResumenFinancieroContratista,
  CorteHistorial,
} from "@/lib/server/control-de-obra/recibos";

type Datos = Awaited<ReturnType<typeof obtenerContratistasProyecto>>;
type ContratistasDisponibles = Awaited<ReturnType<typeof listarContratistasDisponibles>>;
type ContratoRow = Datos["contratos"][number];

// Un contratista puede tener más de un ContratoContratista en la misma obra
// (el schema ya lo permite) — el resumen financiero y el historial son por
// contratista (beneficiarioProyecto), no por contrato individual, así que se
// agrupan aquí antes de renderizar. En el caso común (un solo contrato por
// contratista) esto no cambia nada visualmente respecto a antes.
function agruparPorBeneficiario(contratos: ContratoRow[]) {
  const grupos = new Map<string, { beneficiarioProyectoId: string; nombre: string; contratos: ContratoRow[] }>();
  for (const contrato of contratos) {
    const id = contrato.beneficiarioProyecto.id;
    const grupo = grupos.get(id) ?? {
      beneficiarioProyectoId: id,
      nombre: contrato.beneficiarioProyecto.beneficiario.nombre,
      contratos: [],
    };
    grupo.contratos.push(contrato);
    grupos.set(id, grupo);
  }
  return [...grupos.values()];
}

// Un <option> nativo no es un elemento de bloque: los saltos de línea que
// ahora admite la Descripción de un concepto (Contrato General, septiembre
// 2026) no se envuelven ahí, se muestran literales y desbordan el ancho del
// <select> (se veía como un cuadro negro gigante en Contratistas → Asignar
// concepto). Se aplana a una sola línea y se acorta solo para esta etiqueta
// — nunca se toca concepto.descripcion en sí.
function etiquetaOpcion(descripcion: string, unidad: string): string {
  const plano = descripcion.replace(/\s+/g, " ").trim();
  const acortado = plano.length > 100 ? `${plano.slice(0, 100)}…` : plano;
  return `${acortado} (${unidad})`;
}

export function ContratistasView({
  proyectoId,
  partidas,
  contratos,
  contratistasDisponibles,
  avancePorConcepto,
  puedeAdministrar,
  puedeVerRecibosFinancieros,
  resumenFinancieroPorBeneficiario,
  historialPorBeneficiario,
}: {
  proyectoId: string;
  partidas: Datos["partidas"];
  contratos: Datos["contratos"];
  contratistasDisponibles: ContratistasDisponibles;
  avancePorConcepto: Map<string, AvanceContratista>;
  puedeAdministrar: boolean;
  puedeVerRecibosFinancieros: boolean;
  resumenFinancieroPorBeneficiario: Map<string, ResumenFinancieroContratista>;
  historialPorBeneficiario: Map<string, CorteHistorial[]>;
}) {
  // Un concepto solo puede pertenecer a un contratista (la base de datos ya
  // lo impone con un único índice sobre conceptoId — sección 49.9). Este set
  // es solo para filtrar el selector de "Asignar concepto" a lo disponible;
  // no hace falta ninguna otra consulta, `contratos` ya trae todo.
  const conceptoIdsAsignados = new Set(
    contratos.flatMap((contrato) => contrato.conceptos.map((c) => c.conceptoId))
  );

  // Reutiliza los conceptos ya creados en Contrato General — no se duplican
  // aquí, solo se relacionan con un contratista. Cantidad y P.U. se heredan
  // del Contrato General al asignar, ya no se vuelven a pedir aquí. Agrupados
  // por partida (optgroup) para que quede claro que lo seleccionable es el
  // concepto, no la partida.
  const conceptosPorPartida = partidas
    .map((partida) => ({
      partidaNombre: partida.nombre,
      conceptos: partida.conceptos
        .filter((concepto) => !conceptoIdsAsignados.has(concepto.id))
        .map((concepto) => ({
          id: concepto.id,
          etiqueta: etiquetaOpcion(concepto.descripcion, concepto.unidad),
        })),
    }))
    .filter((grupo) => grupo.conceptos.length > 0);
  const hayConceptosDisponibles = conceptosPorPartida.length > 0;

  const grupos = agruparPorBeneficiario(contratos);

  return (
    <div className="space-y-3">
      {contratos.length === 0 && (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay contratistas asignados a este proyecto.
        </Card>
      )}

      {grupos.map((grupo, i) => {
        const resumen = resumenFinancieroPorBeneficiario.get(grupo.beneficiarioProyectoId);
        const historial = historialPorBeneficiario.get(grupo.beneficiarioProyectoId) ?? [];
        const unSoloContrato = grupo.contratos.length === 1;
        const primerContrato = grupo.contratos[0];
        const etiquetaContrato = (contrato: ContratoRow) =>
          [contrato.numeroContrato, contrato.descripcion].filter(Boolean).join(" — ");

        // "Contrato vigente" vive en un solo lugar: dentro del resumen
        // financiero cuando es visible (Administrador/Director/Master). Un
        // Supervisor no ve ese resumen, así que para él se muestra aquí en
        // el encabezado — nunca en los dos lados a la vez.
        const montoContratoTotal = grupo.contratos.reduce(
          (total, contrato) =>
            total +
            contrato.conceptos.reduce(
              (t, c) => t + Number(c.cantidad) * Number(c.precioUnitarioContratista),
              0
            ),
          0
        );

        return (
          <Card
            key={grupo.beneficiarioProyectoId}
            className="enter overflow-hidden"
            style={{ transitionDelay: `${Math.min(i, 6) * 40}ms` }}
          >
            {/* Cerrado por default (sin `open`) — el usuario decide qué
                contratistas abrir, cada tarjeta es independiente y nada de
                esto se persiste (decisión de sesión, agosto 2026). */}
            <details className="group">
              <summary className="cursor-pointer list-none px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-base font-semibold text-[var(--foreground)]">
                      {grupo.nombre}
                    </h3>
                    {unSoloContrato && etiquetaContrato(primerContrato) && (
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {etiquetaContrato(primerContrato)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    {!puedeVerRecibosFinancieros && (
                      <div className="text-right">
                        <p className="text-[11px] font-medium tracking-wide text-[var(--muted)] uppercase">
                          Contrato vigente
                        </p>
                        <p className="text-sm font-semibold tabular-nums text-[var(--foreground)]">
                          {formatMoney(montoContratoTotal)}
                        </p>
                      </div>
                    )}
                    <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted)] transition-transform duration-150 ease-out group-open:rotate-180" />
                  </div>
                </div>

                {puedeVerRecibosFinancieros && resumen && (
                  <div className="mt-4 border-t border-[var(--border)] pt-4">
                    <ResumenFinancieroIndicadores resumen={resumen} />
                  </div>
                )}
              </summary>

              <div className="border-t border-[var(--border)] px-5 pt-4 pb-5">
                <ContratistaTabs
                  proyectoId={proyectoId}
                  puedeVerRecibosFinancieros={puedeVerRecibosFinancieros}
                  historial={historial}
                  contratoBody={
                    <div className="space-y-4">
                      <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
                        Conceptos asignados
                      </p>
                      {grupo.contratos.map((contrato) => (
                        <div key={contrato.id}>
                          {!unSoloContrato && etiquetaContrato(contrato) && (
                            <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                              {etiquetaContrato(contrato)}
                            </p>
                          )}
                          {contrato.conceptos.length > 0 ? (
                            <Table>
                              <Thead>
                                <Tr>
                                  <Th>Concepto</Th>
                                  <Th>Unidad</Th>
                                  <Th className="text-right">Cantidad asignada</Th>
                                  <Th className="text-right">P.U. contratista</Th>
                                  <Th className="text-right">Importe</Th>
                                  <Th className="text-right">Ejecutado</Th>
                                  <Th className="text-right">Pendiente</Th>
                                  <Th className="text-right">Avance</Th>
                                </Tr>
                              </Thead>
                              <tbody>
                                {contrato.conceptos.map((asignacion) => {
                                  const avance = avancePorConcepto.get(asignacion.conceptoId);

                                  return (
                                    <Tr key={asignacion.id}>
                                      <Td className="align-top font-medium whitespace-pre-line">{asignacion.concepto.descripcion}</Td>
                                      <Td className="text-[var(--muted)]">{asignacion.concepto.unidad}</Td>
                                      <Td className="text-right tabular-nums">
                                        {Number(asignacion.cantidad).toLocaleString("es-MX")}
                                      </Td>
                                      <Td className="text-right tabular-nums">
                                        {formatMoney(asignacion.precioUnitarioContratista)}
                                      </Td>
                                      <Td className="text-right tabular-nums">
                                        {formatMoney(
                                          Number(asignacion.cantidad) *
                                            Number(asignacion.precioUnitarioContratista)
                                        )}
                                      </Td>
                                      {!avance ? (
                                        <Td colSpan={3} className="text-xs text-[var(--muted)]">
                                          —
                                        </Td>
                                      ) : (
                                        <>
                                          <Td className="text-right tabular-nums">
                                            {avance.acumulado.toLocaleString("es-MX")}
                                            {avance.historicoSinAtribuir > 0 && (
                                              <span className="block text-[11px] text-[var(--muted)]">
                                                + {avance.historicoSinAtribuir.toLocaleString("es-MX")} histórico sin atribuir
                                              </span>
                                            )}
                                          </Td>
                                          <Td className="text-right tabular-nums">
                                            {avance.pendiente.toLocaleString("es-MX")}
                                          </Td>
                                          <Td>
                                            <BarraAvance porcentaje={avance.avancePorcentaje} />
                                          </Td>
                                        </>
                                      )}
                                    </Tr>
                                  );
                                })}
                              </tbody>
                            </Table>
                          ) : (
                            <p className="text-sm text-[var(--muted)]">
                              Este contrato todavía no tiene conceptos asignados.
                            </p>
                          )}

                          {puedeAdministrar && hayConceptosDisponibles && (
                            <details className="mt-3">
                              <summary className="inline-flex w-fit cursor-pointer list-none items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium text-[var(--foreground)] transition-colors duration-150 ease-out select-none hover:bg-black/[0.03] [&::-webkit-details-marker]:hidden">
                                + Asignar concepto
                              </summary>
                              <div className="mt-3">
                                <FormAsignarConcepto
                                  contratoId={contrato.id}
                                  proyectoId={proyectoId}
                                  conceptosPorPartida={conceptosPorPartida}
                                />
                              </div>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  }
                />
              </div>
            </details>
          </Card>
        );
      })}

      {puedeAdministrar && (
        <details>
          <summary className="inline-flex w-fit cursor-pointer list-none items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] transition-colors duration-150 ease-out select-none hover:bg-black/[0.03] [&::-webkit-details-marker]:hidden">
            + Agregar contratista
          </summary>
          <Card className="enter mt-3 p-4">
            <FormNuevoContrato proyectoId={proyectoId} contratistas={contratistasDisponibles} />
          </Card>
        </details>
      )}
    </div>
  );
}

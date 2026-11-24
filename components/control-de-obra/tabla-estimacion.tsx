import { Card } from "@/components/ui/card";
import { Table, Thead, Tr, Th, Td } from "@/components/ui/table";
import { BarraAvance } from "@/components/control-de-obra/barra-avance";
import { formatMoney, formatMoneyOrDash } from "@/lib/dinero";

// Fila normalizada, ya elegida a la capa correspondiente (operativo o
// privado) por quien llama — este componente no sabe ni le importa de qué
// capa vienen los números, solo los pinta. Así se reutiliza tal cual para
// Cliente y Cliente Priv. sin duplicar la tabla (sección 6/8 del diseño de
// Cliente, agosto 2026).
export type FilaTablaEstimacion = {
  conceptoId: string;
  descripcionConcepto: string;
  unidad: string;
  cantidadContratada: number;
  precioUnitario: number;
  importeContratado: number;
  cantidadAnterior: number;
  cantidadEstaSemana: number;
  cantidadAcumulada: number;
  importeEstaSemana: number;
  importeAcumulado: number;
  cantidadPorEjercer: number;
  importePorEjercer: number;
  avancePorcentaje: number;
};

function formatCantidad(n: number): string {
  return n.toLocaleString("es-MX", { maximumFractionDigits: 3 });
}

// Rediseño de lectura horizontal (Contratado → Anterior → Esta semana →
// Acumulado → Avance) — de 10 columnas agrupadas por encabezados a 6
// columnas, cada una con su propia jerarquía tipográfica interna en vez de
// subcolumnas separadas (agosto 2026). Cliente Priv. oculta Anterior (el
// Acumulado ya lo incluye) y declara con `nota` la base de sus importes.
export function TablaEstimacion({
  partidas,
  ocultarAnterior = false,
  nota,
}: {
  partidas: { partidaNombre: string; conceptos: FilaTablaEstimacion[] }[];
  ocultarAnterior?: boolean;
  nota?: string;
}) {
  if (partidas.length === 0) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Ningún concepto tuvo avance registrado en esta semana.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {nota && <p className="text-xs text-[var(--muted)]">{nota}</p>}
      {partidas.map((partida) => {
        const subtotalContratado = partida.conceptos.reduce((t, c) => t + c.importeContratado, 0);
        const subtotalEstaSemana = partida.conceptos.reduce((t, c) => t + c.importeEstaSemana, 0);
        const subtotalAcumulado = partida.conceptos.reduce((t, c) => t + c.importeAcumulado, 0);
        const subtotalPorEjercer = partida.conceptos.reduce((t, c) => t + c.importePorEjercer, 0);

        return (
          <Card key={partida.partidaNombre} className="enter overflow-hidden">
            <details open>
              <summary className="group flex cursor-pointer list-none items-center justify-between px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-semibold text-[var(--foreground)]">
                  {partida.partidaNombre}
                </span>
                <span className="flex items-center gap-4 text-xs text-[var(--muted)]">
                  <span>
                    Esta semana{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {formatMoney(subtotalEstaSemana)}
                    </span>
                  </span>
                  <span>
                    Acumulado{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {formatMoney(subtotalAcumulado)}
                    </span>
                  </span>
                </span>
              </summary>

              <div className="border-t border-[var(--border)]">
                <Table>
                  <Thead>
                    <Tr>
                      <Th className={ocultarAnterior ? "w-[35%]" : "w-[26%]"}>Concepto</Th>
                      <Th className="w-[17%] text-right">Contratado</Th>
                      {!ocultarAnterior && <Th className="w-[12%] text-right">Anterior</Th>}
                      <Th className="w-[17%] text-right">Esta semana</Th>
                      <Th className="w-[17%] text-right">Acumulado</Th>
                      <Th className={`text-right ${ocultarAnterior ? "w-[14%]" : "w-[11%]"}`}>Avance</Th>
                    </Tr>
                  </Thead>
                  <tbody>
                    {partida.conceptos.map((c) => (
                      <Tr key={c.conceptoId}>
                        <Td>
                          <p className="text-[var(--foreground)]">{c.descripcionConcepto}</p>
                          <p className="mt-0.5 text-xs text-[var(--muted)]">{c.unidad}</p>
                        </Td>
                        <Td className="text-right">
                          <p className="font-medium tabular-nums text-[var(--foreground)]">
                            {formatCantidad(c.cantidadContratada)} {c.unidad}
                          </p>
                          <p className="text-xs tabular-nums text-[var(--muted)]">
                            P.U. {formatMoneyOrDash(c.precioUnitario)}
                          </p>
                          <p className="text-xs tabular-nums text-[var(--muted)]">
                            {formatMoneyOrDash(c.importeContratado)}
                          </p>
                        </Td>
                        {!ocultarAnterior && (
                          <Td className="text-right">
                            <p className="tabular-nums text-[var(--muted)]">
                              {formatCantidad(c.cantidadAnterior)} {c.unidad}
                            </p>
                          </Td>
                        )}
                        <Td className="text-right">
                          <p className="font-medium tabular-nums text-[var(--foreground)]">
                            {formatCantidad(c.cantidadEstaSemana)} {c.unidad}
                          </p>
                          <p className="text-xs tabular-nums text-[var(--muted)]">
                            {formatMoneyOrDash(c.importeEstaSemana)}
                          </p>
                        </Td>
                        <Td className="text-right">
                          <p className="font-medium tabular-nums text-[var(--foreground)]">
                            {formatCantidad(c.cantidadAcumulada)} / {formatCantidad(c.cantidadContratada)}{" "}
                            {c.unidad}
                          </p>
                          <p className="text-xs tabular-nums text-[var(--muted)]">
                            {formatMoneyOrDash(c.importeAcumulado)}
                          </p>
                        </Td>
                        <Td>
                          <BarraAvance porcentaje={c.avancePorcentaje} />
                          <p className="mt-1 text-right text-xs text-[var(--muted)]">
                            Saldo: {formatMoney(c.importePorEjercer)}
                          </p>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <Tr className="border-b-0 bg-black/[0.015] font-semibold text-[var(--foreground)]">
                      <Td className="text-xs">Subtotal de partida</Td>
                      <Td className="text-right text-xs tabular-nums">
                        {formatMoneyOrDash(subtotalContratado)}
                      </Td>
                      {!ocultarAnterior && <Td />}
                      <Td className="text-right text-xs tabular-nums">
                        {formatMoneyOrDash(subtotalEstaSemana)}
                      </Td>
                      <Td className="text-right text-xs tabular-nums">
                        {formatMoneyOrDash(subtotalAcumulado)}
                      </Td>
                      <Td className="text-right text-xs tabular-nums">
                        Saldo: {formatMoneyOrDash(subtotalPorEjercer)}
                      </Td>
                    </Tr>
                  </tfoot>
                </Table>
              </div>
            </details>
          </Card>
        );
      })}
    </div>
  );
}

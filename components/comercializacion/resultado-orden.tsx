import { Card } from "@/components/ui/card";
import { formatearCantidad, formatearImporte } from "@/lib/comercializacion/importes";
import type { ResultadoEstimado } from "@/lib/comercializacion/resultado";

// Bloque «Resultado estimado» de la OV (B7) — SOLO administración: la página
// no lo calcula para el vendedor. Importes sin IVA; nunca usa cobros ni pagos.

function Fila({ etiqueta, valor, signo, fuerte }: { etiqueta: string; valor: string; signo?: "−"; fuerte?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 text-sm ${fuerte ? "border-t border-[var(--border)] pt-2.5 font-semibold" : ""}`}>
      <dt className={fuerte ? "" : "text-[var(--muted)]"}>{etiqueta}</dt>
      <dd className="tabular-nums">
        {signo ? `${signo} ` : ""}
        {formatearImporte(valor)}
      </dd>
    </div>
  );
}

export function ResultadoOrdenView({ resultado: r }: { resultado: ResultadoEstimado }) {
  const incompleto = r.estado === "INCOMPLETO";
  return (
    <Card id="resultado" className="scroll-mt-6 space-y-3 p-5" data-estado-resultado={r.estado}>
      <div>
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Resultado estimado</h2>
        <p className="text-sm text-[var(--muted)]">Sin IVA: venta − compras confirmadas − gastos vigentes. No usa cobros ni pagos; no es utilidad fiscal ni dinero disponible.</p>
      </div>

      <dl className="max-w-md">
        <Fila etiqueta="Venta sin IVA" valor={r.venta} />
        <Fila etiqueta="Compras confirmadas sin IVA" valor={r.compras} signo="−" />
        <Fila etiqueta="Gastos adicionales sin IVA" valor={r.gastos} signo="−" />
        {incompleto ? (
          <Fila etiqueta="Costos conocidos" valor={r.costosConocidos} fuerte />
        ) : (
          <Fila etiqueta={r.estado === "PERDIDA" ? "Pérdida estimada" : "Resultado estimado"} valor={r.resultado!} fuerte />
        )}
      </dl>

      {incompleto ? (
        <div role="status" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          <p className="font-medium">Resultado incompleto: faltan compras por registrar.</p>
          {r.faltantes.length > 0 ? (
            <ul className="list-disc pl-5 text-xs">
              {r.faltantes.map((f) => (
                <li key={f.codigo}>
                  {f.codigo} {f.descripcion}: faltan {formatearCantidad(f.falta)} {f.unidad} (vendido {formatearCantidad(f.vendido)}, comprado{" "}
                  {formatearCantidad(f.comprado)})
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs">La orden no tiene materiales.</p>
          )}
          <p className="text-xs">Lo que falta comprar no se toma como costo cero: no se muestra una cifra final ni la simulación de reparto.</p>
          {r.ordenCancelada && (
            <p className="text-xs font-medium" data-simulacion-cancelada>
              Orden de venta cancelada: no tiene simulación de reparto ni admite nuevas compras; estas cifras quedan como consulta.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--muted)]">
            Materiales cubiertos por compras confirmadas. El resultado depende de los costos y gastos registrados; no es definitivo ni cierra la operación.
          </p>
          {r.ordenCancelada ? (
            <p className="text-xs text-[var(--muted)]" data-simulacion-cancelada>
              Orden de venta cancelada: no se muestra simulación de reparto.
            </p>
          ) : r.simulacion ? (
            <div className="space-y-2 rounded-lg border border-[var(--border)] p-3" data-simulacion>
              <p className="text-sm font-medium">Simulación de reparto 50/50</p>
              <dl className="grid max-w-md grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-[var(--muted)]">Socio 1 · 50 %</dt>
                  <dd className="font-semibold tabular-nums">{formatearImporte(r.simulacion.socio1)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Socio 2 · 50 %</dt>
                  <dd className="font-semibold tabular-nums">{formatearImporte(r.simulacion.socio2)}</dd>
                </div>
              </dl>
              <p className="text-xs font-medium text-amber-800">Simulación sobre el resultado estimado. No representa dinero disponible ni un reparto autorizado.</p>
              <p className="text-xs text-[var(--muted)]">Si hay un centavo indivisible, se asigna al Socio 2. No genera movimientos, cuentas ni reservas.</p>
            </div>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              {r.estado === "CERO" ? "Resultado estimado de cero" : "Pérdida estimada"}: no hay resultado positivo para simular un reparto.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

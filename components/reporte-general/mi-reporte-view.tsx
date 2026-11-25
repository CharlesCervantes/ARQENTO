import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/dinero";
import type { MiReporte } from "@/lib/server/reporte-general/mi-reporte";
import { EstadoPagoBadge } from "./estado-pago-badge";

// Reporte General del Supervisor: solo lo suyo.
const ORIGEN: Record<string, string> = {
  CORTE_CONTRATISTA: "Trabajos de la semana",
  REPOSICION_GASTOS: "Reposición de gastos",
  ORDEN_COMPRA: "Orden de compra",
  MANUAL: "Pago",
};
const GASTO: Record<string, string> = {
  BORRADOR: "Borrador",
  PENDIENTE_REVISION: "Por revisar",
  APROBADO: "Aprobado",
  RECHAZADO: "Rechazado",
  CANCELADO: "Cancelado",
};
const fecha = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", timeZone: "UTC" });

export function MiReporteView({ reporte: r }: { reporte: MiReporte }) {
  const tarjetas = [
    { etiqueta: "Mi total de la semana", valor: r.totalPagos },
    { etiqueta: "Pendiente de pagarme", valor: r.totalPendiente },
    { etiqueta: "Mis gastos por revisar", valor: r.gastosPorRevisar },
  ];
  return (
    <div className="space-y-6">
      {!r.vinculado && (
        <Card className="p-4 text-sm text-amber-800">
          Tu usuario todavía no está vinculado a tu registro de pago, así que aquí no aparecen tus pagos. Pide a Administración que lo
          vincule en Catálogos → Personal.
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tarjetas.map((t) => (
          <Card key={t.etiqueta} className="p-4">
            <p className="text-xs font-medium text-[var(--muted)]">{t.etiqueta}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--foreground)]">{formatMoney(t.valor)}</p>
          </Card>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-semibold text-[var(--foreground)]">Lo que se me paga</h2>
        {r.pagos.length === 0 ? (
          <Card className="p-4 text-sm text-[var(--muted)]">No tienes pagos esta semana.</Card>
        ) : (
          r.pagos.map((p) => (
            <Card key={p.id} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="font-medium text-[var(--foreground)]">{ORIGEN[p.origen] ?? p.origen}</p>
                <p className="text-xs text-[var(--muted)]">{p.obra}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">{formatMoney(p.monto)}</p>
                {p.aprobado ? <EstadoPagoBadge estatus={p.estatusPago} /> : <span className="text-xs text-[var(--muted)]">Por validar</span>}
                {p.pendiente > 0 && p.pendiente !== p.monto && <p className="text-xs text-red-700">Pendiente {formatMoney(p.pendiente)}</p>}
                {p.fechaPago && <p className="text-xs text-[var(--muted)]">Pagado el {fecha.format(new Date(p.fechaPago))}</p>}
              </div>
            </Card>
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-semibold text-[var(--foreground)]">Mis gastos</h2>
        {r.gastos.length === 0 ? (
          <Card className="p-4 text-sm text-[var(--muted)]">No tienes gastos esta semana.</Card>
        ) : (
          r.gastos.map((g) => (
            <Card key={g.id} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="font-medium text-[var(--foreground)]">{g.descripcion}</p>
                <p className="text-xs text-[var(--muted)]">
                  {g.obra} · {fecha.format(new Date(g.fecha))} · {g.loPagueYo ? "Lo pagué yo" : "Capturado por mí; lo pagó alguien más"}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">{formatMoney(g.monto)}</p>
                <p className="text-xs text-[var(--muted)]">{GASTO[g.estatus] ?? g.estatus}</p>
              </div>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}

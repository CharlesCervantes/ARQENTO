import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { CotizacionDetalle } from "@/lib/server/comercializacion/cotizaciones";
import { formatearCantidad, formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { AccionesCotizacionEmitida } from "./acciones-cotizacion-emitida";
import { AvisoCierre, EstatusCotizacionBadge } from "./cotizacion-emitida";

// B8B — borrador CANCELADO: nunca se emitió (no hay copia emitida ni PDF).
// Solo lectura con sus datos y partidas guardados; se puede Duplicar.

export function CotizacionCanceladaBorradorView({ cotizacion, esAdmin, hoy }: { cotizacion: CotizacionDetalle; esAdmin: boolean; hoy: string }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/comercializacion" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
            ← Cotizaciones y órdenes
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--foreground)]">Cotización {cotizacion.folio}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Borrador cancelado antes de emitirse. Capturó {cotizacion.creadoPorNombre}.</p>
        </div>
        <EstatusCotizacionBadge estatus={cotizacion.estatus} />
      </div>
      {cotizacion.cierre && <AvisoCierre titulo="Cotización cancelada" cierre={cotizacion.cierre} />}
      <Card className="space-y-4 p-5">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--muted)]">Vendedor</dt>
            <dd>{cotizacion.vendedor.nombre}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Descripción</dt>
            <dd>{cotizacion.descripcion ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Fecha</dt>
            <dd>{formatearFechaCalendario(cotizacion.fecha)}</dd>
          </div>
        </dl>
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.02]">
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                <th className="border-b border-[var(--border)] px-3 py-2.5">Material</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Cantidad</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Precio sin IVA</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {cotizacion.partidas.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-2.5 text-[var(--muted)]">
                    Sin materiales.
                  </td>
                </tr>
              ) : (
                cotizacion.partidas.map((p) => (
                  <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{p.codigo}</span> <span className="text-xs text-[var(--muted)]">{p.descripcion}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatearCantidad(p.cantidad)} {p.unidad}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatearImporte(p.precioUnitario)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatearImporte(p.importe)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-right text-sm font-semibold">Total {formatearImporte(cotizacion.totales.total)}</p>
      </Card>
      <AccionesCotizacionEmitida
        cotizacionId={cotizacion.id}
        folio={cotizacion.folio}
        estatus={cotizacion.estatus}
        esAdmin={esAdmin}
        sinPdf
        vencida={false}
        fechaMinima={cotizacion.fecha}
        hoy={hoy}
      />
    </div>
  );
}

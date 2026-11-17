import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { ResumenComprasOrden } from "@/lib/server/comercializacion/compras";
import { formatearCantidad, formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { BotonNuevaCompra } from "./boton-nueva-compra";

// Bloque "Compras a proveedores" del detalle de una OV (B4) — SOLO se arma
// para administración (la página no lo consulta para el vendedor). Muestra
// cantidades compradas/pendientes y las compras; NO muestra pagos ni saldos
// por pagar (eso llega en B5).

const ESTATUS: Record<string, { texto: string; clase: string }> = {
  BORRADOR: { texto: "Borrador", clase: "bg-black/[0.06] text-[var(--muted)]" },
  CONFIRMADA: { texto: "Confirmada", clase: "bg-emerald-50 text-emerald-800" },
  ANULADA: { texto: "Anulada", clase: "bg-red-50 text-red-700" },
};

export function ComprasOrden({ resumen }: { resumen: ResumenComprasOrden }) {
  const todoComprado = resumen.partidas.every((p) => Number(p.pendiente) === 0);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Compras a proveedores</h2>
          <p className="text-xs text-[var(--muted)]">
            Solo administración. Cuenta como comprado lo de compras confirmadas; los borradores y las anuladas no. Comprado no
            significa pagado ni recibido.
          </p>
        </div>
        {!todoComprado && <BotonNuevaCompra ordenVentaId={resumen.ordenVentaId} />}
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-black/[0.02]">
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              <th className="border-b border-[var(--border)] px-3 py-2.5">Material vendido</th>
              <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Vendido</th>
              <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Comprado</th>
              <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Pendiente por comprar</th>
              <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">En borradores</th>
            </tr>
          </thead>
          <tbody>
            {resumen.partidas.map((p) => (
              <tr key={p.partidaVentaId} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2.5">
                  <span className="font-medium">{p.codigo}</span> <span className="text-xs text-[var(--muted)]">{p.descripcion}</span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                  {formatearCantidad(p.vendido)} {p.unidad}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{formatearCantidad(p.comprado)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${Number(p.pendiente) > 0 ? "font-medium text-amber-800" : "text-[var(--muted)]"}`}>
                  {formatearCantidad(p.pendiente)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-[var(--muted)]">
                  {Number(p.enBorrador) > 0 ? formatearCantidad(p.enBorrador) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {resumen.compras.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Todavía no hay compras para esta orden.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.02]">
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                <th className="border-b border-[var(--border)] px-3 py-2.5">Compra</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Proveedor</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Fecha</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Importe</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Estado</th>
              </tr>
            </thead>
            <tbody>
              {resumen.compras.map((c) => (
                <tr key={c.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <Link href={`/comercializacion/compras/${c.id}`} className="font-medium text-[var(--brand)] hover:underline">
                      {c.folio}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{c.proveedorNombre ?? <span className="text-[var(--muted)]">Sin proveedor</span>}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{formatearFechaCalendario(c.fecha)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                    {c.estatus === "BORRADOR" && !c.completa ? <span className="text-[var(--muted)]">Incompleta</span> : formatearImporte(c.total)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ESTATUS[c.estatus].clase}`}>{ESTATUS[c.estatus].texto}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

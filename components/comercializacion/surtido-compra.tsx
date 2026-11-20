import Link from "next/link";
import { Card } from "@/components/ui/card";
import { formatearCantidad } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import type { SurtidoCompra } from "@/lib/server/comercializacion/surtido";

// «Surtido a obra registrado» de una compra (B8A) — solo administración (la
// página de compras ya lo exige). Lo vinculado a entregas vigentes; lo no
// vinculado puede ser falta de captura, no prueba de que el proveedor no
// entregó. No es una recepción física comprobada ni inventario.

const cant = (c: string, u: string) => `${formatearCantidad(c)} ${u}`;

export function SurtidoCompraView({ surtido }: { surtido: SurtidoCompra }) {
  return (
    <Card id="surtido" className="scroll-mt-6 space-y-3 p-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">Surtido a obra registrado</h2>
        <p className="text-xs text-[var(--muted)]">
          Cantidades de esta compra vinculadas a entregas vigentes al cliente de {surtido.ordenFolio}. «Sin vincular» puede ser solo falta de captura: no demuestra
          que el proveedor no haya entregado ni es una recepción física comprobada.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-black/[0.02]">
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              <th className="border-b border-[var(--border)] px-3 py-2">Material</th>
              <th className="border-b border-[var(--border)] px-3 py-2 text-right">Comprado</th>
              <th className="border-b border-[var(--border)] px-3 py-2 text-right">Surtido a obra registrado</th>
              <th className="border-b border-[var(--border)] px-3 py-2 text-right">Sin vincular</th>
              <th className="border-b border-[var(--border)] px-3 py-2">Entregas relacionadas</th>
            </tr>
          </thead>
          <tbody>
            {surtido.partidas.map((p) => (
              <tr key={p.partidaCompraId} className="border-b border-[var(--border)] last:border-0" data-surtido-compra={p.codigo}>
                <td className="px-3 py-2">
                  <span className="font-medium">{p.codigo}</span> <span className="text-[var(--muted)]">{p.descripcion}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cant(p.comprado, p.unidad)}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cant(p.vinculado, p.unidad)}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cant(p.sinVincular, p.unidad)}</td>
                <td className="px-3 py-2 text-xs">
                  {p.entregas.length === 0
                    ? "—"
                    : p.entregas.map((e, i) => (
                        <span key={e.entregaId}>
                          {i > 0 && ", "}
                          <Link href={`/comercializacion/cotizaciones/${surtido.cotizacionId}#entrega-${e.entregaId}`} className="font-medium text-[var(--brand)] hover:underline">
                            Entrega {e.numero}
                          </Link>{" "}
                          ({formatearFechaCalendario(e.fechaEntrega)}): {cant(e.cantidad, p.unidad)}
                        </span>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

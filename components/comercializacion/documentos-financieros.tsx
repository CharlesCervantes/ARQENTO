import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { DetalleCuenta, ResumenSaldos } from "@/lib/server/comercializacion/cuentas";
import type { ResumenComprasOrden } from "@/lib/server/comercializacion/compras";
import type { ResumenGastosOrden } from "@/lib/server/comercializacion/gastos";
import { ETIQUETA_LIQUIDACION, ETIQUETA_SITUACION, type EstadoCuenta } from "@/lib/comercializacion/cuentas";
import { formatearImporte } from "@/lib/comercializacion/importes";
import { ACCION_EN_LINEA, claseEstado, type TonoEstado } from "./estilos";

// «Cobros y pagos» (plan §5) — SOLO administración. Lista resumida de los
// documentos con dinero de la operación: a quién corresponde, a qué OV, COC o
// gasto se aplica y su saldo real. Cada fila abre su bloque actual (los pagos
// de una compra viven en la compra). Por cobrar y por pagar nunca se suman.

type Estado = Pick<EstadoCuenta, "liquidacion" | "situacion" | "saldo" | "vencido" | "aplicado" | "total">;

function Situacion({ e, anulada }: { e: Estado | null; anulada?: boolean }) {
  if (anulada) return <span className={claseEstado("alerta")}>Cuenta anulada</span>;
  if (!e) return <span className="text-[var(--muted)]">—</span>;
  if (e.liquidacion === "LIQUIDADA") return <span className={claseEstado("ok")}>Liquidada</span>;
  const tono: TonoEstado = e.situacion === "VENCIDA" ? "alerta" : e.situacion === "VENCE_HOY" || e.situacion === "SIN_CALENDARIO" ? "aviso" : "neutro";
  return (
    <span className={claseEstado(tono)}>
      {ETIQUETA_LIQUIDACION[e.liquidacion]} · {ETIQUETA_SITUACION[e.situacion]}
    </span>
  );
}

type Fila = { clave: string; tipo: "Cobro" | "Pago"; documento: string; quien: string; e: Estado | null; anulada?: boolean; href: string; interno: boolean; accion: string };

export function DocumentosFinancieros({
  ordenFolio,
  clienteNombre,
  cuenta,
  compras,
  pagosCompras,
  gastos,
  financiero,
}: {
  ordenFolio: string;
  clienteNombre: string | null;
  cuenta: DetalleCuenta | null;
  compras: ResumenComprasOrden | null;
  pagosCompras: Map<string, Estado & { anulada: boolean }>;
  gastos: ResumenGastosOrden | null;
  financiero: { porCobrar: ResumenSaldos; porPagar: ResumenSaldos } | null;
}) {
  const filas: Fila[] = [];
  if (cuenta)
    filas.push({
      clave: cuenta.id,
      tipo: "Cobro",
      documento: `Venta ${ordenFolio}`,
      quien: clienteNombre ?? "Cliente",
      e: cuenta.estado,
      anulada: cuenta.estatus !== "VIGENTE",
      href: "#cobros",
      interno: true,
      accion: "Ver cobros",
    });
  for (const k of compras?.compras ?? []) {
    if (k.estatus === "BORRADOR") continue; // un borrador no tiene cuenta
    const e = pagosCompras.get(k.id) ?? null;
    filas.push({
      clave: k.id,
      tipo: "Pago",
      documento: `Compra ${k.folio}`,
      quien: k.proveedorNombre ?? "Sin proveedor",
      e,
      anulada: e?.anulada ?? k.estatus === "ANULADA",
      href: `/comercializacion/compras/${k.id}#pagos`,
      interno: false,
      accion: "Abrir compra",
    });
  }
  for (const g of gastos?.gastos ?? [])
    filas.push({
      clave: g.id,
      tipo: "Pago",
      documento: `Gasto ${g.numero} · ${g.concepto}`,
      quien: g.beneficiarioNombre,
      e: g.cuenta?.estado ?? null,
      anulada: g.estatus === "ANULADO",
      href: `#gasto-${g.id}`,
      interno: true,
      accion: "Ver pagos",
    });

  return (
    <Card id="documentos-financieros" className="scroll-mt-6 space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Documentos con cobro o pago</h2>
          <p className="text-sm text-[var(--muted)]">Saldos reales de cada documento. Elige uno para ver su calendario y movimientos.</p>
        </div>
        {financiero && (
          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-xs text-[var(--muted)]">Por cobrar</dt>
              <dd className="font-semibold tabular-nums">{formatearImporte(financiero.porCobrar.saldo)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Por pagar</dt>
              <dd className="font-semibold tabular-nums">{formatearImporte(financiero.porPagar.saldo)}</dd>
            </div>
          </dl>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--c-suave)]">
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              <th className="px-3 py-2.5">Tipo</th>
              <th className="px-3 py-2.5">Documento</th>
              <th className="px-3 py-2.5">Cliente / proveedor</th>
              <th className="px-3 py-2.5 text-right">Total</th>
              <th className="px-3 py-2.5 text-right">Saldo</th>
              <th className="px-3 py-2.5">Situación</th>
              <th className="px-3 py-2.5">
                <span className="sr-only">Abrir</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.clave} className={`border-t border-[var(--border)] ${f.anulada ? "text-[var(--muted)]" : ""}`} data-documento={f.documento}>
                <td className="whitespace-nowrap px-3 py-2.5">{f.tipo}</td>
                <td className="px-3 py-2.5 font-medium">{f.documento}</td>
                <td className="px-3 py-2.5">{f.quien}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{f.e ? formatearImporte(f.e.total) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{f.e && !f.anulada ? formatearImporte(f.e.saldo) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <Situacion e={f.e} anulada={f.anulada} />
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">
                  {f.interno ? (
                    <a href={f.href} className={ACCION_EN_LINEA}>
                      {f.accion}
                    </a>
                  ) : (
                    <Link href={f.href} className={ACCION_EN_LINEA}>
                      {f.accion}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

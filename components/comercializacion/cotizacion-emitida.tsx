import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { CotizacionDetalle } from "@/lib/server/comercializacion/cotizaciones";
import { formatearCantidad, formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { AccionesCotizacionEmitida } from "./acciones-cotizacion-emitida";
import type { ResumenComprasOrden } from "@/lib/server/comercializacion/compras";
import { ComprasOrden } from "./compras-orden";
import type { DetalleCuenta, ResumenSaldos } from "@/lib/server/comercializacion/cuentas";
import { CuentaComercialView } from "./cuenta-comercial";
import { formatearImporte as fmt } from "@/lib/comercializacion/importes";

// Vista de una cotización EMITIDA o ACEPTADA (B3). Solo lectura y armada con
// la COPIA HISTÓRICA (documentoEmitido): lo que se ve aquí es lo que dice el
// PDF, aunque después cambie el catálogo, el cliente, la obra o la Empresa.
// Sin costos, utilidad ni cobranza.

const claseEnlace = "text-sm font-medium text-[var(--brand)] hover:underline";
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });

export function EstatusCotizacionBadge({ estatus, vencida }: { estatus: CotizacionDetalle["estatus"]; vencida?: boolean }) {
  if (estatus === "ACEPTADA") {
    return <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">Aceptada</span>;
  }
  if (estatus === "EMITIDA") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800">Emitida</span>
        {vencida && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">Vencida</span>}
      </span>
    );
  }
  return <span className="rounded-full bg-black/[0.06] px-2.5 py-1 text-xs font-medium text-[var(--muted)]">Borrador</span>;
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{etiqueta}</dt>
      <dd className="mt-0.5 text-sm text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

export function CotizacionEmitidaView({
  cotizacion,
  esAdmin,
  hoy,
  compras,
  cuenta,
  financiero,
}: {
  cotizacion: CotizacionDetalle;
  esAdmin: boolean;
  hoy: string;
  // Solo se recibe para administración (B4); para el vendedor es null.
  compras: ResumenComprasOrden | null;
  // B5 — solo administración; para el vendedor son null.
  cuenta?: DetalleCuenta | null;
  financiero?: { porCobrar: ResumenSaldos; porPagar: ResumenSaldos; comprasConCuenta: number } | null;
}) {
  const doc = cotizacion.emision!.documento;
  const orden = cotizacion.orden;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/comercializacion" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
            ← Cotizaciones y órdenes
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--foreground)]">
            {orden ? `Orden de venta ${orden.folio}` : `Cotización ${doc.folio}`}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {orden ? `Cotización ${doc.folio} · ` : ""}
            Emitida el {formatoFechaHora.format(new Date(cotizacion.emision!.emitidaEn))} por {cotizacion.emision!.emitidaPorNombre}.
            {cotizacion.origen && (
              <>
                {" "}Duplicada de{" "}
                {esAdmin ? (
                  <Link href={`/comercializacion/cotizaciones/${cotizacion.origen.id}`} className={claseEnlace}>
                    {cotizacion.origen.folio}
                  </Link>
                ) : (
                  cotizacion.origen.folio
                )}
                .
              </>
            )}
          </p>
        </div>
        <EstatusCotizacionBadge estatus={cotizacion.estatus} vencida={cotizacion.vencida} />
      </div>

      {orden && (
        <Card className="space-y-3 border-emerald-200 p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Aceptación del cliente</h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Dato etiqueta="Orden de venta">{orden.folio}</Dato>
            <Dato etiqueta="Cotización">{doc.folio}</Dato>
            <Dato etiqueta="Fecha de aceptación">{formatearFechaCalendario(orden.fechaAceptacion)}</Dato>
            <Dato etiqueta="OC del cliente">{orden.referenciaOcCliente ?? <span className="text-[var(--muted)]">Sin referencia</span>}</Dato>
            <Dato etiqueta="Evidencia">
              <a href={`/api/comercializacion/ordenes/${orden.id}/evidencia`} target="_blank" rel="noopener" className={claseEnlace}>
                {orden.evidenciaNombre}
              </a>
            </Dato>
            <Dato etiqueta="Registró">
              {orden.registradaPorNombre} · {formatoFechaHora.format(new Date(orden.registradaEn))}
            </Dato>
          </dl>
          <p className="text-xs text-[var(--muted)]">
            Registro interno de la evidencia de aceptación; no es una firma electrónica del cliente. Compras, cobros y entregas
            se registrarán en bloques posteriores.
          </p>
        </Card>
      )}

      {orden && esAdmin && financiero && (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Resumen de la orden</h2>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Dato etiqueta="Por cobrar (cliente)">{fmt(financiero.porCobrar.saldo)}</Dato>
            <Dato etiqueta="Vencido por cobrar">{fmt(financiero.porCobrar.vencido)}</Dato>
            <Dato etiqueta="Por pagar (proveedores)">{fmt(financiero.porPagar.saldo)}</Dato>
            <Dato etiqueta="Vencido por pagar">{fmt(financiero.porPagar.vencido)}</Dato>
          </dl>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Saldos reales: por pagar suma solo compras confirmadas vigentes ({financiero.comprasConCuenta}). Cobrado no es utilidad; pagado no es recibido.
            {financiero.porCobrar.sinCondiciones + financiero.porPagar.sinCondiciones > 0 && " Hay cuentas con condiciones por definir (no cuentan como vencidas)."}
          </p>
        </Card>
      )}
      {orden && esAdmin && cuenta && <CuentaComercialView cuenta={cuenta} />}
      {orden && esAdmin && compras && <ComprasOrden resumen={compras} />}

      <Card className="space-y-4 p-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Datos de la cotización</h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Dato etiqueta="Cliente">{doc.cliente?.nombre ?? "—"}</Dato>
          <Dato etiqueta="Obra">{doc.obra?.nombre ?? "—"}</Dato>
          <Dato etiqueta="Vendedor">{doc.vendedor.nombre}</Dato>
          <Dato etiqueta="Descripción">{doc.descripcion ?? "—"}</Dato>
          <Dato etiqueta="Fecha">{formatearFechaCalendario(doc.fecha)}</Dato>
          <Dato etiqueta="Vigente hasta">{formatearFechaCalendario(doc.vigenciaHasta)}</Dato>
        </dl>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Materiales</h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.02]">
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                <th className="border-b border-[var(--border)] px-3 py-2.5">Material</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Cantidad</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Precio sin IVA</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Impuesto</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {doc.partidas.map((p, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0 align-top">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[var(--foreground)]">{p.codigo}</div>
                    <div className="text-xs text-[var(--muted)]">{p.descripcion}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {formatearCantidad(p.cantidad)} <span className="text-xs text-[var(--muted)]">{p.unidad}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{formatearImporte(p.precioUnitario)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {p.tratamientoImpuesto === "GRAVADO" && p.tasaIva ? `IVA ${Number(p.tasaIva)} %` : p.tratamientoImpuesto === "TASA_CERO" ? "Tasa 0 %" : "Exento"}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{formatearImporte(p.importe)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ml-auto w-full max-w-sm space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatearImporte(doc.totales.subtotal)}</span>
          </div>
          {doc.totales.gravado.map((g) => (
            <div key={g.tasa} className="flex justify-between gap-4">
              <span>
                IVA {Number(g.tasa)} % sobre {formatearImporte(g.base)}
              </span>
              <span className="tabular-nums">{formatearImporte(g.iva)}</span>
            </div>
          ))}
          {doc.totales.baseTasaCero !== "0.00" && (
            <div className="flex justify-between gap-4 text-[var(--muted)]">
              <span>Base tasa 0 % (IVA $0.00)</span>
              <span className="tabular-nums">{formatearImporte(doc.totales.baseTasaCero)}</span>
            </div>
          )}
          {doc.totales.baseExenta !== "0.00" && (
            <div className="flex justify-between gap-4 text-[var(--muted)]">
              <span>Base exenta (sin IVA)</span>
              <span className="tabular-nums">{formatearImporte(doc.totales.baseExenta)}</span>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-[var(--border)] pt-1 text-base font-semibold text-[var(--foreground)]">
            <span>Total</span>
            <span className="tabular-nums">{formatearImporte(doc.totales.total)}</span>
          </div>
        </div>
      </Card>

      {(doc.condiciones || doc.observaciones) && (
        <Card className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
          <Dato etiqueta="Condiciones">
            <span className="whitespace-pre-wrap">{doc.condiciones ?? "—"}</span>
          </Dato>
          <Dato etiqueta="Observaciones">
            <span className="whitespace-pre-wrap">{doc.observaciones ?? "—"}</span>
          </Dato>
        </Card>
      )}

      <AccionesCotizacionEmitida
        cotizacionId={cotizacion.id}
        folio={doc.folio}
        estatus={cotizacion.estatus}
        vencida={cotizacion.vencida}
        fechaMinima={doc.fecha}
        hoy={hoy}
      />
    </div>
  );
}

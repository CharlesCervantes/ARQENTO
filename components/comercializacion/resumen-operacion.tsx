import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { CotizacionDetalle } from "@/lib/server/comercializacion/cotizaciones";
import type { ResumenComprasOrden } from "@/lib/server/comercializacion/compras";
import type { DetalleCuenta, ResumenSaldos } from "@/lib/server/comercializacion/cuentas";
import type { ResumenEntregasOrden } from "@/lib/server/comercializacion/entregas";
import type { ResumenGastosOrden } from "@/lib/server/comercializacion/gastos";
import type { SurtidoEntrega } from "@/lib/server/comercializacion/surtido";
import { etiquetaImpuestoPartidaVenta, formatearCantidad, formatearImporte } from "@/lib/comercializacion/importes";
import { filasImpuestoVenta } from "@/lib/comercializacion/totales-venta";
import { enlaceDefinir } from "@/lib/comercializacion/condiciones";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { ETIQUETA_ESTADO_ENTREGA } from "@/lib/comercializacion/entregas";
import { ETIQUETA_METODO } from "@/lib/comercializacion/cuentas";
import { nombreVendedor } from "@/lib/comercializacion/vendedor";
import { ACCION_EN_LINEA, claseEstado, type TonoEstado } from "./estilos";

// Vista «Resumen» del expediente (plan §5/§6). Responde qué se vende, a
// quién, en qué obra y qué está pendiente, con los estados y saldos que ya
// calcula el servidor; no recalcula reglas de negocio. Compras, cuentas,
// gastos y surtido solo llegan para administración (para el vendedor son
// null y aquí simplemente no se muestran). Los indicadores son navegación:
// llevan al bloque, no cambian ningún estado.

const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });
const fechaDeMarca = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Monterrey" });

export type DatosResumen = {
  cotizacion: CotizacionDetalle;
  esAdmin: boolean;
  compras: ResumenComprasOrden | null;
  cuenta: DetalleCuenta | null;
  financiero: { porCobrar: ResumenSaldos; porPagar: ResumenSaldos; comprasConCuenta: number; gastosConCuenta: number } | null;
  entregas: ResumenEntregasOrden | null;
  gastos: ResumenGastosOrden | null;
  surtido: Record<string, SurtidoEntrega> | null;
};

type Avance = "PENDIENTE" | "PARCIAL" | "COMPLETA";
const TONO_AVANCE: Record<Avance, TonoEstado> = { PENDIENTE: "neutro", PARCIAL: "aviso", COMPLETA: "ok" };

function avanceCompras(c: ResumenComprasOrden): Avance {
  if (c.partidas.length === 0) return "PENDIENTE";
  const sinPendiente = c.partidas.filter((p) => Number(p.pendiente) === 0).length;
  const algoComprado = c.partidas.some((p) => Number(p.comprado) > 0);
  return sinPendiente === c.partidas.length ? "COMPLETA" : algoComprado ? "PARCIAL" : "PENDIENTE";
}

function estadoCotizacion(c: CotizacionDetalle): { texto: string; tono: TonoEstado } {
  if (c.orden?.estatus === "CANCELADA") return { texto: "Aceptada · OV cancelada", tono: "alerta" };
  switch (c.estatus) {
    case "ACEPTADA":
      return { texto: "Aceptada", tono: "ok" };
    case "RECHAZADA":
      return { texto: "Rechazada", tono: "alerta" };
    case "CANCELADA":
      return { texto: "Cancelada", tono: "neutro" };
    case "EMITIDA":
      return c.vencida ? { texto: "Emitida · vencida", tono: "aviso" } : { texto: "Emitida", tono: "info" };
    default:
      return { texto: "Borrador", tono: "neutro" };
  }
}

function Seguimiento({ titulo, estado, tono, detalle, href }: { titulo: string; estado: string; tono: TonoEstado; detalle?: string; href?: string }) {
  const contenido = (
    <>
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{titulo}</span>
      <span className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className={claseEstado(tono)}>{estado}</span>
        {detalle && <span className="text-xs text-[var(--muted)]">{detalle}</span>}
      </span>
    </>
  );
  const clase = "flex min-h-[4.5rem] flex-col justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3";
  return href ? (
    <a href={href} className={`${clase} transition-colors hover:border-[var(--foreground)]/30 hover:bg-black/[0.015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]`} data-seguimiento={titulo}>
      {contenido}
    </a>
  ) : (
    <div className={clase} data-seguimiento={titulo}>
      {contenido}
    </div>
  );
}

function Cifra({ etiqueta, valor, secundario, alerta, href }: { etiqueta: string; valor: string; secundario?: string; alerta?: boolean; href?: string }) {
  const cuerpo = (
    <>
      <p className="text-sm text-[var(--muted)]">{etiqueta}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{formatearImporte(valor)}</p>
      {secundario && <p className={`mt-0.5 text-sm tabular-nums ${alerta ? "font-medium text-red-700" : "text-[var(--muted)]"}`}>{secundario}</p>}
    </>
  );
  return href ? (
    <a href={href} className="block rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4 transition-colors hover:border-[var(--foreground)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
      {cuerpo}
    </a>
  ) : (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">{cuerpo}</div>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{etiqueta}</dt>
      <dd className="mt-0.5 text-sm text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

type Pendiente = { texto: string; href?: string; enlace?: string; tono: TonoEstado };

function pendientesDe(d: DatosResumen): Pendiente[] {
  const { cotizacion: c, compras, cuenta, financiero, entregas, surtido } = d;
  const orden = c.orden;
  const p: Pendiente[] = [];
  if (c.estatus === "EMITIDA" && !c.vencida) p.push({ texto: "Registrar la aceptación cuando el cliente la confirme.", tono: "info" });
  if (!orden || orden.estatus === "CANCELADA") return p;
  if (compras) {
    const faltan = compras.partidas.filter((x) => Number(x.pendiente) > 0).length;
    if (faltan > 0) p.push({ texto: `Comprar: ${faltan} de ${compras.partidas.length} materiales sin compra confirmada completa.`, href: "#compras", enlace: "Ver compras", tono: "aviso" });
    const borradores = compras.compras.filter((x) => x.estatus === "BORRADOR");
    if (borradores.length > 0)
      p.push({
        texto: `${borradores.length === 1 ? "Hay 1 compra en borrador" : `Hay ${borradores.length} compras en borrador`} (${borradores.map((b) => b.folio).join(", ")}): no cuentan como compradas hasta confirmarse.`,
        href: `/comercializacion/compras/${borradores[0].id}`,
        enlace: `Abrir ${borradores[0].folio}`,
        tono: "aviso",
      });
  }
  if (entregas) {
    const faltan = entregas.partidas.filter((x) => !x.completa).length;
    if (faltan > 0) p.push({ texto: `Entregar: ${faltan} de ${entregas.totalPartidas} materiales con cantidad pendiente.`, href: "#entregas", enlace: "Ver entregas", tono: "aviso" });
  }
  if (surtido) {
    const sinOrigen = Object.values(surtido).filter((x) => x.vigente && x.pendienteTotal).length;
    if (sinOrigen > 0) p.push({ texto: `${sinOrigen} ${sinOrigen === 1 ? "entrega" : "entregas"} con origen por identificar (falta vincular la compra que surtió).`, href: "#entregas", enlace: "Vincular", tono: "aviso" });
  }
  if (cuenta && cuenta.estatus === "VIGENTE") {
    const e = cuenta.estado;
    if (e.situacion === "SIN_CALENDARIO") p.push({ texto: "Definir las condiciones de cobro (contado o crédito) para registrar cobros.", href: enlaceDefinir("?vista=resumen", cuenta.id), enlace: "Definir ahora", tono: "aviso" });
    else if (e.vencido !== "0.00") p.push({ texto: `Cobro vencido: ${formatearImporte(e.vencido)}.`, href: "#cobros", enlace: "Ver cobros", tono: "alerta" });
    else if (e.situacion === "VENCE_HOY") p.push({ texto: "Hay un cobro que vence hoy.", href: "#cobros", enlace: "Ver cobros", tono: "aviso" });
  }
  if (financiero) {
    if (financiero.porPagar.vencido !== "0.00") p.push({ texto: `Pagos vencidos a proveedores o gastos: ${formatearImporte(financiero.porPagar.vencido)}.`, href: "#documentos-financieros", enlace: "Ver pagos", tono: "alerta" });
    if (financiero.porPagar.sinCondiciones > 0)
      p.push({ texto: `${financiero.porPagar.sinCondiciones} ${financiero.porPagar.sinCondiciones === 1 ? "cuenta por pagar" : "cuentas por pagar"} sin condiciones definidas.`, href: "#documentos-financieros", enlace: "Ver pagos", tono: "aviso" });
  }
  return p;
}

// ---------------------------------------------------------------------------
// Actividad: eventos YA registrados que el usuario puede ver. No se fabrican
// eventos ni fechas; la fecha operativa se distingue de la de captura.
// ---------------------------------------------------------------------------

type Evento = { en: string; titulo: string; detalle?: string; por?: string | null; operativa?: string; tono?: TonoEstado };

function eventosDe(d: DatosResumen): Evento[] {
  const { cotizacion: c, compras, cuenta, entregas, gastos } = d;
  const ev: Evento[] = [];
  if (c.emision) ev.push({ en: c.emision.emitidaEn, titulo: `Cotización ${c.folio} emitida`, por: c.emision.emitidaPorNombre });
  if (c.cierre) ev.push({ en: c.cierre.en, titulo: c.estatus === "RECHAZADA" ? "Rechazo del cliente registrado" : "Cotización cancelada", detalle: `Motivo: ${c.cierre.motivo}`, por: c.cierre.porNombre, tono: "alerta" });
  if (c.orden) {
    ev.push({
      en: c.orden.registradaEn,
      titulo: `Aceptación registrada · ${c.orden.folio}`,
      detalle: c.orden.referenciaOcCliente ? `OC del cliente ${c.orden.referenciaOcCliente}` : undefined,
      por: c.orden.registradaPorNombre,
      operativa: c.orden.fechaAceptacion,
      tono: "ok",
    });
    if (c.orden.cancelacion) ev.push({ en: c.orden.cancelacion.en, titulo: `Orden de venta ${c.orden.folio} cancelada`, detalle: `Motivo: ${c.orden.cancelacion.motivo}`, por: c.orden.cancelacion.porNombre, tono: "alerta" });
  }
  for (const e of entregas?.entregas ?? []) {
    ev.push({ en: e.registradaEn, titulo: `Entrega ${e.numero} registrada`, detalle: e.partidas.map((p) => `${p.codigo}: ${formatearCantidad(p.cantidad)} ${p.unidad}`).join(" · "), por: e.registradaPorNombre, operativa: e.fechaEntrega });
    for (const x of e.evidencias) if (x.agregada) ev.push({ en: x.agregada.en, titulo: `Evidencia agregada a la entrega ${e.numero}`, detalle: x.nombre, por: x.agregada.porNombre });
    if (e.anulada) ev.push({ en: e.anulada.en, titulo: `Entrega ${e.numero} anulada`, detalle: `Motivo: ${e.anulada.motivo}`, por: e.anulada.porNombre, tono: "alerta" });
  }
  for (const k of compras?.compras ?? []) {
    if (k.confirmada) ev.push({ en: k.confirmada.en, titulo: `Compra ${k.folio} confirmada`, detalle: `${k.proveedorNombre ?? "Sin proveedor"} · ${formatearImporte(k.total)}`, por: k.confirmada.porNombre, operativa: k.fecha });
    if (k.anulada) ev.push({ en: k.anulada.en, titulo: `Compra ${k.folio} ${k.confirmada ? "anulada" : "descartada"}`, por: k.anulada.porNombre, tono: "alerta" });
  }
  const movimientos = (cta: DetalleCuenta, sujeto: string, tipo: "Cobro" | "Pago") => {
    for (const m of cta.movimientos) {
      ev.push({ en: m.registradoEn, titulo: `${tipo} ${sujeto} registrado`, detalle: `${formatearImporte(m.importe)} · ${ETIQUETA_METODO[m.metodo]}`, por: m.registradoPorNombre, operativa: m.fecha });
      if (m.anulado) ev.push({ en: m.anulado.en, titulo: `${tipo} ${sujeto} anulado`, detalle: `${formatearImporte(m.importe)} · Motivo: ${m.anulado.motivo}`, por: m.anulado.porNombre, tono: "alerta" });
    }
    const numero = new Map(cta.estado.cuotas.map((q) => [q.id, q.numero]));
    for (const [cuotaId, v] of Object.entries(cta.vencimientos))
      for (const h of v.cambios)
        ev.push({
          en: h.en,
          titulo: `Vencimiento cambiado · ${sujeto}, cuota ${numero.get(cuotaId) ?? "—"}`,
          detalle: `${formatearFechaCalendario(h.fechaAnterior)} → ${formatearFechaCalendario(h.fechaNueva)} · ${h.motivo}`,
          por: h.porNombre,
        });
  };
  if (cuenta) movimientos(cuenta, "del cliente", "Cobro");
  for (const g of gastos?.gastos ?? []) {
    ev.push({ en: g.registradoEn, titulo: `Gasto ${g.numero} registrado`, detalle: `${g.concepto} · ${g.beneficiarioNombre} · ${formatearImporte(g.total)}`, por: g.registradoPorNombre, operativa: g.fecha });
    if (g.anulado) ev.push({ en: g.anulado.en, titulo: `Gasto ${g.numero} anulado`, detalle: `Motivo: ${g.anulado.motivo}`, por: g.anulado.porNombre, tono: "alerta" });
    if (g.cuenta) movimientos(g.cuenta, `del gasto ${g.numero}`, "Pago");
  }
  return ev.sort((a, b) => (a.en < b.en ? 1 : a.en > b.en ? -1 : 0));
}

function Actividad({ d }: { d: DatosResumen }) {
  const eventos = eventosDe(d);
  return (
    <Card id="actividad" className="scroll-mt-6 p-0">
      <details className="group" data-actividad>
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="text-base font-semibold">Actividad</span>
            <span className="ml-2 text-sm text-[var(--muted)]">{eventos.length} {eventos.length === 1 ? "evento" : "eventos"}</span>
          </span>
          <svg viewBox="0 0 20 20" className="size-5 text-[var(--muted)] transition-transform group-open:rotate-180" aria-hidden="true">
            <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <div className="border-t border-[var(--border)] px-5 py-4">
          {eventos.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Sin eventos registrados.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-[var(--border)] pl-5">
              {eventos.map((e, i) => {
                const captura = fechaDeMarca.format(new Date(e.en));
                return (
                  <li key={i} className="relative">
                    <span
                      className={`absolute -left-[1.6rem] top-1.5 size-2.5 rounded-full ring-4 ring-[var(--surface)] ${
                        e.tono === "alerta" ? "bg-red-600" : e.tono === "ok" ? "bg-emerald-600" : "bg-[var(--foreground)]/50"
                      }`}
                      aria-hidden="true"
                    />
                    <p className="text-sm font-medium">{e.titulo}</p>
                    {e.detalle && <p className="text-sm text-[var(--muted)]">{e.detalle}</p>}
                    <p className="text-xs text-[var(--muted)]">
                      {e.operativa && e.operativa !== captura ? `Fecha operativa ${formatearFechaCalendario(e.operativa)} · capturado ` : ""}
                      {formatoFechaHora.format(new Date(e.en))}
                      {e.por ? ` · ${e.por}` : ""}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="mt-4 text-xs text-[var(--muted)]">
            Reúne los registros que ya guarda cada bloque.
            {d.esAdmin && " Los pagos y cambios de vencimiento de cada compra se consultan en su compra; la definición de condiciones y los vínculos de surtido, en su bloque."}
          </p>
        </div>
      </details>
    </Card>
  );
}

const VISTA_PREVIA = 5;

// La columna «Impuesto» solo aparece en documentos con impuesto por partida
// (anteriores a la opción de IVA por cotización).
function TablaMateriales({
  partidas,
  porPartida,
}: {
  partidas: NonNullable<CotizacionDetalle["emision"]>["documento"]["partidas"];
  porPartida: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--c-suave)]">
          <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            <th className="px-3 py-2.5">Material</th>
            <th className="px-3 py-2.5 text-right">Cantidad</th>
            <th className="px-3 py-2.5 text-right">Precio sin IVA</th>
            {porPartida && <th className="px-3 py-2.5">Impuesto</th>}
            <th className="px-3 py-2.5 text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {partidas.map((p, i) => (
            <tr key={i} className="border-t border-[var(--border)] align-top">
              <td className="px-3 py-2.5">
                <div className="font-medium text-[var(--foreground)]">{p.codigo}</div>
                <div className="text-xs text-[var(--muted)]">{p.descripcion}</div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                {formatearCantidad(p.cantidad)} <span className="text-xs text-[var(--muted)]">{p.unidad}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatearImporte(p.precioUnitario)}</td>
              {porPartida && <td className="whitespace-nowrap px-3 py-2.5">{etiquetaImpuestoPartidaVenta(p.tratamientoImpuesto, p.tasaIva)}</td>}
              <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatearImporte(p.importe)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResumenOperacion(d: DatosResumen) {
  const { cotizacion: c, esAdmin, compras, financiero, entregas } = d;
  const doc = c.emision!.documento;
  const orden = c.orden;
  const vigente = orden?.estatus === "VIGENTE";
  const est = estadoCotizacion(c);
  const pendientes = pendientesDe(d);
  const avC = compras ? avanceCompras(compras) : null;

  return (
    <>
      {/* Seguimiento: frentes independientes (pueden avanzar a la vez). */}
      <div className={`grid grid-cols-1 gap-3 ${orden ? (esAdmin ? "sm:grid-cols-3" : "sm:grid-cols-2") : "sm:grid-cols-1"}`} data-seguimiento-operacion>
        <Seguimiento titulo="Cotización" estado={est.texto} tono={est.tono} detalle={doc.vigenciaHasta && c.estatus === "EMITIDA" ? `Vigente hasta ${formatearFechaCalendario(doc.vigenciaHasta)}` : undefined} />
        {orden && compras && avC && (
          <Seguimiento
            titulo="Compras"
            estado={vigente ? (avC === "COMPLETA" ? "Completa" : avC === "PARCIAL" ? "Parcial" : "Pendiente") : "Sin cambios (OV cancelada)"}
            tono={vigente ? TONO_AVANCE[avC] : "neutro"}
            detalle={`${compras.partidas.filter((p) => Number(p.pendiente) === 0).length} de ${compras.partidas.length} materiales cubiertos`}
            href="#compras"
          />
        )}
        {orden && entregas && (
          <Seguimiento
            titulo="Entregas"
            estado={vigente ? ETIQUETA_ESTADO_ENTREGA[entregas.estado] : "Sin cambios (OV cancelada)"}
            tono={vigente ? TONO_AVANCE[entregas.estado] : "neutro"}
            detalle={`${entregas.completas} de ${entregas.totalPartidas} partidas completas`}
            href="#entregas"
          />
        )}
      </div>

      {/* Cifras: por cobrar y por pagar siempre separadas (solo administración). */}
      <div className={`grid grid-cols-1 gap-3 ${orden && esAdmin && financiero ? "sm:grid-cols-3" : "sm:grid-cols-1"}`}>
        <Cifra etiqueta="Venta total (con impuestos)" valor={doc.totales.total} secundario={`Subtotal sin IVA ${formatearImporte(doc.totales.subtotal)}`} />
        {orden && esAdmin && financiero && (
          <>
            <Cifra
              etiqueta="Por cobrar al cliente"
              valor={financiero.porCobrar.saldo}
              secundario={financiero.porCobrar.sinCondiciones > 0 ? "Condiciones por definir (no cuenta como vencido)" : `Vencido ${formatearImporte(financiero.porCobrar.vencido)}`}
              alerta={financiero.porCobrar.vencido !== "0.00"}
              href="#cobros"
            />
            <Cifra
              etiqueta="Por pagar (proveedores y gastos)"
              valor={financiero.porPagar.saldo}
              secundario={`Vencido ${formatearImporte(financiero.porPagar.vencido)}`}
              alerta={financiero.porPagar.vencido !== "0.00"}
              href="#documentos-financieros"
            />
          </>
        )}
      </div>
      {orden && esAdmin && financiero && <p className="-mt-3 text-xs text-[var(--muted)]">Saldos reales: solo bajan con cobros o pagos registrados. Cobrado no es utilidad; pagado no es recibido.</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="space-y-3 p-5 lg:col-span-2" data-pendientes>
          <h2 className="text-lg font-semibold">Pendientes</h2>
          {orden?.estatus === "CANCELADA" ? (
            <p className="text-sm text-[var(--muted)]">Orden de venta cancelada: no admite nuevas operaciones.</p>
          ) : pendientes.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Sin pendientes registrados.</p>
          ) : (
            <ul className="space-y-3">
              {pendientes.map((p) => (
                <li key={p.texto} className="flex gap-3 text-sm">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${p.tono === "alerta" ? "bg-red-600" : p.tono === "aviso" ? "bg-amber-500" : "bg-sky-600"}`}
                    aria-hidden="true"
                  />
                  <span>
                    {p.texto}{" "}
                    {p.href &&
                      (p.href.startsWith("#") ? (
                        <a href={p.href} className={ACCION_EN_LINEA}>
                          {p.enlace}
                        </a>
                      ) : (
                        <Link href={p.href} className={ACCION_EN_LINEA}>
                          {p.enlace}
                        </Link>
                      ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="space-y-4 p-5 lg:col-span-3">
          <h2 className="text-lg font-semibold">Datos comerciales</h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Dato etiqueta="Cliente">{doc.cliente?.nombre ?? "—"}</Dato>
            <Dato etiqueta="Obra">{doc.obra?.nombre ?? "—"}</Dato>
            <Dato etiqueta="Vendedor">{nombreVendedor(doc.vendedor)}</Dato>
            <Dato etiqueta="Fecha de la cotización">
              {formatearFechaCalendario(doc.fecha)}
              {doc.vigenciaHasta && <span className="text-[var(--muted)]"> · vigente hasta {formatearFechaCalendario(doc.vigenciaHasta)}</span>}
            </Dato>
            <Dato etiqueta="Emisión">
              {formatoFechaHora.format(new Date(c.emision!.emitidaEn))} · {c.emision!.emitidaPorNombre}
            </Dato>
            {orden && (
              <Dato etiqueta="Aceptación">
                {formatearFechaCalendario(orden.fechaAceptacion)}
                {orden.referenciaOcCliente && <span className="text-[var(--muted)]"> · OC {orden.referenciaOcCliente}</span>}
              </Dato>
            )}
            {c.origen && (
              <Dato etiqueta="Duplicada de">
                {esAdmin ? (
                  <Link href={`/comercializacion/cotizaciones/${c.origen.id}`} className={ACCION_EN_LINEA}>
                    {c.origen.folio}
                  </Link>
                ) : (
                  c.origen.folio
                )}
              </Dato>
            )}
          </dl>
          {(doc.condiciones || doc.observaciones) && (
            <details className="group rounded-xl bg-[var(--c-suave)] px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium">Ver condiciones y observaciones</summary>
              <dl className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Dato etiqueta="Condiciones">
                  <span className="whitespace-pre-wrap">{doc.condiciones ?? "—"}</span>
                </Dato>
                <Dato etiqueta="Observaciones">
                  <span className="whitespace-pre-wrap">{doc.observaciones ?? "—"}</span>
                </Dato>
              </dl>
            </details>
          )}
        </Card>
      </div>

      <Card id="materiales" className="scroll-mt-6 space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Materiales</h2>
          <span className="text-sm text-[var(--muted)]">
            {doc.partidas.length} {doc.partidas.length === 1 ? "partida" : "partidas"} · copia emitida
          </span>
        </div>
        <TablaMateriales partidas={doc.partidas.slice(0, VISTA_PREVIA)} porPartida={doc.impuestoVenta === null} />
        {doc.partidas.length > VISTA_PREVIA && (
          <details className="group" data-todos-materiales>
            <summary className={`${ACCION_EN_LINEA} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              <span className="group-open:hidden">Ver todos los materiales ({doc.partidas.length})</span>
              <span className="hidden group-open:inline">Ocultar la lista completa</span>
            </summary>
            <div className="mt-3">
              <TablaMateriales partidas={doc.partidas} porPartida={doc.impuestoVenta === null} />
            </div>
          </details>
        )}
        <div className="ml-auto w-full max-w-sm space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatearImporte(doc.totales.subtotal)}</span>
          </div>
          {filasImpuestoVenta(doc.totales, doc.impuestoVenta).map((f) => (
            <div key={f.etiqueta} className={`flex justify-between gap-4 ${f.tenue ? "text-[var(--muted)]" : ""}`}>
              <span>{f.etiqueta}</span>
              <span className="tabular-nums">{formatearImporte(f.valor)}</span>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-t border-[var(--border)] pt-1 text-base font-semibold text-[var(--foreground)]">
            <span>Total</span>
            <span className="tabular-nums">{formatearImporte(doc.totales.total)}</span>
          </div>
        </div>
      </Card>

      <Actividad d={d} />
    </>
  );
}

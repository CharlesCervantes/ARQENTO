import Link from "next/link";
import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarClientesYObras } from "@/lib/server/comercializacion/clientes";
import { listarCotizacionesVenta, listarVendedoresConCotizaciones, type FilaCotizacion } from "@/lib/server/comercializacion/cotizaciones";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { EstatusCotizacionBadge } from "@/components/comercializacion/cotizacion-emitida";
import { estadoCobroDeOrdenes, indicadoresCuentasEmpresa } from "@/lib/server/comercializacion/cuentas";
import { ETIQUETA_LIQUIDACION, ETIQUETA_SITUACION } from "@/lib/comercializacion/cuentas";
import { db } from "@/lib/server/db";
import { contarOrdenesConEntregaPendiente, estadoEntregaDeOrdenes } from "@/lib/server/comercializacion/entregas";
import { recordatoriosComerciales, type RecordatoriosComerciales } from "@/lib/server/comercializacion/recordatorios";
import { PorAtender } from "@/components/comercializacion/por-atender";
import { PanelPendientes } from "@/components/comercializacion/panel-pendientes";
import { ActualizarConsulta } from "@/components/comercializacion/actualizar-consulta";
import { ETIQUETA_ESTADO_ENTREGA } from "@/lib/comercializacion/entregas";
import { formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { ETIQUETA_SIN_VENDEDOR, FILTRO_SIN_VENDEDOR } from "@/lib/comercializacion/vendedor";
import { BOTON_PRIMARIO, BOTON_SECUNDARIO } from "@/components/comercializacion/estilos";

// Listado «Operaciones» (plan de rediseño §4). Una fila por operación: la
// cotización y, si se aceptó, su OV (nunca dos filas). Mismas fuentes y
// alcances que antes:
// - Cobro, indicadores y «Por atender» (B5/B6B): solo administración; para el
//   vendedor no se calcula nada aunque mande parámetros por URL.
// - Entrega (B6A): administración y el vendedor de sus OV.
// - Filtros por GET, aplicados en servidor dentro del alcance del usuario.
// «Por atender» queda como franja compacta; su detalle abre en un panel
// controlado por la URL (?avisos=…), así que sus enlaces siguen igual.

const claseSelect =
  "w-full min-h-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";

const texto = (v: string | string[] | undefined) => (typeof v === "string" && v.length <= 100 ? v : undefined);

const ESTADOS: [string, string][] = [
  ["BORRADOR", "Borrador"],
  ["EMITIDA", "Emitida"],
  ["ACEPTADA", "Aceptada (OV)"],
  ["RECHAZADA", "Rechazada"],
  ["CANCELADA", "Cancelada"],
];

type Cobro = { liquidacion: keyof typeof ETIQUETA_LIQUIDACION; situacion: keyof typeof ETIQUETA_SITUACION; saldo: string; vencido: string };
type Entrega = { estado: keyof typeof ETIQUETA_ESTADO_ENTREGA; completas: number; total: number };

function CeldaCobro({ c, e }: { c: FilaCotizacion; e: Cobro | undefined }) {
  if (!c.ordenFolio) return <span className="text-[var(--muted)]">No aplica</span>;
  if (c.ordenCancelada) return <span className="text-[var(--muted)]">Cuenta anulada</span>;
  if (!e) return <span className="text-[var(--muted)]">—</span>;
  if (e.situacion === "SIN_CALENDARIO")
    return (
      <span>
        <span className="tabular-nums">{formatearImporte(e.saldo)}</span>
        <span className="block text-xs text-amber-900">Condiciones por definir</span>
      </span>
    );
  if (e.liquidacion === "LIQUIDADA") return <span className="text-emerald-800">Cobrada</span>;
  return (
    <span>
      <span className="tabular-nums">{formatearImporte(e.saldo)}</span>
      <span className={`block text-xs ${e.situacion === "VENCIDA" ? "font-medium text-red-700" : "text-[var(--muted)]"}`}>
        {ETIQUETA_LIQUIDACION[e.liquidacion]} · {ETIQUETA_SITUACION[e.situacion]}
      </span>
    </span>
  );
}

function CeldaEntrega({ c, e }: { c: FilaCotizacion; e: Entrega | undefined }) {
  if (!c.ordenFolio) return <span className="text-[var(--muted)]">No aplica</span>;
  if (c.ordenCancelada) return <span className="text-[var(--muted)]">OV cancelada</span>;
  if (!e) return <span className="text-[var(--muted)]">—</span>;
  return (
    <span className={e.estado === "COMPLETA" ? "text-emerald-800" : e.estado === "PARCIAL" ? "text-amber-900" : ""}>
      {ETIQUETA_ESTADO_ENTREGA[e.estado]}
      <span className="block text-xs text-[var(--muted)]">
        {e.completas} de {e.total} partidas
      </span>
    </span>
  );
}

function FranjaPorAtender({ datos, hrefPendientes }: { datos: RecordatoriosComerciales; hrefPendientes: string }) {
  const r = datos.resumen;
  const grupo = (k: "VENCIDO" | "HOY", titulo: string) => {
    const t = r[k];
    const hay = t.cobro.cuotas + t.pago.cuotas > 0;
    return (
      <div className="min-w-0" data-franja={k}>
        <p className={`text-sm font-semibold ${k === "VENCIDO" && hay ? "text-red-700" : "text-[var(--foreground)]"}`}>{titulo}</p>
        <p className="text-xs text-[var(--muted)]">
          Por cobrar: {t.cobro.cuotas} {t.cobro.cuotas === 1 ? "cuota" : "cuotas"} · <span className="tabular-nums">{formatearImporte(t.cobro.importe)}</span>
        </p>
        <p className="text-xs text-[var(--muted)]">
          Por pagar: {t.pago.cuotas} {t.pago.cuotas === 1 ? "cuota" : "cuotas"} · <span className="tabular-nums">{formatearImporte(t.pago.importe)}</span>
        </p>
      </div>
    );
  };
  const proximos = r.PROXIMO.cobro.cuotas + r.PROXIMO.pago.cuotas;
  const sinCondiciones = r.SIN_CONDICIONES.cobro.cuentas + r.SIN_CONDICIONES.pago.cuentas;
  return (
    <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between" data-por-atender>
      <ActualizarConsulta hoy={datos.hoy} zona={datos.zona} generadoEn={datos.generadoEn} />
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Por atender</p>
          <p className="text-xs text-[var(--muted)]">Hoy {formatearFechaCalendario(datos.hoy)}</p>
        </div>
        {grupo("VENCIDO", "Vencidos")}
        {grupo("HOY", "Vencen hoy")}
        <p className="self-center text-xs text-[var(--muted)]">
          Además: {proximos} {proximos === 1 ? "cuota" : "cuotas"} en los próximos 3 días · {sinCondiciones}{" "}
          {sinCondiciones === 1 ? "cuenta" : "cuentas"} sin condiciones
        </p>
      </div>
      <Link href={hrefPendientes} scroll={false} className={`${BOTON_SECUNDARIO} shrink-0`}>
        Ver pendientes
      </Link>
    </Card>
  );
}

export default async function ComercializacionPage(props: PageProps<"/comercializacion">) {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  const esAdmin = esAdministradorComercial(usuario);
  const sp = await props.searchParams;
  const filtros = {
    busqueda: texto(sp.q),
    clienteId: texto(sp.cliente),
    obraId: texto(sp.obra),
    vendedorId: esAdmin ? texto(sp.vendedor) : undefined,
    estatus: texto(sp.estado),
  };

  const [cotizaciones, { clientes, obras }, vendedores] = await Promise.all([
    listarCotizacionesVenta(usuario, filtros),
    listarClientesYObras(usuario),
    listarVendedoresConCotizaciones(usuario),
  ]);
  // OV visibles en el listado (ya filtradas por el alcance del usuario).
  const ordenIds = await db.ordenVenta.findMany({
    where: { cotizacionId: { in: cotizaciones.filter((c) => c.ordenFolio).map((c) => c.id) } },
    select: { id: true, cotizacionId: true },
  });
  // B6A — estado de entrega: administración y vendedor (solo sus OV).
  const entregasPorOrden = await estadoEntregaDeOrdenes(usuario, ordenIds.map((o) => o.id));
  const entregaPorCotizacion = new Map(ordenIds.map((o) => [o.cotizacionId, entregasPorOrden.get(o.id)]));
  // B5 — cobranza e indicadores: solo administración (el vendedor no los recibe).
  const cobros: Awaited<ReturnType<typeof estadoCobroDeOrdenes>> = esAdmin ? await estadoCobroDeOrdenes(usuario, ordenIds.map((o) => o.id)) : new Map();
  const cobroPorCotizacion = new Map(ordenIds.map((o) => [o.cotizacionId, cobros.get(o.id)]));
  const indicadores = esAdmin ? await indicadoresCuentasEmpresa(usuario) : null;
  // B6B — «Por atender» y «Entregas pendientes»: SOLO administración.
  const [avisos, entregasPendientes] = esAdmin
    ? await Promise.all([recordatoriosComerciales(usuario, { categoria: texto(sp.avisos), visibles: texto(sp.ver) }), contarOrdenesConEntregaPendiente(usuario)])
    : [null, null];
  const parametros = Object.fromEntries(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length <= 100));
  const conParametros = (cambios: Record<string, string | null>, hash = "") => {
    const p = new URLSearchParams(parametros);
    for (const [k, v] of Object.entries(cambios)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const q = p.toString();
    return `/comercializacion${q ? `?${q}` : ""}${hash}`;
  };
  const pendientesAbierto = Boolean(avisos && (texto(sp.avisos) || texto(sp.ver)));
  const obrasFiltro = filtros.clienteId ? obras.filter((o) => o.clienteId === filtros.clienteId) : obras;
  const hayFiltros = Boolean(filtros.busqueda || filtros.clienteId || filtros.obraId || filtros.vendedorId || filtros.estatus);
  const masFiltrosActivos = [filtros.clienteId, filtros.obraId, filtros.vendedorId].filter(Boolean).length;

  // Filtros activos, cada uno con su enlace para quitarlo.
  const activos: { etiqueta: string; quitar: string }[] = [];
  if (filtros.busqueda) activos.push({ etiqueta: `Búsqueda: «${filtros.busqueda}»`, quitar: "q" });
  if (filtros.estatus) activos.push({ etiqueta: `Estado: ${ESTADOS.find((e) => e[0] === filtros.estatus)?.[1] ?? filtros.estatus}`, quitar: "estado" });
  if (filtros.clienteId) activos.push({ etiqueta: `Cliente: ${clientes.find((c) => c.id === filtros.clienteId)?.nombre ?? "—"}`, quitar: "cliente" });
  if (filtros.obraId) activos.push({ etiqueta: `Obra: ${obras.find((o) => o.id === filtros.obraId)?.nombre ?? "—"}`, quitar: "obra" });
  if (filtros.vendedorId) {
    const nombre = filtros.vendedorId === FILTRO_SIN_VENDEDOR ? ETIQUETA_SIN_VENDEDOR : (vendedores.find((v) => v.id === filtros.vendedorId)?.nombre ?? "—");
    activos.push({ etiqueta: `Vendedor: ${nombre}`, quitar: "vendedor" });
  }

  const abrir = (c: FilaCotizacion) => `/comercializacion/cotizaciones/${c.id}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--foreground)] sm:text-3xl">Operaciones</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {esAdmin
              ? "Cada operación reúne su cotización y, al aceptarse, su venta (OV) con compras, entregas, cobros y pagos."
              : "Tus cotizaciones y las ventas (OV) que resultan de su aceptación."}
          </p>
        </div>
        <Link href="/comercializacion/cotizaciones/nueva" className={`${BOTON_PRIMARIO} self-start sm:self-auto`}>
          + Nueva cotización
        </Link>
      </div>

      {indicadores && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(
            [
              ["Por cobrar", indicadores.porCobrar, "a clientes"],
              ["Por pagar", indicadores.porPagar, "a proveedores y gastos"],
            ] as const
          ).map(([etiqueta, s, quien]) => (
            <Card key={etiqueta} className="px-4 py-3 sm:px-5 sm:py-4" data-indicador={etiqueta}>
              <p className="text-sm text-[var(--muted)]">
                {etiqueta} <span className="hidden text-xs sm:inline">{quien}</span>
              </p>
              <p className="mt-1 text-lg sm:text-2xl font-semibold tabular-nums tracking-tight">{formatearImporte(s.saldo)}</p>
              <p className={`mt-0.5 text-sm tabular-nums ${s.vencido !== "0.00" ? "font-medium text-red-700" : "text-[var(--muted)]"}`}>
                Vencido {formatearImporte(s.vencido)}
              </p>
            </Card>
          ))}
          {/* B6B — indicador operativo, separado de los importes. */}
          <Card className="col-span-2 flex items-baseline justify-between gap-3 px-4 py-3 sm:col-span-1 sm:block sm:px-5 sm:py-4">
            <p className="text-sm text-[var(--muted)]">Entregas pendientes</p>
            <p className="text-lg sm:mt-1 sm:text-2xl font-semibold tabular-nums tracking-tight" data-indicador="entregas-pendientes">
              {entregasPendientes}
            </p>
            <p className="mt-0.5 text-sm text-[var(--muted)]">OV con material por entregar</p>
          </Card>
        </div>
      )}
      {indicadores && hayFiltros && (
        <p className="-mt-2 text-xs text-[var(--muted)]">Los indicadores y «Por atender» son de toda la empresa; no dependen de los filtros del listado.</p>
      )}

      {avisos && (
        <>
          <FranjaPorAtender datos={avisos} hrefPendientes={conParametros({ avisos: avisos.categoria, ver: null }, "#por-atender")} />
          <PanelPendientes key={String(pendientesAbierto)} abierto={pendientesAbierto} hrefCerrar={conParametros({ avisos: null, ver: null })}>
            <PorAtender datos={avisos} parametros={parametros} />
          </PanelPendientes>
        </>
      )}

      <Card className="overflow-hidden">
        {/* Filtros por GET. «Más filtros» agrupa cliente, obra y vendedor (este
            último solo para administración). */}
        <form method="get" className="space-y-3 border-b border-[var(--border)] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              name="q"
              type="search"
              placeholder="Buscar por folio (COT, OV), OC del cliente, cliente u obra"
              defaultValue={filtros.busqueda}
              aria-label="Buscar"
              className="min-h-11 min-w-0 flex-[3_1_16rem] rounded-xl"
            />
            <select name="estado" defaultValue={filtros.estatus ?? ""} className={`${claseSelect} w-auto flex-[1_1_11rem]`} aria-label="Estado">
              <option value="">Todos los estados</option>
              {ESTADOS.map(([v, e]) => (
                <option key={v} value={v}>
                  {e}
                </option>
              ))}
            </select>
            <button type="submit" className={BOTON_SECUNDARIO}>
              Buscar
            </button>
          </div>
          <details className="group" open={masFiltrosActivos > 0 || undefined}>
            <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg text-sm font-medium text-[var(--foreground)] [&::-webkit-details-marker]:hidden">
              <svg viewBox="0 0 20 20" className="size-4 transition-transform group-open:rotate-90" aria-hidden="true">
                <path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Más filtros{masFiltrosActivos > 0 ? ` (${masFiltrosActivos})` : ""}
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <select name="cliente" defaultValue={filtros.clienteId ?? ""} className={claseSelect} aria-label="Cliente">
                <option value="">Todos los clientes</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
              <select name="obra" defaultValue={filtros.obraId ?? ""} className={claseSelect} aria-label="Obra">
                <option value="">Todas las obras</option>
                {obrasFiltro.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
              </select>
              {esAdmin ? (
                <select name="vendedor" defaultValue={filtros.vendedorId ?? ""} className={claseSelect} aria-label="Vendedor">
                  <option value="">Todos los vendedores</option>
                  <option value={FILTRO_SIN_VENDEDOR}>{ETIQUETA_SIN_VENDEDOR}</option>
                  {vendedores.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nombre}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </details>
          {activos.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-filtros-activos>
              {activos.map((a) => (
                <Link
                  key={a.quitar}
                  href={conParametros({ [a.quitar]: null, ...(a.quitar === "cliente" ? { obra: null } : {}) })}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-black/[0.06] px-3 text-xs font-medium text-[var(--foreground)] hover:bg-black/[0.1]"
                  aria-label={`Quitar filtro ${a.etiqueta}`}
                >
                  {a.etiqueta}
                  <span aria-hidden="true">×</span>
                </Link>
              ))}
              <Link href="/comercializacion" className="text-xs font-medium text-[var(--muted)] underline underline-offset-4 hover:text-[var(--foreground)]">
                Limpiar filtros
              </Link>
            </div>
          )}
        </form>

        {cotizaciones.length === 0 ? (
          <p className="p-6 text-sm text-[var(--muted)]">
            {hayFiltros ? "Ninguna operación coincide con los filtros." : "Todavía no hay operaciones. Crea la primera con «Nueva cotización»."}
          </p>
        ) : (
          <>
            {/* Escritorio: tabla. Móvil: lista de tarjetas (sin desborde de página). */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm" data-listado-operaciones>
                <thead className="bg-[var(--c-suave)]">
                  <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    <th className="px-4 py-3">Operación</th>
                    <th className="px-4 py-3">Cliente / obra</th>
                    <th className="whitespace-nowrap px-4 py-3 text-right">Venta total</th>
                    {/* Cobranza: solo Administrador/Director (decisión confirmada, B3). */}
                    {esAdmin && <th className="px-4 py-3">Por cobrar</th>}
                    <th className="px-4 py-3">Entrega</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Acción</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cotizaciones.map((c) => (
                    <tr key={c.id} className="border-t border-[var(--border)] align-top transition-colors hover:bg-black/[0.015]" data-operacion={c.ordenFolio ?? c.folio}>
                      <td className="max-w-[26rem] px-4 py-3">
                        <Link href={abrir(c)} className="font-semibold text-[var(--foreground)] hover:underline">
                          {c.descripcion ?? <span className="font-normal italic text-[var(--muted)]">Sin descripción</span>}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
                          <EstatusCotizacionBadge estatus={c.estatus} vencida={c.vencida} ordenCancelada={c.ordenCancelada} />
                          <span className="whitespace-nowrap">
                            {c.ordenFolio ? `${c.ordenFolio} · ${c.folio}` : c.folio} · {formatearFechaCalendario(c.fecha)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {c.clienteNombre ?? <span className="text-[var(--muted)]">Sin cliente</span>}
                        {c.obraNombre && <div className="text-xs text-[var(--muted)]">{c.obraNombre}</div>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                        {c.partidas > 0 ? formatearImporte(c.total) : <span className="text-[var(--muted)]">—</span>}
                      </td>
                      {esAdmin && (
                        <td className="whitespace-nowrap px-4 py-3">
                          <CeldaCobro c={c} e={cobroPorCotizacion.get(c.id)} />
                        </td>
                      )}
                      <td className="whitespace-nowrap px-4 py-3">
                        <CeldaEntrega c={c} e={entregaPorCotizacion.get(c.id)} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={abrir(c)}
                          className="inline-flex min-h-9 items-center rounded-lg border border-[var(--border)] px-3 text-sm font-medium hover:bg-black/[0.04]"
                          aria-label={`Abrir ${c.ordenFolio ?? c.folio}`}
                        >
                          Abrir
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-[var(--border)] md:hidden" data-listado-movil>
              {cotizaciones.map((c) => (
                <li key={c.id} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={abrir(c)} className="font-semibold text-[var(--foreground)]">
                        {c.descripcion ?? <span className="font-normal italic text-[var(--muted)]">Sin descripción</span>}
                      </Link>
                      <p className="text-sm text-[var(--muted)]">
                        {c.clienteNombre ?? "Sin cliente"}
                        {c.obraNombre && ` · ${c.obraNombre}`}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums">{c.partidas > 0 ? formatearImporte(c.total) : "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                    <EstatusCotizacionBadge estatus={c.estatus} vencida={c.vencida} ordenCancelada={c.ordenCancelada} />
                    <span>{c.ordenFolio ? `${c.ordenFolio} · ${c.folio}` : c.folio}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {esAdmin && (
                      <div>
                        <p className="text-xs text-[var(--muted)]">Por cobrar</p>
                        <CeldaCobro c={c} e={cobroPorCotizacion.get(c.id)} />
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-[var(--muted)]">Entrega</p>
                      <CeldaEntrega c={c} e={entregaPorCotizacion.get(c.id)} />
                    </div>
                  </div>
                  <Link href={abrir(c)} className={`${BOTON_SECUNDARIO} w-full`}>
                    Abrir operación
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

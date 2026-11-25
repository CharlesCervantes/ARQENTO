"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { pedirCondiciones } from "./asistente-condiciones";
import { AvisosArchivos, useArchivosDeCarga } from "./campo-archivos";
import { MB_POR_CARGA } from "@/lib/comercializacion/cargas";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  calcularImportePartida,
  calcularTotalesCotizacion,
  esImpuestoCompraVigente,
  etiquetaImpuestoCompra,
  formatearCantidad,
  formatearImporte,
  normalizarCantidad,
  normalizarImporte,
  normalizarTasa,
  OPCIONES_IMPUESTO_COMPRA,
  type TratamientoImpuestoCompra,
} from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import type { CompraDetalle, OpcionProveedor } from "@/lib/server/comercializacion/compras";
import {
  adjuntarDocumentoCompraAction,
  anularCompraAction,
  confirmarCompraAction,
  crearProveedorCompraAction,
  guardarCompraAction,
  type DocumentoCompraState,
} from "@/app/(app)/comercializacion/actions";

// Compra a proveedor (B4): un solo componente para borrador (editable) y para
// compra confirmada/anulada (solo lectura). Los importes de pantalla son una
// vista previa con las mismas funciones exactas del servidor; el servidor
// recalcula y valida todo al guardar y al confirmar.

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";
const claseEnlace = "text-sm font-medium text-[var(--brand)] hover:underline";
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });

type Linea = { cantidad: string; costo: string; tratamiento: TratamientoImpuestoCompra | ""; tasa: string };

const etiquetaImpuesto = etiquetaImpuestoCompra;

// Selector visible: «Sin IVA» / «IVA 16 %». Un tratamiento anterior del
// borrador (tasa 0 %, exento u otra tasa) se muestra como opción propia para
// conservarlo tal cual; no se ofrece para partidas nuevas.
function valorSelector(l: Linea): string {
  if (!l.tratamiento) return "";
  const tasa = l.tratamiento === "GRAVADO" ? normalizarTasa(l.tasa) : null;
  if (esImpuestoCompraVigente(l.tratamiento, tasa)) return l.tratamiento === "SIN_IVA" ? "SIN_IVA" : "IVA";
  return "ANTERIOR";
}

export function FormularioCompra({
  compra,
  proveedoresIniciales,
  bloqueosAnulacion = [],
}: {
  compra: CompraDetalle;
  proveedoresIniciales: OpcionProveedor[];
  /** Motivos que impiden la anulación simple (B5: pagos; B8A: surtido a obra). Calculados en el servidor, que vuelve a validarlos. */
  bloqueosAnulacion?: { texto: string; enlaces: { href: string; etiqueta: string }[] }[];
}) {
  const router = useRouter();
  const editable = compra.estatus === "BORRADOR";
  const [proveedores, setProveedores] = useState(proveedoresIniciales);
  const [proveedorId, setProveedorId] = useState(compra.proveedorId ?? "");
  const [fecha, setFecha] = useState(compra.fecha);
  const [notas, setNotas] = useState(compra.notas ?? "");
  const anteriores = useMemo(() => {
    const m: Record<string, Linea> = {};
    for (const p of compra.partidas) {
      if (p.tratamientoImpuesto && !esImpuestoCompraVigente(p.tratamientoImpuesto, p.tasaIva)) {
        m[p.partidaVentaId] = { cantidad: "", costo: "", tratamiento: p.tratamientoImpuesto, tasa: p.tasaIva ? String(Number(p.tasaIva)) : "" };
      }
    }
    return m;
  }, [compra.partidas]);
  const [lineas, setLineas] = useState<Record<string, Linea>>(() => {
    const m: Record<string, Linea> = {};
    for (const q of compra.cantidadesOrden) m[q.partidaVentaId] = { cantidad: "", costo: "", tratamiento: "", tasa: "" };
    for (const p of compra.partidas) {
      m[p.partidaVentaId] = {
        cantidad: formatearCantidad(p.cantidad).replace(/,/g, ""),
        costo: p.costoUnitario ?? "",
        tratamiento: p.tratamientoImpuesto ?? "",
        tasa: p.tasaIva ? String(Number(p.tasaIva)) : "",
      };
    }
    return m;
  });
  const [error, setError] = useState<string | null>(null);
  const [conflicto, setConflicto] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [pendiente, start] = useTransition();
  const refError = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) refError.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [error]);

  const vista = useMemo(() => {
    const filas = compra.cantidadesOrden.map((q) => {
      const l = lineas[q.partidaVentaId];
      const cantidad = l.cantidad.trim() ? normalizarCantidad(l.cantidad) : null;
      const costo = l.costo.trim() ? normalizarImporte(l.costo, { permitirCero: false }) : null;
      const tasa = l.tratamiento === "GRAVADO" ? normalizarTasa(l.tasa) : null;
      let importe: string | null = null;
      if (cantidad && costo) {
        try {
          importe = calcularImportePartida(cantidad, costo);
        } catch {
          importe = null;
        }
      }
      const completa = Boolean(cantidad && costo && l.tratamiento && (l.tratamiento !== "GRAVADO" || tasa));
      return { q, l, cantidad, importe, completa, incluida: Boolean(l.cantidad.trim()), tasa };
    });
    const validas = filas.filter((f) => f.completa && f.importe);
    let totales = null;
    try {
      totales = calcularTotalesCotizacion(
        validas.map((f) => ({ importe: f.importe!, tratamientoImpuesto: f.l.tratamiento as TratamientoImpuestoCompra, tasaIva: f.tasa }))
      );
    } catch {
      totales = null;
    }
    const incluidas = filas.filter((f) => f.incluida);
    return { filas, totales, incompleta: incluidas.some((f) => !f.completa) };
  }, [lineas, compra.cantidadesOrden]);

  function datos() {
    return {
      proveedorId: proveedorId || null,
      fecha,
      notas,
      referenciaProveedor: compra.referenciaProveedor,
      partidas: compra.cantidadesOrden
        .filter((q) => lineas[q.partidaVentaId].cantidad.trim())
        .map((q) => {
          const l = lineas[q.partidaVentaId];
          return {
            partidaVentaId: q.partidaVentaId,
            cantidad: l.cantidad,
            costoUnitario: l.costo,
            tratamientoImpuesto: l.tratamiento,
            tasaIva: l.tratamiento === "GRAVADO" ? l.tasa : "",
          };
        }),
    };
  }

  function guardar(despues?: (version: number) => Promise<{ error?: string; conflicto?: boolean }>) {
    setError(null);
    setConflicto(false);
    start(async () => {
      const g = await guardarCompraAction({ id: compra.id, version: compra.version, datos: datos() });
      if (g.error) {
        setError(g.error);
        setConflicto(Boolean(g.conflicto));
        setConfirmando(false);
        return;
      }
      if (despues) {
        const r = await despues(g.version ?? compra.version);
        setConfirmando(false);
        if (r.error) {
          setError(r.error);
          setConflicto(Boolean(r.conflicto));
        }
      }
      router.refresh();
    });
  }

  function anular() {
    setError(null);
    start(async () => {
      const r = await anularCompraAction({ id: compra.id, motivo });
      if (r.error) return setError(r.error);
      setAnulando(false);
      router.refresh();
    });
  }

  const actualizar = (id: string, cambio: Partial<Linea>) => setLineas((m) => ({ ...m, [id]: { ...m[id], ...cambio } }));
  const nombreProveedor = compra.proveedorConfirmado?.nombre ?? compra.proveedorNombre;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {/* Regreso a la operación de origen, en su vista de compras. */}
          <Link href={`/comercializacion/cotizaciones/${compra.orden.cotizacionId}?vista=compras`} className={`${claseSecundaria} inline-flex min-h-9 items-center`}>
            ← {compra.orden.descripcion ?? `Operación ${compra.orden.folio}`}
          </Link>
          <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-[var(--foreground)] sm:text-3xl">
            {nombreProveedor ? `Compra a ${nombreProveedor}` : "Compra a proveedor"} <span className="font-normal text-[var(--muted)]">· {compra.folio}</span>
          </h1>
          <p className="mt-1 text-base text-[var(--foreground)]">
            Para la venta {compra.orden.folio}
            {compra.orden.clienteNombre && ` · ${compra.orden.clienteNombre}`}
            {compra.orden.obraNombre && <span className="text-[var(--muted)]"> · {compra.orden.obraNombre}</span>}
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Cotización {compra.orden.cotizacionFolio} · capturó {compra.creadaPorNombre}.
            {compra.confirmada && ` Confirmada el ${formatoFechaHora.format(new Date(compra.confirmada.en))} por ${compra.confirmada.porNombre}.`}
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-2.5 py-1 text-xs font-medium ${
            compra.estatus === "CONFIRMADA" ? "bg-emerald-50 text-emerald-800" : compra.estatus === "ANULADA" ? "bg-red-50 text-red-700" : "bg-black/[0.06] text-[var(--muted)]"
          }`}
        >
          {compra.estatus === "CONFIRMADA" ? "Confirmada" : compra.estatus === "ANULADA" ? "Anulada" : "Borrador"}
        </span>
      </div>

      {compra.anulada && (
        <div role="status" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
          Anulada el {formatoFechaHora.format(new Date(compra.anulada.en))} por {compra.anulada.porNombre}. Motivo: {compra.anulada.motivo}. Sus
          cantidades ya no cuentan como compradas.
        </div>
      )}

      <Card className="space-y-4 p-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Proveedor y fecha</h2>
        {editable ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectorProveedor
              proveedores={proveedores}
              proveedorId={proveedorId}
              onSeleccionar={setProveedorId}
              onCreado={(p) => {
                setProveedores((ps) => [...ps, p].sort((a, b) => a.nombre.localeCompare(b.nombre)));
                setProveedorId(p.id);
              }}
            />
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">Fecha de la compra</span>
              <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
            </label>
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-[var(--muted)]">Proveedor</dt>
              <dd className="text-sm">
                {nombreProveedor ?? "—"}
                {compra.proveedorConfirmado?.razonSocial && <div className="text-xs text-[var(--muted)]">{compra.proveedorConfirmado.razonSocial}</div>}
                {compra.proveedorConfirmado?.rfc && <div className="text-xs text-[var(--muted)]">RFC {compra.proveedorConfirmado.rfc}</div>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Fecha de la compra</dt>
              <dd className="text-sm">{formatearFechaCalendario(compra.fecha)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Notas</dt>
              <dd className="text-sm whitespace-pre-wrap">{compra.notas ?? "—"}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Materiales de la orden</h2>
          <p className="text-xs text-[var(--muted)]">
            {editable
              ? "Captura la cantidad que compras a este proveedor (vacío = no se incluye), el costo unitario sin IVA y si la partida lleva IVA (16 % sobre el importe) o no. Se compra en la unidad de la venta. El costo de referencia del catálogo es solo orientativo."
              : "Copia histórica de lo comprado."}
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.02]">
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                <th className="border-b border-[var(--border)] px-3 py-2.5">Material</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Pendiente por comprar</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Cantidad</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Costo unitario sin IVA</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5">Impuesto de compra</th>
                <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {editable
                ? vista.filas.map(({ q, l, importe, incluida, completa }) => {
                    const excede = incluida && normalizarCantidad(l.cantidad) !== null && Number(normalizarCantidad(l.cantidad)) > Number(q.pendiente);
                    return (
                      <tr key={q.partidaVentaId} className="border-b border-[var(--border)] last:border-0 align-top">
                        <td className="px-3 py-2.5">
                          <div className="font-medium">{q.codigo}</div>
                          <div className="text-xs text-[var(--muted)]">{q.descripcion}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                          {formatearCantidad(q.pendiente)} {q.unidad}
                          <div className="text-xs text-[var(--muted)]">de {formatearCantidad(q.vendido)} vendidos</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Input
                            value={l.cantidad}
                            onChange={(e) => actualizar(q.partidaVentaId, { cantidad: e.target.value })}
                            inputMode="decimal"
                            placeholder="0"
                            className={`w-28 ${excede ? "border-red-400" : ""}`}
                            aria-label={`Cantidad a comprar de ${q.codigo}`}
                          />
                          {excede && <div className="mt-0.5 text-xs text-red-700">Supera lo pendiente</div>}
                        </td>
                        <td className="px-3 py-2.5">
                          <Input
                            value={l.costo}
                            onChange={(e) => actualizar(q.partidaVentaId, { costo: e.target.value })}
                            inputMode="decimal"
                            placeholder="0.00"
                            className="w-32"
                            aria-label={`Costo unitario de ${q.codigo}`}
                          />
                          {q.costoReferencia && <div className="mt-0.5 text-xs text-[var(--muted)]">Ref. catálogo: {formatearImporte(q.costoReferencia)}</div>}
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={valorSelector(l)}
                            onChange={(e) => {
                              const v = e.target.value;
                              const anterior = anteriores[q.partidaVentaId];
                              const opcion = OPCIONES_IMPUESTO_COMPRA.find((o) => o.valor === v);
                              if (opcion) actualizar(q.partidaVentaId, { tratamiento: opcion.tratamiento, tasa: opcion.tasa ? String(Number(opcion.tasa)) : "" });
                              else if (v === "ANTERIOR" && anterior) actualizar(q.partidaVentaId, { tratamiento: anterior.tratamiento, tasa: anterior.tasa });
                              else actualizar(q.partidaVentaId, { tratamiento: "", tasa: "" });
                            }}
                            className={`${claseSelect} w-40`}
                            aria-label={`Impuesto de compra de ${q.codigo}`}
                          >
                            <option value="">Selecciona…</option>
                            {OPCIONES_IMPUESTO_COMPRA.map((o) => (
                              <option key={o.valor} value={o.valor}>
                                {o.etiqueta}
                              </option>
                            ))}
                            {anteriores[q.partidaVentaId] && (
                              <option value="ANTERIOR">
                                {etiquetaImpuesto(anteriores[q.partidaVentaId].tratamiento || null, normalizarTasa(anteriores[q.partidaVentaId].tasa))} (registro anterior)
                              </option>
                            )}
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                          {importe ? formatearImporte(importe) : <span className="text-[var(--muted)]">—</span>}
                          {incluida && !completa && <div className="text-xs text-amber-700">Incompleta</div>}
                        </td>
                      </tr>
                    );
                  })
                : compra.partidas.map((p) => (
                    <tr key={p.partidaVentaId} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{p.codigo}</div>
                        <div className="text-xs text-[var(--muted)]">{p.descripcion}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-[var(--muted)]">
                        {(() => {
                          const q = compra.cantidadesOrden.find((x) => x.partidaVentaId === p.partidaVentaId);
                          return q ? `${formatearCantidad(q.pendiente)} ${q.unidad}` : "—";
                        })()}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                        {formatearCantidad(p.cantidad)} {p.unidad}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{p.costoUnitario ? formatearImporte(p.costoUnitario) : "—"}</td>
                      <td className="px-3 py-2.5">{etiquetaImpuesto(p.tratamientoImpuesto, p.tasaIva)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{p.importe ? formatearImporte(p.importe) : "—"}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {(() => {
          const t = editable ? vista.totales : compra.totales;
          if (!t) return null;
          return (
            <div className="ml-auto w-full max-w-sm space-y-1 text-sm">
              <div className="flex justify-between gap-4">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatearImporte(t.subtotal)}</span>
              </div>
              {t.gravado.length === 0 ? (
                <div className="flex justify-between gap-4">
                  <span>IVA</span>
                  <span className="tabular-nums">{formatearImporte(t.iva)}</span>
                </div>
              ) : (
                t.gravado.map((g) => (
                  <div key={g.tasa} className="flex justify-between gap-4">
                    <span>
                      IVA {Number(g.tasa)} % sobre {formatearImporte(g.base)}
                    </span>
                    <span className="tabular-nums">{formatearImporte(g.iva)}</span>
                  </div>
                ))
              )}
              {t.baseSinIva !== "0.00" && (
                <div className="flex justify-between gap-4 text-[var(--muted)]">
                  <span>Importe sin IVA (no agrega impuesto)</span>
                  <span className="tabular-nums">{formatearImporte(t.baseSinIva)}</span>
                </div>
              )}
              {t.baseTasaCero !== "0.00" && (
                <div className="flex justify-between gap-4 text-[var(--muted)]">
                  <span>Base tasa 0 % (IVA $0.00)</span>
                  <span className="tabular-nums">{formatearImporte(t.baseTasaCero)}</span>
                </div>
              )}
              {t.baseExenta !== "0.00" && (
                <div className="flex justify-between gap-4 text-[var(--muted)]">
                  <span>Base exenta (sin IVA)</span>
                  <span className="tabular-nums">{formatearImporte(t.baseExenta)}</span>
                </div>
              )}
              <div className="flex justify-between gap-4 border-t border-[var(--border)] pt-1 text-base font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatearImporte(t.total)}</span>
              </div>
              {editable && vista.incompleta && (
                <p className="text-xs text-amber-700">Hay materiales sin costo o impuesto: no están en el total y la compra no se puede confirmar.</p>
              )}
            </div>
          );
        })()}
      </Card>

      {editable && (
        <Card className="p-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">Notas internas (opcional)</span>
            <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={2000} />
          </label>
        </Card>
      )}

      {compra.estatus !== "ANULADA" && <DocumentoProveedor compra={compra} />}
      {compra.estatus === "ANULADA" && compra.documento && (
        <p className="text-sm">
          Documento del proveedor:{" "}
          <a href={`/api/comercializacion/compras/${compra.id}/documento`} target="_blank" rel="noopener" className={claseEnlace}>
            {compra.documento.nombre}
          </a>
        </p>
      )}

      {error && (
        <div ref={refError} role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          <span>{error}</span>
          {conflicto && (
            <button type="button" onClick={() => router.refresh()} className={claseEnlace}>
              Recargar
            </button>
          )}
        </div>
      )}

      {confirmando && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <p className="font-medium">¿Confirmar la compra {compra.folio}?</p>
          <p className="mt-1 text-[var(--muted)]">
            Se guardan los cambios y la compra queda fija: sus cantidades cuentan como compradas. Para corregirla después habrá que
            anularla. Confirmar no registra pagos ni recepciones.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" disabled={pendiente} onClick={() =>
                guardar(async (v) => {
                  const r = await confirmarCompraAction({ id: compra.id, version: v });
                  if (!r.error) pedirCondiciones(compra.id);
                  return r;
                })
              }>
              {pendiente ? "Confirmando…" : "Confirmar compra"}
            </Button>
            <button type="button" onClick={() => setConfirmando(false)} className={claseSecundaria} disabled={pendiente}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {anulando && (
        <div className="rounded-lg border border-red-200 bg-[var(--surface)] p-4 text-sm">
          <p className="font-medium">{editable ? "Descartar el borrador" : "Anular la compra"} {compra.folio}</p>
          <p className="mt-1 text-[var(--muted)]">
            {editable
              ? "El borrador queda anulado (no se borra) y no afecta cantidades."
              : "Sus cantidades dejan de contar como compradas y quedan otra vez pendientes. El historial se conserva."}
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (obligatorio)" maxLength={500} className="sm:max-w-md" />
            <Button type="button" variant="outline" disabled={pendiente || motivo.trim().length < 3} onClick={anular}>
              {pendiente ? "Anulando…" : "Confirmar anulación"}
            </Button>
            <button type="button" onClick={() => setAnulando(false)} className={claseSecundaria} disabled={pendiente}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {compra.estatus !== "ANULADA" && (
        <div className="flex flex-wrap items-center gap-3">
          {editable && (
            <>
              <Button type="button" onClick={() => guardar()} disabled={pendiente}>
                {pendiente && !confirmando ? "Guardando…" : "Guardar borrador"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmando(true)} disabled={pendiente || confirmando}>
                Confirmar compra
              </Button>
            </>
          )}
          {!editable && bloqueosAnulacion.length > 0 ? (
            <div className="text-xs text-[var(--muted)]" data-bloqueos-anulacion>
              <p>No se puede anular con la acción simple:</p>
              <ul className="list-disc pl-5">
                {bloqueosAnulacion.map((b) => (
                  <li key={b.texto}>
                    {b.texto}
                    {b.enlaces.length > 0 && ": "}
                    {b.enlaces.map((e, i) => (
                      <span key={e.href}>
                        {i > 0 && ", "}
                        <Link href={e.href} className="font-medium text-[var(--brand)] hover:underline">
                          {e.etiqueta}
                        </Link>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <button type="button" onClick={() => setAnulando(true)} className={claseSecundaria} disabled={pendiente || anulando}>
              {editable ? "Descartar borrador" : "Anular compra"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SelectorProveedor({
  proveedores,
  proveedorId,
  onSeleccionar,
  onCreado,
}: {
  proveedores: OpcionProveedor[];
  proveedorId: string;
  onSeleccionar: (id: string) => void;
  onCreado: (p: OpcionProveedor) => void;
}) {
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  return (
    <div>
      <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-[var(--foreground)]">
        Proveedor
        {!creando && (
          <button type="button" onClick={() => setCreando(true)} className={claseEnlace}>
            + Nuevo proveedor
          </button>
        )}
      </span>
      {creando ? (
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del proveedor" maxLength={200} autoFocus />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={pendiente || !nombre.trim()}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await crearProveedorCompraAction({ nombre });
                  if (r.error || !r.proveedor) return setError(r.error ?? "No se pudo crear el proveedor.");
                  onCreado(r.proveedor);
                  setCreando(false);
                  setNombre("");
                })
              }
            >
              {pendiente ? "Guardando…" : "Agregar proveedor"}
            </Button>
            <button type="button" onClick={() => setCreando(false)} className={claseSecundaria}>
              Cancelar
            </button>
          </div>
          <p className="text-xs text-[var(--muted)]">Se agrega al catálogo de proveedores de la empresa (Catálogos).</p>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <select value={proveedorId} onChange={(e) => onSeleccionar(e.target.value)} className={claseSelect} aria-label="Proveedor">
          <option value="">Selecciona un proveedor</option>
          {proveedores.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function DocumentoProveedor({ compra }: { compra: CompraDetalle }) {
  const router = useRouter();
  const [state, formAction, pendiente] = useActionState<DocumentoCompraState, FormData>(adjuntarDocumentoCompraAction.bind(null, compra.id), undefined);
  const [referencia, setReferencia] = useState(compra.referenciaProveedor ?? "");
  const documento = useArchivosDeCarga(state, { maxArchivos: 1 });
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-[var(--foreground)]">Documento del proveedor</h2>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Opcional: referencia y archivo del proveedor (cotización, remisión, factura…). PDF, JPG o PNG de hasta {MB_POR_CARGA} MB. Solo administración
        puede verlo.
      </p>
      {compra.documento && (
        <p className="mt-2 text-sm">
          Actual:{" "}
          <a href={`/api/comercializacion/compras/${compra.id}/documento`} target="_blank" rel="noopener" className={claseEnlace}>
            {compra.documento.nombre}
          </a>
        </p>
      )}
      <form action={formAction} className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">Referencia del proveedor</span>
          <Input name="referenciaProveedor" value={referencia} onChange={(ev) => setReferencia(ev.target.value)} maxLength={100} placeholder="Folio de su cotización o factura" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">{compra.documento ? "Reemplazar archivo" : "Archivo"}</span>
          <input
            type="file"
            name="documento"
            accept="application/pdf,image/jpeg,image/png"
            onChange={documento.onChange}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-2 file:text-sm"
          />
          <AvisosArchivos
            exceso={documento.exceso}
            reseleccionar={state?.error && documento.debeReseleccionar ? "La referencia se conservó; vuelve a seleccionar el archivo." : null}
          />
        </label>
        <Button type="submit" variant="outline" disabled={pendiente || Boolean(documento.exceso)}>
          {pendiente ? "Guardando…" : "Guardar documento"}
        </Button>
        {state?.error && <p className="md:col-span-3 text-sm text-red-700">{state.error}</p>}
      </form>
    </Card>
  );
}

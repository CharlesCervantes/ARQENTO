"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  calcularImportePartida,
  calcularTotalesCotizacion,
  esImpuestoVenta,
  etiquetaImpuestoPartidaVenta,
  formatearCantidad,
  formatearImporte,
  impuestoDePartidaVenta,
  normalizarCantidad,
  normalizarImporte,
  OPCIONES_IMPUESTO_VENTA,
  TASA_IVA_VENTA,
  type ImpuestoVenta,
  type ModoImpuestoCotizacion,
  type TratamientoPartidaVenta,
} from "@/lib/comercializacion/importes";
import { filasImpuestoVenta } from "@/lib/comercializacion/totales-venta";
import type { ProductoParaVenta } from "@/lib/server/comercializacion/productos";
import type { OpcionCliente, OpcionObra } from "@/lib/server/comercializacion/clientes";
import type { CotizacionDetalle, OpcionVendedor } from "@/lib/server/comercializacion/cotizaciones";
import { ETIQUETA_SIN_VENDEDOR } from "@/lib/comercializacion/vendedor";
import {
  crearClienteAction,
  crearObraAction,
  emitirCotizacionAction,
  guardarCotizacionAction,
} from "@/app/(app)/comercializacion/actions";
import { coincideBusqueda } from "./productos-comun";

// Formulario único de cotización (nueva y borrador existente) — §5.2. Los
// importes que se ven aquí son una VISTA PREVIA con las mismas funciones
// exactas del servidor; el servidor vuelve a calcular todo al guardar y
// nunca recibe importes, impuestos ni (si es vendedor) precios. Del IVA solo
// recibe la opción de la venta («Con IVA»/«Sin IVA»).

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15 disabled:opacity-60";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";
const claseEnlace = "text-sm font-medium text-[var(--brand)] hover:underline";

type Linea = {
  clave: string;
  id: string | null;
  productoId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  // Impuesto guardado de la partida (cotizaciones anteriores o pendientes).
  // null en partidas nuevas: lo fija la opción de IVA de la cotización.
  tratamientoImpuesto: TratamientoPartidaVenta | null;
  tasaIva: string | null;
  precioBase: string;
  precioUnitario: string; // texto editable (solo administración)
  precioGuardado: string | null; // precio vigente ya guardado (partidas existentes)
  precioAjustado: boolean;
  cantidad: string; // texto editable
  productoActivo: boolean;
};

let contador = 0;
const nuevaClave = () => `l${Date.now().toString(36)}${(contador++).toString(36)}`;

function claveCreacionNueva(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function FormularioCotizacion({
  esAdmin,
  usuarioActual,
  clientesIniciales,
  obrasIniciales,
  vendedores,
  productos,
  hoy,
  cotizacion,
  accionesEncabezado,
}: {
  esAdmin: boolean;
  usuarioActual: OpcionVendedor;
  clientesIniciales: OpcionCliente[];
  obrasIniciales: OpcionObra[];
  vendedores: OpcionVendedor[];
  productos: ProductoParaVenta[];
  hoy: string;
  cotizacion?: CotizacionDetalle;
  /** Rediseño: «Más acciones» del borrador (administración). */
  accionesEncabezado?: React.ReactNode;
}) {
  const router = useRouter();
  const [clientes, setClientes] = useState(clientesIniciales);
  const [obras, setObras] = useState(obrasIniciales);
  const [clienteId, setClienteId] = useState(cotizacion?.clienteId ?? "");
  const [obraId, setObraId] = useState(cotizacion?.obraId ?? "");
  const [descripcion, setDescripcion] = useState(cotizacion?.descripcion ?? "");
  // "" = «Sin vendedor». Administración abre una cotización nueva sin
  // vendedor; el vendedor (función Vendedor) siempre queda él mismo.
  const [vendedorId, setVendedorId] = useState(cotizacion ? (cotizacion.vendedor?.id ?? "") : esAdmin ? "" : usuarioActual.id);
  const [fecha, setFecha] = useState(cotizacion?.fecha ?? hoy);
  const [vigenciaHasta, setVigenciaHasta] = useState(cotizacion?.vigenciaHasta ?? "");
  const [condiciones, setCondiciones] = useState(cotizacion?.condiciones ?? "");
  const [observaciones, setObservaciones] = useState(cotizacion?.observaciones ?? "");
  // Opción de IVA de toda la venta. Nueva: «Con IVA». Una cotización anterior
  // (null) o una copia PENDIENTE abren sin opción elegida: conservan su
  // impuesto por partida hasta que alguien elija explícitamente.
  const modoGuardado: ModoImpuestoCotizacion = cotizacion ? cotizacion.impuestoVenta : "CON_IVA";
  const [impuesto, setImpuesto] = useState<ImpuestoVenta | null>(esImpuestoVenta(modoGuardado) ? modoGuardado : null);
  const [lineas, setLineas] = useState<Linea[]>(() =>
    (cotizacion?.partidas ?? []).map((p) => ({
      clave: p.id,
      id: p.id,
      productoId: p.productoId,
      codigo: p.codigo,
      descripcion: p.descripcion,
      unidad: p.unidad,
      tratamientoImpuesto: p.tratamientoImpuesto,
      tasaIva: p.tasaIva,
      precioBase: p.precioBase,
      precioUnitario: p.precioUnitario,
      precioGuardado: p.precioUnitario,
      precioAjustado: p.precioAjustado,
      cantidad: formatearCantidad(p.cantidad).replace(/,/g, ""),
      productoActivo: p.productoActivo,
    }))
  );
  const [claveCreacion] = useState(claveCreacionNueva);
  const [error, setError] = useState<string | null>(null);
  const [conflicto, setConflicto] = useState(false);
  const refError = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) refError.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [error]);
  const [guardando, startGuardar] = useTransition();
  const [confirmandoEmision, setConfirmandoEmision] = useState(false);

  const obrasDelCliente = obras.filter((o) => o.clienteId === clienteId);
  const nombreVendedor = vendedorId ? (vendedores.find((v) => v.id === vendedorId)?.nombre ?? usuarioActual.nombre) : ETIQUETA_SIN_VENDEDOR;

  // Vista previa de importes (mismas funciones exactas que el servidor). Con
  // una opción elegida, su impuesto se aplica a TODAS las partidas.
  const vista = useMemo(() => {
    const deOpcion = impuesto ? impuestoDePartidaVenta(impuesto) : null;
    const importes = lineas.map((l) => {
      const cantidad = normalizarCantidad(l.cantidad);
      const precio = esAdmin ? normalizarImporte(l.precioUnitario, { permitirCero: false }) : l.precioUnitario;
      if (!cantidad || !precio) return null;
      try {
        return calcularImportePartida(cantidad, precio);
      } catch {
        return null;
      }
    });
    const sinImpuesto = !deOpcion && lineas.some((l) => !l.tratamientoImpuesto);
    const validas = lineas
      .map((l, i) => ({ importe: importes[i], ...(deOpcion ?? { tratamientoImpuesto: l.tratamientoImpuesto, tasaIva: l.tasaIva }) }))
      .filter(
        (p): p is { importe: string; tratamientoImpuesto: TratamientoPartidaVenta; tasaIva: string | null } =>
          p.importe !== null && p.tratamientoImpuesto !== null
      );
    let totales = null;
    try {
      totales = calcularTotalesCotizacion(validas);
    } catch {
      totales = null;
    }
    return { importes, totales, incompleta: validas.length !== lineas.length, sinImpuesto };
  }, [lineas, esAdmin, impuesto]);
  const cambiaImpuesto = Boolean(cotizacion) && impuesto !== null && impuesto !== modoGuardado;

  function agregarProducto(p: ProductoParaVenta) {
    setLineas((ls) => [
      ...ls,
      {
        clave: nuevaClave(),
        id: null,
        productoId: p.id,
        codigo: p.codigo,
        descripcion: p.descripcion,
        unidad: p.unidad,
        tratamientoImpuesto: null,
        tasaIva: null,
        precioBase: p.precioVenta,
        precioUnitario: p.precioVenta,
        precioGuardado: null,
        precioAjustado: false,
        cantidad: "1",
        productoActivo: true,
      },
    ]);
  }

  function actualizarLinea(clave: string, cambio: Partial<Linea>) {
    setLineas((ls) => ls.map((l) => (l.clave === clave ? { ...l, ...cambio } : l)));
  }

  function datosDelFormulario() {
    return {
      clienteId: clienteId || null,
      obraId: obraId || null,
      descripcion,
      // El vendedor no envía vendedorId: el servidor siempre lo fija a él.
      // Administración envía null para «Sin vendedor».
      ...(esAdmin ? { vendedorId: vendedorId || null } : {}),
      fecha,
      vigenciaHasta: vigenciaHasta || null,
      condiciones,
      observaciones,
      // Sin opción elegida (cotización anterior o pendiente) no se envía: el
      // servidor conserva el impuesto guardado.
      ...(impuesto ? { impuestoVenta: impuesto } : {}),
      partidas: lineas.map((l) => ({
        id: l.id,
        productoId: l.productoId,
        cantidad: l.cantidad,
        // Solo administración envía precio; el vendedor nunca.
        ...(esAdmin ? { precioUnitario: l.precioUnitario } : {}),
      })),
    };
  }

  // Emitir = guardar lo capturado (si hay cambios) y emitir esa versión. El
  // servidor valida los requisitos y congela la copia histórica.
  function emitir() {
    if (!cotizacion) return;
    setError(null);
    setConflicto(false);
    startGuardar(async () => {
      const g = await guardarCotizacionAction({ id: cotizacion.id, version: cotizacion.version, datos: datosDelFormulario() });
      if (g.error) {
        setError(g.error);
        setConflicto(Boolean(g.conflicto));
        setConfirmandoEmision(false);
        return;
      }
      const e = await emitirCotizacionAction({ id: cotizacion.id, version: g.version ?? cotizacion.version });
      setConfirmandoEmision(false);
      if (e.error) {
        setError(e.error);
        setConflicto(Boolean(e.conflicto));
      }
      router.refresh();
    });
  }

  function guardar() {
    setError(null);
    setConflicto(false);
    const datos = datosDelFormulario();
    startGuardar(async () => {
      const r = await guardarCotizacionAction(
        cotizacion ? { id: cotizacion.id, version: cotizacion.version, datos } : { claveCreacion, datos }
      );
      if (r.error) {
        setError(r.error);
        setConflicto(Boolean(r.conflicto));
        return;
      }
      if (!cotizacion && r.id) {
        router.push(`/comercializacion/cotizaciones/${r.id}`);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/comercializacion" className={claseSecundaria}>
            ← Operaciones
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--foreground)]">
            {cotizacion ? `Cotización ${cotizacion.folio}` : "Nueva cotización"}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {cotizacion
              ? `Borrador · capturó ${cotizacion.creadoPorNombre}. Cobro y entrega: no aplica mientras sea cotización.`
              : "Se guarda como borrador. Puedes completarla después."}
          </p>
          {cotizacion?.origen && (
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Duplicada de {esAdmin ? (
                <Link href={`/comercializacion/cotizaciones/${cotizacion.origen.id}`} className={claseEnlace}>
                  {cotizacion.origen.folio}
                </Link>
              ) : (
                cotizacion.origen.folio
              )}
              . Los precios se tomaron del catálogo vigente{esAdmin ? " o del original" : ""}.
            </p>
          )}
        </div>
        {cotizacion && (
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <span className="w-fit rounded-full bg-black/[0.06] px-2.5 py-1 text-xs font-medium text-[var(--muted)]">Borrador</span>
            {accionesEncabezado}
          </div>
        )}
      </div>

      <Card className="space-y-4 p-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Datos generales</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectorCliente
            clientes={clientes}
            clienteId={clienteId}
            onSeleccionar={(id) => {
              setClienteId(id);
              setObraId("");
            }}
            onCreado={(c) => {
              setClientes((cs) => (cs.some((x) => x.id === c.id) ? cs : [...cs, c].sort((a, b) => a.nombre.localeCompare(b.nombre))));
              setClienteId(c.id);
              setObraId("");
            }}
          />
          <SelectorObra
            clienteId={clienteId}
            obras={obrasDelCliente}
            obraId={obraId}
            onSeleccionar={setObraId}
            onCreada={(o) => {
              setObras((os) => (os.some((x) => x.id === o.id) ? os : [...os, o]));
              setObraId(o.id);
            }}
          />
          <Campo etiqueta="Descripción">
            <Input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={300} placeholder="Ej. Material para losa" />
          </Campo>
          <Campo etiqueta="Vendedor">
            {esAdmin ? (
              <select value={vendedorId} onChange={(e) => setVendedorId(e.target.value)} className={claseSelect}>
                <option value="">{ETIQUETA_SIN_VENDEDOR}</option>
                {vendedores.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.nombre}
                  </option>
                ))}
              </select>
            ) : (
              <p className="rounded-lg border border-[var(--border)] bg-black/[0.02] px-3.5 py-2.5 text-sm text-[var(--foreground)]">{nombreVendedor}</p>
            )}
          </Campo>
          <Campo etiqueta="Fecha">
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
          </Campo>
          <Campo etiqueta="Vigente hasta (opcional)">
            <Input type="date" value={vigenciaHasta} min={fecha} onChange={(e) => setVigenciaHasta(e.target.value)} />
          </Campo>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Materiales</h2>
          <p className="text-xs text-[var(--muted)]">
            Precios de venta sin IVA del catálogo; el IVA se elige abajo para toda la cotización.{" "}
            {esAdmin ? "Como administración puedes ajustar el precio de esta cotización; el catálogo no cambia." : "El precio lo autoriza administración."}
          </p>
        </div>

        <BuscadorProductos productos={productos} onAgregar={agregarProducto} />

        {lineas.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Todavía no hay materiales. Búscalos por código o descripción.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="bg-black/[0.02]">
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  <th className="border-b border-[var(--border)] px-3 py-2.5">Material</th>
                  <th className="border-b border-[var(--border)] px-3 py-2.5">Cantidad</th>
                  <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Precio sin IVA</th>
                  {!impuesto && <th className="border-b border-[var(--border)] px-3 py-2.5">Impuesto</th>}
                  <th className="border-b border-[var(--border)] px-3 py-2.5 text-right">Importe</th>
                  <th className="border-b border-[var(--border)] px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {lineas.map((l, i) => {
                  const cantidadValida = normalizarCantidad(l.cantidad) !== null;
                  const precioValido = !esAdmin || normalizarImporte(l.precioUnitario, { permitirCero: false }) !== null;
                  const ajustado =
                    esAdmin && normalizarImporte(l.precioUnitario, { permitirCero: false }) !== l.precioBase && precioValido;
                  return (
                    <tr key={l.clave} className="border-b border-[var(--border)] last:border-0 align-top">
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-[var(--foreground)]">{l.codigo}</div>
                        <div className="text-xs text-[var(--muted)]">{l.descripcion}</div>
                        {!l.productoActivo && <div className="text-xs text-amber-700">Producto inactivo en catálogo (se conserva en este borrador)</div>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <Input
                            value={l.cantidad}
                            onChange={(e) => actualizarLinea(l.clave, { cantidad: e.target.value })}
                            inputMode="decimal"
                            className={`w-28 ${cantidadValida ? "" : "border-red-400"}`}
                            aria-label={`Cantidad de ${l.codigo}`}
                          />
                          <span className="text-xs text-[var(--muted)]">{l.unidad}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {esAdmin ? (
                          <>
                            <Input
                              value={l.precioUnitario}
                              onChange={(e) => actualizarLinea(l.clave, { precioUnitario: e.target.value })}
                              inputMode="decimal"
                              className={`ml-auto w-32 text-right ${precioValido ? "" : "border-red-400"}`}
                              aria-label={`Precio de ${l.codigo}`}
                            />
                            {ajustado && <div className="mt-0.5 text-xs text-[var(--muted)]">Catálogo: {formatearImporte(l.precioBase)}</div>}
                          </>
                        ) : (
                          <>
                            <span className="tabular-nums">{formatearImporte(l.precioUnitario)}</span>
                            {l.precioAjustado && <div className="text-xs text-[var(--muted)]">Precio autorizado por administración</div>}
                          </>
                        )}
                      </td>
                      {!impuesto && (
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {l.tratamientoImpuesto ? (
                            etiquetaImpuestoPartidaVenta(l.tratamientoImpuesto, l.tasaIva)
                          ) : (
                            <span className="text-amber-700">Elige la opción de IVA</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {vista.importes[i] ? formatearImporte(vista.importes[i]) : <span className="text-[var(--muted)]">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => setLineas((ls) => ls.filter((x) => x.clave !== l.clave))}
                          className={claseSecundaria}
                          aria-label={`Quitar ${l.codigo}`}
                        >
                          Quitar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="ml-auto w-full max-w-sm space-y-3 text-sm">
          <SelectorImpuesto
            impuesto={impuesto}
            modoGuardado={modoGuardado}
            onCambiar={setImpuesto}
          />
          {vista.totales && lineas.length > 0 && (
            <div className="space-y-1" data-resumen-importes>
              <FilaTotal etiqueta="Subtotal" valor={vista.totales.subtotal} />
              {filasImpuestoVenta(vista.totales, impuesto).map((f) => (
                <FilaTotal key={f.etiqueta} etiqueta={f.etiqueta} valor={f.valor} tenue={f.tenue} />
              ))}
              <div className="border-t border-[var(--border)] pt-1">
                <FilaTotal etiqueta="Total" valor={vista.totales.total} fuerte />
              </div>
              {cambiaImpuesto && cotizacion && !vista.incompleta && (
                <p className="text-xs text-[var(--muted)]">
                  Total guardado: {formatearImporte(cotizacion.totales.total)}. Al guardar queda en {formatearImporte(vista.totales.total)}.
                </p>
              )}
              {vista.sinImpuesto && (
                <p className="text-xs text-amber-700">Para agregar materiales a esta cotización elige «Con IVA» o «Sin IVA».</p>
              )}
              {vista.incompleta && !vista.sinImpuesto && (
                <p className="text-xs text-amber-700">Hay partidas con cantidad o precio inválidos; no se incluyen en la vista previa.</p>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
        <Campo etiqueta="Condiciones">
          <Textarea value={condiciones} onChange={(e) => setCondiciones(e.target.value)} maxLength={2000} placeholder="Forma de pago, tiempos de entrega…" />
        </Campo>
        <Campo etiqueta="Observaciones">
          <Textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={2000} />
        </Campo>
      </Card>

      {/* El mensaje va ANTES del botón y se desplaza a la vista: al final de
          un formulario largo quedaba debajo del botón, fuera de pantalla
          (encontrado en la verificación en navegador de B2). */}
      {error && (
        <div
          ref={refError}
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
        >
          <span>{error}</span>
          {conflicto && (
            <button type="button" onClick={() => router.refresh()} className={claseEnlace}>
              Recargar
            </button>
          )}
        </div>
      )}
      {confirmandoEmision && cotizacion && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <p className="font-medium text-[var(--foreground)]">¿Emitir la cotización {cotizacion.folio}?</p>
          <p className="mt-1 text-[var(--muted)]">
            Se guardan los cambios y el documento queda congelado: ya no podrás editarlo (para corregirlo se duplica con un folio
            nuevo). Emitir no lo envía al cliente ni significa que lo aceptó. Requiere cliente, obra, descripción, vigencia, al
            menos un material y la opción de IVA.
          </p>
          {impuesto && vista.totales && (
            <p className="mt-1 text-[var(--muted)]">
              {impuesto === "CON_IVA" ? `Con IVA (${Number(TASA_IVA_VENTA)} %)` : "Sin IVA"} · Total {formatearImporte(vista.totales.total)}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" onClick={emitir} disabled={guardando}>
              {guardando ? "Emitiendo…" : "Confirmar emisión"}
            </Button>
            <button type="button" onClick={() => setConfirmandoEmision(false)} className={claseSecundaria} disabled={guardando}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="button" onClick={guardar} disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar borrador"}
        </Button>
        {cotizacion && (
          <>
            <Button type="button" variant="outline" onClick={() => setConfirmandoEmision(true)} disabled={guardando || confirmandoEmision}>
              Emitir cotización
            </Button>
            <a
              href={`/api/comercializacion/cotizaciones/${cotizacion.id}/pdf`}
              target="_blank"
              rel="noopener"
              className={claseEnlace}
            >
              Vista previa PDF (borrador guardado)
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Campo({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">{etiqueta}</span>
      {children}
    </label>
  );
}

/**
 * Opción de IVA de toda la cotización. Para un borrador anterior (impuesto
 * por partida) o una copia pendiente, ninguna opción está marcada hasta que
 * el usuario elige; puede volver a conservar el impuesto guardado.
 */
function SelectorImpuesto({
  impuesto,
  modoGuardado,
  onCambiar,
}: {
  impuesto: ImpuestoVenta | null;
  modoGuardado: ModoImpuestoCotizacion;
  onCambiar: (v: ImpuestoVenta | null) => void;
}) {
  const anterior = !esImpuestoVenta(modoGuardado);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium text-[var(--foreground)]">IVA de la cotización</legend>
      <div className="grid grid-cols-2 gap-2">
        {OPCIONES_IMPUESTO_VENTA.map((o) => {
          const activa = impuesto === o.valor;
          return (
            <label
              key={o.valor}
              className={`relative flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--brand)]/30 ${
                activa
                  ? "border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              <input
                type="radio"
                name="impuestoVenta"
                value={o.valor}
                checked={activa}
                onChange={() => onCambiar(o.valor)}
                className="sr-only"
              />
              {o.valor === "CON_IVA" ? `${o.etiqueta} (${Number(TASA_IVA_VENTA)} %)` : o.etiqueta}
            </label>
          );
        })}
      </div>
      {anterior && (
        <div className="space-y-1 text-xs text-[var(--muted)]">
          {modoGuardado === "PENDIENTE" ? (
            <p className="text-amber-700">
              Copia de un documento anterior cuyo impuesto (tasa 0 %, exento u otra tasa) no corresponde a estas opciones. Elige «Con IVA» o
              «Sin IVA» antes de emitir.
            </p>
          ) : (
            <p>Cotización anterior: conserva el impuesto de cada partida. Si eliges una opción, se aplica a todas las partidas.</p>
          )}
          {impuesto && (
            <button type="button" onClick={() => onCambiar(null)} className={claseEnlace}>
              {modoGuardado === "PENDIENTE" ? "Decidir después" : "Conservar el impuesto anterior"}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}

function FilaTotal({ etiqueta, valor, fuerte, tenue }: { etiqueta: string; valor: string; fuerte?: boolean; tenue?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${fuerte ? "text-base font-semibold text-[var(--foreground)]" : tenue ? "text-[var(--muted)]" : ""}`}>
      <span>{etiqueta}</span>
      <span className="tabular-nums">{formatearImporte(valor)}</span>
    </div>
  );
}

function BuscadorProductos({ productos, onAgregar }: { productos: ProductoParaVenta[]; onAgregar: (p: ProductoParaVenta) => void }) {
  const [busqueda, setBusqueda] = useState("");
  const resultados = busqueda.trim() ? productos.filter((p) => coincideBusqueda(p, busqueda)).slice(0, 8) : [];
  return (
    <div className="relative">
      <Input
        type="search"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder={productos.length ? "Agregar material: busca por código o descripción" : "No hay productos activos en el catálogo"}
        disabled={productos.length === 0}
        aria-label="Buscar material"
      />
      {busqueda.trim() && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg">
          {resultados.length === 0 ? (
            <p className="px-3.5 py-2.5 text-sm text-[var(--muted)]">Sin coincidencias entre los productos activos.</p>
          ) : (
            resultados.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onAgregar(p);
                  setBusqueda("");
                }}
                className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm hover:bg-black/[0.03]"
              >
                <span>
                  <span className="font-medium">{p.codigo}</span> <span className="text-[var(--muted)]">{p.descripcion}</span>
                </span>
                <span className="shrink-0 tabular-nums text-[var(--muted)]">
                  {formatearImporte(p.precioVenta)} / {p.unidad}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SelectorCliente({
  clientes,
  clienteId,
  onSeleccionar,
  onCreado,
}: {
  clientes: OpcionCliente[];
  clienteId: string;
  onSeleccionar: (id: string) => void;
  onCreado: (c: OpcionCliente) => void;
}) {
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [contacto, setContacto] = useState("");
  const [telefono, setTelefono] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();

  return (
    <div>
      <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-[var(--foreground)]">
        Cliente
        {!creando && (
          <button type="button" onClick={() => setCreando(true)} className={claseEnlace}>
            + Nuevo cliente
          </button>
        )}
      </span>
      {creando ? (
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del cliente" maxLength={200} autoFocus />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input value={contacto} onChange={(e) => setContacto(e.target.value)} placeholder="Contacto (opcional)" maxLength={200} />
            <Input value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="Teléfono (opcional)" maxLength={40} />
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={pendiente || !nombre.trim()}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await crearClienteAction({ nombre, contacto, telefono });
                  if (r.error || !r.cliente) return setError(r.error ?? "No se pudo crear el cliente.");
                  onCreado(r.cliente);
                  setCreando(false);
                  setNombre("");
                  setContacto("");
                  setTelefono("");
                })
              }
            >
              {pendiente ? "Guardando…" : "Agregar cliente"}
            </Button>
            <button type="button" onClick={() => setCreando(false)} className={claseSecundaria}>
              Cancelar
            </button>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <select value={clienteId} onChange={(e) => onSeleccionar(e.target.value)} className={claseSelect} aria-label="Cliente">
          <option value="">Sin cliente todavía</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function SelectorObra({
  clienteId,
  obras,
  obraId,
  onSeleccionar,
  onCreada,
}: {
  clienteId: string;
  obras: OpcionObra[];
  obraId: string;
  onSeleccionar: (id: string) => void;
  onCreada: (o: OpcionObra) => void;
}) {
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [ubicacion, setUbicacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();

  return (
    <div>
      <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-[var(--foreground)]">
        Obra
        {!creando && clienteId && (
          <button type="button" onClick={() => setCreando(true)} className={claseEnlace}>
            + Nueva obra
          </button>
        )}
      </span>
      {creando && clienteId ? (
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre de la obra" maxLength={200} autoFocus />
          <Input value={ubicacion} onChange={(e) => setUbicacion(e.target.value)} placeholder="Ubicación (opcional)" maxLength={300} />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={pendiente || !nombre.trim()}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await crearObraAction({ clienteId, nombre, ubicacion });
                  if (r.error || !r.obra) return setError(r.error ?? "No se pudo crear la obra.");
                  onCreada(r.obra);
                  setCreando(false);
                  setNombre("");
                  setUbicacion("");
                })
              }
            >
              {pendiente ? "Guardando…" : "Agregar obra"}
            </Button>
            <button type="button" onClick={() => setCreando(false)} className={claseSecundaria}>
              Cancelar
            </button>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <select
          value={obraId}
          onChange={(e) => onSeleccionar(e.target.value)}
          className={claseSelect}
          disabled={!clienteId}
          aria-label="Obra"
        >
          <option value="">{clienteId ? "Sin obra todavía" : "Selecciona primero un cliente"}</option>
          {obras.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nombre}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

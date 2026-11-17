"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, Thead, Th, Tr, Td } from "@/components/ui/table";
import {
  calcularImpuesto,
  ETIQUETA_TRATAMIENTO,
  formatearImporte,
  normalizarImporte,
  normalizarTasa,
  TASA_IVA_INICIAL,
  TRATAMIENTOS_IMPUESTO,
  type TratamientoImpuesto,
} from "@/lib/comercializacion/importes";
import type { EntradaHistorialProducto, ProductoAdministracion } from "@/lib/server/comercializacion/productos";
import {
  cambiarEstatusProductoAction,
  crearProductoAction,
  editarProductoAction,
  historialProductoAction,
  type ProductoFormState,
} from "@/app/(app)/comercializacion/actions";
import { coincideBusqueda, etiquetaImpuesto } from "./productos-comun";

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";

const claseEnlace = "text-sm font-medium text-[var(--brand)] hover:underline";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";

// Vista de administración (Administrador/Director): catálogo completo con
// costo de referencia privado, alta, edición, desactivación/reactivación e
// historial. Los productos nunca se borran.
export function ProductosAdministracionView({ productos }: { productos: ProductoAdministracion[] }) {
  const [busqueda, setBusqueda] = useState("");
  const [mostrarInactivos, setMostrarInactivos] = useState(false);
  const [creando, setCreando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [desactivando, setDesactivando] = useState<string | null>(null);
  const [historialDe, setHistorialDe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, startTransition] = useTransition();

  const inactivos = productos.filter((p) => !p.activo).length;
  const visibles = useMemo(
    () => productos.filter((p) => (mostrarInactivos || p.activo) && coincideBusqueda(p, busqueda)),
    [productos, busqueda, mostrarInactivos]
  );

  function reactivar(id: string) {
    setError(null);
    startTransition(async () => {
      const r = await cambiarEstatusProductoAction(id, true);
      if (r.error) setError(r.error);
    });
  }

  const productoEditando = productos.find((p) => p.id === editando) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Productos</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Catálogo de venta de tu empresa. Precios sin IVA. El costo de referencia es privado: el vendedor no lo ve.
          </p>
        </div>
        {!creando && (
          <Button type="button" onClick={() => { setCreando(true); setEditando(null); }}>
            + Nuevo producto
          </Button>
        )}
      </div>

      {creando && (
        <Card className="enter p-5">
          <h2 className="mb-3 text-base font-semibold text-[var(--foreground)]">Nuevo producto</h2>
          <FormularioProducto onListo={() => setCreando(false)} />
        </Card>
      )}

      {productoEditando && (
        <Card className="enter p-5">
          <h2 className="mb-3 text-base font-semibold text-[var(--foreground)]">Editar {productoEditando.codigo}</h2>
          <FormularioProducto key={productoEditando.id} producto={productoEditando} onListo={() => setEditando(null)} />
        </Card>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          type="search"
          placeholder="Buscar por código o descripción"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          className="sm:max-w-sm"
          aria-label="Buscar productos"
        />
        {inactivos > 0 && (
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <input type="checkbox" checked={mostrarInactivos} onChange={(e) => setMostrarInactivos(e.target.checked)} />
            Mostrar inactivos ({inactivos})
          </label>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      {productos.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay productos. Agrega el primero con «Nuevo producto». La carga masiva desde archivo llegará
          cuando se defina el formato del catálogo inicial.
        </Card>
      ) : visibles.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">Ningún producto coincide con la búsqueda.</Card>
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Código</Th>
              <Th>Descripción</Th>
              <Th>Unidad</Th>
              <Th className="text-right">Precio sin IVA</Th>
              <Th>Impuesto</Th>
              <Th className="text-right">Costo ref.</Th>
              <Th>Estado</Th>
              <Th className="text-right">Acciones</Th>
            </tr>
          </Thead>
          <tbody>
            {visibles.map((p) => (
              <FilaProducto
                key={p.id}
                producto={p}
                pendiente={pendiente}
                onEditar={() => { setEditando(p.id); setCreando(false); }}
                onDesactivar={() => setDesactivando(desactivando === p.id ? null : p.id)}
                onReactivar={() => reactivar(p.id)}
                onHistorial={() => setHistorialDe(historialDe === p.id ? null : p.id)}
                desactivando={desactivando === p.id}
                onCerrarDesactivar={() => setDesactivando(null)}
                historialAbierto={historialDe === p.id}
              />
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function FilaProducto({
  producto: p,
  pendiente,
  onEditar,
  onDesactivar,
  onReactivar,
  onHistorial,
  desactivando,
  onCerrarDesactivar,
  historialAbierto,
}: {
  producto: ProductoAdministracion;
  pendiente: boolean;
  onEditar: () => void;
  onDesactivar: () => void;
  onReactivar: () => void;
  onHistorial: () => void;
  desactivando: boolean;
  onCerrarDesactivar: () => void;
  historialAbierto: boolean;
}) {
  return (
    <>
      <Tr className={p.activo ? undefined : "opacity-60"}>
        <Td className="font-medium whitespace-nowrap">{p.codigo}</Td>
        <Td>{p.descripcion}</Td>
        <Td className="whitespace-nowrap">{p.unidad}</Td>
        <Td className="text-right tabular-nums whitespace-nowrap">{formatearImporte(p.precioVenta)}</Td>
        <Td className="whitespace-nowrap" title={ETIQUETA_TRATAMIENTO[p.tratamientoImpuesto]}>
          {etiquetaImpuesto(p)}
        </Td>
        <Td className="text-right tabular-nums whitespace-nowrap">{formatearImporte(p.costoReferencia)}</Td>
        <Td className="whitespace-nowrap">
          {p.activo ? (
            "Activo"
          ) : (
            <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">Inactivo</span>
          )}
        </Td>
        <Td className="text-right whitespace-nowrap">
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onEditar} className={claseEnlace}>
              Editar
            </button>
            {p.activo ? (
              <button type="button" onClick={onDesactivar} className={claseSecundaria}>
                Desactivar
              </button>
            ) : (
              <button type="button" onClick={onReactivar} disabled={pendiente} className={claseSecundaria}>
                Reactivar
              </button>
            )}
            <button type="button" onClick={onHistorial} className={claseSecundaria} aria-expanded={historialAbierto}>
              Historial
            </button>
          </div>
        </Td>
      </Tr>
      {desactivando && (
        <tr>
          <td colSpan={8} className="border-b border-[var(--border)] bg-black/[0.015] px-3.5 py-3">
            <FormularioDesactivar productoId={p.id} codigo={p.codigo} onListo={onCerrarDesactivar} />
          </td>
        </tr>
      )}
      {historialAbierto && (
        <tr>
          <td colSpan={8} className="border-b border-[var(--border)] bg-black/[0.015] px-3.5 py-3">
            <HistorialProducto productoId={p.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function FormularioDesactivar({ productoId, codigo, onListo }: { productoId: string; codigo: string; onListo: () => void }) {
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="text-sm text-[var(--foreground)]">
        Desactivar <strong>{codigo}</strong>: deja de ofrecerse para nuevas ventas y conserva su historial.
      </span>
      <Input
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Motivo (opcional)"
        maxLength={300}
        className="sm:max-w-xs"
      />
      <Button
        type="button"
        variant="outline"
        disabled={pendiente}
        onClick={() =>
          startTransition(async () => {
            const r = await cambiarEstatusProductoAction(productoId, false, motivo.trim());
            if (r.error) setError(r.error);
            else onListo();
          })
        }
      >
        {pendiente ? "Desactivando…" : "Confirmar"}
      </Button>
      <button type="button" onClick={onListo} className={claseSecundaria}>
        Cancelar
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

const ETIQUETA_CAMPO: Record<string, string> = {
  codigo: "Código",
  descripcion: "Descripción",
  unidad: "Unidad",
  precioVenta: "Precio sin IVA",
  costoReferencia: "Costo de referencia",
  tratamientoImpuesto: "Impuesto",
  tasaIva: "Tasa IVA",
  activo: "Estado",
};

const ETIQUETA_ACCION: Record<EntradaHistorialProducto["accion"], string> = {
  CREAR: "Alta",
  EDITAR: "Edición",
  ACTIVAR: "Reactivación",
  DESACTIVAR: "Desactivación",
};

function valorLegible(campo: string, valor: string | null): string {
  if (valor === null) return "—";
  if (campo === "precioVenta" || campo === "costoReferencia") return formatearImporte(valor);
  if (campo === "tasaIva") return `${Number(valor)} %`;
  if (campo === "tratamientoImpuesto") return ETIQUETA_TRATAMIENTO[valor as TratamientoImpuesto] ?? valor;
  if (campo === "activo") return valor === "true" ? "Activo" : "Inactivo";
  return valor;
}

const formatoFecha = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });

function HistorialProducto({ productoId }: { productoId: string }) {
  const [estado, setEstado] = useState<{ cargando: boolean; error?: string; historial?: EntradaHistorialProducto[] }>({
    cargando: true,
  });
  useEffect(() => {
    let vigente = true;
    historialProductoAction(productoId).then((r) => {
      if (vigente) setEstado({ cargando: false, ...r });
    });
    return () => {
      vigente = false;
    };
  }, [productoId]);

  if (estado.cargando) return <p className="text-sm text-[var(--muted)]">Cargando historial…</p>;
  if (estado.error) return <p className="text-sm text-red-700">{estado.error}</p>;
  if (!estado.historial?.length) return <p className="text-sm text-[var(--muted)]">Sin movimientos registrados.</p>;

  return (
    <ul className="space-y-2 text-sm">
      {estado.historial.map((h) => (
        <li key={h.id}>
          <span className="font-medium text-[var(--foreground)]">{ETIQUETA_ACCION[h.accion]}</span>
          <span className="text-[var(--muted)]">
            {" "}
            · {formatoFecha.format(new Date(h.fecha))} · {h.usuarioNombre ?? "Sistema"}
          </span>
          {h.accion === "EDITAR" && (
            <ul className="mt-0.5 ml-4 list-disc text-[var(--muted)]">
              {h.cambios.map((c) => (
                <li key={c.campo}>
                  {ETIQUETA_CAMPO[c.campo] ?? c.campo}: {valorLegible(c.campo, c.anterior)} → {valorLegible(c.campo, c.nuevo)}
                </li>
              ))}
            </ul>
          )}
          {h.accion === "CREAR" && (
            <p className="ml-4 text-[var(--muted)]">
              Precio {valorLegible("precioVenta", h.cambios.find((c) => c.campo === "precioVenta")?.nuevo ?? null)}
              {" · "}Costo {valorLegible("costoReferencia", h.cambios.find((c) => c.campo === "costoReferencia")?.nuevo ?? null)}
            </p>
          )}
          {h.motivo && <p className="ml-4 text-[var(--muted)]">Motivo: {h.motivo}</p>}
        </li>
      ))}
    </ul>
  );
}

function FormularioProducto({ producto, onListo }: { producto?: ProductoAdministracion; onListo: () => void }) {
  const action = producto ? editarProductoAction.bind(null, producto.id) : crearProductoAction;
  const [state, formAction, pending] = useActionState<ProductoFormState, FormData>(action, undefined);
  const [stateAnterior, setStateAnterior] = useState(state);
  if (state !== stateAnterior) {
    setStateAnterior(state);
    if (state?.guardado) onListo();
  }

  // Todos los campos CONTROLADOS: React 19 limpia los campos no controlados
  // de un <form action> después de cada envío, también cuando el servidor
  // responde con un error de validación — el usuario perdía lo capturado
  // (encontrado en la verificación en navegador de B1/B2).
  const [codigo, setCodigo] = useState(producto?.codigo ?? "");
  const [descripcion, setDescripcion] = useState(producto?.descripcion ?? "");
  const [unidad, setUnidad] = useState(producto?.unidad ?? "");
  const [costo, setCosto] = useState(producto?.costoReferencia ?? "");
  const [precio, setPrecio] = useState(producto?.precioVenta ?? "");
  const [tratamiento, setTratamiento] = useState<TratamientoImpuesto>(producto?.tratamientoImpuesto ?? "GRAVADO");
  const [tasa, setTasa] = useState(producto?.tasaIva ? String(Number(producto.tasaIva)) : String(Number(TASA_IVA_INICIAL)));

  // Vista previa solamente — el servidor vuelve a validar y calcular.
  const precioNormalizado = normalizarImporte(precio, { permitirCero: false });
  const tasaNormalizada = tratamiento === "GRAVADO" ? normalizarTasa(tasa) : null;
  const vistaPrevia =
    precioNormalizado && (tratamiento !== "GRAVADO" || tasaNormalizada)
      ? calcularImpuesto(precioNormalizado, tratamiento, tasaNormalizada)
      : null;

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Campo etiqueta="Código">
          <Input name="codigo" required maxLength={40} value={codigo} onChange={(e) => setCodigo(e.target.value)} autoComplete="off" />
        </Campo>
        <div className="sm:col-span-2">
          <Campo etiqueta="Descripción">
            <Input name="descripcion" required maxLength={300} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
          </Campo>
        </div>
        <Campo etiqueta="Unidad">
          <Input name="unidad" required maxLength={20} placeholder="pza, m², ton…" value={unidad} onChange={(e) => setUnidad(e.target.value)} />
        </Campo>
        <Campo etiqueta="Precio de venta sin IVA">
          <Input
            name="precioVenta"
            required
            inputMode="decimal"
            placeholder="0.00"
            value={precio}
            onChange={(e) => setPrecio(e.target.value)}
          />
        </Campo>
        <Campo etiqueta="Impuesto">
          <select
            name="tratamientoImpuesto"
            value={tratamiento}
            onChange={(e) => setTratamiento(e.target.value as TratamientoImpuesto)}
            className={claseSelect}
          >
            {TRATAMIENTOS_IMPUESTO.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TRATAMIENTO[t]}
              </option>
            ))}
          </select>
        </Campo>
        {tratamiento === "GRAVADO" && (
          <Campo etiqueta="Tasa de IVA (%)">
            <Input name="tasaIva" required inputMode="decimal" value={tasa} onChange={(e) => setTasa(e.target.value)} />
          </Campo>
        )}
        <Campo etiqueta="Costo de referencia (privado, opcional)">
          <Input
            name="costoReferencia"
            inputMode="decimal"
            placeholder="0.00"
            value={costo}
            onChange={(e) => setCosto(e.target.value)}
          />
        </Campo>
      </div>
      <p className="text-xs text-[var(--muted)]">
        {vistaPrevia
          ? `Precio con impuesto: ${formatearImporte(vistaPrevia.total)} (IVA ${formatearImporte(vistaPrevia.iva)}).`
          : "Captura un precio mayor que 0 con máximo 2 decimales."}
        {producto && " Cambiar el precio aquí no modifica cotizaciones ya guardadas."}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : producto ? "Guardar cambios" : "Guardar producto"}
        </Button>
        <button type="button" onClick={onListo} className={claseSecundaria}>
          Cancelar
        </button>
        {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
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

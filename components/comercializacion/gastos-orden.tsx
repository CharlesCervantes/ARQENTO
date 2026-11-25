"use client";

import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GastoDetalle, ResumenGastosOrden } from "@/lib/server/comercializacion/gastos";
import { aCentavos, calcularImpuesto, deCentavos, ETIQUETA_TRATAMIENTO, formatearImporte, normalizarImporte, normalizarTasa, TRATAMIENTOS_IMPUESTO, type TratamientoImpuesto } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { ETIQUETA_LIQUIDACION, ETIQUETA_SITUACION } from "@/lib/comercializacion/cuentas";
import { anularGastoAction, crearProveedorCompraAction, registrarGastoAction, type GastoState } from "@/app/(app)/comercializacion/actions";
import { pedirCondiciones } from "./asistente-condiciones";
import { CuentaComercialView } from "./cuenta-comercial";
import { AvisosArchivos, useArchivosDeCarga } from "./campo-archivos";
import { PanelLateral } from "./panel-lateral";
import { BOTON_PRIMARIO, BOTON_SECUNDARIO } from "./estilos";

// Gastos adicionales de una OV — B7. SOLO administración (la página no los
// consulta para el vendedor). Un gasto se guarda vigente con su cuenta por
// pagar (B5); sus pagos se registran en su propio bloque. No se edita: sin
// historial de pagos se anula con motivo y se captura el correcto.

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";
const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });
const clave = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function GastosOrden({
  resumen,
  beneficiarios,
  ordenCancelada = false,
}: {
  resumen: ResumenGastosOrden;
  beneficiarios: { id: string; nombre: string }[];
  ordenCancelada?: boolean;
}) {
  const [capturando, setCapturando] = useState(false);
  const cerrar = useCallback(() => setCapturando(false), []);
  const vigentes = resumen.gastos.filter((g) => g.estatus === "VIGENTE");
  const totalBase = deCentavos(vigentes.reduce((s, g) => s + aCentavos(g.subtotal), BigInt(0)));
  return (
    <Card id="gastos" className="scroll-mt-6 space-y-4 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">Gastos adicionales</h2>
          <p className="text-sm text-[var(--muted)]">Fletes, maniobras o servicios externos. Guardar un gasto crea su cuenta por pagar; no significa que esté pagado.</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {vigentes.length} vigente{vigentes.length === 1 ? "" : "s"} · {formatearImporte(totalBase)} sin IVA
          </p>
        </div>
        {ordenCancelada ? (
          <span className="text-sm text-[var(--muted)]">OV cancelada: no admite nuevos gastos.</span>
        ) : (
          <button type="button" className={BOTON_PRIMARIO} onClick={() => setCapturando(true)}>
            + Agregar gasto
          </button>
        )}
      </div>

      <PanelLateral abierto={capturando && !ordenCancelada} onCerrar={cerrar} titulo="Agregar gasto adicional" contexto={resumen.folio}>
        <FormularioGasto resumen={resumen} beneficiariosIniciales={beneficiarios} onListo={cerrar} />
      </PanelLateral>

      {resumen.gastos.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Sin gastos adicionales registrados.</p>
      ) : (
        <ul className="space-y-3">
          {resumen.gastos.map((g) => (
            <Gasto key={g.id} g={g} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function FormularioGasto({
  resumen,
  beneficiariosIniciales,
  onListo,
}: {
  resumen: ResumenGastosOrden;
  beneficiariosIniciales: { id: string; nombre: string }[];
  onListo: () => void;
}) {
  const router = useRouter();
  const [claveRegistro] = useState(clave);
  const [beneficiarios, setBeneficiarios] = useState(beneficiariosIniciales);
  // Campos controlados: se conservan si el servidor rechaza el registro.
  const [concepto, setConcepto] = useState("");
  const [beneficiarioId, setBeneficiarioId] = useState("");
  const [fecha, setFecha] = useState(resumen.hoy);
  const [subtotal, setSubtotal] = useState("");
  const [tratamiento, setTratamiento] = useState<TratamientoImpuesto | "">("");
  const [tasa, setTasa] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [nuevoProveedor, setNuevoProveedor] = useState<string | null>(null);
  const [errorProveedor, setErrorProveedor] = useState<string | null>(null);
  const [creandoProveedor, startProveedor] = useTransition();
  const [state, formAction, pendiente] = useActionState<GastoState, FormData>(registrarGastoAction.bind(null, resumen.ordenVentaId), undefined);
  const comprobante = useArchivosDeCarga(state, { maxArchivos: 1 });
  useEffect(() => {
    if (state?.ok) {
      onListo();
      if (state.gastoId) pedirCondiciones(state.gastoId);
      router.refresh();
    }
  }, [state, onListo, router]);

  // Vista previa con las mismas reglas del servidor (que vuelve a calcular).
  const base = normalizarImporte(subtotal, { permitirCero: false });
  const tasaNormal = tratamiento === "GRAVADO" ? normalizarTasa(tasa) : null;
  const previa = base && tratamiento && (tratamiento !== "GRAVADO" || tasaNormal) ? calcularImpuesto(base, tratamiento, tasaNormal) : null;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="clave" value={claveRegistro} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Concepto</span>
          <Input name="concepto" value={concepto} onChange={(ev) => setConcepto(ev.target.value)} maxLength={200} placeholder="Flete, maniobra, servicio externo…" required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Fecha del gasto</span>
          <Input type="date" name="fecha" value={fecha} max={resumen.hoy} onChange={(ev) => setFecha(ev.target.value)} required />
        </label>
        <div className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Beneficiario o proveedor</span>
          <div className="flex flex-wrap items-center gap-3">
            <select name="beneficiarioId" value={beneficiarioId} onChange={(ev) => setBeneficiarioId(ev.target.value)} className={claseSelect} aria-label="Beneficiario o proveedor" required>
              <option value="">Selecciona…</option>
              {beneficiarios.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nombre}
                </option>
              ))}
            </select>
            {nuevoProveedor === null ? (
              <button type="button" className={claseSecundaria} onClick={() => setNuevoProveedor("")}>
                + Nuevo proveedor
              </button>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <Input value={nuevoProveedor} onChange={(ev) => setNuevoProveedor(ev.target.value)} placeholder="Nombre del proveedor" maxLength={200} className="w-64" aria-label="Nombre del nuevo proveedor" />
                <Button
                  type="button"
                  variant="outline"
                  disabled={creandoProveedor || !nuevoProveedor.trim()}
                  onClick={() =>
                    startProveedor(async () => {
                      setErrorProveedor(null);
                      const r = await crearProveedorCompraAction({ nombre: nuevoProveedor });
                      if (r.error || !r.proveedor) return setErrorProveedor(r.error ?? "No se pudo registrar el proveedor.");
                      const p = r.proveedor;
                      setBeneficiarios((bs) => (bs.some((b) => b.id === p.id) ? bs : [...bs, p].sort((a, b) => a.nombre.localeCompare(b.nombre))));
                      setBeneficiarioId(p.id);
                      setNuevoProveedor(null);
                    })
                  }
                >
                  {creandoProveedor ? "Guardando…" : "Agregar"}
                </Button>
                <button type="button" className={claseSecundaria} onClick={() => setNuevoProveedor(null)}>
                  Cancelar
                </button>
                {errorProveedor && <span className="text-sm text-red-700">{errorProveedor}</span>}
              </span>
            )}
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Importe sin IVA</span>
          <Input name="subtotal" value={subtotal} onChange={(ev) => setSubtotal(ev.target.value)} inputMode="decimal" placeholder="0.00" required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Impuesto</span>
          <select
            name="tratamientoImpuesto"
            value={tratamiento}
            onChange={(ev) => setTratamiento(ev.target.value as TratamientoImpuesto | "")}
            className={claseSelect}
            required
          >
            <option value="">Selecciona…</option>
            {TRATAMIENTOS_IMPUESTO.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TRATAMIENTO[t]}
              </option>
            ))}
          </select>
        </label>
        {tratamiento === "GRAVADO" && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Tasa de IVA (%)</span>
            <Input name="tasaIva" value={tasa} onChange={(ev) => setTasa(ev.target.value)} inputMode="decimal" placeholder="Ej. 16" required />
          </label>
        )}
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Observaciones (opcional)</span>
          <Input name="observaciones" value={observaciones} onChange={(ev) => setObservaciones(ev.target.value)} maxLength={1000} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Comprobante (opcional, PDF/JPG/PNG)</span>
          <input
            type="file"
            name="comprobante"
            accept="application/pdf,image/jpeg,image/png"
            onChange={comprobante.onChange}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-2 file:text-sm"
          />
          <AvisosArchivos
            exceso={comprobante.exceso}
            reseleccionar={state?.error && comprobante.debeReseleccionar ? "Los datos se conservaron; vuelve a seleccionar el comprobante (si no, se registrará sin él)." : null}
          />
        </label>
      </div>
      <p className="text-sm" data-previa-gasto>
        {previa ? (
          <>
            IVA {formatearImporte(previa.iva)} · Total con impuestos <span className="font-semibold">{formatearImporte(previa.total)}</span> (por pagar)
          </>
        ) : (
          <span className="text-[var(--muted)]">Indica importe e impuesto para ver el total.</span>
        )}
      </p>
      <p className="text-xs text-[var(--muted)]">El impuesto no se supone: elige gravado con su tasa, tasa 0 % o exento. Un gasto guardado no se edita; se anula con motivo.</p>
      {state?.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={BOTON_PRIMARIO} disabled={pendiente || !previa || !beneficiarioId || !concepto.trim() || Boolean(comprobante.exceso)}>
          {pendiente ? "Guardando…" : "Guardar gasto"}
        </button>
        <button type="button" onClick={onListo} className={BOTON_SECUNDARIO} disabled={pendiente}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

const contextoGasto = (g: GastoDetalle) => `Gasto ${g.numero} · ${g.concepto} · ${g.beneficiarioNombre}`;

function Gasto({ g }: { g: GastoDetalle }) {
  const router = useRouter();
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  const anulado = g.estatus === "ANULADO";
  const conPagos = Boolean(g.cuenta?.tuvoMovimientos);
  const e = g.cuenta?.estado;
  return (
    <li id={`gasto-${g.id}`} className={`scroll-mt-6 space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm ${anulado ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className={`font-semibold ${anulado ? "line-through" : ""}`}>
            Gasto {g.numero}: {g.concepto}
          </span>
          <span className="text-[var(--muted)]">
            {" "}
            · {g.beneficiarioNombre} · {formatearFechaCalendario(g.fecha)}
          </span>
          {anulado && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Anulado</span>}
          {!anulado && e && (
            <span className="ml-2 rounded-full bg-black/[0.06] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
              {e.liquidacion === "LIQUIDADA" ? "Pagado" : `${ETIQUETA_LIQUIDACION[e.liquidacion]} · ${ETIQUETA_SITUACION[e.situacion]}`}
            </span>
          )}
        </div>
        <span className="tabular-nums">
          {formatearImporte(g.subtotal)} + IVA {formatearImporte(g.iva)} ={" "}
          <span className="font-semibold">{formatearImporte(g.total)}</span>
          <span className="text-xs text-[var(--muted)]">
            {" "}
            ({ETIQUETA_TRATAMIENTO[g.tratamientoImpuesto]}
            {g.tasaIva ? ` ${Number(g.tasaIva)} %` : ""})
          </span>
        </span>
      </div>
      <p className="text-xs text-[var(--muted)]">
        {g.comprobanteNombre ? (
          <>
            Comprobante:{" "}
            <a href={`/api/comercializacion/gastos/${g.id}/comprobante`} target="_blank" rel="noopener" className="font-medium text-[var(--brand)] hover:underline">
              {g.comprobanteNombre}
            </a>{" "}
            ·{" "}
          </>
        ) : (
          "Sin comprobante · "
        )}
        registró {g.registradoPorNombre} el {formatoFechaHora.format(new Date(g.registradoEn))}
        {g.observaciones && ` · ${g.observaciones}`}
      </p>
      {g.anulado && (
        <p className="text-xs text-red-700">
          Anulado por {g.anulado.porNombre} el {formatoFechaHora.format(new Date(g.anulado.en))}: {g.anulado.motivo}. Ya no cuenta en el resultado ni en el saldo por pagar; el
          registro se conserva.
        </p>
      )}
      {!anulado && (
        <div className="flex flex-wrap items-center gap-3">
          {conPagos ? (
            <span className="text-xs text-[var(--muted)]">Tiene historial de pagos (aunque estén anulados): no se anula con la acción simple.</span>
          ) : (
            !anulando && (
              <button type="button" onClick={() => setAnulando(true)} className={claseSecundaria}>
                Anular por error
              </button>
            )
          )}
        </div>
      )}
      {anulando && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Motivo (obligatorio)" maxLength={500} className="sm:max-w-md" />
          <Button
            type="button"
            variant="outline"
            disabled={pendiente || motivo.trim().length < 3}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await anularGastoAction({ gastoId: g.id, motivo });
                if (r.error) return setError(r.error);
                setAnulando(false);
                router.refresh();
              })
            }
          >
            {pendiente ? "Anulando…" : "Anular gasto"}
          </Button>
          <button type="button" onClick={() => setAnulando(false)} className={claseSecundaria}>
            Cancelar
          </button>
          {error && <span className="text-sm text-red-700">{error}</span>}
        </div>
      )}
      {!anulado && g.cuenta && (
        // Plegado para no desplegar todos los calendarios juntos; un enlace
        // #gasto-… (avisos, bloqueos) lo abre automáticamente.
        <details className="group rounded-xl border border-[var(--border)] bg-[var(--c-suave)] px-4 py-3" data-abrir-con-ancla>
          <summary className="cursor-pointer text-sm font-medium">
            Pagos del gasto {g.numero} · saldo {formatearImporte(g.cuenta.estado.saldo)}
          </summary>
          <div className="mt-3">
            <CuentaComercialView cuenta={g.cuenta} contexto={contextoGasto(g)} />
          </div>
        </details>
      )}
    </li>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import type { CotizacionDetalle } from "@/lib/server/comercializacion/cotizaciones";
import type { ResumenComprasOrden } from "@/lib/server/comercializacion/compras";
import type { DetalleCuenta, ResumenSaldos } from "@/lib/server/comercializacion/cuentas";
import type { ResumenEntregasOrden } from "@/lib/server/comercializacion/entregas";
import type { ResumenGastosOrden } from "@/lib/server/comercializacion/gastos";
import type { ResultadoEstimado } from "@/lib/comercializacion/resultado";
import type { SurtidoEntrega } from "@/lib/server/comercializacion/surtido";
import type { EstadoCancelacionOrden } from "@/lib/server/comercializacion/cancelaciones";
import type { EstadoCuenta } from "@/lib/comercializacion/cuentas";
import { ComprasOrden } from "./compras-orden";
import { CuentaComercialView } from "./cuenta-comercial";
import { EntregasOrden } from "./entregas-orden";
import { GastosOrden } from "./gastos-orden";
import { ResultadoOrdenView } from "./resultado-orden";
import { AccionesOperacion } from "./acciones-operacion";
import { ResumenOperacion } from "./resumen-operacion";
import { DocumentosFinancieros } from "./documentos-financieros";
import { VistasOperacion, type VistaOperacion } from "./vistas-operacion";
import { claseEstado } from "./estilos";

// Expediente de una operación (plan de rediseño §3/§5) para una cotización
// EMITIDA, RECHAZADA, CANCELADA (emitida) o ACEPTADA. La cotización se lee de
// su COPIA HISTÓRICA (documentoEmitido): lo que se ve es lo que dice el PDF.
// - Sin OV: solo la consulta de la cotización (no se muestran compras ni
//   cuentas como si existieran).
// - Con OV, administración: Resumen / Compras y entregas / Cobros y pagos.
// - Con OV, vendedor: Resumen / Entregas. La página NO consulta compras,
//   costos, gastos, cuentas ni simulaciones para él (llegan null).

const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey" });

export function EstatusCotizacionBadge({ estatus, vencida, ordenCancelada }: { estatus: CotizacionDetalle["estatus"]; vencida?: boolean; ordenCancelada?: boolean }) {
  // B8B: OV cancelada (la cotización sigue aceptada), rechazada y cancelada.
  if (estatus === "ACEPTADA" && ordenCancelada) return <span className={claseEstado("alerta")}>OV cancelada</span>;
  if (estatus === "RECHAZADA") return <span className={claseEstado("alerta")}>Rechazada</span>;
  if (estatus === "CANCELADA") return <span className={claseEstado("neutro")}>Cancelada</span>;
  if (estatus === "ACEPTADA") return <span className={claseEstado("ok")}>Aceptada</span>;
  if (estatus === "EMITIDA") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={claseEstado("info")}>Emitida</span>
        {vencida && <span className={claseEstado("aviso")}>Vencida</span>}
      </span>
    );
  }
  return <span className={`${claseEstado("neutro")} text-[var(--muted)]`}>Borrador</span>;
}

export function AvisoCierre({ titulo, cierre, nota }: { titulo: string; cierre: { en: string; porNombre: string; motivo: string }; nota?: string }) {
  return (
    <div className="space-y-1 rounded-2xl border border-red-200 bg-red-50/60 px-5 py-4" data-aviso-cierre>
      <p className="text-sm font-semibold text-red-800">{titulo}</p>
      <p className="text-sm text-[var(--foreground)]">Motivo: {cierre.motivo}</p>
      <p className="text-xs text-[var(--muted)]">
        Registró {cierre.porNombre} · {formatoFechaHora.format(new Date(cierre.en))}
        {nota ? ` · ${nota}` : ""}
      </p>
    </div>
  );
}

/** Encabezado del expediente: qué se vende, a quién, en qué obra, folios y estado. */
export function EncabezadoOperacion({
  descripcion,
  clienteNombre,
  obraNombre,
  referencias,
  estado,
  acciones,
}: {
  descripcion: string | null;
  clienteNombre: string | null;
  obraNombre: string | null;
  referencias: string[];
  estado: ReactNode;
  acciones: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between" data-encabezado-operacion>
      <div className="min-w-0">
        <Link href="/comercializacion" className="inline-flex min-h-9 items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          <span aria-hidden="true">←</span> Operaciones
        </Link>
        <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-[var(--foreground)] sm:text-3xl">
          {descripcion ?? <span className="italic text-[var(--muted)]">Sin descripción</span>}
        </h1>
        <p className="mt-1 text-base text-[var(--foreground)]">
          {clienteNombre ?? "Sin cliente"}
          {obraNombre && <span className="text-[var(--muted)]"> · {obraNombre}</span>}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-[var(--muted)]">
          {estado}
          {referencias.map((r) => (
            <span key={r} className="whitespace-nowrap">
              {r}
            </span>
          ))}
        </div>
      </div>
      <div className="shrink-0">{acciones}</div>
    </div>
  );
}

export function CotizacionEmitidaView({
  cotizacion,
  esAdmin,
  hoy,
  vistaInicial,
  compras,
  cuenta,
  gastos,
  resultado,
  surtido,
  financiero,
  entregas,
  cancelacionOrden,
  pagosCompras,
}: {
  cotizacion: CotizacionDetalle;
  esAdmin: boolean;
  hoy: string;
  vistaInicial: string;
  // Solo administración (B4); para el vendedor es null.
  compras: ResumenComprasOrden | null;
  // B5 — solo administración; para el vendedor son null.
  cuenta?: DetalleCuenta | null;
  financiero?: { porCobrar: ResumenSaldos; porPagar: ResumenSaldos; comprasConCuenta: number; gastosConCuenta: number } | null;
  // B6A — administración y vendedor asignado; sin costos, compras ni cobranza.
  entregas?: ResumenEntregasOrden | null;
  // B7 — solo administración (la página no los consulta para el vendedor).
  gastos?: { resumen: ResumenGastosOrden; beneficiarios: { id: string; nombre: string }[] } | null;
  resultado?: ResultadoEstimado | null;
  // B8A — surtido a obra por entrega, solo administración.
  surtido?: Record<string, SurtidoEntrega> | null;
  // B8B — solo administración.
  cancelacionOrden?: EstadoCancelacionOrden | null;
  // Rediseño — estado de pago de cada compra, solo administración.
  pagosCompras?: Map<string, Pick<EstadoCuenta, "liquidacion" | "situacion" | "saldo" | "vencido" | "aplicado" | "total"> & { anulada: boolean }> | null;
}) {
  const doc = cotizacion.emision!.documento;
  const orden = cotizacion.orden;
  const ordenCancelada = orden?.estatus === "CANCELADA";
  const contexto = [doc.cliente?.nombre, doc.obra?.nombre].filter(Boolean).join(" · ");
  const referencias = orden
    ? [`Venta ${orden.folio}`, `Cotización ${doc.folio}`, ...(orden.referenciaOcCliente ? [`OC del cliente ${orden.referenciaOcCliente}`] : []), `Vendedor ${doc.vendedor.nombre}`]
    : [`Cotización ${doc.folio}`, `Vendedor ${doc.vendedor.nombre}`];

  const resumen = (
    <ResumenOperacion
      cotizacion={cotizacion}
      esAdmin={esAdmin}
      compras={compras}
      cuenta={cuenta ?? null}
      financiero={financiero ?? null}
      entregas={entregas ?? null}
      gastos={gastos?.resumen ?? null}
      surtido={surtido ?? null}
    />
  );

  let cuerpo: ReactNode = <div className="space-y-6">{resumen}</div>;
  if (orden) {
    const entregasBloque = entregas ? <EntregasOrden resumen={entregas} surtido={esAdmin ? surtido : null} ordenCancelada={ordenCancelada} contexto={contexto} /> : null;
    const vistas: VistaOperacion[] = esAdmin
      ? [
          { id: "resumen", etiqueta: "Resumen" },
          { id: "compras", etiqueta: "Compras y entregas" },
          { id: "cobros", etiqueta: "Cobros y pagos" },
        ]
      : [
          { id: "resumen", etiqueta: "Resumen" },
          { id: "entregas", etiqueta: "Entregas" },
        ];
    const paneles: Record<string, ReactNode> = esAdmin
      ? {
          resumen,
          compras: (
            <>
              {compras && <ComprasOrden resumen={compras} ordenCancelada={ordenCancelada} />}
              {entregasBloque}
            </>
          ),
          cobros: (
            <>
              <DocumentosFinancieros
                ordenFolio={orden.folio}
                clienteNombre={doc.cliente?.nombre ?? null}
                cuenta={cuenta ?? null}
                compras={compras}
                pagosCompras={pagosCompras ?? new Map()}
                gastos={gastos?.resumen ?? null}
                financiero={financiero ?? null}
              />
              {cuenta && <CuentaComercialView cuenta={cuenta} contexto={`Venta ${orden.folio}${doc.cliente ? ` · ${doc.cliente.nombre}` : ""}`} />}
              {gastos && <GastosOrden resumen={gastos.resumen} beneficiarios={gastos.beneficiarios} ordenCancelada={ordenCancelada} />}
              {resultado && <ResultadoOrdenView resultado={resultado} />}
            </>
          ),
        }
      : { resumen, entregas: entregasBloque };
    cuerpo = <VistasOperacion vistas={vistas} inicial={vistaInicial} paneles={paneles} />;
  }

  return (
    <div className="space-y-6">
      <EncabezadoOperacion
        descripcion={doc.descripcion}
        clienteNombre={doc.cliente?.nombre ?? null}
        obraNombre={doc.obra?.nombre ?? null}
        referencias={referencias}
        estado={<EstatusCotizacionBadge estatus={cotizacion.estatus} vencida={cotizacion.vencida} ordenCancelada={ordenCancelada} />}
        acciones={
          <AccionesOperacion
            cotizacionId={cotizacion.id}
            folio={doc.folio}
            estatus={cotizacion.estatus}
            esAdmin={esAdmin}
            vencida={cotizacion.vencida}
            fechaMinima={doc.fecha}
            hoy={hoy}
            contexto={contexto}
            orden={orden}
            cancelacionOrden={cancelacionOrden ?? null}
          />
        }
      />

      {cotizacion.cierre && <AvisoCierre titulo={cotizacion.estatus === "RECHAZADA" ? "Rechazada por el cliente" : "Cotización cancelada"} cierre={cotizacion.cierre} />}
      {orden?.cancelacion && (
        <AvisoCierre
          titulo={`Orden de venta ${orden.folio} cancelada`}
          cierre={orden.cancelacion}
          nota="La cotización conserva su aceptación y no genera otra OV; para una nueva venta, duplícala."
        />
      )}

      {cuerpo}
    </div>
  );
}

import Link from "next/link";
import {
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  CreditCard,
  FileCheck,
  FileWarning,
  HandCoins,
  HardHat,
  Receipt,
  RotateCcw,
  ScanEye,
  TrendingDown,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { PendienteDashboard } from "@/lib/server/dashboard";
import { ANILLO_FOCO, EncabezadoPanel, PANEL, hrefPermitido } from "./comun";

// Por atender (V4): hasta tres pendientes ya fusionados y ordenados en el
// servidor (priorizarPendientes). Títulos y detalles son los del sistema;
// la "acción" es un enlace al flujo existente donde se revisa y ejecuta —
// nunca cierra, emite ni modifica nada desde Inicio.

const MAX_PENDIENTES = 3;

const PRESENTACION: Record<PendienteDashboard["tipo"], { icono: LucideIcon; accion: string }> = {
  pagos_pendientes: { icono: CreditCard, accion: "Ver pagos" },
  pago_pendiente: { icono: CreditCard, accion: "Ver obra" },
  semanas_sin_cerrar: { icono: CalendarCheck, accion: "Ir al cierre" },
  gastos_pendientes: { icono: Receipt, accion: "Revisar" },
  estimaciones_listas: { icono: FileCheck, accion: "Ver estimaciones" },
  pendiente_cobro: { icono: HandCoins, accion: "Ver cobros" },
  desviacion: { icono: TrendingDown, accion: "Ver obra" },
  facturas_pendientes: { icono: FileWarning, accion: "Ver facturas" },
  cfdi_diferencia: { icono: ScanEye, accion: "Revisar" },
  reposicion_pendiente_antigua: { icono: RotateCcw, accion: "Ver reposiciones" },
  reposicion_pendiente: { icono: RotateCcw, accion: "Ver reposiciones" },
  gasto_recurrente_variable_pendiente: { icono: CalendarClock, accion: "Capturar monto" },
  gasto_recurrente_variable: { icono: CalendarClock, accion: "Capturar monto" },
  sin_avance_reciente: { icono: HardHat, accion: "Capturar avance" },
};

export function PorAtender({ pendientes, modulos }: { pendientes: PendienteDashboard[]; modulos: string[] }) {
  const visibles = pendientes.slice(0, MAX_PENDIENTES);
  const subtitulo =
    pendientes.length === 0
      ? "Al día"
      : pendientes.length > MAX_PENDIENTES
        ? `${visibles.length} de ${pendientes.length}, por prioridad`
        : pendientes.length === 1
          ? "1 pendiente"
          : `${pendientes.length} pendientes, por prioridad`;

  return (
    <section aria-labelledby="atender-titulo" className={cn(PANEL, "px-6 pt-[22px] pb-3 max-sm:px-4")}>
      <EncabezadoPanel id="atender-titulo" titulo="Por atender" subtitulo={subtitulo} />
      {pendientes.length === 0 ? (
        <div className="flex items-center gap-3 pb-3.5 text-sm font-medium text-[var(--i-tinta-2)]">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[var(--i-ok-suave)] text-[var(--i-ok)]">
            <CircleCheck size={20} aria-hidden />
          </span>
          Nada pendiente por ahora.
        </div>
      ) : (
        <>
          <ul className="divide-y divide-[var(--i-linea)]">
            {visibles.map((p, i) => (
              <li key={`${p.tipo}-${i}`}>
                <Accion p={p} href={hrefPermitido(p.href, modulos)} />
              </li>
            ))}
          </ul>
          {pendientes.length > MAX_PENDIENTES && (
            <details className="group border-t border-[var(--i-linea)]">
              <summary
                className={cn(
                  "cursor-pointer list-none rounded-lg py-3 text-sm font-bold text-[var(--marca-tinta)] hover:underline hover:underline-offset-4 [&::-webkit-details-marker]:hidden",
                  ANILLO_FOCO
                )}
              >
                <span className="group-open:hidden">Ver {pendientes.length - MAX_PENDIENTES} más</span>
                <span className="hidden group-open:inline">Ver menos</span>
              </summary>
              <ul className="divide-y divide-[var(--i-linea)] border-t border-[var(--i-linea)]">
                {pendientes.slice(MAX_PENDIENTES).map((p, i) => (
                  <li key={`${p.tipo}-r-${i}`}>
                    <Accion p={p} href={hrefPermitido(p.href, modulos)} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Accion({ p, href }: { p: PendienteDashboard; href: string | null }) {
  const { icono: Icono, accion } = PRESENTACION[p.tipo];
  const critica = p.severidad === "REQUIERE_ACCION";
  const contenido = (
    <>
      <span
        className={cn(
          "grid h-11 w-11 place-items-center rounded-[14px]",
          critica ? "bg-[var(--i-alerta-suave)] text-[var(--i-alerta)]" : "bg-[var(--i-suave)] text-[var(--i-tinta)]"
        )}
      >
        <Icono size={20} strokeWidth={1.8} aria-hidden />
      </span>
      <span className="min-w-0">
        <b className="block text-[15px] leading-5 font-bold">{p.titulo}</b>
        <small className="block truncate text-[13px] leading-[18px] text-[var(--i-tinta-3)]">
          {critica && <span className="font-bold text-[var(--i-alerta)]">Requiere acción. </span>}
          {p.detalle}
        </small>
      </span>
      {href && (
        <span
          className={cn(
            "rounded-full px-3 py-[7px] text-[13px] font-bold whitespace-nowrap max-sm:col-start-2 max-sm:-mt-1 max-sm:justify-self-start",
            critica ? "bg-[var(--i-grafito)] text-[var(--i-grafito-tinta)]" : "bg-[var(--i-suave)] text-[var(--i-tinta)]"
          )}
        >
          {accion}
        </span>
      )}
    </>
  );
  const clase = "-mx-2 grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[14px] px-2 py-[13px] max-sm:grid-cols-[44px_minmax(0,1fr)]";
  if (!href) return <div className={clase}>{contenido}</div>;
  return (
    <Link href={href} className={cn(clase, "transition-colors duration-150 ease-[var(--ease-out)] hover:bg-[var(--i-suave)]", ANILLO_FOCO)}>
      {contenido}
    </Link>
  );
}

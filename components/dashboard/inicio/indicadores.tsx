import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  CircleDollarSign,
  Clock,
  HandCoins,
  HardHat,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ResumenEjecutivo } from "@/lib/server/dashboard";
import { CIFRA, Cifra, NOTA, PERIODO_ALCANCE, TarjetaIndicador, hrefPermitido, plural } from "./comun";

// Indicadores de Inicio (V4): cuadrícula 2 × 2. Solo presentan lo que ya
// calcula proyectarResumenEjecutivo; un dato null (sin obras, o recortado
// por permisos) se muestra como "—", nunca como cero.

function Vacio({ texto, oscura = false }: { texto: string; oscura?: boolean }) {
  return (
    <>
      <span className={cn(CIFRA, oscura ? "text-[var(--i-grafito-tenue)]" : "text-[var(--i-tinta-3)]")}>—</span>
      <span className={cn(NOTA, "mt-auto", oscura && "text-[var(--i-grafito-tenue)]")}>{texto}</span>
    </>
  );
}

function Anillo({ valor }: { valor: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const p = Math.min(Math.max(valor, 0), 100) / 100;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0" role="img" aria-label={`Avance físico ${valor.toFixed(1)} %`}>
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="8" stroke="var(--i-suave)" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        stroke="var(--marca-relleno)"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p)}
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}

function Grid({ children, etiqueta }: { children: React.ReactNode; etiqueta: string }) {
  return (
    <section aria-label={etiqueta} className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 sm:gap-5">
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

export function IndicadoresGeneral({ r, modulos }: { r: ResumenEjecutivo; modulos: string[] }) {
  const flujo = r.flujoDinero;
  return (
    <Grid etiqueta="Indicadores generales">
      <TarjetaIndicador
        id="por-pagar"
        icono={Wallet}
        nombre="Por pagar · Obras"
        alcance={{ tipo: "fecha" }}
        ayuda="Pagos autorizados que aún no se liquidan. Obras y Empresa van por separado; la antigüedad corresponde solo a Obras."
        href={hrefPermitido("/reporte-general", modulos)}
        oscura
      >
        {r.porPagarObras === null ? (
          <Vacio texto="Sin obras activas" oscura />
        ) : (
          <>
            <span className={CIFRA}>
              <Cifra valor={r.porPagarObras} />
            </span>
            {r.porPagarObrasDiasMax !== null && r.porPagarObrasDiasMax > 0 && (
              <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-[rgba(244,114,103,0.14)] px-2.5 py-1 text-xs font-bold text-[#ffb4ab]">
                <Clock size={14} aria-hidden />
                El más antiguo lleva {plural(r.porPagarObrasDiasMax, "día")}
              </span>
            )}
            <div className="mt-auto flex items-center justify-between gap-3 border-t border-[#3a4046] pt-3 text-sm">
              <span className="font-semibold opacity-80">Por pagar · Empresa</span>
              <b className="text-base font-bold tabular-nums">
                <Cifra valor={r.porPagarEmpresa ?? 0} />
              </b>
            </div>
          </>
        )}
      </TarjetaIndicador>

      <TarjetaIndicador
        id="por-cobrar"
        icono={HandCoins}
        nombre="Por cobrar"
        alcance={{ tipo: "fecha" }}
        ayuda="Importe General de las estimaciones emitidas menos lo ya cobrado, con el mismo cálculo de Cliente."
        href={hrefPermitido("/contabilidad/ingresos", modulos)}
      >
        {r.porCobrar === null ? (
          <Vacio texto="Sin obras activas" />
        ) : (
          <>
            <span className={CIFRA}>
              <Cifra valor={r.porCobrar} />
            </span>
            <span className="mt-auto inline-flex items-center gap-2 text-sm font-semibold text-[var(--i-tinta-2)]">
              <b className="inline-grid h-7 min-w-7 place-items-center rounded-[9px] bg-[var(--marca-suave)] px-2 font-extrabold text-[var(--marca-tinta)] tabular-nums">
                {r.estimacionesPorCobrar ?? 0}
              </b>
              {r.estimacionesPorCobrar === 1 ? "estimación con saldo" : "estimaciones con saldo"}
            </span>
          </>
        )}
      </TarjetaIndicador>

      <TarjetaIndicador
        id="flujo"
        icono={ArrowLeftRight}
        nombre="Flujo neto de obras"
        alcance={{ tipo: "periodo", etiqueta: PERIODO_ALCANCE[r.periodo] }}
        ayuda="Cobros de clientes a valores General (con tope por estimación) más aportaciones, menos pagos de obra liquidados en el periodo. No equivale necesariamente al efectivo en banco."
        href={hrefPermitido("/contabilidad", modulos)}
      >
        {flujo === null ? (
          <Vacio texto="Sin obras activas" />
        ) : (
          <>
            {flujo.entradas === 0 && flujo.pagosDeObra === 0 ? (
              <>
                <span className={cn(CIFRA, "text-[var(--i-tinta-3)]")}>—</span>
                <span className={NOTA}>Sin cobros ni pagos en el periodo</span>
              </>
            ) : (
              <span className={cn(CIFRA, flujo.neto > 0 && "text-[var(--i-ok)]", flujo.neto < 0 && "text-[var(--i-alerta)]")}>
                <Cifra valor={flujo.neto} signo />
              </span>
            )}
            <dl className="mt-auto grid grid-cols-2 gap-2.5">
              <div className="min-w-0 rounded-[14px] bg-[var(--i-suave)] px-3 py-2">
                <dt className="flex items-center gap-1 text-xs font-semibold text-[var(--i-tinta-3)]">
                  <ArrowDownLeft size={14} aria-hidden />
                  Entradas
                </dt>
                <dd className="truncate text-[15px] font-bold">
                  <Cifra valor={flujo.entradas} />
                </dd>
              </div>
              <div className="min-w-0 rounded-[14px] bg-[var(--i-suave)] px-3 py-2">
                <dt className="flex items-center gap-1 text-xs font-semibold text-[var(--i-tinta-3)]">
                  <ArrowUpRight size={14} aria-hidden />
                  Pagos de obra
                </dt>
                <dd className="truncate text-[15px] font-bold">
                  <Cifra valor={flujo.pagosDeObra} />
                </dd>
              </div>
            </dl>
          </>
        )}
      </TarjetaIndicador>

      <TarjetaAvance r={r} modulos={modulos} />
    </Grid>
  );
}

function TarjetaAvance({ r, modulos, oscura = false }: { r: ResumenEjecutivo; modulos: string[]; oscura?: boolean }) {
  const { porcentaje, proyectosIncompletos, deltaVsAnterior } = r.avanceFisicoConsolidado;
  const conDelta = deltaVsAnterior !== null && (r.periodo === "semana" || r.periodo === "mes");
  return (
    <TarjetaIndicador
      id="avance"
      icono={HardHat}
      nombre="Avance físico"
      alcance={{ tipo: "fecha" }}
      ayuda="Avance aprobado de las obras activas, ponderado por el valor de cada concepto. Es el mismo en General y en Privado."
      href={hrefPermitido("/control-de-obra", modulos)}
      oscura={oscura}
    >
      {porcentaje === null ? (
        <Vacio
          texto={proyectosIncompletos > 0 ? `${plural(proyectosIncompletos, "obra")} con precios incompletos` : "Sin obras con avance"}
          oscura={oscura}
        />
      ) : (
        <>
          <div className="flex items-end justify-between gap-3.5">
            <span className={CIFRA}>
              {porcentaje.toFixed(1)}
              <span className="text-[0.55em] font-bold opacity-55"> %</span>
            </span>
            <Anillo valor={porcentaje} />
          </div>
          <div className="mt-auto grid gap-1">
            {conDelta && deltaVsAnterior !== null && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[13px] font-bold",
                  deltaVsAnterior >= 0 ? "text-[var(--i-ok)]" : "text-[var(--i-alerta)]"
                )}
              >
                {deltaVsAnterior >= 0 ? <TrendingUp size={15} aria-hidden /> : <TrendingDown size={15} aria-hidden />}
                {deltaVsAnterior >= 0 ? "+" : "−"}
                {Math.abs(deltaVsAnterior).toFixed(1)} pp vs {r.periodo === "semana" ? "semana anterior" : "mes anterior"}
              </span>
            )}
            {proyectosIncompletos > 0 && (
              <span className={NOTA}>{plural(proyectosIncompletos, "obra")} fuera del cálculo por precios incompletos</span>
            )}
          </div>
        </>
      )}
    </TarjetaIndicador>
  );
}

// ---------------------------------------------------------------------------
// Privado — tres indicadores, todo a la fecha. Utilidad presupuestada ocupa
// las dos columnas (no se inventa una cuarta tarjeta).
// ---------------------------------------------------------------------------

export function IndicadoresPrivado({ r, modulos }: { r: ResumenEjecutivo; modulos: string[] }) {
  const u = r.utilidadConsolidada;
  const p = r.privado;
  const adelantadas = p?.obrasAdelantadas ?? [];
  const hrefAdelantadas = adelantadas.length === 1 ? `/control-de-obra/${adelantadas[0].id}` : "/control-de-obra";

  return (
    <Grid etiqueta="Indicadores privados">
      <TarjetaIndicador
        id="utilidad"
        icono={TrendingUp}
        nombre="Utilidad presupuestada"
        alcance={{ tipo: "fecha" }}
        ayuda="Monto de contratos General menos el presupuesto de costo interno de las obras activas y pausadas. La utilidad real no se muestra mientras se valida su fórmula (D6)."
        href={hrefPermitido("/control-de-obra", modulos)}
        oscura
        ancha
      >
        {!u ? (
          <Vacio texto="Sin obras activas" oscura />
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <span className={cn(CIFRA, u.utilidadPresupuestada < 0 && "text-[#ffb4ab]")}>
              <Cifra valor={u.utilidadPresupuestada} />
            </span>
            <span className="text-right text-xs font-semibold text-[var(--i-grafito-tenue)]">
              Margen sobre contratos
              <b className="block text-[15px] leading-5 font-bold text-[var(--i-grafito-tinta)] tabular-nums">
                {u.margenPresupuestadoPct === null ? "Sin datos" : `${u.margenPresupuestadoPct.toFixed(1)} %`}
              </b>
            </span>
          </div>
        )}
      </TarjetaIndicador>

      <TarjetaIndicador
        id="costo-cubierto"
        icono={CircleDollarSign}
        nombre="Costo cubierto vs presupuesto"
        alcance={{ tipo: "fecha" }}
        ayuda="Incluye pagos liquidados y pagos puente. No incluye gastos aprobados que aún no se pagan."
        href={hrefPermitido("/reporte-general", modulos)}
      >
        {!p || p.presupuestoCosto === 0 ? (
          <Vacio texto="Sin presupuesto de costo capturado" />
        ) : (
          <>
            <span className={CIFRA}>
              <Cifra valor={p.costoCubierto} />
            </span>
            <div className="mt-auto grid gap-2">
              <span
                role="img"
                aria-label={`${(p.porcentajeCubierto ?? 0).toFixed(1)} % del presupuesto cubierto`}
                className="block h-2 overflow-hidden rounded-full bg-[var(--i-suave)]"
              >
                <span className="block h-full rounded-full bg-[var(--marca-relleno)]" style={{ width: `${Math.min(p.porcentajeCubierto ?? 0, 100)}%` }} />
              </span>
              <span className={NOTA}>
                {(p.porcentajeCubierto ?? 0).toFixed(1)} % de <Cifra valor={p.presupuestoCosto} />
              </span>
            </div>
          </>
        )}
      </TarjetaIndicador>

      <TarjetaIndicador
        id="adelantadas"
        icono={TriangleAlert}
        nombre="Obras con costo adelantado"
        alcance={{ tipo: "fecha" }}
        ayuda={`Obras cuyo % de costo cubierto supera su avance físico por más de ${p?.umbralPP ?? 15} puntos.`}
        href={hrefPermitido(hrefAdelantadas, modulos)}
      >
        {!p || p.obrasConDesviacionCalculable === 0 ? (
          <Vacio texto="Ninguna obra con avance y costo calculables" />
        ) : (
          <>
            <span className={CIFRA}>
              {adelantadas.length}
              <span className="text-[0.55em] font-bold opacity-55"> de {p.obrasConDesviacionCalculable}</span>
            </span>
            <span className={cn(NOTA, "mt-auto min-w-0 truncate")}>
              {adelantadas.length > 0 ? (
                <>
                  <b className="font-bold text-[var(--i-aviso)]">+{adelantadas[0].desviacionPP.toFixed(0)} pp</b> en {adelantadas[0].nombre}
                </>
              ) : (
                `Ninguna supera el umbral de ${p.umbralPP} pp`
              )}
            </span>
          </>
        )}
      </TarjetaIndicador>
    </Grid>
  );
}

// ---------------------------------------------------------------------------
// Supervisor — sin montos ni porcentajes financieros.
// ---------------------------------------------------------------------------

export function IndicadoresSupervisor({ r, modulos }: { r: ResumenEjecutivo; modulos: string[] }) {
  return (
    <Grid etiqueta="Indicadores de obra">
      <TarjetaAvance r={r} modulos={modulos} />
      <TarjetaIndicador
        id="sin-avance"
        icono={Clock}
        nombre="Obras sin avance reciente"
        alcance={{ tipo: "fecha" }}
        ayuda="Obras en ejecución sin avance capturado en las últimas 2 semanas o más."
        href={hrefPermitido("/control-de-obra", modulos)}
        oscura
      >
        <span className={CIFRA}>
          {r.obrasSinAvanceReciente}
          <span className="text-[0.55em] font-bold opacity-55"> de {r.obrasActivas.enEjecucion}</span>
        </span>
        <span className="mt-auto text-[13px] font-medium text-[var(--i-grafito-tenue)]">
          {r.obrasSinAvanceReciente > 0 ? "Requieren captura de avance" : "Todas con avance reciente"}
        </span>
      </TarjetaIndicador>
    </Grid>
  );
}

import Link from "next/link";
import { Clock, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PeriodoDashboard, ResumenEjecutivo, VistaDashboard } from "@/lib/server/dashboard";
import { ANILLO_FOCO, PERIODO_ALCANCE } from "./inicio/comun";
import { fuenteInicio } from "./inicio/fuente";
import { IndicadoresGeneral, IndicadoresPrivado, IndicadoresSupervisor } from "./inicio/indicadores";
import { GraficaAvance } from "./inicio/grafica";
import { ordenarObras, ResumenObras } from "./inicio/obras";
import { PorAtender } from "./inicio/pendientes";

// Inicio — diseño V4 aprobado (design/prototypes/dashboard-inicio/v4).
// Izquierda: indicadores 2 × 2 y resumen de obras. Derecha: Avance por obra y
// Por atender (proporción 7 : 5). Todo lo que llega aquí ya viene recortado
// por el servidor (proyectarResumenEjecutivo): Supervisor recibe montos y
// porcentajes financieros en null y General nunca recibe datos privados.
// Esta vista solo compone; no calcula cifras.
//

const PERIODOS: PeriodoDashboard[] = ["semana", "mes", "mes_anterior", "acumulado"];

export function InicioView({ resumen, modulosVisibles }: { resumen: ResumenEjecutivo; modulosVisibles: string[] }) {
  const r = resumen;
  const esSupervisor = r.nivelAcceso === "operativo";
  const esPrivado = r.vista === "privado";
  const ordenadas = ordenarObras(r.proyectos, esSupervisor);

  return (
    <div className={cn("inicio font-medium", fuenteInicio.variable)}>
      <Encabezado r={r} esSupervisor={esSupervisor} />

      {/* xl: dos columnas independientes (sin huecos aunque las alturas
          difieran). Debajo de xl se apilan con un orden propio. */}
      <div className="enter grid grid-cols-1 items-start gap-3.5 sm:gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="contents xl:grid xl:min-w-0 xl:content-start xl:gap-5">
          <div className="order-1 min-w-0 xl:order-none">
            {esSupervisor ? (
              <IndicadoresSupervisor r={r} modulos={modulosVisibles} />
            ) : esPrivado ? (
              <IndicadoresPrivado r={r} modulos={modulosVisibles} />
            ) : (
              <IndicadoresGeneral r={r} modulos={modulosVisibles} />
            )}
          </div>
          <div className="order-4 min-w-0 xl:order-none">
            <ResumenObras ordenadas={ordenadas} obrasActivas={r.obrasActivas} esSupervisor={esSupervisor} modulos={modulosVisibles} />
          </div>
        </div>
        <div className="contents xl:grid xl:min-w-0 xl:content-start xl:gap-5">
          <div className="order-3 min-w-0 sm:order-2 xl:order-none">
            <GraficaAvance ordenadas={ordenadas} vista={r.vista} esSupervisor={esSupervisor} modulos={modulosVisibles} />
          </div>
          {/* En móvil, Por atender sube justo después de los indicadores. */}
          <div className="order-2 min-w-0 sm:order-5 xl:order-none">
            <PorAtender pendientes={r.pendientes} modulos={modulosVisibles} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Encabezado({ r, esSupervisor }: { r: ResumenEjecutivo; esSupervisor: boolean }) {
  const href = (vista: VistaDashboard, periodo: PeriodoDashboard) => `/dashboard?vista=${vista}&periodo=${periodo}`;
  const esPrivado = r.vista === "privado";

  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3.5">
      <div className="min-w-0">
        <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] max-sm:text-[26px] max-sm:leading-8">{r.saludo}</h1>
        <p className="mt-1 text-[15px] text-[var(--i-tinta-2)]">
          {r.empresaNombre} · {r.semanaLabel}
        </p>
      </div>

      <div className="flex max-w-full flex-wrap items-center gap-2.5">
        {r.puedeVerPrivado && !esSupervisor && (
          <Segmentos etiqueta="Vista">
            <Segmento activo={!esPrivado} estilo="grafito" href={href("general", r.periodo)}>
              General
            </Segmento>
            {/* El periodo viaja en la URL: al volver a General se conserva. */}
            <Segmento activo={esPrivado} estilo="grafito" href={href("privado", r.periodo)}>
              <Lock size={16} aria-hidden />
              Privado
            </Segmento>
          </Segmentos>
        )}
        {esPrivado ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--i-tarjeta)] px-4 py-[9px] text-sm font-semibold text-[var(--i-tinta-2)] shadow-[var(--i-sombra)]">
            <Clock size={16} aria-hidden />
            Todo a la fecha
          </span>
        ) : (
          <Segmentos etiqueta="Periodo" desplazable>
            {PERIODOS.map((p) => (
              <Segmento key={p} activo={r.periodo === p} estilo="marca" href={href(r.vista, p)}>
                {PERIODO_ALCANCE[p]}
              </Segmento>
            ))}
          </Segmentos>
        )}
      </div>
    </header>
  );
}

function Segmentos({ etiqueta, desplazable, children }: { etiqueta: string; desplazable?: boolean; children: React.ReactNode }) {
  return (
    <nav
      aria-label={etiqueta}
      className={cn("inline-flex max-w-full gap-0.5 rounded-full bg-[var(--i-tarjeta)] p-1 shadow-[var(--i-sombra)]", desplazable && "overflow-x-auto")}
    >
      {children}
    </nav>
  );
}

function Segmento({
  activo,
  estilo,
  href,
  children,
}: {
  activo: boolean;
  estilo: "grafito" | "marca";
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={activo ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3.5 py-[7px] text-sm font-semibold whitespace-nowrap transition-colors duration-150 ease-[var(--ease-out)]",
        ANILLO_FOCO,
        activo
          ? estilo === "grafito"
            ? "bg-[var(--i-grafito)] text-[var(--i-grafito-tinta)]"
            : "bg-[var(--marca-suave)] text-[var(--marca-tinta)]"
          : "text-[var(--i-tinta-2)] hover:text-[var(--i-tinta)]"
      )}
    >
      {children}
    </Link>
  );
}

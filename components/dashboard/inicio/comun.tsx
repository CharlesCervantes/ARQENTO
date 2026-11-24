import Link from "next/link";
import { CalendarDays, Clock, Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/dinero";
import type { PeriodoDashboard } from "@/lib/server/dashboard";

// Piezas compartidas de Inicio (diseño V4) — solo presentación, sin cálculo.
// Todos los colores salen de los tokens acotados a `.inicio` (globals.css).

export const PERIODO_ALCANCE: Record<PeriodoDashboard, string> = {
  semana: "Esta semana",
  mes: "Este mes",
  mes_anterior: "Mes anterior",
  acumulado: "Acumulado",
};

export const ANILLO_FOCO =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--marca-tinta)]";

export const PANEL =
  "rounded-[22px] bg-[var(--i-tarjeta)] shadow-[var(--i-sombra)]";

// Prefijo de ruta → clave de módulo. Un enlace a un módulo que el usuario no
// ve (por Empresa o rol) se dibuja como texto: Inicio nunca invita a una
// pantalla que después negaría el acceso.
const MODULO_DE_RUTA: [string, string][] = [
  ["/control-de-obra", "control_de_obra"],
  ["/reporte-general", "reporte_general"],
  ["/contabilidad", "contabilidad"],
  ["/gastos", "gastos"],
  ["/compras", "compras"],
];

export function hrefPermitido(href: string | null, modulosVisibles: string[]): string | null {
  if (!href) return null;
  const modulo = MODULO_DE_RUTA.find(([prefijo]) => href === prefijo || href.startsWith(`${prefijo}/`))?.[1];
  return modulo === undefined || modulosVisibles.includes(modulo) ? href : null;
}

// Importe con centavos atenuados: la parte entera se lee de un vistazo.
export function Cifra({ valor, signo = false, className }: { valor: number; signo?: boolean; className?: string }) {
  const texto = formatMoney(Math.abs(valor));
  const punto = texto.lastIndexOf(".");
  const prefijo = valor < 0 ? "−" : signo && valor > 0 ? "+" : "";
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      {prefijo}
      {punto === -1 ? texto : texto.slice(0, punto)}
      {punto !== -1 && <span className="text-[0.55em] font-bold tracking-normal opacity-55">{texto.slice(punto)}</span>}
    </span>
  );
}

export function pct(n: number | null, decimales = 0): string {
  return n === null ? "Sin datos" : `${n.toFixed(decimales)} %`;
}

export function plural(n: number, singular: string, pluralForma = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForma}`;
}

// Ayuda de un indicador: botón que muestra el texto al pasar el puntero, al
// enfocarlo con teclado o al tocarlo (el toque enfoca el botón). Va fuera del
// enlace que cubre la tarjeta (un botón dentro de <a> no es válido) y por
// encima de él; el texto se ancla a la tarjeta para no salirse de ella.
export function Ayuda({ id, texto, oscuro = false }: { id: string; texto: string; oscuro?: boolean }) {
  return (
    <span className="group/ayuda inline-flex">
      <button
        type="button"
        aria-label="Qué incluye"
        aria-describedby={id}
        className={cn(
          "relative z-10 -m-0.5 inline-flex cursor-help rounded-md p-0.5",
          oscuro ? "text-[var(--i-grafito-tenue)] hover:text-[var(--i-grafito-tinta)]" : "text-[var(--i-tinta-3)] hover:text-[var(--i-tinta)]",
          ANILLO_FOCO
        )}
      >
        <Info size={15} aria-hidden />
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute inset-x-4 top-[76px] z-20 rounded-xl px-3 py-2.5 text-[13px] leading-[19px] font-medium opacity-0 transition-[opacity,transform,visibility] duration-150 ease-[var(--ease-out)] -translate-y-0.5",
          "group-focus-within/ayuda:visible group-focus-within/ayuda:translate-y-0 group-focus-within/ayuda:opacity-100 group-hover/ayuda:visible group-hover/ayuda:translate-y-0 group-hover/ayuda:opacity-100",
          oscuro ? "bg-[var(--i-grafito-tinta)] text-[var(--i-tinta)]" : "bg-[var(--i-tinta)] text-[#f2f4f3]"
        )}
      >
        {texto}
      </span>
    </span>
  );
}

export type Alcance = { tipo: "fecha" } | { tipo: "periodo"; etiqueta: string };

export function EtiquetaAlcance({ alcance, oscuro = false }: { alcance: Alcance; oscuro?: boolean }) {
  const base = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap";
  if (alcance.tipo === "fecha") {
    return (
      <span className={cn(base, oscuro ? "bg-[var(--i-grafito-2)] text-[var(--i-grafito-tenue)]" : "bg-[var(--i-suave)] text-[var(--i-tinta-3)]")}>
        <Clock size={13} aria-hidden />A la fecha
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-[var(--marca-suave)] text-[var(--marca-tinta)]")}>
      <CalendarDays size={13} aria-hidden />
      {alcance.etiqueta}
    </span>
  );
}

// Encabezado de panel (Avance por obra, Obras, Por atender).
export function EncabezadoPanel({
  id,
  titulo,
  subtitulo,
  enlace,
}: {
  id: string;
  titulo: string;
  subtitulo?: string | null;
  enlace?: { href: string | null; texto: string } | null;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-xl leading-[26px] font-extrabold tracking-[-0.015em]">
          {titulo}
        </h2>
        {subtitulo && <p className="mt-0.5 text-[13px] font-medium text-[var(--i-tinta-3)]">{subtitulo}</p>}
      </div>
      {enlace?.href && (
        <Link
          href={enlace.href}
          className={cn("shrink-0 rounded-lg text-sm font-bold whitespace-nowrap text-[var(--marca-tinta)] hover:underline hover:underline-offset-4", ANILLO_FOCO)}
        >
          {enlace.texto}
        </Link>
      )}
    </div>
  );
}

// Tarjeta de indicador: icono, alcance, nombre con ayuda, contenido y un pie
// anclado abajo (mt-auto) para que las tarjetas de una fila queden alineadas.
export function TarjetaIndicador({
  id,
  icono: Icono,
  nombre,
  alcance,
  ayuda,
  href,
  oscura = false,
  ancha = false,
  children,
}: {
  id: string;
  icono: LucideIcon;
  nombre: string;
  alcance: Alcance;
  ayuda: string;
  href: string | null;
  oscura?: boolean;
  ancha?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article
      aria-labelledby={`k-${id}`}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 rounded-[22px] px-5 py-[18px] transition-[transform,box-shadow] duration-200 ease-[var(--ease-out)]",
        oscura
          ? "bg-[var(--i-grafito)] text-[var(--i-grafito-tinta)] shadow-[0_1px_2px_rgba(0,0,0,0.2),0_16px_34px_-14px_rgba(22,25,28,0.55)]"
          : "bg-[var(--i-tarjeta)] shadow-[var(--i-sombra)]",
        href && "hover:-translate-y-0.5 hover:shadow-[var(--i-sombra-hover)]",
        ancha && "sm:col-span-2"
      )}
    >
      {href && (
        <Link
          href={href}
          aria-label={`${nombre}: ver detalle`}
          className="absolute inset-0 z-[1] rounded-[22px] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--marca-tinta)]"
        />
      )}
      <div className="flex items-start justify-between gap-2.5">
        <span
          className={cn(
            "grid h-[42px] w-[42px] place-items-center rounded-[13px]",
            oscura ? "bg-[var(--i-grafito-2)] text-[var(--i-grafito-tinta)]" : "bg-[var(--i-suave)] text-[var(--i-tinta)]"
          )}
        >
          <Icono size={20} strokeWidth={1.8} aria-hidden />
        </span>
        <EtiquetaAlcance alcance={alcance} oscuro={oscura} />
      </div>
      <span
        id={`k-${id}`}
        className={cn("flex items-center gap-1.5 text-sm font-semibold", oscura ? "text-[var(--i-grafito-tenue)]" : "text-[var(--i-tinta-2)]")}
      >
        {nombre}
        <Ayuda id={`a-${id}`} texto={ayuda} oscuro={oscura} />
      </span>
      {children}
    </article>
  );
}

export const CIFRA = "text-[32px] leading-9 font-extrabold tracking-[-0.03em]";
export const NOTA = "text-[13px] font-medium text-[var(--i-tinta-3)]";

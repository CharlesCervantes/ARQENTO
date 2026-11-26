import Link from "next/link";
import { ChevronRight, HardHat } from "lucide-react";
import { cn } from "@/lib/cn";
import type { EstadoSalud, FilaProyectoDashboard } from "@/lib/server/dashboard";
import { ANILLO_FOCO, EncabezadoPanel, PANEL, hrefPermitido, plural } from "./comun";

// Resumen compacto de obras (V4): iniciales, nombre, pendiente principal y
// estado, sin fotografías y sin repetir las barras de la gráfica.

export const MAX_OBRAS = 5;

export const RANGO_SALUD: Record<EstadoSalud, number> = { REQUIERE_ACCION: 0, ATENCION: 1, SALUDABLE: 2, EN_SEGUIMIENTO: 3 };

export const ESTADO_SALUD: Record<EstadoSalud, { texto: string; clase: string }> = {
  REQUIERE_ACCION: { texto: "Requiere acción", clase: "bg-[var(--i-alerta-suave)] text-[var(--i-alerta)]" },
  ATENCION: { texto: "Atención", clase: "bg-[var(--i-aviso-suave)] text-[var(--i-aviso)]" },
  SALUDABLE: { texto: "Al día", clase: "bg-[var(--i-ok-suave)] text-[var(--i-ok)]" },
  EN_SEGUIMIENTO: { texto: "En seguimiento", clase: "bg-[var(--i-suave)] text-[var(--i-tinta-3)]" },
};

// Mismo orden para la lista y para la gráfica: obras activas por salud (la
// de General no usa información privada) y nombre; Supervisor, primero lo
// que lleva más tiempo sin avance.
export function ordenarObras(proyectos: FilaProyectoDashboard[], esSupervisor: boolean): FilaProyectoDashboard[] {
  return proyectos
    .filter((p) => p.estatus === "ACTIVO")
    .sort((a, b) =>
      esSupervisor
        ? b.semanasSinAvance - a.semanasSinAvance || a.nombre.localeCompare(b.nombre, "es")
        : RANGO_SALUD[a.salud] - RANGO_SALUD[b.salud] || a.nombre.localeCompare(b.nombre, "es")
    );
}

function iniciales(nombre: string): string {
  return (
    nombre
      .split(/\s+/)
      .filter((palabra) => /^[\p{L}\p{N}]/u.test(palabra))
      .slice(0, 2)
      .map((palabra) => palabra[0].toUpperCase())
      .join("") || "—"
  );
}

export function ResumenObras({
  ordenadas,
  obrasActivas,
  esSupervisor,
  modulos,
}: {
  ordenadas: FilaProyectoDashboard[];
  obrasActivas: { total: number; pausadas: number };
  esSupervisor: boolean;
  modulos: string[];
}) {
  const visibles = ordenadas.slice(0, MAX_OBRAS);
  const hrefTodas = hrefPermitido("/control-de-obra", modulos);
  const subtitulo =
    obrasActivas.total === 0 && obrasActivas.pausadas === 0
      ? null
      : [plural(obrasActivas.total, "activa"), obrasActivas.pausadas > 0 ? plural(obrasActivas.pausadas, "pausada") : null]
          .filter(Boolean)
          .join(" y ");

  return (
    <section aria-labelledby="obras-titulo" className={cn(PANEL, "px-6 pt-[22px] pb-3 max-sm:px-4")}>
      <EncabezadoPanel
        id="obras-titulo"
        titulo="Obras"
        subtitulo={subtitulo}
        enlace={ordenadas.length > 0 ? { href: hrefTodas, texto: ordenadas.length > MAX_OBRAS ? `Ver las ${ordenadas.length}` : "Ver todas" } : null}
      />
      {visibles.length === 0 ? (
        <div className="flex items-center gap-3 pb-3.5 text-sm font-medium text-[var(--i-tinta-2)]">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[var(--i-suave)] text-[var(--i-tinta-3)]">
            <HardHat size={20} aria-hidden />
          </span>
          <span>
            {obrasActivas.pausadas > 0 ? "Todas las obras están pausadas." : "Aún no hay obras activas."}{" "}
            {hrefTodas && (
              <Link href={hrefTodas} className={cn("rounded font-bold text-[var(--marca-tinta)] hover:underline", ANILLO_FOCO)}>
                Ir a Proyectos
              </Link>
            )}
          </span>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--i-linea)]">
          {visibles.map((p) => (
            <li key={p.id}>
              <FilaObra p={p} esSupervisor={esSupervisor} href={hrefPermitido(`/control-de-obra/${p.id}`, modulos)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilaObra({ p, esSupervisor, href }: { p: FilaProyectoDashboard; esSupervisor: boolean; href: string | null }) {
  const contenido = (
    <>
      <span aria-hidden className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--i-suave)] text-[13px] font-extrabold text-[var(--i-tinta-2)]">
        {iniciales(p.nombre)}
      </span>
      <span className="min-w-0">
        <b className="block truncate text-[15px] leading-5 font-bold">{p.nombre}</b>
        <Detalle p={p} esSupervisor={esSupervisor} />
      </span>
      {esSupervisor ? (
        <span />
      ) : (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap max-sm:col-start-2 max-sm:-mt-1 max-sm:justify-self-start",
            ESTADO_SALUD[p.salud].clase
          )}
        >
          <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-current" />
          {ESTADO_SALUD[p.salud].texto}
        </span>
      )}
      {href ? <ChevronRight size={18} aria-hidden className="text-[var(--i-tinta-3)] max-sm:col-start-3 max-sm:row-start-1" /> : <span />}
    </>
  );
  const clase =
    "-mx-2 grid grid-cols-[40px_minmax(0,1fr)_auto_18px] items-center gap-3.5 rounded-[14px] px-2 py-[13px] max-sm:grid-cols-[40px_minmax(0,1fr)_18px] max-sm:gap-y-1.5";
  if (!href) return <div className={clase}>{contenido}</div>;
  return (
    <Link
      href={href}
      aria-label={`${p.nombre}: ver obra`}
      className={cn(clase, "transition-colors duration-150 ease-[var(--ease-out)] hover:bg-[var(--i-suave)]", ANILLO_FOCO)}
    >
      {contenido}
    </Link>
  );
}

export function Detalle({ p, esSupervisor }: { p: FilaProyectoDashboard; esSupervisor: boolean }) {
  const base = "block truncate text-[13px] leading-[18px]";
  if (p.etapa === "POR_INICIAR") return <small className={cn(base, "text-[var(--i-tinta-3)]")}>Por iniciar</small>;
  if (esSupervisor) {
    // Un avance fechado en la semana en curso da un valor apenas negativo:
    // se muestra como «esta semana», nunca «hace -1 semanas».
    const semanas = Math.max(0, Math.floor(p.semanasSinAvance));
    return (
      <small className={cn(base, semanas >= 2 ? "font-semibold text-[var(--i-aviso)]" : "text-[var(--i-tinta-3)]")}>
        {semanas === 0 ? "Último avance esta semana" : `Último avance hace ${plural(semanas, "semana")}`}
      </small>
    );
  }
  if (!p.motivo) return <small className={cn(base, "text-[var(--i-tinta-3)]")}>Sin pendientes</small>;
  return (
    <small
      className={cn(
        base,
        p.motivo.severidad === "REQUIERE_ACCION" && "font-semibold text-[var(--i-alerta)]",
        p.motivo.severidad === "ATENCION" && "font-semibold text-[var(--i-aviso)]",
        p.motivo.severidad === "AVISO" && "text-[var(--i-tinta-3)]"
      )}
    >
      {p.motivo.texto}
    </small>
  );
}

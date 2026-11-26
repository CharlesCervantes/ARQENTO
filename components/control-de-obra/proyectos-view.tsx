import Link from "next/link";
import { LayoutGrid, List, MoreHorizontal, Plus, Search, Users, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { FilaProyectoDashboard } from "@/lib/server/dashboard";
import type { EstatusProyecto } from "@/lib/generated/prisma/client";
import {
  FILTROS_PROYECTOS,
  hrefListado,
  resumenEstatus,
  type EstatusListado,
  type FiltroProyectos,
  type VistaProyectos,
} from "@/lib/control-de-obra/listado-proyectos";
import { ANILLO_FOCO, Cifra, PANEL } from "@/components/dashboard/inicio/comun";
import { Detalle, ESTADO_SALUD } from "@/components/dashboard/inicio/obras";
import { fuenteInicio } from "@/components/dashboard/inicio/fuente";
import { BotonEliminarProyecto } from "@/components/control-de-obra/boton-eliminar-proyecto";
import { cambiarEstatusAction } from "@/app/(app)/control-de-obra/actions";

// Proyectos — diseño aprobado (noviembre 2026): mismo estilo que Inicio
// (clase `.inicio`), una tarjeta blanca por obra o una lista compacta.
// Solo compone: las cifras vienen de Inicio (proyectarResumenEjecutivo), ya
// recortadas por el servidor — Supervisor recibe montos y porcentajes
// financieros en null y nunca se consulta información privada.

export type ProyectoListado = {
  id: string;
  nombre: string;
  tipo: string;
  cliente: string | null;
  estatus: EstatusListado;
  pendientesAprobar: number;
  // null: el proyecto no tiene cifras de Inicio (cerrado o cancelado, o la
  // Empresa no tiene el módulo Inicio).
  fila: FilaProyectoDashboard | null;
};

const TIPO_LABEL: Record<string, string> = {
  FORMAL: "Obra",
  MOMENTANEA: "Obra momentánea",
  OFICINA: "Oficina",
};

const CHIP_ESTATUS: Record<EstatusListado, { texto: string; clase: string }> = {
  ACTIVO: { texto: "Activo", clase: "bg-[var(--i-ok-suave)] text-[var(--i-ok)]" },
  PAUSADO: { texto: "Pausado", clase: "bg-[var(--i-suave)] text-[var(--i-tinta-2)]" },
  CERRADO: { texto: "Cerrado", clase: "bg-[var(--i-suave)] text-[var(--i-tinta-2)]" },
  CANCELADO: { texto: "Cancelado", clase: "bg-[var(--i-alerta-suave)] text-[var(--i-alerta)]" },
};

const DETALLE_ESTATUS: Record<Exclude<EstatusListado, "ACTIVO">, string> = {
  PAUSADO: "Proyecto en pausa",
  CERRADO: "Proyecto cerrado",
  CANCELADO: "Proyecto cancelado",
};

const BOTON_PILDORA =
  "inline-flex min-h-11 items-center gap-2 rounded-full px-[18px] text-sm font-bold transition-[background-color,box-shadow] duration-150 ease-[var(--ease-out)]";

export function ProyectosView({
  proyectos,
  conteos,
  filtro,
  vista,
  busqueda,
  esSupervisor,
  puedeAdministrar,
  puedeEliminar,
  puedeAsignar,
}: {
  proyectos: ProyectoListado[];
  conteos: Record<FiltroProyectos, number>;
  filtro: FiltroProyectos;
  vista: VistaProyectos;
  busqueda: string;
  esSupervisor: boolean;
  puedeAdministrar: boolean;
  puedeEliminar: boolean;
  puedeAsignar: boolean;
}) {
  const estado = { filtro, vista, busqueda };
  const menu = { puedeAdministrar, puedeEliminar };
  const vacio = busqueda
    ? `Ningún proyecto coincide con «${busqueda}».`
    : (FILTROS_PROYECTOS.find((f) => f.clave === filtro)?.vacio ?? "No hay proyectos.");

  return (
    <div className={cn("inicio font-medium", fuenteInicio.variable)}>
      <div className="mx-auto flex max-w-[1240px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] max-sm:text-[26px] max-sm:leading-8">Proyectos</h1>
            <p className="mt-1.5 text-sm text-[var(--i-tinta-2)]">{resumenEstatus(conteos)}</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {puedeAsignar && (
              <Link href="/control-de-obra/accesos" className={cn(BOTON_PILDORA, "bg-[var(--i-tarjeta)] font-semibold shadow-[var(--i-sombra)] hover:shadow-[var(--i-sombra-hover)]", ANILLO_FOCO)}>
                <Users size={16} aria-hidden />
                Accesos de supervisores
              </Link>
            )}
            {puedeAdministrar && (
              <Link href="/control-de-obra/nuevo" className={cn(BOTON_PILDORA, "bg-[var(--i-grafito)] text-[var(--i-grafito-tinta)] hover:bg-[var(--i-grafito-2)]", ANILLO_FOCO)}>
                <Plus size={16} strokeWidth={2.4} aria-hidden />
                Nuevo proyecto
              </Link>
            )}
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="Filtrar por estatus" className="max-w-full overflow-x-auto rounded-full bg-[var(--i-tarjeta)] p-1 shadow-[var(--i-sombra)]">
            <ul className="flex gap-0.5">
              {FILTROS_PROYECTOS.map((f) => {
                const activo = f.clave === filtro;
                return (
                  <li key={f.clave}>
                    <Link
                      href={hrefListado({ ...estado, filtro: f.clave })}
                      aria-current={activo ? "page" : undefined}
                      className={cn(
                        "inline-flex min-h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition-colors duration-150 ease-[var(--ease-out)]",
                        activo ? "bg-[var(--i-grafito)] text-[var(--i-grafito-tinta)]" : "text-[var(--i-tinta-2)] hover:bg-[var(--i-suave)]",
                        ANILLO_FOCO
                      )}
                    >
                      {f.etiqueta}
                      <span
                        className={cn(
                          "rounded-full px-[7px] py-0.5 text-[11px] font-bold tabular-nums",
                          activo ? "bg-[var(--i-grafito-2)] text-[var(--i-grafito-tinta)]" : "bg-[var(--i-suave)] text-[var(--i-tinta-2)]"
                        )}
                      >
                        {conteos[f.clave]}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <form action="/control-de-obra" method="get" role="search" className="flex min-h-12 min-w-[220px] flex-[1_1_260px] items-center gap-2.5 rounded-full bg-[var(--i-tarjeta)] pr-2 pl-4 text-[var(--i-tinta-3)] shadow-[var(--i-sombra)] focus-within:outline-2 focus-within:outline-[var(--marca-tinta)]">
            {filtro !== "activos" && <input type="hidden" name="estatus" value={filtro} />}
            {vista !== "tarjetas" && <input type="hidden" name="vista" value={vista} />}
            <Search size={16} aria-hidden className="shrink-0" />
            <label htmlFor="buscar-proyecto" className="sr-only">
              Buscar proyecto
            </label>
            <input
              id="buscar-proyecto"
              type="search"
              name="q"
              defaultValue={busqueda}
              placeholder="Buscar por proyecto o cliente"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--i-tinta)] outline-none placeholder:text-[var(--i-tinta-3)]"
            />
            {busqueda && (
              <Link href={hrefListado({ ...estado, busqueda: "" })} aria-label="Quitar búsqueda" className={cn("grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--i-suave)]", ANILLO_FOCO)}>
                <X size={16} aria-hidden />
              </Link>
            )}
          </form>

          <nav aria-label="Vista" className="inline-flex gap-0.5 rounded-full bg-[var(--i-tarjeta)] p-1 shadow-[var(--i-sombra)]">
            {(
              [
                { clave: "tarjetas", texto: "Tarjetas", Icono: LayoutGrid },
                { clave: "lista", texto: "Lista", Icono: List },
              ] as const
            ).map(({ clave, texto, Icono }) => (
              <Link
                key={clave}
                href={hrefListado({ ...estado, vista: clave })}
                aria-current={vista === clave ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors duration-150 ease-[var(--ease-out)]",
                  vista === clave ? "bg-[var(--i-suave)] text-[var(--i-tinta)]" : "text-[var(--i-tinta-2)] hover:bg-[var(--i-suave)]",
                  ANILLO_FOCO
                )}
              >
                <Icono size={16} aria-hidden />
                {texto}
              </Link>
            ))}
          </nav>
        </div>

        {proyectos.length === 0 ? (
          <p className={cn(PANEL, "p-7 text-center text-sm text-[var(--i-tinta-2)]")}>{vacio}</p>
        ) : vista === "tarjetas" ? (
          <ul className="enter grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-[18px] max-sm:gap-3.5">
            {proyectos.map((p) => (
              <li key={p.id} className="flex">
                <TarjetaProyecto p={p} esSupervisor={esSupervisor} menu={menu} />
              </li>
            ))}
          </ul>
        ) : (
          <TablaProyectos proyectos={proyectos} esSupervisor={esSupervisor} menu={menu} />
        )}
      </div>
    </div>
  );
}

type Menu = { puedeAdministrar: boolean; puedeEliminar: boolean };

function chipDe(p: ProyectoListado, esSupervisor: boolean) {
  // La salud solo se muestra para obras activas y nunca al Supervisor (igual
  // que en Inicio); en los demás casos, el estatus del proyecto.
  if (p.estatus === "ACTIVO" && p.fila && !esSupervisor) return ESTADO_SALUD[p.fila.salud];
  return CHIP_ESTATUS[p.estatus];
}

function Chip({ p, esSupervisor }: { p: ProyectoListado; esSupervisor: boolean }) {
  const { texto, clase } = chipDe(p, esSupervisor);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap", clase)}>
      <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-current" />
      {texto}
    </span>
  );
}

function LineaDetalle({ p, esSupervisor }: { p: ProyectoListado; esSupervisor: boolean }) {
  if (p.estatus !== "ACTIVO") return <small className="block truncate text-[13px] leading-[18px] text-[var(--i-tinta-3)]">{DETALLE_ESTATUS[p.estatus]}</small>;
  if (!p.fila) return null;
  return <Detalle p={p.fila} esSupervisor={esSupervisor} />;
}

function PendientesAprobar({ p }: { p: ProyectoListado }) {
  if (p.pendientesAprobar === 0) return null;
  return (
    <Link
      href={`/control-de-obra/${p.id}/ejecucion/avance`}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--i-aviso-suave)] px-2.5 py-1 text-xs font-bold text-[var(--i-aviso)] hover:underline",
        ANILLO_FOCO
      )}
    >
      {p.pendientesAprobar} avance{p.pendientesAprobar === 1 ? "" : "s"} por aprobar
    </Link>
  );
}

// Avance de la obra. Sin fila de Inicio no se muestra nada (no se inventa un
// 0 %); el financiero solo llega a quien puede verlo (null al Supervisor).
function Avance({ fila, esSupervisor, compacto = false }: { fila: FilaProyectoDashboard; esSupervisor: boolean; compacto?: boolean }) {
  const fisico = fila.avanceFisico.incompleto ? null : fila.avanceFisico.porcentaje;
  return (
    <div className={cn("flex flex-col", compacto ? "gap-1.5" : "gap-2.5")}>
      <Barra rotulo="Físico" valor={fisico} sinDato={fila.avanceFisico.incompleto ? "Faltan precios" : "Sin datos"} color="bg-[var(--i-grafito-2)]" compacto={compacto} />
      {!esSupervisor && <Barra rotulo="Facturado" valor={fila.avanceFinancieroPorcentaje} sinDato="Sin datos" color="bg-[var(--serie-2)]" compacto={compacto} />}
    </div>
  );
}

function Barra({ rotulo, valor, sinDato, color, compacto }: { rotulo: string; valor: number | null; sinDato: string; color: string; compacto: boolean }) {
  const ancho = valor === null ? 0 : Math.min(100, Math.max(0, valor));
  return (
    <div className={cn("grid items-center gap-2.5 text-xs text-[var(--i-tinta-2)]", compacto ? "grid-cols-[64px_minmax(60px,1fr)_auto]" : "grid-cols-[72px_minmax(0,1fr)_auto]")}>
      <span>{rotulo}</span>
      <span
        role="meter"
        aria-label={`Avance ${rotulo.toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valor === null ? undefined : Math.round(ancho)}
        aria-valuetext={valor === null ? sinDato : `${Math.round(valor)} %`}
        className={cn("overflow-hidden rounded-full bg-[var(--i-suave)]", compacto ? "h-1.5" : "h-2")}
      >
        <span className={cn("block h-full rounded-full", color)} style={{ width: `${ancho}%` }} />
      </span>
      <span className={cn("text-right tabular-nums", valor === null ? "text-[var(--i-tinta-3)]" : "font-bold text-[var(--i-tinta)]")}>
        {valor === null ? sinDato : `${Math.round(valor)} %`}
      </span>
    </div>
  );
}

function PorPagar({ fila }: { fila: FilaProyectoDashboard | null }) {
  if (!fila || fila.porPagar === null) return <span />;
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--i-tinta-3)]">Por pagar</div>
      <Cifra valor={fila.porPagar} className={cn("text-base font-extrabold", fila.porPagar > 0 ? "text-[var(--i-alerta)]" : "text-[var(--i-tinta)]")} />
    </div>
  );
}

function TarjetaProyecto({ p, esSupervisor, menu }: { p: ProyectoListado; esSupervisor: boolean; menu: Menu }) {
  return (
    <article className={cn(PANEL, "flex w-full flex-col gap-3.5 p-5 transition-shadow duration-200 ease-[var(--ease-out)] hover:shadow-[var(--i-sombra-hover)]")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] leading-[22px] font-extrabold tracking-[-0.01em] break-words">{p.nombre}</h2>
          <p className="mt-0.5 text-[13px] text-[var(--i-tinta-3)]">
            {TIPO_LABEL[p.tipo] ?? p.tipo} · {p.cliente ?? "Sin cliente"}
          </p>
        </div>
        <Chip p={p} esSupervisor={esSupervisor} />
      </div>
      <LineaDetalle p={p} esSupervisor={esSupervisor} />
      <PendientesAprobar p={p} />
      {p.fila && <Avance fila={p.fila} esSupervisor={esSupervisor} />}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--i-linea)] pt-3.5">
        <PorPagar fila={p.fila} />
        <div className="flex items-center gap-2">
          <MenuAcciones p={p} menu={menu} />
          <Link
            href={`/control-de-obra/${p.id}`}
            className={cn("inline-flex min-h-10 items-center rounded-xl bg-[var(--i-grafito)] px-4 text-[13px] font-bold text-[var(--i-grafito-tinta)] hover:bg-[var(--i-grafito-2)]", ANILLO_FOCO)}
          >
            Abrir obra
          </Link>
        </div>
      </div>
    </article>
  );
}

function TablaProyectos({ proyectos, esSupervisor, menu }: { proyectos: ProyectoListado[]; esSupervisor: boolean; menu: Menu }) {
  return (
    <div className={cn(PANEL, "enter overflow-x-auto")}>
      <table className="w-full min-w-[860px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--i-tinta-3)]">
            <th scope="col" className="px-5 py-4 font-semibold">Proyecto</th>
            <th scope="col" className="px-3 py-4 font-semibold">Cliente</th>
            <th scope="col" className="w-[230px] px-3 py-4 font-semibold">{esSupervisor ? "Avance físico" : "Avance físico / facturado"}</th>
            {!esSupervisor && <th scope="col" className="px-3 py-4 text-right font-semibold">Por pagar</th>}
            <th scope="col" className="px-3 py-4 font-semibold">Estado</th>
            <th scope="col" className="px-5 py-4"><span className="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          {proyectos.map((p) => (
            <tr key={p.id} className="border-t border-[var(--i-linea)] align-middle hover:bg-[var(--i-suave)]/50">
              <td className="max-w-[320px] px-5 py-3.5">
                <div className="truncate font-bold">{p.nombre}</div>
                <LineaDetalle p={p} esSupervisor={esSupervisor} />
                <div className="mt-1 empty:hidden"><PendientesAprobar p={p} /></div>
              </td>
              <td className="px-3 py-3.5 text-[var(--i-tinta-2)]">{p.cliente ?? "Sin cliente"}</td>
              <td className="px-3 py-3.5">
                {p.fila ? <Avance fila={p.fila} esSupervisor={esSupervisor} compacto /> : <span className="text-xs text-[var(--i-tinta-3)]">—</span>}
              </td>
              {!esSupervisor && (
                <td className="px-3 py-3.5 text-right font-bold">
                  {p.fila?.porPagar != null ? (
                    <Cifra valor={p.fila.porPagar} className={p.fila.porPagar > 0 ? "text-[var(--i-alerta)]" : undefined} />
                  ) : (
                    <span className="text-[var(--i-tinta-3)]">—</span>
                  )}
                </td>
              )}
              <td className="px-3 py-3.5"><Chip p={p} esSupervisor={esSupervisor} /></td>
              <td className="px-5 py-3.5">
                <div className="flex items-center justify-end gap-2">
                  <MenuAcciones p={p} menu={menu} />
                  <Link
                    href={`/control-de-obra/${p.id}`}
                    className={cn("inline-flex min-h-9 items-center rounded-[10px] bg-[var(--i-grafito)] px-3.5 text-[13px] font-bold text-[var(--i-grafito-tinta)] hover:bg-[var(--i-grafito-2)]", ANILLO_FOCO)}
                  >
                    Abrir
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Mismas acciones que tenía la tabla anterior (cambiar estatus, eliminar).
function MenuAcciones({ p, menu }: { p: ProyectoListado; menu: Menu }) {
  if (!menu.puedeAdministrar) return null;
  return (
    <details className="group relative">
      <summary
        aria-label={`Más acciones de ${p.nombre}`}
        className={cn(
          "flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-xl border border-[var(--i-linea)] bg-[var(--i-tarjeta)] text-[var(--i-tinta-2)] transition-colors duration-150 ease-out select-none hover:bg-[var(--i-suave)] [&::-webkit-details-marker]:hidden",
          ANILLO_FOCO
        )}
      >
        <MoreHorizontal size={16} aria-hidden />
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1.5 w-44 overflow-hidden rounded-xl border border-[var(--i-linea)] bg-[var(--i-tarjeta)] py-1 text-left shadow-[var(--i-sombra-hover)]">
        {transicionesDisponibles(p.estatus).map((t) => (
          <form key={t.estatus} action={cambiarEstatusAction.bind(null, p.id, t.estatus)}>
            <button
              type="submit"
              className={cn("block w-full px-3.5 py-2 text-left text-sm transition-colors duration-150 ease-out", t.claseColor ?? "text-[var(--i-tinta)] hover:bg-[var(--i-suave)]")}
            >
              {t.etiqueta}
            </button>
          </form>
        ))}
        {menu.puedeEliminar && <BotonEliminarProyecto proyectoId={p.id} proyectoNombre={p.nombre} />}
      </div>
    </details>
  );
}

// claseColor: solo las 3 transiciones que el negocio pidió distinguir por
// color (Reactivar/Pausar/Cancelar) — Cerrar y Reabrir se quedan con el
// estilo neutro por defecto (decisión de sesión, agosto 2026).
function transicionesDisponibles(estatus: EstatusProyecto): { estatus: EstatusProyecto; etiqueta: string; claseColor?: string }[] {
  switch (estatus) {
    case "ACTIVO":
      return [
        { estatus: "PAUSADO", etiqueta: "Pausar", claseColor: "text-amber-700 hover:bg-amber-50" },
        { estatus: "CERRADO", etiqueta: "Cerrar" },
        { estatus: "CANCELADO", etiqueta: "Cancelar", claseColor: "text-red-700 hover:bg-red-50" },
      ];
    case "PAUSADO":
      return [
        { estatus: "ACTIVO", etiqueta: "Reactivar", claseColor: "text-emerald-700 hover:bg-emerald-50" },
        { estatus: "CERRADO", etiqueta: "Cerrar" },
        { estatus: "CANCELADO", etiqueta: "Cancelar", claseColor: "text-red-700 hover:bg-red-50" },
      ];
    case "CERRADO":
    case "CANCELADO":
      return [{ estatus: "ACTIVO", etiqueta: "Reabrir" }];
    default:
      return [];
  }
}

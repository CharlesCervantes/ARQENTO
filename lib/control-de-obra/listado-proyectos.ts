// Listado de Proyectos (tarjetas / lista): filtros por estatus, búsqueda y
// orden. Lógica pura — sin BD ni React — para poder probarla aparte.
//
// Los filtros son por ESTATUS del proyecto. La salud de la obra («Atención»,
// «Al día»…) se muestra solo en su tarjeta, nunca como filtro (decisión de
// diseño, noviembre 2026). Los proyectos cerrados solo aparecen en «Todos».

export type EstatusListado = "ACTIVO" | "PAUSADO" | "CERRADO" | "CANCELADO";
export type FiltroProyectos = "activos" | "todos" | "pausados" | "cancelados";
export type VistaProyectos = "tarjetas" | "lista";

export const FILTROS_PROYECTOS: { clave: FiltroProyectos; etiqueta: string; vacio: string }[] = [
  { clave: "activos", etiqueta: "Activos", vacio: "No hay proyectos activos." },
  { clave: "todos", etiqueta: "Todos", vacio: "Todavía no hay proyectos." },
  { clave: "pausados", etiqueta: "Pausados", vacio: "No hay proyectos pausados." },
  { clave: "cancelados", etiqueta: "Cancelados", vacio: "No hay proyectos cancelados." },
];

const ESTATUS_DE_FILTRO: Record<FiltroProyectos, EstatusListado | null> = {
  activos: "ACTIVO",
  todos: null,
  pausados: "PAUSADO",
  cancelados: "CANCELADO",
};

export function aFiltroProyectos(valor: string | string[] | undefined): FiltroProyectos {
  return FILTROS_PROYECTOS.some((f) => f.clave === valor) ? (valor as FiltroProyectos) : "activos";
}

export function aVistaProyectos(valor: string | string[] | undefined): VistaProyectos {
  return valor === "lista" ? "lista" : "tarjetas";
}

export function aBusqueda(valor: string | string[] | undefined): string {
  return typeof valor === "string" ? valor.trim().slice(0, 100) : "";
}

export function cumpleFiltro(estatus: EstatusListado, filtro: FiltroProyectos): boolean {
  const requerido = ESTATUS_DE_FILTRO[filtro];
  return requerido === null || estatus === requerido;
}

export function contarPorFiltro(proyectos: { estatus: EstatusListado }[]): Record<FiltroProyectos, number> {
  return {
    activos: proyectos.filter((p) => cumpleFiltro(p.estatus, "activos")).length,
    todos: proyectos.length,
    pausados: proyectos.filter((p) => cumpleFiltro(p.estatus, "pausados")).length,
    cancelados: proyectos.filter((p) => cumpleFiltro(p.estatus, "cancelados")).length,
  };
}

// Sin acentos ni mayúsculas: «cienega» encuentra «CIÉNEGA».
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function coincideBusqueda(proyecto: { nombre: string; cliente: string | null }, busqueda: string): boolean {
  if (!busqueda) return true;
  const termino = normalizar(busqueda);
  return normalizar(proyecto.nombre).includes(termino) || normalizar(proyecto.cliente ?? "").includes(termino);
}

const ORDEN_ESTATUS: Record<EstatusListado, number> = { ACTIVO: 0, PAUSADO: 1, CERRADO: 2, CANCELADO: 3 };

// Activos primero; dentro de cada estatus, primero lo que necesita atención
// (rango de salud menor; sin dato de salud, al final) y luego por nombre.
export function ordenarProyectos<T extends { nombre: string; estatus: EstatusListado; rangoSalud: number | null }>(proyectos: T[]): T[] {
  return [...proyectos].sort(
    (a, b) =>
      ORDEN_ESTATUS[a.estatus] - ORDEN_ESTATUS[b.estatus] ||
      (a.rangoSalud ?? 99) - (b.rangoSalud ?? 99) ||
      a.nombre.localeCompare(b.nombre, "es")
  );
}

export function resumenEstatus(conteos: Record<FiltroProyectos, number>): string {
  const partes = [
    `${conteos.activos} ${conteos.activos === 1 ? "activo" : "activos"}`,
    conteos.pausados > 0 ? `${conteos.pausados} ${conteos.pausados === 1 ? "pausado" : "pausados"}` : null,
  ].filter(Boolean);
  return partes.join(" y ");
}

// Enlace de la pantalla conservando lo demás; omite los valores por defecto
// para que la URL de entrada siga siendo /control-de-obra.
export function hrefListado(estado: { filtro: FiltroProyectos; vista: VistaProyectos; busqueda: string }): string {
  const parametros = new URLSearchParams();
  if (estado.filtro !== "activos") parametros.set("estatus", estado.filtro);
  if (estado.vista !== "tarjetas") parametros.set("vista", estado.vista);
  if (estado.busqueda) parametros.set("q", estado.busqueda);
  const texto = parametros.toString();
  return texto ? `/control-de-obra?${texto}` : "/control-de-obra";
}

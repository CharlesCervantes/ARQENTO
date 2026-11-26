import { GRID_PROYECTOS } from "./grid-proyectos";
import { cn } from "@/lib/cn";

export function TablaProyectosHeader() {
  return (
    <div
      className={cn(
        GRID_PROYECTOS,
        "px-5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]"
      )}
    >
      <span>Proyecto</span>
      <span className="text-right">Fin de semana</span>
      <span className="text-right">Total semana</span>
      <span className="text-right">Pendiente</span>
      <span className="text-right">Estado</span>
    </div>
  );
}

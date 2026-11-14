import { cn } from "@/lib/cn";
import type { FilaProyectoDashboard, VistaDashboard } from "@/lib/server/dashboard";
import { EncabezadoPanel, PANEL, hrefPermitido } from "./comun";
import { MAX_OBRAS } from "./obras";

// Avance por obra (V4): barras horizontales agrupadas, sólidas.
// - Físico: color de la Empresa. Segunda serie: Facturado (General) o
//   Cubierto (Privado), gris pizarra con luminosidad opuesta a la marca.
// - Supervisor: solo Físico (el servidor ya le entrega el financiero en null).
// - Escala común: 100 % o, si un valor real lo supera, el siguiente múltiplo
//   de 25. Un dato ausente se dice "Sin datos"; nunca se dibuja como cero.

type Serie = { clave: "fisico" | "financiero"; rotulo: string; color: string };

export function GraficaAvance({
  ordenadas,
  vista,
  esSupervisor,
  modulos,
}: {
  ordenadas: FilaProyectoDashboard[];
  vista: VistaDashboard;
  esSupervisor: boolean;
  modulos: string[];
}) {
  const obras = ordenadas.slice(0, MAX_OBRAS);
  const series: Serie[] = [
    { clave: "fisico", rotulo: "Físico", color: "var(--marca-relleno)" },
    ...(esSupervisor ? [] : [{ clave: "financiero" as const, rotulo: vista === "privado" ? "Cubierto" : "Facturado", color: "var(--serie-2)" }]),
  ];
  const valor = (p: FilaProyectoDashboard, s: Serie): number | null =>
    s.clave === "fisico" ? (p.avanceFisico.incompleto ? null : p.avanceFisico.porcentaje) : p.avanceFinancieroPorcentaje;

  const reales = obras.flatMap((p) => series.map((s) => valor(p, s))).filter((v): v is number => v !== null);
  const maximo = Math.max(100, Math.ceil(Math.max(0, ...reales) / 25) * 25);
  const pasos: number[] = [];
  for (let v = 0; v <= maximo; v += 25) pasos.push(v);
  const x = (v: number) => (Math.max(v, 0) / maximo) * 100;

  const subtitulo = esSupervisor ? "Avance físico, a la fecha" : `Físico frente a ${series[1].rotulo.toLowerCase()}, a la fecha`;

  return (
    <section aria-labelledby="grafica-titulo" className={cn(PANEL, "px-6 pt-[22px] pb-5 max-sm:px-4")}>
      <EncabezadoPanel
        id="grafica-titulo"
        titulo="Avance por obra"
        subtitulo={subtitulo}
        enlace={obras.length > 0 ? { href: hrefPermitido("/control-de-obra", modulos), texto: "Ver todas" } : null}
      />

      {obras.length === 0 ? (
        <p className="pb-2 text-sm font-medium text-[var(--i-tinta-3)]">Sin obras activas para comparar.</p>
      ) : (
        <>
          <div className="mb-3.5 flex flex-wrap gap-3.5 text-[13px] font-semibold text-[var(--i-tinta-2)]">
            {series.map((s) => (
              <span key={s.clave} className="inline-flex items-center gap-1.5">
                <i aria-hidden className="inline-block h-2.5 w-[22px] rounded-full" style={{ background: s.color }} />
                {s.rotulo}
              </span>
            ))}
          </div>

          <div className="relative grid gap-3.5">
            {/* Rejilla común detrás de las barras; 100 % marcado. */}
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-16 left-0">
              {pasos.map((v) => (
                <i
                  key={v}
                  className={cn("absolute inset-y-0 w-px", v === 100 ? "w-[1.5px] bg-[var(--i-tinta-3)] opacity-55" : "bg-[var(--i-linea)]")}
                  style={{ left: `${x(v)}%` }}
                />
              ))}
            </div>
            {obras.map((p) => (
              <div key={p.id} className="relative grid gap-1">
                <span className="truncate text-sm font-bold" title={p.nombre}>
                  {p.nombre}
                </span>
                {series.map((s) => {
                  const v = valor(p, s);
                  return (
                    <div key={s.clave} className="grid grid-cols-[minmax(0,1fr)_54px] items-center gap-2.5 leading-4">
                      <span
                        role="img"
                        aria-label={`${p.nombre}, ${s.rotulo}: ${v === null ? "sin datos" : `${v.toFixed(1)} %`}`}
                        className="relative block h-3.5"
                      >
                        {v === null ? (
                          <span className="absolute inset-0 rounded-full border-[1.5px] border-dashed border-[var(--i-linea)]" />
                        ) : (
                          <span className="absolute inset-y-0 left-0 rounded-r-full" style={{ width: `${x(v)}%`, background: s.color }} />
                        )}
                      </span>
                      <span className={cn("text-right tabular-nums", v === null ? "text-xs font-semibold text-[var(--i-tinta-3)]" : "text-[13px] font-bold")}>
                        {v === null ? "Sin datos" : `${Math.round(v)} %`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div aria-hidden className="relative mt-2 mr-16 h-[18px] text-[11px] font-semibold text-[var(--i-tinta-3)]">
            {pasos.map((v, i) => (
              <span
                key={v}
                className={cn("absolute whitespace-nowrap", i === 0 ? "" : i === pasos.length - 1 ? "-translate-x-full" : "-translate-x-1/2")}
                style={{ left: `${x(v)}%` }}
              >
                {v} %
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

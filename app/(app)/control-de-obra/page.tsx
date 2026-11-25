import Link from "next/link";
import { requireSession } from "@/lib/server/auth/dal";
import {
  empresaTieneModulo,
  puedeAdministrarProyectos,
  puedeAsignarObras,
  puedeEliminarProyectos,
} from "@/lib/server/permisos";
import { listarProyectos } from "@/lib/server/control-de-obra/proyectos";
import { contarPendientesPorProyecto } from "@/lib/server/control-de-obra/avance";
import type { EstatusProyecto, Proyecto } from "@/lib/generated/prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, Thead, Tr, Th, Td } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { EstatusProyectoBadge } from "@/components/control-de-obra/estatus-proyecto-badge";
import { BotonEliminarProyecto } from "@/components/control-de-obra/boton-eliminar-proyecto";
import { cambiarEstatusAction } from "./actions";

const TIPO_LABEL: Record<string, string> = {
  FORMAL: "Obra",
  MOMENTANEA: "Obra momentánea",
  OFICINA: "Oficina",
};

export default async function ControlDeObraPage() {
  const usuario = await requireSession();

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  if (!empresaTieneModulo(usuario, "control_de_obra")) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu plan no incluye el módulo de Control de Obra.
      </Card>
    );
  }

  const proyectos = await listarProyectos(usuario);
  const operativos = proyectos.filter(
    (p) => p.estatus === "ACTIVO" || p.estatus === "PAUSADO"
  );
  const historicos = proyectos.filter(
    (p) => p.estatus === "CERRADO" || p.estatus === "CANCELADO"
  );
  const puedeAdministrar = puedeAdministrarProyectos(usuario);
  const puedeEliminar = puedeEliminarProyectos(usuario);
  // Solo quien puede aprobar necesita ver el aviso — nadie más puede actuar
  // sobre él (mismo criterio que P.U./Monto en Avance de obra).
  const pendientesPorProyecto = puedeAdministrar
    ? await contarPendientesPorProyecto(usuario.empresa.id)
    : new Map<string, number>();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Proyectos
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Administración de proyectos
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {puedeAsignarObras(usuario) && (
            <Link href="/control-de-obra/accesos">
              <Button variant="outline">Accesos de supervisores</Button>
            </Link>
          )}
          {puedeAdministrar && (
            <Link href="/control-de-obra/nuevo">
              <Button>+ Nuevo proyecto</Button>
            </Link>
          )}
        </div>
      </div>

      {operativos.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay proyectos activos o pausados.
        </Card>
      ) : (
        <Card className="enter overflow-hidden">
          <Table>
            <Thead>
              <Tr>
                <Th>Proyecto</Th>
                <Th>Tipo</Th>
                <Th>Cliente</Th>
                <Th>Estatus</Th>
                <Th className="text-right">Acciones</Th>
              </Tr>
            </Thead>
            <tbody>
              {operativos.map((p) => (
                <FilaProyecto
                  key={p.id}
                  proyecto={p}
                  puedeAdministrar={puedeAdministrar}
                  puedeEliminar={puedeEliminar}
                  pendientesAprobar={pendientesPorProyecto.get(p.id) ?? 0}
                />
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {historicos.length > 0 && (
        <Card className="enter overflow-hidden">
          <details>
            <summary className="cursor-pointer list-none px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
              <span className="text-sm font-semibold text-[var(--foreground)]">
                Histórico
              </span>
              <span className="ml-2 text-xs text-[var(--muted)]">
                {historicos.length} proyecto{historicos.length === 1 ? "" : "s"}{" "}
                cerrado{historicos.length === 1 ? "" : "s"} o cancelado
                {historicos.length === 1 ? "" : "s"}
              </span>
            </summary>
            <div className="border-t border-[var(--border)]">
              <table className="w-full text-sm">
                <Thead>
                  <Tr>
                    <Th>Proyecto</Th>
                    <Th>Tipo</Th>
                    <Th>Cliente</Th>
                    <Th>Estatus</Th>
                    <Th className="text-right">Acciones</Th>
                  </Tr>
                </Thead>
                <tbody>
                  {historicos.map((p) => (
                    <FilaProyecto
                      key={p.id}
                      proyecto={p}
                      puedeAdministrar={puedeAdministrar}
                      puedeEliminar={puedeEliminar}
                      pendientesAprobar={pendientesPorProyecto.get(p.id) ?? 0}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}

function FilaProyecto({
  proyecto,
  puedeAdministrar,
  puedeEliminar,
  pendientesAprobar,
}: {
  proyecto: Proyecto;
  puedeAdministrar: boolean;
  puedeEliminar: boolean;
  pendientesAprobar: number;
}) {
  return (
    <Tr>
      <Td className="font-medium">
        <div>{proyecto.nombre}</div>
        {pendientesAprobar > 0 && (
          <Link
            href={`/control-de-obra/${proyecto.id}/ejecucion/avance`}
            className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors duration-150 ease-out hover:bg-amber-100"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {pendientesAprobar} pendiente{pendientesAprobar === 1 ? "" : "s"} de aprobar
          </Link>
        )}
      </Td>
      <Td className="text-[var(--muted)]">
        {TIPO_LABEL[proyecto.tipo] ?? proyecto.tipo}
      </Td>
      <Td className="text-[var(--muted)]">{proyecto.cliente ?? "—"}</Td>
      <Td>
        <EstatusProyectoBadge estatus={proyecto.estatus} />
      </Td>
      <Td>
        <div className="flex justify-end gap-2">
          <Link href={`/control-de-obra/${proyecto.id}`}>
            <Button variant="outline" className="px-3 py-1.5 text-xs">
              Abrir
            </Button>
          </Link>
          {puedeAdministrar && (
            <details className="group relative">
              <summary className="flex h-[30px] w-[30px] cursor-pointer list-none items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] transition-colors duration-150 ease-out select-none hover:bg-black/[0.03] hover:text-[var(--foreground)] [&::-webkit-details-marker]:hidden">
                ⋯
              </summary>
              <div className="absolute right-0 z-20 mt-1.5 w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.16)]">
                {transicionesDisponibles(proyecto.estatus).map((t) => (
                  <form
                    key={t.estatus}
                    action={cambiarEstatusAction.bind(null, proyecto.id, t.estatus)}
                  >
                    <button
                      type="submit"
                      className={cn(
                        "block w-full px-3.5 py-2 text-left text-sm transition-colors duration-150 ease-out",
                        t.claseColor ?? "text-[var(--foreground)] hover:bg-black/[0.04]"
                      )}
                    >
                      {t.etiqueta}
                    </button>
                  </form>
                ))}
                {puedeEliminar && (
                  <BotonEliminarProyecto proyectoId={proyecto.id} proyectoNombre={proyecto.nombre} />
                )}
              </div>
            </details>
          )}
        </div>
      </Td>
    </Tr>
  );
}

// claseColor: solo las 3 transiciones que el negocio pidió distinguir por
// color (Reactivar/Pausar/Cancelar) — Cerrar y Reabrir se quedan con el
// estilo neutro por defecto (decisión de sesión, agosto 2026).
function transicionesDisponibles(
  estatus: EstatusProyecto
): { estatus: EstatusProyecto; etiqueta: string; claseColor?: string }[] {
  switch (estatus) {
    case "ACTIVO":
      return [
        { estatus: "PAUSADO", etiqueta: "Pausar", claseColor: "text-amber-700 hover:bg-amber-50" },
        { estatus: "CERRADO", etiqueta: "Cerrar" },
        { estatus: "CANCELADO", etiqueta: "Cancelar", claseColor: "text-red-700 hover:bg-red-50" },
      ];
    case "PAUSADO":
      return [
        {
          estatus: "ACTIVO",
          etiqueta: "Reactivar",
          claseColor: "text-emerald-700 hover:bg-emerald-50",
        },
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

"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/dinero";
import { formatearFecha } from "@/lib/fecha";
import { CATEGORIA_GASTO_LABEL } from "@/lib/control-de-obra/categorias-gasto";
import { FormularioGasto } from "./formulario-gasto";
import type { FilaGastoGlobal } from "@/lib/server/control-de-obra/gastos";

const ESTATUS_GASTO_ESTILO: Record<string, string> = {
  BORRADOR: "bg-black/[0.05] text-[var(--muted)]",
  PENDIENTE_REVISION: "bg-amber-100 text-amber-800",
  APROBADO: "bg-emerald-100 text-emerald-700",
  RECHAZADO: "bg-red-100 text-red-700",
  CANCELADO: "bg-black/[0.05] text-[var(--muted)]",
};

const ESTATUS_GASTO_LABEL: Record<string, string> = {
  BORRADOR: "Borrador",
  PENDIENTE_REVISION: "Pendiente de revisión",
  APROBADO: "Aprobado",
  RECHAZADO: "Rechazado",
  CANCELADO: "Cancelado",
};

// Vista de solo lectura + captura — la aprobación/rechazo, evidencia y
// reposiciones siguen viviendo en Proyecto → Ejecución → Gastos (esta
// pantalla es el acceso rápido transversal, no un segundo flujo — Gastos
// transversal, septiembre 2026).
export function GastosGlobalView({
  gastos,
  proyectosDisponibles,
  beneficiarios,
  beneficiarioVinculado,
  verPrivado,
}: {
  gastos: FilaGastoGlobal[];
  proyectosDisponibles: { id: string; nombre: string }[];
  beneficiarios: { id: string; nombre: string; tipo: string }[];
  beneficiarioVinculado: { id: string; nombre: string } | null;
  verPrivado: boolean;
}) {
  const [modalNuevoGasto, setModalNuevoGasto] = useState(false);
  const [gastoEditando, setGastoEditando] = useState<FilaGastoGlobal | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Gastos de la semana</h2>
        <Button onClick={() => setModalNuevoGasto(true)}>+ Registrar gasto</Button>
      </div>

      {gastos.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay gastos capturados esta semana.
        </Card>
      ) : (
        <div className="space-y-3">
          {gastos.map((g) => (
            <Card key={g.id} className="enter p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-[var(--foreground)]">{g.descripcion}</p>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${ESTATUS_GASTO_ESTILO[g.estatus]}`}
                    >
                      {ESTATUS_GASTO_LABEL[g.estatus]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {g.esEmpresa ? (
                      <span className="font-medium text-[var(--brand)]">Empresa</span>
                    ) : (
                      g.proyectoNombre
                    )}{" "}
                    · {formatearFecha(new Date(g.fecha))} ·{" "}
                    {CATEGORIA_GASTO_LABEL[g.categoria as keyof typeof CATEGORIA_GASTO_LABEL] ?? g.categoria}
                    {g.pagadorNombre && ` · Pagó: ${g.pagadorNombre}`}
                  </p>
                  {g.estatus === "PENDIENTE_REVISION" || g.estatus === "BORRADOR" ? (
                    <button
                      type="button"
                      onClick={() => setGastoEditando(g)}
                      className="mt-2 text-xs font-medium text-[var(--brand)] hover:underline"
                    >
                      Editar
                    </button>
                  ) : null}
                </div>
                <p className="shrink-0 font-semibold tabular-nums text-[var(--foreground)]">
                  {formatMoney(g.monto)}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {(modalNuevoGasto || gastoEditando) && (
        <FormularioGasto
          proyectosDisponibles={proyectosDisponibles}
          beneficiarios={beneficiarios}
          beneficiarioVinculado={beneficiarioVinculado}
          gasto={gastoEditando}
          verPrivado={verPrivado}
          onClose={() => {
            setModalNuevoGasto(false);
            setGastoEditando(null);
          }}
        />
      )}
    </div>
  );
}

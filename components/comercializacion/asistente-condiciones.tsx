"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import type { DetalleCuenta } from "@/lib/server/comercializacion/cuentas";
import { PARAM_DEFINIR } from "@/lib/comercializacion/condiciones";
import { PanelLateral } from "./panel-lateral";
import { FormularioCondiciones } from "./formulario-condiciones";

// Abre «Definir condiciones» en cuanto se registra algo que las requiere
// (aceptar una cotización, confirmar una compra, guardar un gasto) o desde un
// aviso. La petición vive en la URL (?definir=<documento o cuenta>), así no se
// pierde mientras llegan los datos nuevos, y se retira al guardar o cerrar.
// Va fuera de las vistas del expediente: se muestra en cualquiera de ellas.

function escribir(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(PARAM_DEFINIR, id);
  else url.searchParams.delete(PARAM_DEFINIR);
  window.history.replaceState(null, "", url);
}

/** Llamar justo después de registrar el documento (antes de router.refresh). */
export const pedirCondiciones = (documentoId: string) => escribir(documentoId);

export function AsistenteCondiciones({ cuentas }: { cuentas: { cuenta: DetalleCuenta; contexto: string; referencia?: string | null }[] }) {
  const pedida = useSearchParams().get(PARAM_DEFINIR);
  const cerrar = useCallback(() => escribir(null), []);
  const actual = pedida
    ? cuentas.find(
        ({ cuenta: c }) => (c.id === pedida || c.documento.id === pedida) && c.estatus === "VIGENTE" && c.estado.situacion === "SIN_CALENDARIO" && !c.tuvoMovimientos
      )
    : undefined;
  const esCobro = actual?.cuenta.tipo === "POR_COBRAR";

  return (
    <PanelLateral abierto={Boolean(actual)} onCerrar={cerrar} titulo={esCobro ? "Condiciones de cobro" : "Condiciones de pago"} contexto={actual?.contexto} ancho="amplio">
      {actual && (
        <div className="space-y-4">
          {actual.referencia && (
            <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-sm whitespace-pre-wrap">
              <span className="block text-xs text-[var(--muted)]">Condiciones escritas en la cotización</span>
              {actual.referencia}
            </p>
          )}
          <FormularioCondiciones key={actual.cuenta.id} cuenta={actual.cuenta} onListo={cerrar} textoCancelar="Definir después" />
        </div>
      )}
    </PanelLateral>
  );
}

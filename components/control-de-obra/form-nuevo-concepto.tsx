"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CampoDinero } from "@/components/ui/campo-dinero";
import { crearConceptoAction, proponerConceptoEnPropuestaAction, type FormState } from "@/app/(proyecto)/control-de-obra/[id]/actions";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";

// Solo campos operativos (Contrato General) — descripción, unidad, cantidad,
// P.U., y P.U. materiales cuando aplica (Precio Alzado). Los campos privados
// (Indirectos, Herramienta, %, precio comercial) ya no se capturan aquí — se
// definen desde Contrato General Priv., una vez creado el concepto (sección
// 13 del rediseño, agosto 2026: "la separación debe ser real por pestaña").
export function FormNuevoConcepto({
  partidaId,
  proyectoId,
  esquemaContractual,
  proponer = false,
  enPropuesta = false,
}: {
  // Con `enPropuesta`, es el id de una partida todavía por aprobar.
  partidaId: string;
  proyectoId: string;
  esquemaContractual: EsquemaContractual | null;
  proponer?: boolean;
  enPropuesta?: boolean;
}) {
  const action = (enPropuesta ? proponerConceptoEnPropuestaAction : crearConceptoAction).bind(null, partidaId, proyectoId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    action,
    undefined
  );

  const esPrecioAlzado = esquemaContractual === "PRECIO_ALZADO";

  return (
    <form action={formAction} className="space-y-4">
      <Textarea
        name="descripcion"
        required
        placeholder="Descripción — admite varias líneas para especificaciones largas"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input name="unidad" required placeholder="Unidad (m², ml…)" />
        <Input
          name="cantidadContratada"
          required
          type="number"
          step="0.001"
          min="0"
          placeholder="Cantidad total"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
        <CampoDinero name="precioUnitarioContratista" placeholder="P.U. (presupuesto)" />
        {esPrecioAlzado && (
          <CampoDinero name="precioUnitarioMateriales" placeholder="P.U. materiales (presupuesto)" />
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className="shrink-0">
          {pending ? "Guardando…" : proponer ? "Enviar a aprobación" : "Guardar concepto"}
        </Button>
        {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}

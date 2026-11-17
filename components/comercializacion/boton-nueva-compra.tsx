"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { crearCompraAction } from "@/app/(app)/comercializacion/actions";

// Crea un borrador de compra para la OV (idempotente por clave: un doble clic
// no crea dos borradores) y abre su formulario.
export function BotonNuevaCompra({ ordenVentaId }: { ordenVentaId: string }) {
  const router = useRouter();
  const [clave] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        type="button"
        disabled={pendiente}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await crearCompraAction({ ordenVentaId, claveCreacion: clave });
            if (r.error || !r.id) return setError(r.error ?? "No se pudo crear la compra.");
            router.push(`/comercializacion/compras/${r.id}`);
          })
        }
      >
        {pendiente ? "Creando…" : "+ Nueva compra"}
      </Button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cancelarOrdenVentaAction, cerrarCotizacionAction } from "@/app/(app)/comercializacion/actions";
import type { EstadoCancelacionOrden } from "@/lib/server/comercializacion/cancelaciones";

// B8B — acciones de administración: registrar rechazo o cancelar una
// cotización y cancelar una OV sin dinero ni dependencias vigentes. Solo se
// muestran a administración; el servidor vuelve a validar permisos, estado y
// bloqueos (también por id directo).

const claseSecundaria = "text-sm text-[var(--muted)] hover:text-[var(--foreground)]";
const claseEnlace = "text-sm font-medium text-[var(--brand)] hover:underline";

function FormularioMotivo({
  titulo,
  explicacion,
  boton,
  onConfirmar,
  onCancelar,
}: {
  titulo: string;
  explicacion: string;
  boton: string;
  onConfirmar: (motivo: string) => Promise<{ error?: string }>;
  onCancelar: () => void;
}) {
  const router = useRouter();
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendiente, start] = useTransition();
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-4" data-formulario-motivo>
      <p className="text-sm font-medium text-[var(--foreground)]">{titulo}</p>
      <p className="text-xs text-[var(--muted)]">{explicacion}</p>
      <Textarea value={motivo} onChange={(ev) => setMotivo(ev.target.value)} maxLength={500} placeholder="Motivo (obligatorio)" aria-label="Motivo" />
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={pendiente || motivo.trim().length < 3}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await onConfirmar(motivo);
              if (r.error) return setError(r.error);
              router.refresh();
            })
          }
        >
          {pendiente ? "Guardando…" : boton}
        </Button>
        <button type="button" onClick={onCancelar} className={claseSecundaria} disabled={pendiente}>
          Volver
        </button>
      </div>
    </div>
  );
}

/** Rechazo (solo emitida) y cancelación (borrador o emitida) de una cotización. */
export function CerrarCotizacion({ cotizacionId, folio, estatus }: { cotizacionId: string; folio: string; estatus: string }) {
  const [accion, setAccion] = useState<"RECHAZAR" | "CANCELAR" | null>(null);
  const puedeRechazar = estatus === "EMITIDA";
  const puedeCancelar = estatus === "BORRADOR" || estatus === "EMITIDA";
  if (!puedeRechazar && !puedeCancelar) return null;
  if (accion) {
    const rechazo = accion === "RECHAZAR";
    return (
      <FormularioMotivo
        titulo={rechazo ? `Registrar rechazo del cliente de ${folio}` : `Cancelar la cotización ${folio}`}
        explicacion={`${rechazo ? "Registra que el cliente no aceptó la cotización." : "La cotización deja de estar disponible."} Es definitivo: no se edita, emite ni acepta después. Se conservan el folio, las partidas, el PDF emitido y el historial; para una nueva venta usa «Duplicar».`}
        boton={rechazo ? "Registrar rechazo" : "Cancelar cotización"}
        onConfirmar={(motivo) => cerrarCotizacionAction({ id: cotizacionId, accion, motivo })}
        onCancelar={() => setAccion(null)}
      />
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3" data-cerrar-cotizacion>
      {puedeRechazar && (
        <button type="button" onClick={() => setAccion("RECHAZAR")} className={claseSecundaria}>
          Registrar rechazo
        </button>
      )}
      {puedeCancelar && (
        <button type="button" onClick={() => setAccion("CANCELAR")} className={claseSecundaria}>
          Cancelar cotización
        </button>
      )}
    </div>
  );
}

/** «Cancelar OV»: solo sin dinero ni dependencias vigentes; si no, muestra los bloqueos. */
export function CancelarOrdenVenta({ ordenId, folio, estado }: { ordenId: string; folio: string; estado: EstadoCancelacionOrden }) {
  const [abierto, setAbierto] = useState(false);
  if (estado.cancelada) return null;
  return (
    <Card className="space-y-3 p-5" id="cancelar-ov">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">Cancelar orden de venta</h2>
        <p className="text-xs text-[var(--muted)]">
          Solo para una OV sin cobros ni pagos registrados (aunque estén anulados) y sin compras, gastos, entregas ni vínculos vigentes. Es definitiva: la
          cuenta por cobrar se anula conservando su total y calendario, la cotización no vuelve a emitirse ni a aceptarse y para una nueva venta se
          duplica. No registra devoluciones ni notas de crédito.
        </p>
      </div>
      {estado.bloqueos.length > 0 ? (
        <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900" data-bloqueos-cancelacion>
          <p className="font-medium">No se puede cancelar {folio} todavía:</p>
          <ul className="list-disc space-y-1 pl-5">
            {estado.bloqueos.map((b) => (
              <li key={b.texto}>
                {b.texto}{" "}
                {b.enlaces.map((e, i) => (
                  <span key={e.href}>
                    {i > 0 && ", "}
                    <Link href={e.href} className={claseEnlace}>
                      {e.etiqueta}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="text-xs">Atiende cada punto en su documento; esta acción no cancela ni anula dependencias por su cuenta.</p>
        </div>
      ) : abierto ? (
        <FormularioMotivo
          titulo={`Cancelar ${folio}`}
          explicacion="Confirma la cancelación definitiva de la orden de venta. Se registran autor, fecha y motivo."
          boton="Cancelar OV"
          onConfirmar={(motivo) => cancelarOrdenVentaAction({ ordenId, motivo })}
          onCancelar={() => setAbierto(false)}
        />
      ) : (
        <Button type="button" variant="outline" onClick={() => setAbierto(true)}>
          Cancelar OV
        </Button>
      )}
    </Card>
  );
}

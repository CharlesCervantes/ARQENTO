"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { formatearFecha } from "@/lib/fecha";
import { descartarDocumentoRecibidoAction, reanudarRecepcionesRecibidasAction } from "@/app/(app)/contabilidad/actions";
import type { BandejaRecibidos } from "@/lib/server/contabilidad/documentos/recibidos-whatsapp";

// Bandeja «Recibidos por WhatsApp» (Fase 2A): comprobantes enviados al número
// oficial, pendientes de revisión. Por ahora solo se pueden ver y descartar.

const TIPO: Record<string, string> = { "application/pdf": "PDF", "image/jpeg": "Fotografía", "image/png": "Fotografía" };

export function RecibidosWhatsapp({ bandeja }: { bandeja: BandejaRecibidos }) {
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const descartar = (id: string, reintento: boolean) => {
    if (
      !reintento &&
      !window.confirm("¿Descartar este comprobante? Su archivo se eliminará de forma definitiva y no se podrá recuperar.")
    ) {
      return;
    }
    setError(null);
    setAviso(null);
    iniciar(async () => {
      const r = await descartarDocumentoRecibidoAction(id);
      if (r?.error) setError(r.error);
      else if (r?.archivoEliminado === false) setAviso("El comprobante se descartó. Su archivo se conserva porque otro registro lo utiliza.");
    });
  };

  const reanudar = () => {
    setError(null);
    setAviso(null);
    iniciar(async () => {
      const r = await reanudarRecepcionesRecibidasAction();
      if (r.error) setError(r.error);
      else if (r.resultado) {
        const { guardadas, pendientes } = r.resultado;
        setAviso(
          pendientes === 0
            ? "Listo: ya no hay recepciones sin terminar."
            : guardadas === 0
              ? "Todavía no fue posible terminar la recepción. Nada se perdió: sigue pendiente y puedes reintentar más tarde."
              : `Se ${guardadas === 1 ? "terminó 1 recepción" : `terminaron ${guardadas} recepciones`}. ${pendientes === 1 ? "Queda 1" : `Quedan ${pendientes}`} sin terminar; puedes reintentar de nuevo.`
        );
      }
    });
  };
  const porRevisar = bandeja.documentos.filter((d) => !d.eliminacionPendiente).length;
  const detenidas = bandeja.recepciones.filter((r) => r.estado === "DETENIDA").length;

  return (
    <section className="space-y-2" aria-label="Recibidos por WhatsApp">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Recibidos por WhatsApp</h2>
        <p className="text-xs text-[var(--muted)]">
          {porRevisar} pendiente{porRevisar === 1 ? "" : "s"} de revisión
        </p>
      </div>

      {bandeja.recepciones.length > 0 && (
        <Card className="space-y-2 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--foreground)]">
                {bandeja.recepciones.length === 1 ? "1 comprobante sin terminar de recibir" : `${bandeja.recepciones.length} comprobantes sin terminar de recibir`}
              </p>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                {detenidas > 0
                  ? "ARQENTO dejó de reintentar los detenidos por su cuenta. No se perdieron: reintenta la recepción para guardarlos."
                  : "Normalmente terminan solos en unos momentos. Si siguen aquí, reintenta la recepción."}
              </p>
            </div>
            <button
              type="button"
              disabled={pendiente}
              onClick={reanudar}
              className="shrink-0 text-sm font-medium text-[var(--foreground)] underline underline-offset-2 disabled:opacity-50"
            >
              {pendiente ? "Reintentando" : "Reintentar recepción"}
            </button>
          </div>
          <ul className="space-y-1 text-xs text-[var(--muted)]">
            {bandeja.recepciones.map((r) => (
              <li key={r.id}>
                Enviado por {r.enviadoPor}, {formatearFecha(r.recibidoEn)}:{" "}
                <span className={r.estado === "DETENIDA" ? "text-amber-700" : undefined}>
                  {r.estado === "DETENIDA" ? "detenido" : "recibiendo"}
                  {r.almacenado ? ", archivo ya resguardado" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {bandeja.limitados > 0 && (
        <p className="text-xs text-amber-700">
          {bandeja.limitados === 1
            ? "En las últimas 24 horas, 1 comprobante no se guardó porque su remitente envió demasiados archivos en poco tiempo."
            : `En las últimas 24 horas, ${bandeja.limitados} comprobantes no se guardaron porque su remitente envió demasiados archivos en poco tiempo.`}{" "}
          Ya se le pidió reenviarlos.
        </p>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {aviso && <p className="text-sm text-[var(--muted)]">{aviso}</p>}

      {bandeja.documentos.length === 0 ? (
        <Card className="p-4 text-sm text-[var(--muted)]">
          No hay comprobantes por revisar. Los que tus usuarios envíen al WhatsApp de ARQENTO aparecerán aquí.
        </Card>
      ) : (
        <div className="space-y-2">
          {bandeja.documentos.map((d) => (
            <Card key={d.id} className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-[var(--foreground)]">{d.nombre}</p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {TIPO[d.tipoMime] ?? "Archivo"}, enviado por {d.enviadoPor}, {formatearFecha(d.recibidoEn)}
                  </p>
                  {d.contexto && <p className="mt-1 text-sm text-[var(--foreground)]">Nota de quien lo envió: «{d.contexto}»</p>}
                  {d.eliminacionPendiente && (
                    <p className="mt-1 text-xs text-amber-700">Descartado. Su archivo todavía no se ha eliminado.</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm">
                  {!d.eliminacionPendiente && (
                    <a
                      href={`/api/contabilidad/documentos-recibidos/${d.id}/archivo`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[var(--foreground)] underline underline-offset-2"
                    >
                      Ver archivo
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={pendiente}
                    onClick={() => descartar(d.id, d.eliminacionPendiente)}
                    className="text-red-700 hover:underline disabled:opacity-50"
                  >
                    {d.eliminacionPendiente ? "Reintentar eliminación" : "Descartar"}
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

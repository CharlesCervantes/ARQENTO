"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { formatearFecha } from "@/lib/fecha";
import { NOMBRE_ROL } from "@/lib/roles";
import { cambiarWhatsappEmpresaAction, reprocesarMensajesWhatsappAction, revocarVinculoWhatsappMasterAction } from "@/app/master/actions";
import type { WhatsappEmpresaMaster } from "@/lib/server/master/whatsapp";

// Master → Empresa → WhatsApp (Fase 1 WhatsApp + ARQENTO IA): interruptor
// del canal por Empresa — independiente de ARQENTO IA — y vínculos con
// teléfonos enmascarados desde el servidor (D3).

const ESTADO: Record<string, string> = { PENDIENTE: "Pendiente", VERIFICADO: "Verificado", REVOCADO: "Revocado" };

export function TabWhatsapp({ empresaId, whatsapp }: { empresaId: string; whatsapp: WhatsappEmpresaMaster }) {
  const [pendiente, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resumen, setResumen] = useState<string | null>(null);

  function ejecutar(accion: () => Promise<{ error?: string } | void>) {
    setError(null);
    startTransition(async () => {
      const r = await accion();
      if (r && r.error) setError(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-5">
        <label className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
          <input
            type="checkbox"
            checked={whatsapp.whatsappHabilitado}
            disabled={pendiente}
            onChange={(e) => ejecutar(() => cambiarWhatsappEmpresaAction(empresaId, e.target.checked))}
          />
          WhatsApp habilitado para esta Empresa
        </label>
        <p className="text-xs text-[var(--muted)]">
          Permite que sus usuarios autorizados vinculen su WhatsApp. No habilita ARQENTO IA ni la recepción o el procesamiento de
          documentos. Al apagarlo, los vínculos se conservan pero no se pueden usar.
        </p>
      </Card>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <Card className="space-y-2 p-5">
        <h3 className="text-sm font-semibold text-[var(--foreground)]">Mensajes del canal</h3>
        <p className="text-xs text-[var(--muted)]">
          De todas las Empresas: {whatsapp.canal.pendientes} pendiente(s), {whatsapp.canal.reintentables} con error por reintentar,{" "}
          {whatsapp.canal.detenidos} comprobante(s) detenido(s) y {whatsapp.canal.definitivos} con error definitivo. Meta reentrega
          automáticamente los mensajes que fallan; usa esta opción si alguno se quedó pendiente. Un comprobante detenido agotó sus
          reintentos automáticos sin perderse: solo avanza al reprocesar aquí o desde la bandeja de su Empresa.
        </p>
        {resumen && <p className="text-xs text-[var(--foreground)]">{resumen}</p>}
        <button
          type="button"
          disabled={pendiente || whatsapp.canal.pendientes + whatsapp.canal.reintentables + whatsapp.canal.detenidos === 0}
          onClick={() => {
            setError(null);
            setResumen(null);
            startTransition(async () => {
              const r = await reprocesarMensajesWhatsappAction(empresaId);
              if (r.error) setError(r.error);
              else if (r.resumen)
                setResumen(
                  `Revisados ${r.resumen.revisados}: ${r.resumen.procesados} procesado(s), ${r.resumen.reintentables} por reintentar, ${r.resumen.detenidos} detenido(s), ${r.resumen.definitivos} con error definitivo.`
                );
            });
          }}
          className="text-xs font-medium text-[var(--foreground)] hover:underline disabled:text-[var(--muted)] disabled:no-underline"
        >
          Reprocesar mensajes pendientes
        </button>
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-[var(--foreground)]">Vínculos</h3>
        {whatsapp.vinculos.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">Ningún usuario ha vinculado su WhatsApp.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {whatsapp.vinculos.map((v) => (
              <li key={v.vinculoId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="text-[var(--foreground)]">
                    {v.usuarioNombre} <span className="text-xs text-[var(--muted)]">· {NOMBRE_ROL[v.usuarioRol] ?? v.usuarioRol}</span>
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {v.telefono} · {ESTADO[v.estado]}
                    {v.verificadoEn && ` · verificado ${formatearFecha(new Date(v.verificadoEn))}`}
                    {v.revocadoEn && ` · revocado ${formatearFecha(new Date(v.revocadoEn))}`}
                    {v.motivoRevocacion && ` (${v.motivoRevocacion})`}
                  </p>
                </div>
                {v.estado !== "REVOCADO" && (
                  <button
                    type="button"
                    disabled={pendiente}
                    onClick={() => ejecutar(() => revocarVinculoWhatsappMasterAction(empresaId, v.vinculoId))}
                    className="text-xs text-red-700 hover:underline"
                  >
                    Revocar
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

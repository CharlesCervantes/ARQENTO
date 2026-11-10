"use client";

import { useActionState, useState, useTransition } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatearFecha } from "@/lib/fecha";
import {
  iniciarVinculacionWhatsappAction,
  revocarMiWhatsappAction,
  type VinculacionState,
} from "@/app/(app)/perfil/whatsapp-actions";
import type { MiWhatsapp } from "@/lib/server/whatsapp/vinculos";

// "Mi perfil → WhatsApp" (Fase 1 WhatsApp + ARQENTO IA): el propio usuario
// vincula su número enviando un código temporal desde su WhatsApp al número
// oficial de ARQENTO. El código solo se muestra aquí, a su dueño, una vez.

export function WhatsappVinculacion({ estado, puedeAdministrar }: { estado: MiWhatsapp; puedeAdministrar: boolean }) {
  const [state, formAction, pending] = useActionState<VinculacionState, FormData>(iniciarVinculacionWhatsappAction, undefined);
  const [revocando, startRevocar] = useTransition();
  const [errorRevocar, setErrorRevocar] = useState<string | null>(null);
  const disponible = estado.empresaHabilitada && estado.autorizado;
  const vinculo = estado.vinculo;
  const inicio = state?.inicio && vinculo?.estado !== "VERIFICADO" ? state.inicio : null;

  function revocar() {
    setErrorRevocar(null);
    startRevocar(async () => {
      const r = await revocarMiWhatsappAction();
      if (r.error) setErrorRevocar(r.error);
    });
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-[var(--foreground)]">WhatsApp</h2>
      <div className="mt-3 space-y-3 text-sm">
        {vinculo?.estado === "VERIFICADO" ? (
          <>
            <p className="text-[var(--foreground)]">
              Vinculado: <span className="font-medium">{vinculo.telefono}</span>
              {vinculo.verificadoEn && <span className="text-[var(--muted)]"> · desde {formatearFecha(new Date(vinculo.verificadoEn))}</span>}
            </p>
            {!disponible && (
              <p className="text-xs text-amber-700">
                WhatsApp está pausado para tu usuario o tu Empresa. El vínculo se conserva, pero no se puede usar por ahora.
              </p>
            )}
            <Button type="button" onClick={revocar} disabled={revocando}>
              {revocando ? "Revocando…" : "Revocar"}
            </Button>
          </>
        ) : !disponible ? (
          <p className="text-[var(--muted)]">
            {estado.empresaHabilitada
              ? "Tu usuario todavía no está autorizado para usar WhatsApp. Pídelo al administrador de tu Empresa."
              : "WhatsApp no está disponible para tu Empresa."}
          </p>
        ) : (
          <>
            {vinculo?.estado === "PENDIENTE" && (
              <p className="text-[var(--muted)]">
                Vinculación pendiente para <span className="font-medium text-[var(--foreground)]">{vinculo.telefono}</span>. Si tu
                código venció, genera uno nuevo.
              </p>
            )}
            {estado.ultimaRevocacion && !vinculo && (
              <p className="text-xs text-[var(--muted)]">Tu vínculo anterior fue revocado. Puedes volver a vincular tu número.</p>
            )}
            <form action={formAction} className="flex flex-wrap items-end gap-2">
              <label className="flex-1 text-xs text-[var(--muted)]">
                Tu número de WhatsApp (formato internacional)
                <Input name="telefono" required placeholder="+52 33 1234 5678" defaultValue={vinculo?.telefono ?? ""} className="mt-1" />
              </label>
              <Button type="submit" disabled={pending}>
                {pending ? "Generando…" : vinculo ? "Volver a vincular" : "Vincular"}
              </Button>
            </form>
            {vinculo && (
              <button type="button" onClick={revocar} disabled={revocando} className="text-xs text-[var(--muted)] hover:underline">
                Cancelar la vinculación pendiente
              </button>
            )}
          </>
        )}

        {inicio && (
          <div className="space-y-1.5 rounded-lg border border-[var(--border)] p-3">
            <p className="text-[var(--foreground)]">
              Envía este código desde <span className="font-medium">{inicio.telefono}</span> al número oficial de ARQENTO:
            </p>
            <p className="font-mono text-lg font-semibold tracking-wider text-[var(--foreground)]">{inicio.codigo}</p>
            <p className="text-xs text-[var(--muted)]">
              Vale hasta las {new Date(inicio.expiraEn).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}, es de un
              solo uso y no lo compartas con nadie.
            </p>
            {inicio.enlace ? (
              <a href={inicio.enlace} target="_blank" rel="noreferrer" className="text-sm font-medium text-[var(--brand)] hover:underline">
                Abrir WhatsApp con el código
              </a>
            ) : (
              <p className="text-xs text-amber-700">El número oficial de ARQENTO todavía no está configurado en este entorno.</p>
            )}
          </div>
        )}
        {state?.error && <p className="text-red-700">{state.error}</p>}
        {errorRevocar && <p className="text-red-700">{errorRevocar}</p>}

        {puedeAdministrar && (
          <Link href="/perfil/whatsapp" className="inline-block text-xs font-medium text-[var(--brand)] hover:underline">
            Administrar WhatsApp de los usuarios de tu Empresa
          </Link>
        )}
      </div>
    </Card>
  );
}

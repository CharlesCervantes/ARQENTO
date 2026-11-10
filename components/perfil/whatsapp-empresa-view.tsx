"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { autorizarWhatsappUsuarioAction, revocarWhatsappDeUsuarioAction } from "@/app/(app)/perfil/whatsapp-actions";
import type { FilaWhatsappUsuario } from "@/lib/server/whatsapp/vinculos";

const ESTADO: Record<"PENDIENTE" | "VERIFICADO", string> = { PENDIENTE: "Pendiente de verificar", VERIFICADO: "Vinculado" };

export function WhatsappEmpresaView({
  empresaHabilitada,
  usuarios,
}: {
  empresaHabilitada: boolean;
  usuarios: (FilaWhatsappUsuario & { rolLabel: string })[];
}) {
  const [pendiente, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function ejecutar(accion: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await accion();
      if (r.error) setError(r.error);
    });
  }

  return (
    <div className="space-y-3">
      {!empresaHabilitada && (
        <Card className="p-4 text-sm text-amber-700">
          WhatsApp no está habilitado para tu Empresa. Puedes preparar las autorizaciones, pero nadie podrá usarlo hasta que se
          habilite.
        </Card>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {usuarios.map((u) => (
        <Card key={u.usuarioId} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-medium text-[var(--foreground)]">
              {u.nombre} <span className="text-xs font-normal text-[var(--muted)]">· {u.rolLabel}</span>
              {!u.activo && <span className="ml-2 text-xs text-[var(--muted)]">(desactivado)</span>}
            </p>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              {u.vinculo ? `${ESTADO[u.vinculo.estado]} · ${u.vinculo.telefono}` : "Sin WhatsApp vinculado"}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={u.autorizado}
                disabled={pendiente || (!u.activo && !u.autorizado)}
                onChange={(e) => ejecutar(() => autorizarWhatsappUsuarioAction(u.usuarioId, e.target.checked))}
              />
              Autorizado
            </label>
            {u.vinculo && (
              <button
                type="button"
                disabled={pendiente}
                onClick={() => ejecutar(() => revocarWhatsappDeUsuarioAction(u.usuarioId))}
                className="text-xs text-red-700 hover:underline"
              >
                Revocar
              </button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

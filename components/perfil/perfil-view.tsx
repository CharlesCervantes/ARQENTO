"use client";

import { useState, useTransition } from "react";
import { useActionState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  actualizarNombreAction,
  cambiarPasswordAction,
  actualizarVistaPrivadaAction,
  type PerfilFormState,
} from "@/app/(app)/perfil/actions";

export function PerfilView({
  nombre,
  email,
  rolLabel,
  mostrarPrivacidad,
  vistaPrivadaActivaInicial,
  privadoEmpresaHabilitado,
}: {
  nombre: string;
  email: string;
  rolLabel: string;
  mostrarPrivacidad: boolean;
  vistaPrivadaActivaInicial: boolean;
  privadoEmpresaHabilitado: boolean;
}) {
  return (
    <div className="space-y-5">
      <Seccion titulo="Perfil">
        <FormularioNombre nombre={nombre} email={email} rolLabel={rolLabel} />
      </Seccion>

      <Seccion titulo="Seguridad">
        <FormularioPassword />
      </Seccion>

      {mostrarPrivacidad && (
        <Seccion titulo="Privacidad">
          <VistaPrivadaSwitch
            vistaPrivadaActivaInicial={vistaPrivadaActivaInicial}
            privadoEmpresaHabilitado={privadoEmpresaHabilitado}
          />
        </Seccion>
      )}
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-[var(--foreground)]">{titulo}</h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function FormularioNombre({
  nombre,
  email,
  rolLabel,
}: {
  nombre: string;
  email: string;
  rolLabel: string;
}) {
  const [state, formAction, pending] = useActionState<PerfilFormState, FormData>(
    actualizarNombreAction,
    undefined
  );

  return (
    <form action={formAction} className="space-y-3">
      <Campo label="Nombre">
        <Input name="nombre" defaultValue={nombre} required />
      </Campo>
      <Campo label="Correo asignado">
        <Input value={email} disabled className="text-[var(--muted)]" />
      </Campo>
      <Campo label="Rol">
        <Input value={rolLabel} disabled className="text-[var(--muted)]" />
      </Campo>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar cambios"}
        </Button>
        {state?.guardado && <p className="text-sm text-emerald-700">Guardado.</p>}
        {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}

function FormularioPassword() {
  const [state, formAction, pending] = useActionState<PerfilFormState, FormData>(
    cambiarPasswordAction,
    undefined
  );

  return (
    <form action={formAction} className="space-y-3">
      <Campo label="Contraseña actual">
        <Input name="passwordActual" type="password" required autoComplete="current-password" />
      </Campo>
      <Campo label="Nueva contraseña">
        <Input name="passwordNueva" type="password" required autoComplete="new-password" />
      </Campo>
      <Campo label="Confirmar nueva contraseña">
        <Input name="passwordConfirmar" type="password" required autoComplete="new-password" />
      </Campo>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Cambiando…" : "Cambiar contraseña"}
        </Button>
        {state?.guardado && <p className="text-sm text-emerald-700">Contraseña actualizada.</p>}
        {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}

// La preferencia es solo una de las tres condiciones de acceso a la capa
// privada (rol + preferencia + Empresa.privadoHabilitado, ver
// puedeVerInformacionPrivada). Si la Empresa no la tiene habilitada, se dice
// explícitamente — antes el texto «Activada. Puedes visualizar información
// privada» aparecía aunque Privado no se mostrara en ningún lado.
function VistaPrivadaSwitch({
  vistaPrivadaActivaInicial,
  privadoEmpresaHabilitado,
}: {
  vistaPrivadaActivaInicial: boolean;
  privadoEmpresaHabilitado: boolean;
}) {
  const [activa, setActiva] = useState(vistaPrivadaActivaInicial);
  const [pending, startTransition] = useTransition();

  function cambiar(nuevoValor: boolean) {
    setActiva(nuevoValor);
    startTransition(async () => {
      await actualizarVistaPrivadaAction(nuevoValor);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-[var(--foreground)]">Vista privada</span>
        <button
          type="button"
          role="switch"
          aria-checked={activa}
          disabled={pending}
          onClick={() => cambiar(!activa)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ease-out disabled:opacity-50 ${
            activa ? "bg-[var(--brand)]" : "bg-black/[0.15]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
              activa ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {!privadoEmpresaHabilitado && (
        <p className="mt-2 text-xs text-amber-700">
          La capa Privada no está habilitada para tu empresa: aunque actives esta opción, la
          información privada no se mostrará hasta que un usuario Master la habilite en
          Portal Master → Empresas.
        </p>
      )}

      <p className="mt-2 text-xs text-[var(--muted)]">
        {activa ? (
          <>
            <strong className="text-[var(--foreground)]">Activada.</strong>{" "}
            {privadoEmpresaHabilitado
              ? "Puedes visualizar información privada y financiera según tus permisos."
              : "Tu preferencia queda guardada y surtirá efecto cuando tu empresa tenga Privado habilitado."}
          </>
        ) : (
          <>
            <strong className="text-[var(--foreground)]">Desactivada.</strong> La información
            privada se oculta para poder utilizar o presentar el sistema sin mostrar datos
            sensibles.
          </>
        )}
      </p>
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-[var(--foreground)]">{label}</label>
      {children}
    </div>
  );
}

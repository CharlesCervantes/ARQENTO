"use client";

import { useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileInput } from "@/components/ui/file-input";
import {
  editarEmpresaGeneralAction,
  cambiarEstatusEmpresaAction,
  cambiarPrivadoEmpresaAction,
  actualizarModuloEmpresaAction,
  subirLogoEmpresaAction,
  quitarLogoEmpresaAction,
  actualizarConfiguracionRecibosAction,
  crearUsuarioEmpresaAction,
  cambiarEstatusUsuarioEmpresaAction,
  regenerarPasswordUsuarioEmpresaAction,
  type MasterFormState,
} from "@/app/master/actions";
import type { DetalleEmpresaMaster, EstadoModulo, UsuarioEmpresaMaster } from "@/lib/server/master/empresas";
import type {
  ConfiguracionInteligenciaEmpresa,
  TipoRangoInteligencia,
  RangoInteligencia,
} from "@/lib/server/master/inteligencia";
import type { ResumenConsumoInteligencia, DesgloseCapacidad, ConsumoDiario } from "@/lib/server/inteligencia/consumo";
import { PasswordTemporalPanel } from "@/components/master/password-temporal-panel";
import { TabArqentoIA } from "@/components/master/tab-arqento-ia";
import { TabWhatsapp } from "@/components/master/tab-whatsapp";
import type { WhatsappEmpresaMaster } from "@/lib/server/master/whatsapp";
import { NOMBRE_ROL } from "@/lib/roles";

const TABS = ["general", "modulos", "branding", "documentos", "usuarios", "arqento-ia", "whatsapp"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  general: "General",
  modulos: "Módulos",
  branding: "Branding",
  documentos: "Documentos",
  usuarios: "Usuarios",
  "arqento-ia": "ARQENTO IA",
  whatsapp: "WhatsApp",
};

function iniciales(nombre: string): string {
  return nombre.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
}

export function EmpresaDetalleView({
  empresa,
  planes,
  inteligencia,
  whatsapp,
}: {
  empresa: DetalleEmpresaMaster;
  planes: { id: string; nombre: string }[];
  inteligencia: {
    configuracion: ConfiguracionInteligenciaEmpresa;
    dashboard: { resumen: ResumenConsumoInteligencia; desglose: DesgloseCapacidad[]; diario: ConsumoDiario[] };
    rango: RangoInteligencia;
    tipoRango: TipoRangoInteligencia;
  };
  whatsapp: WhatsappEmpresaMaster;
}) {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="enter space-y-6">
      <div>
        <Link href="/master/empresas" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          ← Empresas
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-xl font-semibold text-[var(--foreground)]">{empresa.nombre}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              empresa.activa ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
            }`}
          >
            {empresa.activa ? "Activa" : "Inactiva"}
          </span>
        </div>
      </div>

      <div className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
              tab === t
                ? "border-b-2 border-[var(--brand)] text-[var(--brand)]"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "general" && <TabGeneral empresa={empresa} planes={planes} />}
      {tab === "modulos" && <TabModulos empresa={empresa} />}
      {tab === "branding" && <TabBranding empresa={empresa} />}
      {tab === "documentos" && <TabDocumentos empresa={empresa} />}
      {tab === "usuarios" && <TabUsuarios empresa={empresa} />}
      {tab === "whatsapp" && <TabWhatsapp empresaId={empresa.id} whatsapp={whatsapp} />}
      {tab === "arqento-ia" && (
        <TabArqentoIA
          empresaId={empresa.id}
          configuracion={inteligencia.configuracion}
          dashboard={inteligencia.dashboard}
          rango={inteligencia.rango}
          tipoRango={inteligencia.tipoRango}
        />
      )}
    </div>
  );
}

function TabGeneral({
  empresa,
  planes,
}: {
  empresa: DetalleEmpresaMaster;
  planes: { id: string; nombre: string }[];
}) {
  const [state, formAction, pending] = useActionState<MasterFormState, FormData>(
    editarEmpresaGeneralAction.bind(null, empresa.id),
    undefined
  );

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form action={formAction} className="space-y-3">
          <Input name="nombre" placeholder="Nombre comercial" defaultValue={empresa.nombre} required />
          <Input name="razonSocial" placeholder="Razón social (opcional)" defaultValue={empresa.razonSocial ?? ""} />
          <Input name="rfc" placeholder="RFC (opcional)" defaultValue={empresa.rfc ?? ""} />
          <select
            name="planId"
            required
            defaultValue={empresa.planId ?? ""}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
          >
            <option value="" disabled>
              Selecciona un plan
            </option>
            {planes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Guardar cambios"}
            </Button>
            {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
            {state?.guardado && <p className="text-sm text-emerald-700">Guardado.</p>}
          </div>
        </form>
      </Card>

      <Card className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm font-medium text-[var(--foreground)]">Estatus de la empresa</p>
          <p className="text-xs text-[var(--muted)]">
            {empresa.activa
              ? "Sus usuarios pueden iniciar sesión con normalidad."
              : "Sus usuarios no pueden iniciar sesión ni mantener una sesión abierta."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => cambiarEstatusEmpresaAction(empresa.id, !empresa.activa)}
        >
          {empresa.activa ? "Desactivar" : "Activar"}
        </Button>
      </Card>

      <Card className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm font-medium text-[var(--foreground)]">Funcionalidad Privada</p>
          <p className="text-xs text-[var(--muted)]">
            Habilita si esta empresa contrató las capas privadas del sistema (Contrato General
            Privado, Cliente Priv., Vista privada). Sigue aplicándose el permiso de cada usuario
            además de esto.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => cambiarPrivadoEmpresaAction(empresa.id, !empresa.privadoHabilitado)}
        >
          {empresa.privadoHabilitado ? "Deshabilitar" : "Habilitar"}
        </Button>
      </Card>
    </div>
  );
}

const ESTADO_ESTILO: Record<EstadoModulo, string> = {
  heredado: "text-[var(--muted)]",
  habilitado_adicional: "text-emerald-700",
  deshabilitado_especifico: "text-red-700",
};
const ESTADO_ETIQUETA: Record<EstadoModulo, string> = {
  heredado: "Incluido en Plan",
  habilitado_adicional: "Habilitado adicionalmente",
  deshabilitado_especifico: "Deshabilitado específicamente",
};

function TabModulos({ empresa }: { empresa: DetalleEmpresaMaster }) {
  return (
    <Card className="divide-y divide-[var(--border)] p-0">
      {empresa.modulos.map((m) => (
        <div key={m.id} className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">{m.nombre}</p>
            <p className={`text-xs ${ESTADO_ESTILO[m.estado]}`}>{ESTADO_ETIQUETA[m.estado]}</p>
          </div>
          <select
            defaultValue={m.estado}
            onChange={(ev) =>
              actualizarModuloEmpresaAction(
                empresa.id,
                m.id,
                ev.target.value as "heredado" | "habilitado" | "deshabilitado"
              )
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
          >
            <option value="heredado">Heredar del Plan</option>
            <option value="habilitado">Habilitar</option>
            <option value="deshabilitado">Deshabilitar</option>
          </select>
        </div>
      ))}
    </Card>
  );
}

function TabBranding({ empresa }: { empresa: DetalleEmpresaMaster }) {
  const [state, formAction, pending] = useActionState<MasterFormState, FormData>(
    subirLogoEmpresaAction.bind(null, empresa.id),
    undefined
  );

  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-[var(--foreground)]">Logo de la empresa</p>
      <div className="mt-3 flex items-center gap-4">
        <div className="h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-black/[0.05]">
          {empresa.logoRef ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/empresas/${empresa.id}/logo`}
              alt={empresa.nombre}
              className="h-full w-full object-contain"
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-2xl font-semibold text-[var(--brand-foreground)]"
              style={{ backgroundColor: empresa.colorPrimario }}
            >
              {iniciales(empresa.nombre)}
            </div>
          )}
        </div>
        <form action={formAction} className="flex items-center gap-3">
          <FileInput
            name="logo"
            accept="image/png,image/jpeg,image/webp"
            required
            className="text-sm text-[var(--muted)] file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--foreground)] hover:file:bg-black/[0.03]"
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Subiendo…" : empresa.logoRef ? "Reemplazar" : "Subir logo"}
          </Button>
        </form>
      </div>
      {empresa.logoRef && (
        <button
          type="button"
          onClick={() => quitarLogoEmpresaAction(empresa.id)}
          className="mt-3 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Quitar logo
        </button>
      )}
      {state?.error && <p className="mt-2 text-sm text-red-700">{state.error}</p>}
      <p className="mt-4 text-xs text-[var(--muted)]">
        PNG, JPG o WEBP — máximo 2MB. Documentos ya emitidos (recibos, estimaciones) conservan el
        logo con el que fueron generados, sin importar cambios posteriores aquí.
      </p>
    </Card>
  );
}

function TabDocumentos({ empresa }: { empresa: DetalleEmpresaMaster }) {
  const [state, formAction, pending] = useActionState<MasterFormState, FormData>(
    actualizarConfiguracionRecibosAction.bind(null, empresa.id),
    undefined
  );

  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-[var(--foreground)]">
        Declaraciones y aceptación — recibos de contratista
      </p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Este bloque se agrega al final del recibo/estimación de cada contratista. Un cambio aquí
        solo afecta a los recibos que se generen después — los ya emitidos conservan exactamente
        el texto y título con el que fueron generados.
      </p>
      <form action={formAction} className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
          <input
            type="checkbox"
            name="reciboMostrarLeyenda"
            defaultChecked={empresa.reciboMostrarLeyenda}
            className="h-4 w-4 rounded border-[var(--border)]"
          />
          Mostrar este bloque en los recibos
        </label>
        <Input
          name="reciboTituloLeyenda"
          placeholder="Título del bloque"
          defaultValue={empresa.reciboTituloLeyenda}
          required
        />
        <textarea
          name="reciboLeyenda"
          placeholder="Texto legal — se muestra tal cual, respetando párrafos y saltos de línea."
          defaultValue={empresa.reciboLeyenda ?? ""}
          rows={14}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Guardando…" : "Guardar cambios"}
          </Button>
          {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
          {state?.guardado && <p className="text-sm text-emerald-700">Guardado.</p>}
        </div>
      </form>
    </Card>
  );
}

function TabUsuarios({ empresa }: { empresa: DetalleEmpresaMaster }) {
  const [creando, setCreando] = useState(false);

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-[var(--border)] p-0">
        {empresa.usuarios.length === 0 ? (
          <p className="p-5 text-sm text-[var(--muted)]">Todavía no hay usuarios en esta empresa.</p>
        ) : (
          empresa.usuarios.map((u) => <FilaUsuario key={u.id} empresaId={empresa.id} usuario={u} />)
        )}
      </Card>

      {creando ? (
        <Card className="enter p-5">
          <FormularioNuevoUsuario empresaId={empresa.id} onCancelar={() => setCreando(false)} />
        </Card>
      ) : (
        <button
          type="button"
          onClick={() => setCreando(true)}
          className="inline-flex w-fit items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] transition-colors duration-150 ease-out hover:bg-black/[0.03]"
        >
          + Nuevo usuario
        </button>
      )}
    </div>
  );
}

function FilaUsuario({ empresaId, usuario }: { empresaId: string; usuario: UsuarioEmpresaMaster }) {
  const [passwordTemporal, setPasswordTemporal] = useState<string | null>(null);
  const [regenerando, setRegenerando] = useState(false);

  if (passwordTemporal) {
    return (
      <div className="p-5">
        <PasswordTemporalPanel
          nombre={usuario.nombre}
          password={passwordTemporal}
          onCerrar={() => setPasswordTemporal(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-[var(--foreground)]">{usuario.nombre}</p>
          {!usuario.activo && (
            <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
              Inactivo
            </span>
          )}
          {usuario.debeCambiarPassword && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              Cambio de contraseña pendiente
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--muted)]">
          {usuario.email} · {NOMBRE_ROL[usuario.rol] ?? usuario.rol}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={regenerando}
          onClick={async () => {
            setRegenerando(true);
            const res = await regenerarPasswordUsuarioEmpresaAction(empresaId, usuario.id);
            setRegenerando(false);
            if (res?.passwordTemporal) setPasswordTemporal(res.passwordTemporal);
          }}
          className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
        >
          {regenerando ? "Generando…" : "Nueva contraseña temporal"}
        </button>
        <button
          type="button"
          onClick={() => cambiarEstatusUsuarioEmpresaAction(empresaId, usuario.id, !usuario.activo)}
          className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          {usuario.activo ? "Desactivar" : "Activar"}
        </button>
      </div>
    </div>
  );
}

function FormularioNuevoUsuario({ empresaId, onCancelar }: { empresaId: string; onCancelar: () => void }) {
  const [state, formAction, pending] = useActionState<MasterFormState, FormData>(
    crearUsuarioEmpresaAction.bind(null, empresaId),
    undefined
  );

  if (state?.guardado && state.passwordTemporal) {
    return (
      <PasswordTemporalPanel
        nombre={state.usuarioNombre ?? "el usuario"}
        password={state.passwordTemporal}
        onCerrar={onCancelar}
      />
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <Input name="nombre" placeholder="Nombre completo" required />
      <Input name="email" type="email" placeholder="Correo" required />
      <select
        name="rol"
        required
        defaultValue="ADMINISTRADOR"
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15"
      >
        <option value="DIRECTOR">Director</option>
        <option value="ADMINISTRADOR">Administrador</option>
        <option value="SUPERVISOR">Supervisor de campo</option>
      </select>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creando…" : "Crear usuario"}
        </Button>
        <button
          type="button"
          onClick={onCancelar}
          className="text-sm text-[var(--muted)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
        >
          Cancelar
        </button>
        {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}

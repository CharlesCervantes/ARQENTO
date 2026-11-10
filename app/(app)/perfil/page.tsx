import { requireSession } from "@/lib/server/auth/dal";
import { puedeAdministrarWhatsappEmpresa, puedeConfigurarVistaPrivada } from "@/lib/server/permisos";
import { obtenerMiWhatsapp } from "@/lib/server/whatsapp/vinculos";
import { WhatsappVinculacion } from "@/components/perfil/whatsapp-vinculacion";
import { NOMBRE_ROL } from "@/lib/roles";
import { PerfilView } from "@/components/perfil/perfil-view";

export default async function PerfilPage() {
  const usuario = await requireSession();
  // WhatsApp (Fase 1): solo para roles que pueden vincular, con datos leídos
  // del servidor (nunca de la sesión).
  const whatsapp = await obtenerMiWhatsapp(usuario);

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Mi perfil</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Información de tu cuenta, seguridad y preferencias de privacidad.
        </p>
      </div>

      <PerfilView
        nombre={usuario.nombre}
        email={usuario.email}
        rolLabel={NOMBRE_ROL[usuario.rol] ?? usuario.rol}
        mostrarPrivacidad={puedeConfigurarVistaPrivada(usuario)}
        vistaPrivadaActivaInicial={usuario.vistaPrivadaActiva}
      />

      {whatsapp && <WhatsappVinculacion estado={whatsapp} puedeAdministrar={puedeAdministrarWhatsappEmpresa(usuario)} />}
    </div>
  );
}

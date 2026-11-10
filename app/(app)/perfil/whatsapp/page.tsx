import { requireSession } from "@/lib/server/auth/dal";
import { puedeAdministrarWhatsappEmpresa } from "@/lib/server/permisos";
import { listarWhatsappDeMiEmpresa } from "@/lib/server/whatsapp/vinculos";
import { NOMBRE_ROL } from "@/lib/roles";
import { Card } from "@/components/ui/card";
import { WhatsappEmpresaView } from "@/components/perfil/whatsapp-empresa-view";

// WhatsApp de la Empresa (Fase 1 WhatsApp + ARQENTO IA, D1): Administrador y
// Director autorizan o retiran el acceso de usuarios de SU Empresa. Los
// teléfonos ajenos llegan ya enmascarados desde el servidor.
export default async function WhatsappEmpresaPage() {
  const usuario = await requireSession();
  if (!puedeAdministrarWhatsappEmpresa(usuario)) {
    return <Card className="p-6 text-sm text-[var(--muted)]">No tienes permiso para administrar WhatsApp en tu Empresa.</Card>;
  }
  const { empresaHabilitada, usuarios } = await listarWhatsappDeMiEmpresa(usuario);
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">WhatsApp de la Empresa</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Autoriza quién puede vincular su WhatsApp con ARQENTO. Cada persona vincula su propio número desde su perfil.
        </p>
      </div>
      <WhatsappEmpresaView
        empresaHabilitada={empresaHabilitada}
        usuarios={usuarios.map((u) => ({ ...u, rolLabel: NOMBRE_ROL[u.rol as keyof typeof NOMBRE_ROL] ?? u.rol }))}
      />
    </div>
  );
}

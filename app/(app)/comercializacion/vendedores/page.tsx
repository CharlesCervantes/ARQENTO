import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarUsuariosElegiblesVendedor } from "@/lib/server/comercializacion/vendedores";
import { Card } from "@/components/ui/card";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { VendedoresView } from "@/components/comercializacion/vendedores-view";

// Asignación de la función Vendedor — solo Administrador/Director, solo
// Supervisores de su propia Empresa. No cambia roles ni otros permisos.
export default async function VendedoresComercialesPage() {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;
  if (!esAdministradorComercial(usuario)) {
    return <Card className="p-6 text-sm text-[var(--muted)]">Solo administración puede asignar vendedores.</Card>;
  }

  const usuarios = await listarUsuariosElegiblesVendedor(usuario);
  return <VendedoresView usuarios={usuarios} />;
}

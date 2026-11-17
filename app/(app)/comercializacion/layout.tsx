import type { ReactNode } from "react";
import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { TabNav } from "@/components/control-de-obra/tab-nav";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";

// Comercialización (docs/negocio/comercializacion.md): interfaz sencilla —
// listado único, Productos como acceso secundario y, solo para
// administración, la asignación de la función Vendedor. Cada página vuelve a
// validar en servidor; este layout solo evita mostrar el encabezado a quien
// no tiene acceso.
export default async function ComercializacionLayout({ children }: { children: ReactNode }) {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);

  if (!acceso.permitido) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Comercialización</h1>
        <SinAccesoComercial motivo={acceso.motivo} />
      </div>
    );
  }

  const tabs = [
    { href: "/comercializacion", label: "Cotizaciones y órdenes", activaEn: ["/comercializacion/cotizaciones/"] },
    { href: "/comercializacion/productos", label: "Productos" },
    ...(esAdministradorComercial(usuario) ? [{ href: "/comercializacion/vendedores", label: "Vendedores" }] : []),
  ];

  return (
    <div className="space-y-6">
      <TabNav tabs={tabs} variante="secundaria" />
      {children}
    </div>
  );
}

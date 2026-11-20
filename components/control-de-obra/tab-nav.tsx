"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { EnlaceProtegido } from "./enlace-protegido";

// `coincideSubrutas`: para pestañas que agrupan sub-rutas (p. ej. "Contrato"
// enlaza a /contrato/general pero también debe verse activa en
// /contrato/privado) — sin esto, solo hay match exacto de pathname, que
// sigue siendo lo correcto para pestañas sin hijos (Resumen, Cliente, y
// cualquier subpestaña de segundo nivel).
//
// `variante`: "principal" es la ÚNICA navegación que debe sentirse global —
// barra de ancho completo, subrayada, para las 4 grandes áreas del proyecto
// (Resumen | Contrato | Ejecución | Cliente). "secundaria" es todo nivel por
// debajo de esa (Contrato General | Priv., Avance | Contratistas | Gastos,
// Reposiciones | Órdenes de compra, Cliente | Priv., Estimación | Control
// contractual) — se renderiza como un segmented control compacto (ancho al
// contenido, no a la pantalla) para que se perciba como un selector de vista
// LOCAL del módulo, nunca como otra barra de navegación apilada encima de la
// anterior (principio de diseño, agosto 2026: solo un nivel de "barra
// global" en toda la jerarquía del proyecto, sin importar cuántos niveles
// conceptuales existan debajo).
export function TabNav({
  tabs,
  variante = "principal",
}: {
  // `activaEn`: prefijos adicionales que también activan la pestaña, cuando
  // sus sub-rutas no cuelgan de su propio href (p. ej. Comercialización:
  // el listado vive en /comercializacion y su detalle en
  // /comercializacion/cotizaciones/…, pero /comercializacion/productos es
  // otra pestaña, así que coincideSubrutas no sirve).
  tabs: { href: string; label: string; coincideSubrutas?: boolean; activaEn?: string[] }[];
  variante?: "principal" | "secundaria";
}) {
  const pathname = usePathname();

  function activo(tab: { href: string; coincideSubrutas?: boolean; activaEn?: string[] }): boolean {
    return (
      pathname === tab.href ||
      (tab.coincideSubrutas === true && pathname.startsWith(`${tab.href}/`)) ||
      (tab.activaEn ?? []).some((prefijo) => pathname.startsWith(prefijo))
    );
  }

  if (variante === "secundaria") {
    return (
      <nav className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-lg bg-black/[0.04] p-1">
        {tabs.map((tab) => (
          <EnlaceProtegido
            key={tab.href}
            href={tab.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 ease-out",
              activo(tab)
                ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            )}
          >
            {tab.label}
          </EnlaceProtegido>
        ))}
      </nav>
    );
  }

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
      {tabs.map((tab) => (
        <EnlaceProtegido
          key={tab.href}
          href={tab.href}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out",
            activo(tab)
              ? "border-[var(--brand)] text-[var(--brand)]"
              : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
          )}
        >
          {tab.label}
        </EnlaceProtegido>
      ))}
    </nav>
  );
}

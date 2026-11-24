"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  Building2,
  Calculator,
  HandCoins,
  House,
  LayoutGrid,
  LogOut,
  Receipt,
  ShoppingCart,
  Store,
  type LucideIcon,
} from "lucide-react";
import { EstatusProyectoBadge } from "@/components/control-de-obra/estatus-proyecto-badge";
import { EnlaceProtegido } from "@/components/control-de-obra/enlace-protegido";
import { cn } from "@/lib/cn";
import type { EstatusProyecto } from "@/lib/generated/prisma/enums";
import { logout } from "../actions";

type ModuloNav = {
  clave: string;
  nombre: string;
  href: string | null;
  // true = hay algo pendiente de aprobar/revisar en este módulo (ej.
  // Proyectos con avance o gastos pendientes) — un puntito discreto junto al
  // nombre, solo para quien ya puede ver esta alerta (calculado por el
  // caller, nunca aquí: el sidebar solo pinta lo que le llega).
  pendiente?: boolean;
};

type GrupoProyecto = {
  label: string;
  hrefActivo: string;
  hijos: { href: string; label: string; coincideSubrutas?: boolean; pendiente?: boolean }[];
};

type SidebarProps =
  | {
      variant: "global";
      empresaNombre: string;
      logoUrl: string | null;
      usuarioNombre: string;
      rolLabel: string;
      modulos: ModuloNav[];
    }
  | {
      variant: "proyecto";
      empresaNombre: string;
      logoUrl: string | null;
      usuarioNombre: string;
      rolLabel: string;
      proyecto: { id: string; nombre: string; estatus: EstatusProyecto };
      resumenHref: string;
      grupos: GrupoProyecto[];
    }
  | {
      // Master no pertenece a ninguna Empresa — el header de marca es la
      // identidad de plataforma, no el logo/nombre de un tenant (Portal
      // Master, decisión de sesión).
      variant: "master";
      usuarioNombre: string;
      rolLabel: string;
    };

// Iconos por módulo (solo presentación; rutas y permisos no cambian).
const ICONO_MODULO: Record<string, LucideIcon> = {
  inicio: House,
  reporte_general: BarChart3,
  control_de_obra: Building2,
  control_prestamos: HandCoins,
  catalogos: BookOpen,
  gastos: Receipt,
  contabilidad: Calculator,
  compras: ShoppingCart,
  comercializacion: Store,
};

function iniciales(nombre: string): string {
  return nombre
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((palabra) => palabra[0]?.toUpperCase())
    .join("");
}

// Un solo componente con variante global/proyecto (en vez de dos sidebars
// completos) — comparten el header de marca y el bloque de usuario/logout,
// y solo el <nav> central cambia (rediseño de navegación, agosto 2026).
export function Sidebar(props: SidebarProps) {
  const pathname = usePathname();
  const { usuarioNombre, rolLabel } = props;

  // Con logo cargado, el logo ES la identidad — se quita el nombre en texto
  // para darle todo el espacio del encabezado y que se vea más grande (antes
  // competía por espacio con el nombre; sin logo, el nombre sigue siendo
  // necesario para identificar la Empresa).
  const tieneLogo = props.variant !== "master" && Boolean(props.logoUrl);

  return (
    // 268 px y alto completo (el padre de AppShell es h-screen). Arriba, un
    // espacio fijo para el logo (horizontal o vertical: object-contain, nunca
    // se recorta ni deforma); en medio el menú con desplazamiento propio; al
    // pie, usuario, cerrar sesión y la marca de plataforma.
    <aside className="flex h-full min-h-0 w-[268px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      <Link
        href={props.variant === "master" ? "/master" : "/dashboard"}
        aria-label={props.variant === "master" ? "Portal Master" : `${props.empresaNombre}: ir a Inicio`}
        className={cn(
          "flex h-[112px] shrink-0 items-center gap-3 border-b border-[var(--border)] px-[22px] py-5 transition-opacity duration-150 ease-out hover:opacity-80 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand)]",
          tieneLogo && "justify-center py-4"
        )}
      >
        {props.variant === "master" ? (
          <>
            <span
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl text-sm font-bold text-[var(--brand-foreground)]"
              style={{ backgroundColor: "var(--brand)" }}
            >
              M
            </span>
            <span className="truncate text-sm font-semibold text-[var(--foreground)]">Portal Master</span>
          </>
        ) : tieneLogo ? (
          // Centrado horizontal y vertical en el encabezado: un logo cuadrado
          // queda al centro a todo lo alto; uno horizontal, al centro a todo
          // lo ancho. object-contain: completo y sin deformar.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={props.logoUrl!}
            alt={props.empresaNombre}
            className="block h-full w-full min-w-0 object-contain object-center"
          />
        ) : (
          <>
            <span
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl text-sm font-bold text-[var(--brand-foreground)]"
              style={{ backgroundColor: "var(--brand)" }}
            >
              {iniciales(props.empresaNombre)}
            </span>
            <span className="line-clamp-2 text-[15px] leading-5 font-semibold text-[var(--foreground)]">
              {props.empresaNombre}
            </span>
          </>
        )}
      </Link>

      <nav aria-label="Navegación principal" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3.5 py-4">
        {props.variant === "master" ? (
          <>
            <NavLink href="/master" active={pathname === "/master"} icono={LayoutGrid}>
              Resumen
            </NavLink>
            <NavLink href="/master/empresas" active={pathname.startsWith("/master/empresas")} icono={Building2}>
              Empresas
            </NavLink>
          </>
        ) : props.variant === "global" ? (
          <>
            {/* Inicio es un módulo más (habilitable por Empresa); cuando la
                Empresa lo tiene, llega primero en `modulos`. */}
            {props.modulos.map((modulo) =>
              modulo.href ? (
                <NavLink
                  key={modulo.clave}
                  href={modulo.href}
                  active={pathname.startsWith(modulo.href)}
                  pendiente={modulo.pendiente}
                  icono={ICONO_MODULO[modulo.clave]}
                >
                  {modulo.nombre}
                </NavLink>
              ) : (
                <div
                  key={modulo.clave}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm text-[var(--muted)]"
                >
                  <span className="flex items-center gap-3">
                    <IconoModulo clave={modulo.clave} />
                    {modulo.nombre}
                  </span>
                  <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px]">
                    Próximamente
                  </span>
                </div>
              )
            )}
          </>
        ) : (
          <>
            <EnlaceProtegido
              href="/control-de-obra"
              className="mb-3 block text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              ← Todos los proyectos
            </EnlaceProtegido>

            <div className="px-3 pb-3">
              <p className="truncate text-sm font-semibold text-[var(--foreground)]">
                {props.proyecto.nombre}
              </p>
              <div className="mt-1">
                <EstatusProyectoBadge estatus={props.proyecto.estatus} />
              </div>
            </div>

            <NavLink href={props.resumenHref} active={pathname === props.resumenHref}>
              Resumen
            </NavLink>

            {props.grupos.map((grupo) => {
              const grupoActivo = pathname.startsWith(grupo.hrefActivo);
              return (
                <div key={grupo.label}>
                  <p
                    className={cn(
                      "px-3 pt-4 pb-1 text-xs font-semibold tracking-wide uppercase",
                      grupoActivo ? "text-[var(--foreground)]" : "text-[var(--muted)]"
                    )}
                  >
                    {grupo.label}
                  </p>
                  {grupo.hijos.map((hijo) => {
                    const activo =
                      pathname === hijo.href ||
                      (hijo.coincideSubrutas && pathname.startsWith(hijo.href + "/"));
                    return (
                      <EnlaceProtegido
                        key={hijo.href}
                        href={hijo.href}
                        className={cn(ESTILO_ITEM, activo ? ESTILO_ACTIVO : ESTILO_INACTIVO)}
                      >
                        <span>{hijo.label}</span>
                        {hijo.pendiente && <PuntoPendiente />}
                      </EnlaceProtegido>
                    );
                  })}
                </div>
              );
            })}
          </>
        )}
      </nav>

      <div className="shrink-0 border-t border-[var(--border)] px-3.5 pt-3 pb-2">
        <Link
          href="/perfil"
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-black/[0.04]"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-[var(--brand-foreground)]"
            style={{ backgroundColor: "var(--brand)" }}
          >
            {iniciales(usuarioNombre)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--foreground)]">
              {usuarioNombre}
            </p>
            <p className="truncate text-xs text-[var(--muted)]">{rolLabel}</p>
          </div>
        </Link>
        <form action={logout} className="mt-1">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-[var(--muted)] transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
          >
            <LogOut size={18} strokeWidth={1.8} aria-hidden />
            Cerrar sesión
          </button>
        </form>
        {/* Marca de plataforma (dorado de ARQENTO, definido en app/login/page.tsx). */}
        <p className="mt-2 flex items-center gap-2 border-t border-[var(--border)] px-3 pt-3 pb-1 text-xs font-semibold tracking-[0.02em] text-[var(--muted)]">
          <span aria-hidden className="h-2 w-2 rounded-[2px] bg-[#c99a63]" />
          ARQENTO
        </p>
      </div>
    </aside>
  );
}

// Estado activo en grafito (diseño de Inicio V4), igual en las tres variantes.
const ESTILO_ITEM =
  "flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]";
const ESTILO_ACTIVO = "bg-[#1e2226] text-[#f3f4f5]";
const ESTILO_INACTIVO = "text-[#4d5257] hover:bg-black/[0.04] hover:text-[var(--foreground)]";

function IconoModulo({ clave }: { clave: string }) {
  const Icono = ICONO_MODULO[clave];
  return Icono ? <Icono size={19} strokeWidth={1.8} aria-hidden className="shrink-0" /> : null;
}

function NavLink({
  href,
  active,
  pendiente,
  icono: Icono,
  children,
}: {
  href: string;
  active: boolean;
  pendiente?: boolean;
  icono?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(ESTILO_ITEM, active ? ESTILO_ACTIVO : ESTILO_INACTIVO)}
    >
      <span className="flex min-w-0 items-center gap-3">
        {Icono && <Icono size={19} strokeWidth={1.8} aria-hidden className="shrink-0" />}
        <span className="truncate">{children}</span>
      </span>
      {pendiente && <PuntoPendiente />}
    </Link>
  );
}

// Indicador discreto de "algo pendiente" en un renglón del sidebar (ej.
// Proyectos con avance/gastos sin aprobar) — solo un punto, sin número (el
// detalle exacto ya se ve al entrar a la pantalla). Ámbar porque es un
// aviso, no la identidad de marca (--brand) ni un error (--danger).
function PuntoPendiente() {
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]"
      title="Hay algo pendiente"
    />
  );
}

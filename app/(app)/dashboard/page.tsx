import { redirect } from "next/navigation";
import { requireSession } from "@/lib/server/auth/dal";
import { Card } from "@/components/ui/card";
import { obtenerModulosVisibles, puedeVerInicio } from "@/lib/server/permisos";
import { rutaInicial } from "@/lib/modulos";
import {
  obtenerResumenEjecutivo,
  type VistaDashboard,
  type PeriodoDashboard,
} from "@/lib/server/dashboard";
import { InicioView } from "@/components/dashboard/inicio-view";

function aVista(valor: string | string[] | undefined): VistaDashboard {
  return valor === "privado" ? "privado" : "general";
}
function aPeriodo(valor: string | string[] | undefined): PeriodoDashboard {
  if (valor === "mes") return "mes";
  if (valor === "mes_anterior") return "mes_anterior";
  if (valor === "acumulado") return "acumulado";
  return "semana";
}

// /dashboard es la entrada de todo usuario de Empresa (login, logo, «/»,
// cambio de contraseña). Inicio es un módulo habilitable por Empresa: sin
// él, se envía al primer módulo que el usuario puede usar (p. ej. solo
// Comercialización → Operaciones) ANTES de consultar cualquier dato de obras.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; periodo?: string }>;
}) {
  const usuario = await requireSession();

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada. Contacta a un administrador.
      </Card>
    );
  }

  // Módulos visibles (Empresa + rol, en el orden del menú): Inicio solo
  // enlaza a pantallas que el usuario puede abrir — el resto se muestra como
  // texto, sin enlace.
  const modulos = await obtenerModulosVisibles(usuario);

  if (!puedeVerInicio(usuario)) {
    // rutaInicial nunca devuelve /dashboard aquí (Inicio no está visible):
    // sin ciclos de redirección.
    const destino = rutaInicial(modulos.map((m) => m.clave));
    if (destino) redirect(destino);
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu usuario no tiene módulos habilitados en esta empresa. Contacta a un administrador.
      </Card>
    );
  }

  const { vista: vistaParam, periodo: periodoParam } = await searchParams;
  const vista = aVista(vistaParam);
  const periodo = aPeriodo(periodoParam);

  const resumen = await obtenerResumenEjecutivo(usuario, vista, periodo);

  return <InicioView resumen={resumen} modulosVisibles={modulos.map((m) => m.clave)} />;
}

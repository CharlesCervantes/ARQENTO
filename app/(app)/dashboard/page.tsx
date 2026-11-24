import { requireSession } from "@/lib/server/auth/dal";
import { Card } from "@/components/ui/card";
import { obtenerModulosVisibles } from "@/lib/server/permisos";
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

  const { vista: vistaParam, periodo: periodoParam } = await searchParams;
  const vista = aVista(vistaParam);
  const periodo = aPeriodo(periodoParam);

  // Módulos visibles (Empresa + rol): Inicio solo enlaza a pantallas que el
  // usuario puede abrir — el resto se muestra como texto, sin enlace.
  const [resumen, modulos] = await Promise.all([
    obtenerResumenEjecutivo(usuario, vista, periodo),
    obtenerModulosVisibles(usuario),
  ]);

  return <InicioView resumen={resumen} modulosVisibles={modulos.map((m) => m.clave)} />;
}

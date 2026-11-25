import Link from "next/link";
import { requireSession } from "@/lib/server/auth/dal";
import { empresaTieneModulo, puedeAsignarObras } from "@/lib/server/permisos";
import { obtenerAccesosSupervisores } from "@/lib/server/control-de-obra/accesos-obra";
import { AccesosSupervisorForm } from "@/components/control-de-obra/accesos-supervisor-form";
import { Card } from "@/components/ui/card";

export default async function AccesosSupervisoresPage() {
  const usuario = await requireSession();
  if (!usuario.empresa || !empresaTieneModulo(usuario, "control_de_obra") || !puedeAsignarObras(usuario)) {
    return <Card className="p-6 text-sm text-[var(--muted)]">No tienes permiso para asignar obras.</Card>;
  }
  const { supervisores, obras } = await obtenerAccesosSupervisores(usuario);
  return (
    <div className="space-y-6">
      <div>
        <Link href="/control-de-obra" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          ← Proyectos
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--foreground)]">Accesos de supervisores</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Cada supervisor ve solo las obras marcadas, en Proyectos, Inicio y Gastos. En Reporte General ve solo sus pagos y sus gastos.
        </p>
      </div>
      {supervisores.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">No hay supervisores registrados.</Card>
      ) : (
        supervisores.map((s) => <AccesosSupervisorForm key={s.id + s.obraIds.join()} supervisor={s} obras={obras} />)
      )}
    </div>
  );
}

import { puedeVerInformacionPrivada } from "@/lib/server/permisos";
import { requireSession } from "@/lib/server/auth/dal";
import { puedeCapturarGastos, puedeAutorizarOrdenesCompra } from "@/lib/server/permisos";
import { obtenerOCrearSemanaActual } from "@/lib/server/semanas";
import { obtenerRequisiciones } from "@/lib/server/control-de-obra/requisiciones";
import { listarBeneficiariosParaGasto } from "@/lib/server/control-de-obra/gastos";
import { RequisicionesView } from "@/components/control-de-obra/requisiciones-view";
import { Card } from "@/components/ui/card";

// Requisiciones no está acotada a una semana como Reposiciones/Órdenes de
// compra — es un backlog de necesidades del proyecto, se convierte en OC (con
// su propia semana) hasta que se decide comprar (Compras, septiembre 2026).
export default async function RequisicionesPage({
  params,
}: PageProps<"/control-de-obra/[id]/ejecucion/gastos/requisiciones">) {
  const usuario = await requireSession();

  if (!puedeCapturarGastos(usuario)) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        No tienes permiso para ver Gastos de Obra.
      </Card>
    );
  }

  const { id } = await params;

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  const [requisiciones, beneficiarios, semanaActual] = await Promise.all([
    obtenerRequisiciones(usuario, id),
    listarBeneficiariosParaGasto(usuario),
    obtenerOCrearSemanaActual(usuario.empresa.id),
  ]);
  const proveedores = beneficiarios.filter((b) => b.tipo === "PROVEEDOR");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Gastos de obra</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Requisiciones</p>
      </div>

      <RequisicionesView
        verPrivado={puedeVerInformacionPrivada(usuario)}
        proyectoId={id}
        semanaId={semanaActual.id}
        requisiciones={requisiciones}
        proveedores={proveedores}
        puedeAutorizar={puedeAutorizarOrdenesCompra(usuario)}
      />
    </div>
  );
}

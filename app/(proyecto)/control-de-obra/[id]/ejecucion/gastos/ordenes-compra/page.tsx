import { puedeVerInformacionPrivada } from "@/lib/server/permisos";
import { requireSession } from "@/lib/server/auth/dal";
import { puedeCapturarGastos, puedeAutorizarOrdenesCompra } from "@/lib/server/permisos";
import {
  obtenerOCrearSemana,
  formatearRangoSemana,
  fechaAParametro,
  parametroAFecha,
} from "@/lib/server/semanas";
import {
  obtenerOrdenesCompra,
} from "@/lib/server/control-de-obra/ordenes-compra";
import { listarBeneficiariosParaGasto } from "@/lib/server/control-de-obra/gastos";
import { NavegacionSemana } from "@/components/control-de-obra/navegacion-semana";
import { OrdenesCompraView } from "@/components/control-de-obra/ordenes-compra-view";
import { Card } from "@/components/ui/card";

export default async function OrdenesCompraPage({
  params,
  searchParams,
}: PageProps<"/control-de-obra/[id]/ejecucion/gastos/ordenes-compra">) {
  const usuario = await requireSession();

  if (!puedeCapturarGastos(usuario)) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        No tienes permiso para ver Gastos de Obra.
      </Card>
    );
  }

  const { id } = await params;
  const { fecha } = await searchParams;
  const fechaParam = typeof fecha === "string" ? fecha : undefined;

  if (!usuario.empresa) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]">
        Tu cuenta no tiene una empresa asignada.
      </Card>
    );
  }

  const semana = await obtenerOCrearSemana(usuario.empresa.id, parametroAFecha(fechaParam));
  const [ordenes, beneficiarios] = await Promise.all([
    obtenerOrdenesCompra(usuario, id, semana.id),
    listarBeneficiariosParaGasto(usuario),
  ]);
  const proveedores = beneficiarios.filter((b) => b.tipo === "PROVEEDOR");

  const fechaAnterior = new Date(semana.fechaInicio);
  fechaAnterior.setDate(fechaAnterior.getDate() - 7);
  const fechaSiguiente = new Date(semana.fechaInicio);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 7);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Gastos de obra</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Órdenes de compra · {formatearRangoSemana(semana)}
        </p>
      </div>

      <NavegacionSemana
        proyectoId={id}
        rutaBase="ejecucion/gastos/ordenes-compra"
        etiquetaSemana={`Semana ${semana.numero}`}
        fechaAnteriorParametro={fechaAParametro(fechaAnterior)}
        fechaSiguienteParametro={fechaAParametro(fechaSiguiente)}
      />

      <OrdenesCompraView
        verPrivado={puedeVerInformacionPrivada(usuario)}
        proyectoId={id}
        semanaId={semana.id}
        ordenes={ordenes}
        proveedores={proveedores}
        puedeAutorizar={puedeAutorizarOrdenesCompra(usuario)}
      />
    </div>
  );
}

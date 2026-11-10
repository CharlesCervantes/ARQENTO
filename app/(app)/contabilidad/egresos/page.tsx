import { requireSession } from "@/lib/server/auth/dal";
import { empresaTieneModulo, puedeVerContabilidad } from "@/lib/server/permisos";
import { obtenerEgresos } from "@/lib/server/contabilidad/egresos";
import { listarMediosFinancieros } from "@/lib/server/contabilidad/medios-financieros";
import { listarFacturas } from "@/lib/server/contabilidad/facturas";
import { listarProyectos } from "@/lib/server/control-de-obra/proyectos";
import { inteligenciaHabilitadaParaEmpresa } from "@/lib/server/inteligencia/capacidades";
import { listarBeneficiariosParaGasto } from "@/lib/server/control-de-obra/gastos";
import { listarSemanasParaRegistro } from "@/lib/server/semanas";
import { parametroAPeriodo } from "@/lib/contabilidad/periodo";
import { NavContabilidad } from "@/components/contabilidad/nav-contabilidad";
import { NavegacionMes } from "@/components/contabilidad/navegacion-mes";
import { EgresosView } from "@/components/contabilidad/egresos-view";
import { Card } from "@/components/ui/card";

export default async function EgresosContabilidadPage(props: PageProps<"/contabilidad/egresos">) {
  const usuario = await requireSession();

  if (!usuario.empresa) {
    return <Card className="p-6 text-sm text-[var(--muted)]">Tu cuenta no tiene una empresa asignada.</Card>;
  }
  if (!empresaTieneModulo(usuario, "contabilidad")) {
    return <Card className="p-6 text-sm text-[var(--muted)]">Tu plan no incluye el módulo de Contabilidad.</Card>;
  }
  if (!puedeVerContabilidad(usuario)) {
    return <Card className="p-6 text-sm text-[var(--muted)]">No tienes permiso para ver Contabilidad.</Card>;
  }

  const searchParams = await props.searchParams;
  const periodo = parametroAPeriodo(typeof searchParams.periodo === "string" ? searchParams.periodo : undefined);

  const [egresos, medios, facturas, proyectos, capturaInteligenteHabilitada] = await Promise.all([
    obtenerEgresos(usuario, periodo.anio, periodo.mes),
    listarMediosFinancieros(usuario, true),
    listarFacturas(usuario),
    listarProyectos(usuario),
    inteligenciaHabilitadaParaEmpresa(usuario.empresa.id),
  ]);
  // Solo hacen falta para registrar un documento como gasto de obra.
  const [beneficiarios, semanasRegistro] = capturaInteligenteHabilitada
    ? await Promise.all([listarBeneficiariosParaGasto(usuario), listarSemanasParaRegistro(usuario.empresa.id)])
    : [[], { semanaActualId: "", semanas: [] }];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Contabilidad</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Egresos fiscales</p>
      </div>

      <NavContabilidad />
      <NavegacionMes periodo={periodo} rutaBase="/contabilidad/egresos" />

      <EgresosView
        egresos={egresos}
        mediosFinancieros={medios}
        facturasRecibidas={facturas.filter((f) => f.direccion === "RECIBIDA")}
        proyectosDisponibles={proyectos.map((p) => ({ id: p.id, nombre: p.nombre }))}
        capturaInteligenteHabilitada={capturaInteligenteHabilitada}
        beneficiarios={beneficiarios}
        semanasRegistro={semanasRegistro}
      />
    </div>
  );
}

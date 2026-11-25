import { requireSession } from "@/lib/server/auth/dal";
import {
  puedeVerFinancieroClienteOperativo,
  puedeRegistrarMovimientoFinancieroClienteOperativo,
} from "@/lib/server/permisos";
import {
  obtenerControlContractual,
  obtenerHistorialEstimacionesCliente,
  obtenerAportacionesFondo,
} from "@/lib/server/control-de-obra/financiero-cliente";
import { listarMediosFinancieros } from "@/lib/server/contabilidad/medios-financieros";
import { ResumenControlContractual } from "@/components/control-de-obra/resumen-control-contractual";
import { HistorialEstimacionesCliente } from "@/components/control-de-obra/historial-estimaciones-cliente";
import { AportacionesFondo } from "@/components/control-de-obra/aportaciones-fondo";
import { EstimacionesExternas } from "@/components/control-de-obra/estimaciones-externas";
import { obtenerEstimacionesExternas } from "@/lib/server/control-de-obra/estimaciones-externas";

// A diferencia de cliente/privado/control-contractual, esta pantalla NO
// tiene gate propio — cualquiera con acceso al proyecto entra, igual que
// Cliente (Estimación semanal) hoy. El bloque financiero real (Fondo,
// Aportaciones, columnas de pago del historial) llega o no llega según
// puedeVerFinancieroCliente, decidido del lado servidor dentro de
// obtenerControlContractual/obtenerHistorialEstimacionesCliente — esta
// página solo refleja lo que ya vino, nunca oculta un dato que sí llegó
// (rediseño Cliente/Cliente Priv., agosto 2026).
export default async function ClienteGeneralControlContractualPage({
  params,
}: PageProps<"/control-de-obra/[id]/cliente/general/control-contractual">) {
  const usuario = await requireSession();
  const { id } = await params;

  // Capa operativo — deliberadamente sin exigir Vista privada (gastos
  // cobrables en Estimación Cliente, agosto 2026), a diferencia de
  // cliente/privado/control-contractual que sigue exigiéndola.
  const puedeVerFinanciero = puedeVerFinancieroClienteOperativo(usuario);

  // Capa operativo — deliberadamente sin exigir Vista privada, igual que
  // puedeVerFinanciero arriba (arquitectura por capas, agosto 2026).
  const puedeRegistrar = puedeRegistrarMovimientoFinancieroClienteOperativo(usuario);

  const [datos, historial, externas, aportaciones, mediosFinancieros] = await Promise.all([
    obtenerControlContractual(usuario, id, "operativo"),
    obtenerHistorialEstimacionesCliente(usuario, id, "operativo"),
    obtenerEstimacionesExternas(usuario, id, "operativo"),
    puedeVerFinanciero ? obtenerAportacionesFondo(usuario, id) : Promise.resolve([]),
    puedeRegistrar ? listarMediosFinancieros(usuario, true) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Control contractual</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{datos.proyecto.nombre}</p>
      </div>

      <ResumenControlContractual proyectoId={id} datos={datos} />

      <HistorialEstimacionesCliente
        proyectoId={id}
        capa="operativo"
        fondoDisponible={datos.financiero?.fondo?.disponible ?? 0}
        filas={historial}
        puedeRegistrar={puedeRegistrar}
        mediosFinancieros={mediosFinancieros}
      />

      <EstimacionesExternas filas={externas} verPago={puedeVerFinanciero} />

      {puedeVerFinanciero && (
        <AportacionesFondo
          proyectoId={id}
          aportaciones={aportaciones}
          puedeRegistrar={puedeRegistrar}
          mediosFinancieros={mediosFinancieros}
        />
      )}
    </div>
  );
}

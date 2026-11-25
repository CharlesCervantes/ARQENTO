import "server-only";
import { db } from "@/lib/server/db";
import type { UsuarioSesion } from "@/lib/server/session";
import type { EstatusGasto, EstatusPago, OrigenMovimientoSemanal } from "@/lib/generated/prisma/enums";
import { estadoDeReposicion } from "@/lib/control-de-obra/reposicion-estado";
import { EMPRESA_PROYECTO_LABEL } from "@/lib/server/control-de-obra/proyecto-oficina";

// Reporte General del Supervisor (noviembre 2026): solo lo suyo — lo que se le
// va a pagar y los gastos que él capturó o pagó. Nunca contratistas,
// proveedores, otras personas ni totales de la obra. La identidad sale del
// vínculo Beneficiario.usuarioId del usuario en sesión, nunca de un id que
// mande el navegador. Incluye su dinero de cualquier obra: quitarle el acceso
// a una obra no borra lo que se le debe.

export type FilaMiPago = {
  id: string;
  obra: string;
  origen: OrigenMovimientoSemanal;
  monto: number;
  pendiente: number;
  aprobado: boolean;
  estatusPago: EstatusPago;
  fechaPago: string | null;
};
export type FilaMiGasto = { id: string; obra: string; fecha: string; descripcion: string; monto: number; estatus: EstatusGasto; loPagueYo: boolean };
export type MiReporte = { vinculado: boolean; pagos: FilaMiPago[]; gastos: FilaMiGasto[]; totalPagos: number; totalPendiente: number; gastosPorRevisar: number };

const nombreObra = (p: { nombre: string; tipo: string }) => (p.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : p.nombre);

// Su registro de pago y los alias de la misma persona real.
async function misBeneficiarios(usuario: UsuarioSesion, empresaId: string): Promise<string[]> {
  const propio = await db.beneficiario.findFirst({
    where: { usuarioId: usuario.id, empresaId },
    select: { id: true, mismaPersonaQueId: true },
  });
  if (!propio) return [];
  const raiz = propio.mismaPersonaQueId ?? propio.id;
  const alias = await db.beneficiario.findMany({
    where: { empresaId, OR: [{ id: raiz }, { mismaPersonaQueId: raiz }] },
    select: { id: true },
  });
  return [...new Set([propio.id, ...alias.map((a) => a.id)])];
}

export async function obtenerMiReporte(usuario: UsuarioSesion, semanaId: string): Promise<MiReporte> {
  const empresaId = usuario.empresa!.id;
  const ids = await misBeneficiarios(usuario, empresaId);
  const obra = { select: { nombre: true, tipo: true } } as const;
  const [movimientos, gastos] = await Promise.all([
    db.movimientoSemanal.findMany({
      where: {
        semanaId,
        estatusAprobacion: { notIn: ["RECHAZADO", "CANCELADO"] },
        beneficiarioProyecto: { beneficiarioId: { in: ids }, proyecto: { empresaId } },
      },
      select: {
        id: true, origen: true, montoEntreSemana: true, montoFinSemana: true, estatusAprobacion: true, estatusPago: true, fechaPago: true,
        beneficiarioProyecto: { select: { proyecto: obra } },
        reposicionGastos: { select: { cerrada: true, gastos: { select: { monto: true } }, abonos: { select: { monto: true } } } },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.gastoObra.findMany({
      where: { empresaId, semanaId, OR: [{ capturadoPorId: usuario.id }, { pagadorBeneficiarioId: { in: ids } }] },
      select: { id: true, fecha: true, descripcion: true, monto: true, estatus: true, pagadorBeneficiarioId: true, proyecto: obra },
      orderBy: { fecha: "desc" },
    }),
  ]);

  const pagos = movimientos.map((m): FilaMiPago => {
    const monto = Number(m.montoEntreSemana) + Number(m.montoFinSemana);
    const aprobado = m.estatusAprobacion === "APROBADO";
    let pendiente = m.estatusPago === "PENDIENTE_PAGO" ? monto : 0;
    if (m.origen === "REPOSICION_GASTOS" && m.reposicionGastos) {
      const suma = (xs: { monto: unknown }[]) => xs.reduce((t, x) => t + Number(x.monto), 0);
      pendiente = estadoDeReposicion({
        total: suma(m.reposicionGastos.gastos),
        abonado: suma(m.reposicionGastos.abonos),
        cerrada: m.reposicionGastos.cerrada,
        estatusPago: m.estatusPago,
        montoMovimiento: monto,
      }).saldoPendiente;
    }
    return {
      id: m.id, obra: nombreObra(m.beneficiarioProyecto.proyecto), origen: m.origen, monto, pendiente: aprobado ? pendiente : 0, aprobado,
      estatusPago: m.estatusPago, fechaPago: m.fechaPago?.toISOString() ?? null,
    };
  });
  const filasGasto = gastos.map((g): FilaMiGasto => ({
    id: g.id, obra: nombreObra(g.proyecto), fecha: g.fecha.toISOString(), descripcion: g.descripcion, monto: Number(g.monto), estatus: g.estatus,
    loPagueYo: g.pagadorBeneficiarioId !== null && ids.includes(g.pagadorBeneficiarioId),
  }));
  return {
    vinculado: ids.length > 0,
    pagos,
    gastos: filasGasto,
    totalPagos: pagos.filter((p) => p.aprobado).reduce((t, p) => t + p.monto, 0),
    totalPendiente: pagos.reduce((t, p) => t + p.pendiente, 0),
    gastosPorRevisar: filasGasto.filter((g) => g.estatus === "PENDIENTE_REVISION" && g.loPagueYo).reduce((t, g) => t + g.monto, 0),
  };
}

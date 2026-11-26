import "server-only";
import { db } from "@/lib/server/db";
import { sumarMontos } from "@/lib/dinero";
import { sumarContratoVigentePorBeneficiario } from "@/lib/server/control-de-obra/estructura-contractual";
import type {
  EstatusAprobacion,
  EstatusPago,
  OrigenMovimientoSemanal,
} from "@/lib/generated/prisma/enums";
import { estadoDeReposicion, type EstadoReposicion } from "@/lib/control-de-obra/reposicion-estado";

// R2 (octubre 2026) — estado de pago de la reposición que paga un movimiento
// de origen REPOSICION_GASTOS. Solo informativo: los montos y totales de
// Reporte General siguen leyendo el importe original del movimiento (nunca
// se suman abonos al movimiento). Ver reposicion-estado.ts.
export type ResumenReposicionFila = {
  total: number;
  abonado: number;
  saldoPendiente: number;
  estado: EstadoReposicion;
  requiereRevision: boolean;
};

// Un beneficiario puede tener más de un MovimientoSemanal la misma semana
// desde que existen Gastos de Obra (p. ej. un contratista con su corte Y una
// reposición de gastos que él mismo pagó) — cada `origen` es su propia fila
// aquí, nunca se combinan en un solo monto (evita que se pisen entre sí y
// deja claro en la UI de dónde sale cada importe). `id` sigue siendo el
// beneficiarioProyectoId (agrupa lo contractual); `movimientoId` distingue
// cada fila cuando hay más de una para el mismo beneficiario.
// Concepto del contrato del contratista en esta obra («Ver concepto»).
export type ConceptoContratadoFila = {
  descripcion: string;
  unidad: string;
  cantidad: number;
  importe: number;
};

export type FilaContratista = {
  id: string; // beneficiarioProyectoId
  movimientoId: string | null;
  origen: OrigenMovimientoSemanal | null;
  nombre: string;
  concepto: string | null;
  conceptos: ConceptoContratadoFila[];
  // Corte de contratista ligado a este movimiento y su recibo vigente, si ya
  // se generó (columna «Recibo»).
  corteId: string | null;
  reciboId: string | null;
  reciboFirmado: boolean;
  montoContrato: number;
  aditivasAutorizadas: number;
  montoContractualVigente: number;
  pagadoHistorico: number;
  saldo: number;
  montoEntreSemana: number;
  montoFinSemana: number;
  estatusAprobacion: EstatusAprobacion | null;
  estatusPago: EstatusPago | null;
  fechaPago: string | null;
  reposicion: ResumenReposicionFila | null;
};

export type FilaProveedor = {
  id: string;
  movimientoId: string | null;
  origen: OrigenMovimientoSemanal | null;
  nombre: string;
  giro: string | null;
  montoEntreSemana: number;
  montoFinSemana: number;
  estatusAprobacion: EstatusAprobacion | null;
  estatusPago: EstatusPago | null;
  fechaPago: string | null;
  reposicion: ResumenReposicionFila | null;
};

export type FilaAdministracion = {
  id: string;
  movimientoId: string | null;
  origen: OrigenMovimientoSemanal | null;
  nombre: string;
  puesto: string | null;
  montoEntreSemana: number;
  montoFinSemana: number;
  estatusAprobacion: EstatusAprobacion | null;
  estatusPago: EstatusPago | null;
  fechaPago: string | null;
  reposicion: ResumenReposicionFila | null;
};

export type ReporteObra = {
  proyecto: {
    id: string;
    nombre: string;
    tipo: string;
    estatus: string;
  };
  contratistas: FilaContratista[];
  proveedores: FilaProveedor[];
  administracion: FilaAdministracion[];
  totalEntreSemana: number;
  totalFinSemana: number;
  totalSemana: number;
  // Suma de los movimientos en estatusPago PENDIENTE_PAGO (dinero que falta
  // por pagar esta semana; no incluye lo ya cubierto por fondo puente).
  pendienteSemana: number;
};

export async function obtenerReporteSemana(
  empresaId: string,
  semanaId: string
): Promise<ReporteObra[]> {
  const [proyectos, pagosHistoricos, contratosNuevaEstructura] = await Promise.all([
    db.proyecto.findMany({
      where: { empresaId, estatus: { in: ["ACTIVO", "PAUSADO"] } },
      orderBy: { nombre: "asc" },
      include: {
        beneficiarios: {
          where: { activo: true },
          orderBy: { beneficiario: { nombre: "asc" } },
          include: {
            beneficiario: { include: { proveedor: true } },
            movimientos: {
              where: { semanaId },
              include: {
                corte: {
                  select: {
                    id: true,
                    estatus: true,
                    recibos: {
                      where: { estatus: "VIGENTE" },
                      select: { id: true, archivoEvidenciaRef: true },
                    },
                  },
                },
                reposicionGastos: {
                  select: {
                    cerrada: true,
                    gastos: { select: { monto: true } },
                    abonos: { select: { monto: true } },
                  },
                },
              },
            },
            aditivas: { where: { estatus: "AUTORIZADA" } },
          },
        },
      },
    }),
    // Solo origen CORTE_CONTRATISTA cuenta contra el saldo contractual — una
    // reposición de gastos o una orden de compra no es un pago contra el
    // contrato del beneficiario, aunque comparta el mismo BeneficiarioProyecto.
    db.movimientoSemanal.groupBy({
      by: ["beneficiarioProyectoId"],
      where: {
        beneficiarioProyecto: { proyecto: { empresaId } },
        estatusAprobacion: "APROBADO",
        origen: "CORTE_CONTRATISTA",
      },
      _sum: { montoEntreSemana: true, montoFinSemana: true },
    }),
    // Contrato vigente real de un contratista con la estructura nueva — ver
    // sumarContratoVigentePorBeneficiario. Un beneficiarioProyectoId presente
    // aquí (con 0 o más conceptos) ya usa la estructura nueva; uno ausente
    // todavía depende del campo legacy BeneficiarioProyecto.montoContrato.
    db.contratoContratista.findMany({
      where: { beneficiarioProyecto: { proyecto: { empresaId } } },
      select: {
        beneficiarioProyectoId: true,
        // Un concepto eliminado/cancelado (Eliminar Partidas/Conceptos,
        // septiembre 2026) deja de contar en "Contrato vigente" — mismo
        // criterio que estructura-contractual.ts:contratosConConceptos.
        conceptos: {
          where: { concepto: { estatus: "ACTIVO" } },
          orderBy: [
            { concepto: { partida: { orden: "asc" } } },
            { concepto: { partida: { createdAt: "asc" } } },
            { concepto: { orden: "asc" } },
            { concepto: { createdAt: "asc" } },
          ],
          select: {
            cantidad: true,
            precioUnitarioContratista: true,
            concepto: { select: { descripcion: true, unidad: true } },
          },
        },
      },
    }),
  ]);

  const pagadoPorParticipacion = new Map<string, number>();
  for (const fila of pagosHistoricos) {
    pagadoPorParticipacion.set(
      fila.beneficiarioProyectoId,
      sumarMontos(fila._sum.montoEntreSemana, fila._sum.montoFinSemana)
    );
  }

  const contratoVigentePorBeneficiario = sumarContratoVigentePorBeneficiario(contratosNuevaEstructura);
  const conceptosPorBeneficiario = new Map<string, ConceptoContratadoFila[]>();
  for (const contrato of contratosNuevaEstructura) {
    const lista = conceptosPorBeneficiario.get(contrato.beneficiarioProyectoId) ?? [];
    for (const cc of contrato.conceptos) {
      const cantidad = Number(cc.cantidad);
      lista.push({
        descripcion: cc.concepto.descripcion,
        unidad: cc.concepto.unidad,
        cantidad,
        importe: cantidad * Number(cc.precioUnitarioContratista),
      });
    }
    conceptosPorBeneficiario.set(contrato.beneficiarioProyectoId, lista);
  }

  return proyectos.map((proyecto) => {
    const contratistas: FilaContratista[] = [];
    const proveedores: FilaProveedor[] = [];
    const administracion: FilaAdministracion[] = [];

    for (const bp of proyecto.beneficiarios) {
      // Normalmente hay a lo más un movimiento (el corte de siempre). Si hay
      // más de uno (p. ej. corte + reposición la misma semana), cada uno se
      // muestra en su propia fila — nunca se combinan en un solo monto. Sin
      // ningún movimiento, se muestra una fila vacía (comportamiento actual:
      // el beneficiario siempre aparece, aunque no tenga nada esta semana).
      const movimientosSemana = bp.movimientos.length > 0 ? bp.movimientos : [null];

      for (const movimiento of movimientosSemana) {
        const montoEntreSemana = movimiento
          ? Number(movimiento.montoEntreSemana)
          : 0;
        const montoFinSemana = movimiento ? Number(movimiento.montoFinSemana) : 0;
        const estatusAprobacion = movimiento?.estatusAprobacion ?? null;
        const estatusPago = movimiento?.estatusPago ?? null;
        const movimientoId = movimiento?.id ?? null;
        const origen = movimiento?.origen ?? null;
        const fechaPago = movimiento?.fechaPago ? movimiento.fechaPago.toISOString() : null;
        const reposicion = resumirReposicion(movimiento, montoEntreSemana + montoFinSemana);

        if (bp.beneficiario.tipo === "CONTRATISTA") {
          // Fuente de verdad: si el contratista ya tiene ContratoContratista
          // (estructura nueva), su Contrato vigente es exactamente el mismo
          // que muestra Contratistas — nunca el campo legacy
          // BeneficiarioProyecto.montoContrato, que para estos beneficiarios
          // nunca se llena y quedaría en $0. Las Aditivas pertenecen al flujo
          // legacy (ver nota en recibos.ts): un contratista con estructura
          // nueva ajusta su contrato editando ContratoConcepto directamente,
          // así que no se sobreponen aquí. Solo un beneficiario SIN ningún
          // ContratoContratista (proyecto antiguo no migrado) sigue leyendo
          // montoContrato + aditivas, igual que siempre.
          const tieneEstructuraNueva = contratoVigentePorBeneficiario.has(bp.id);
          const montoContrato = tieneEstructuraNueva
            ? contratoVigentePorBeneficiario.get(bp.id)!
            : Number(bp.montoContrato ?? 0);
          const aditivasAutorizadas = tieneEstructuraNueva
            ? 0
            : sumarMontos(...bp.aditivas.map((a) => a.monto));
          const montoContractualVigente = montoContrato + aditivasAutorizadas;
          const pagadoHistorico = pagadoPorParticipacion.get(bp.id) ?? 0;
          // Solo un corte vigente (no anulado) tiene recibo que descargar o generar.
          const corte = movimiento?.corte?.estatus === "GENERADO" ? movimiento.corte : null;
          const recibo = corte?.recibos[0] ?? null;

          contratistas.push({
            id: bp.id,
            movimientoId,
            origen,
            nombre: bp.beneficiario.nombre,
            concepto: bp.concepto,
            conceptos: conceptosPorBeneficiario.get(bp.id) ?? [],
            corteId: corte?.id ?? null,
            reciboId: recibo?.id ?? null,
            reciboFirmado: Boolean(recibo?.archivoEvidenciaRef),
            montoContrato,
            aditivasAutorizadas,
            montoContractualVigente,
            pagadoHistorico,
            saldo: montoContractualVigente - pagadoHistorico,
            montoEntreSemana,
            montoFinSemana,
            estatusAprobacion,
            estatusPago,
            fechaPago,
            reposicion,
          });
        } else if (bp.beneficiario.tipo === "PROVEEDOR") {
          proveedores.push({
            id: bp.id,
            movimientoId,
            origen,
            nombre: bp.beneficiario.nombre,
            giro: bp.beneficiario.proveedor?.giro ?? null,
            montoEntreSemana,
            montoFinSemana,
            estatusAprobacion,
            estatusPago,
            fechaPago,
            reposicion,
          });
        } else {
          administracion.push({
            id: bp.id,
            movimientoId,
            origen,
            nombre: bp.beneficiario.nombre,
            puesto: bp.puesto,
            montoEntreSemana,
            montoFinSemana,
            estatusAprobacion,
            estatusPago,
            fechaPago,
            reposicion,
          });
        }
      }
    }

    const totalEntreSemana =
      sumaAprobadaPorGrupo(contratistas, "montoEntreSemana") +
      sumaAprobadaPorGrupo(proveedores, "montoEntreSemana") +
      sumaAprobadaPorGrupo(administracion, "montoEntreSemana");
    const totalFinSemana =
      sumaAprobadaPorGrupo(contratistas, "montoFinSemana") +
      sumaAprobadaPorGrupo(proveedores, "montoFinSemana") +
      sumaAprobadaPorGrupo(administracion, "montoFinSemana");
    const pendienteSemana =
      sumaPendientePorGrupo(contratistas) +
      sumaPendientePorGrupo(proveedores) +
      sumaPendientePorGrupo(administracion);

    return {
      proyecto: {
        id: proyecto.id,
        nombre: proyecto.nombre,
        tipo: proyecto.tipo,
        estatus: proyecto.estatus,
      },
      contratistas,
      proveedores,
      administracion,
      totalEntreSemana,
      totalFinSemana,
      totalSemana: totalEntreSemana + totalFinSemana,
      pendienteSemana,
    };
  });
}

function resumirReposicion(
  movimiento: {
    origen: OrigenMovimientoSemanal;
    estatusPago: EstatusPago;
    reposicionGastos: {
      cerrada: boolean;
      gastos: { monto: unknown }[];
      abonos: { monto: unknown }[];
    } | null;
  } | null,
  montoMovimiento: number
): ResumenReposicionFila | null {
  if (!movimiento || movimiento.origen !== "REPOSICION_GASTOS" || !movimiento.reposicionGastos) return null;
  const r = movimiento.reposicionGastos;
  const total = r.gastos.reduce((t: number, g) => t + Number(g.monto), 0);
  const abonado = r.abonos.reduce((t: number, a) => t + Number(a.monto), 0);
  const { estado, saldoPendiente } = estadoDeReposicion({
    total,
    abonado,
    cerrada: r.cerrada,
    estatusPago: movimiento.estatusPago,
    montoMovimiento,
  });
  return { total, abonado, saldoPendiente, estado, requiereRevision: estado === "REQUIERE_REVISION" };
}

// Solo los movimientos ya Aprobados cuentan en los totales oficiales
// (docs/negocio/03-modulo-reporte-general.md, sección 2.6).
function sumaAprobadaPorGrupo<
  T extends {
    montoEntreSemana: number;
    montoFinSemana: number;
    estatusAprobacion: EstatusAprobacion | null;
  }
>(filas: T[], campo: "montoEntreSemana" | "montoFinSemana"): number {
  return filas
    .filter((f) => f.estatusAprobacion === "APROBADO")
    .reduce((total, f) => total + f[campo], 0);
}

// Dinero aprobado que todavía no se paga (estatusPago = PENDIENTE_PAGO). No
// incluye lo cubierto por fondo puente, que ya se considera pagado al
// beneficiario aunque la empresa deba reponer el fondo.
function sumaPendientePorGrupo<
  T extends {
    montoEntreSemana: number;
    montoFinSemana: number;
    estatusAprobacion: EstatusAprobacion | null;
    estatusPago: EstatusPago | null;
  }
>(filas: T[]): number {
  return filas
    .filter(
      (f) => f.estatusAprobacion === "APROBADO" && f.estatusPago === "PENDIENTE_PAGO"
    )
    .reduce((total, f) => total + f.montoEntreSemana + f.montoFinSemana, 0);
}

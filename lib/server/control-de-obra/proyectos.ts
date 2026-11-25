import "server-only";
import { cache } from "react";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { registrarAuditoria } from "@/lib/server/auditoria";
import {
  puedeAdministrarProyectos,
  puedeEliminarProyectos,
  puedeVerContratoGeneralPrivado,
} from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { filtroObrasVisibles } from "./obras-visibles";
import type { EstatusProyecto } from "@/lib/generated/prisma/enums";

export class SinPermisoError extends Error {
  constructor() {
    super("No tienes permiso para administrar proyectos.");
    this.name = "SinPermisoError";
  }
}

export class ProyectoNoEncontradoError extends Error {
  constructor() {
    super("El proyecto no existe o no pertenece a tu empresa.");
    this.name = "ProyectoNoEncontradoError";
  }
}

export class ValidacionError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ValidacionError";
  }
}

const DatosProyectoSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio."),
  tipo: z.enum(["FORMAL", "MOMENTANEA", "OFICINA"]).default("FORMAL"),
  cliente: z.string().trim().optional().nullable(),
  ubicacion: z.string().trim().optional().nullable(),
  numeroContrato: z.string().trim().optional().nullable(),
  descripcion: z.string().trim().optional().nullable(),
  notas: z.string().trim().optional().nullable(),
  fechaInicio: z.coerce.date().optional().nullable(),
  fechaEstimadaTermino: z.coerce.date().optional().nullable(),
  // Contrato General (sección 49.9) — independiente de `tipo`. null = sin
  // definir todavía, nunca se infiere.
  esquemaContractual: z.enum(["PRECIO_ALZADO", "ADMINISTRACION"]).optional().nullable(),
  porcentajeUtilidadDefault: z.coerce.number().nonnegative().optional().nullable(),
  porcentajeAdministracionDefault: z.coerce.number().nonnegative().optional().nullable(),
  // Override privado del anterior — ver comentario en schema.prisma.
  porcentajeAdministracionPrivadoDefault: z.coerce.number().nonnegative().optional().nullable(),
  // Imagen de portada (Inicio: dashboard ejecutivo, agosto 2026) — ausente
  // (undefined) = no se tocó, deja el valor actual intacto; el server action
  // solo los incluye aquí cuando de verdad se subió un archivo nuevo (nunca
  // se manda como string vacío/null "por si acaso", eso borraría la imagen
  // en cualquier guardado normal del formulario).
  imagenRef: z.string().trim().optional(),
  imagenNombre: z.string().trim().optional(),
  // Supervisor responsable del proyecto (Contratistas: Control Contractual +
  // Estimaciones, septiembre 2026) — opcional, nunca obligatorio. String
  // vacía = quitar la asignación actual (se normaliza a null antes del
  // update, ver editarProyecto).
  supervisorUsuarioId: z.string().trim().optional().nullable(),
});

export type DatosProyecto = z.infer<typeof DatosProyectoSchema>;

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

function requerirAdmin(usuario: UsuarioSesion): string {
  if (!puedeAdministrarProyectos(usuario)) throw new SinPermisoError();
  return requerirEmpresa(usuario);
}

function requerirEliminar(usuario: UsuarioSesion): string {
  if (!puedeEliminarProyectos(usuario)) throw new SinPermisoError();
  return requerirEmpresa(usuario);
}

// %Utilidad/%Administración por default son información privada (misma
// puerta que Contrato General Privado/Cliente Priv.) — se ignoran del lado
// servidor si llegan en el payload sin el permiso, sin rechazar el resto de
// la edición; nunca se confía en que el formulario los haya ocultado
// (defensa en profundidad, corrección de sesión agosto 2026).
function podarPorcentajesPrivados(
  usuario: UsuarioSesion,
  datos: DatosProyecto
): DatosProyecto {
  if (puedeVerContratoGeneralPrivado(usuario)) return datos;
  // porcentajeAdministracionDefault NO se poda — lo usa también el motor
  // operativo (Cliente normal) y el cliente sí puede verlo (a diferencia de
  // %Utilidad de Precio Alzado, que sí es margen oculto, y del override
  // %Administración privado, que sí es exclusivo de Cliente Priv.). Gastos
  // cobrables en Estimación Cliente, agosto 2026.
  return {
    ...datos,
    porcentajeUtilidadDefault: undefined,
    porcentajeAdministracionPrivadoDefault: undefined,
  };
}

// Usuarios activos con rol Supervisor de la empresa — alimenta el selector
// "Supervisor responsable" de Editar Proyecto. Nunca se confía en que el
// formulario haya limitado las opciones: editarProyecto vuelve a validar
// server-side que el id elegido de verdad sea uno de estos.
export async function listarSupervisoresDisponibles(
  usuario: UsuarioSesion
): Promise<{ id: string; nombre: string }[]> {
  const empresaId = requerirEmpresa(usuario);
  return db.usuario.findMany({
    where: { empresaId, activo: true, rol: "SUPERVISOR" },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
}

async function validarSupervisorUsuarioId(
  empresaId: string,
  supervisorUsuarioId: string | null | undefined
): Promise<void> {
  if (!supervisorUsuarioId) return;
  const usuario = await db.usuario.findFirst({
    where: { id: supervisorUsuarioId, empresaId, activo: true, rol: "SUPERVISOR" },
    select: { id: true },
  });
  if (!usuario) throw new ValidacionError("El supervisor seleccionado no es válido.");
}

// Excluye el Proyecto(tipo=OFICINA) — es el vehículo interno de "Gastos de
// Empresa" (ver lib/server/control-de-obra/proyecto-oficina.ts), nunca una
// obra real: no debe aparecer en la lista de Proyectos, ni contarse en
// métricas de obras (Gastos transversal, septiembre 2026).
export async function listarProyectos(usuario: UsuarioSesion) {
  const empresaId = requerirEmpresa(usuario);
  return db.proyecto.findMany({
    where: { AND: [{ empresaId, tipo: { not: "OFICINA" } }, filtroObrasVisibles(usuario)] },
    orderBy: { nombre: "asc" },
  });
}

// Un Supervisor sin acceso a la obra recibe "no existe", igual que una ajena.
// cache() evita repetir esta consulta cuando layout.tsx y page.tsx la piden
// ambos dentro del mismo request (mismo patrón que verifySession en dal.ts).
export const obtenerProyecto = cache(async (usuario: UsuarioSesion, id: string) => {
  const empresaId = requerirEmpresa(usuario);
  const proyecto = await db.proyecto.findFirst({ where: { id, empresaId, ...filtroObrasVisibles(usuario) } });
  if (!proyecto) throw new ProyectoNoEncontradoError();
  return proyecto;
});

// Un proyecto se considera "ya iniciado contractualmente" si existe cualquiera
// de estas dependencias (sección E de la propuesta de rediseño, agosto 2026).
// No incluye BeneficiarioProyecto.montoContrato/concepto (texto libre de
// Reporte General, anterior a esquemaContractual y no depende de su modelo de
// costos). Tampoco incluye todavía estimaciones/movimientos financieros
// ligados a esquema porque esa entidad no existe aún — cuando se construya,
// este checklist debe extenderse.
export async function proyectoTieneInformacionContractual(
  proyectoId: string
): Promise<boolean> {
  const [partida, concepto, contrato, asignacion, avance] = await Promise.all([
    db.partida.findFirst({ where: { proyectoId }, select: { id: true } }),
    db.concepto.findFirst({ where: { partida: { proyectoId } }, select: { id: true } }),
    db.contratoContratista.findFirst({
      where: { beneficiarioProyecto: { proyectoId } },
      select: { id: true },
    }),
    db.contratoConcepto.findFirst({
      where: { concepto: { partida: { proyectoId } } },
      select: { id: true },
    }),
    db.avanceConcepto.findFirst({
      where: { concepto: { partida: { proyectoId } } },
      select: { id: true },
    }),
  ]);
  return Boolean(partida || concepto || contrato || asignacion || avance);
}

export async function crearProyecto(usuario: UsuarioSesion, datosCrudos: unknown) {
  const empresaId = requerirAdmin(usuario);
  const datos = podarPorcentajesPrivados(usuario, DatosProyectoSchema.parse(datosCrudos));

  // Obra formal nueva: el esquema contractual es obligatorio desde el inicio
  // (sección 3 del rediseño). No se aplica en editarProyecto — ahí debe seguir
  // siendo posible editar cualquier otro campo de un proyecto existente que
  // todavía no tiene esquema definido, sin que eso bloquee el guardado.
  if (datos.tipo === "FORMAL" && !datos.esquemaContractual) {
    throw new ValidacionError(
      "Selecciona el esquema contractual (Precio alzado o Administración) para una obra formal."
    );
  }

  const proyecto = await db.proyecto.create({
    data: { ...datos, empresaId },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Proyecto",
    entidadId: proyecto.id,
    accion: "CREAR",
    valorNuevo: proyecto,
  });

  return proyecto;
}

export async function editarProyecto(
  usuario: UsuarioSesion,
  id: string,
  datosCrudos: unknown,
  // Solo relevante para la asignación inicial de esquema (null -> valor) en un
  // proyecto que ya tiene información contractual — el usuario debe confirmar
  // a propósito que la selección es correcta, porque después queda fija
  // (sección 3 del rediseño). Se valida aquí, no solo en la UI.
  confirmarEsquemaConDatos = false
) {
  const empresaId = requerirAdmin(usuario);
  const datos = podarPorcentajesPrivados(usuario, DatosProyectoSchema.parse(datosCrudos));
  await validarSupervisorUsuarioId(empresaId, datos.supervisorUsuarioId);

  const anterior = await db.proyecto.findFirst({ where: { id, empresaId } });
  if (!anterior) throw new ProyectoNoEncontradoError();

  if (datos.esquemaContractual !== anterior.esquemaContractual) {
    // Asignación inicial (null -> un esquema): siempre permitida, incluso con
    // información contractual ya existente (ej. Mississippi, Proyecto Prueba
    // 1) — pero si ya hay información contractual, exige confirmación
    // explícita porque a partir de ahí queda bloqueada (sección E).
    // Cambio posterior (un esquema -> otro, o un esquema -> null): bloqueado
    // sin excepción en cuanto exista cualquier dependencia contractual — no
    // hay forma de "confirmar" para saltárselo (sección 4, excepción futura
    // no implementada todavía).
    const esAsignacionInicial = anterior.esquemaContractual === null;
    const tieneInfo = await proyectoTieneInformacionContractual(id);

    if (!esAsignacionInicial && tieneInfo) {
      throw new ValidacionError(
        "El esquema contractual no puede modificarse porque el proyecto ya tiene información contractual registrada."
      );
    }
    if (esAsignacionInicial && tieneInfo && !confirmarEsquemaConDatos) {
      throw new ValidacionError(
        "Este proyecto ya contiene información contractual. Confirma para definir el esquema contractual."
      );
    }
  }

  const proyecto = await db.proyecto.update({
    where: { id },
    data: datos,
  });
  // El responsable nuevo de la obra debe poder verla.
  if (datos.supervisorUsuarioId && datos.supervisorUsuarioId !== anterior.supervisorUsuarioId) {
    await db.accesoObra.createMany({
      data: [{ usuarioId: datos.supervisorUsuarioId, proyectoId: id }],
      skipDuplicates: true,
    });
  }

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Proyecto",
    entidadId: proyecto.id,
    accion: "EDITAR",
    valorAnterior: anterior,
    valorNuevo: proyecto,
  });

  return proyecto;
}

const ESTATUS_VALIDOS: EstatusProyecto[] = [
  "ACTIVO",
  "PAUSADO",
  "CERRADO",
  "CANCELADO",
];

export async function cambiarEstatusProyecto(
  usuario: UsuarioSesion,
  id: string,
  nuevoEstatus: string
) {
  const empresaId = requerirAdmin(usuario);
  if (!ESTATUS_VALIDOS.includes(nuevoEstatus as EstatusProyecto)) {
    throw new ValidacionError(`Estatus inválido: ${nuevoEstatus}`);
  }
  const estatus = nuevoEstatus as EstatusProyecto;

  const anterior = await db.proyecto.findFirst({ where: { id, empresaId } });
  if (!anterior) throw new ProyectoNoEncontradoError();

  // Al cerrar por primera vez se registra la fecha real de cierre — no se
  // sobreescribe si ya existía (ej. se reabrió y se vuelve a cerrar).
  const fechaCierre =
    estatus === "CERRADO" && !anterior.fechaCierre ? new Date() : undefined;

  const proyecto = await db.proyecto.update({
    where: { id },
    data: { estatus, ...(fechaCierre ? { fechaCierre } : {}) },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Proyecto",
    entidadId: proyecto.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: anterior.estatus },
    valorNuevo: { estatus: proyecto.estatus },
  });

  return proyecto;
}

// Borrado en cascada, irreversible: además del proyecto, elimina todo lo que
// cuelga de él (partidas, conceptos, participaciones de beneficiarios,
// contratos de contratista, asignaciones, avances y pagos semanales) —
// decisión explícita de sesión, agosto 2026: a diferencia de Cancelar (que
// conserva el proyecto como historial), Eliminar lo borra por completo. La
// bitácora de cada entidad borrada se borra con ella (ya no tiene sujeto),
// pero la bitácora del propio Proyecto se conserva y se le agrega un último
// registro ELIMINAR — sigue existiendo un rastro de quién eliminó qué
// proyecto y cuándo, aunque su contenido operativo ya no esté (regla del
// proyecto: mantener trazabilidad de operaciones importantes).
// Borra un Proyecto y TODO lo que le pertenece exclusivamente a él (avance,
// contratos, cortes, recibos, estimaciones al cliente, gastos de obra,
// reposiciones, órdenes de compra) — nunca datos compartidos entre proyectos:
// Beneficiario/Proveedor/PersonalAdministrativo (catálogo de empresa, ver
// lib/server/catalogos.ts) y Semana (ciclo semanal de toda la compañía)
// sobreviven siempre, aunque queden sin participación en ningún proyecto.
export async function eliminarProyecto(usuario: UsuarioSesion, id: string) {
  const empresaId = requerirEliminar(usuario);

  // Timeout explícito y generoso: son ~20 deleteMany secuenciales, y el
  // default de Prisma (5s) no alcanza para un proyecto con historial real
  // (avance, cortes, gastos, estimaciones).
  await db.$transaction(async (tx) => {
    const proyecto = await tx.proyecto.findFirst({ where: { id, empresaId } });
    if (!proyecto) throw new ProyectoNoEncontradoError();

    const partidas = await tx.partida.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const partidaIds = partidas.map((p) => p.id);

    const conceptos = await tx.concepto.findMany({
      where: { partidaId: { in: partidaIds } },
      select: { id: true },
    });
    const conceptoIds = conceptos.map((c) => c.id);

    const beneficiarioProyectos = await tx.beneficiarioProyecto.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const beneficiarioProyectoIds = beneficiarioProyectos.map((b) => b.id);

    const contratos = await tx.contratoContratista.findMany({
      where: { beneficiarioProyectoId: { in: beneficiarioProyectoIds } },
      select: { id: true },
    });
    const contratoIds = contratos.map((c) => c.id);

    const asignaciones = await tx.contratoConcepto.findMany({
      where: { conceptoId: { in: conceptoIds } },
      select: { id: true },
    });
    const asignacionIds = asignaciones.map((a) => a.id);

    const cortes = await tx.corteSemanal.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const corteIds = cortes.map((c) => c.id);

    const estimaciones = await tx.estimacionCliente.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const estimacionIds = estimaciones.map((e) => e.id);

    const gastos = await tx.gastoObra.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const gastoIds = gastos.map((g) => g.id);

    // Arquitectura por capas (agosto 2026) — Cliente/Cliente Priv. son
    // documentos financieros independientes, cada uno con su propia fila
    // EstimacionClienteCapa (y su propio detalle/gastos congelados). Se
    // recolectan aquí para poder borrarlos antes que EstimacionCliente
    // (EstimacionClienteCapa.estimacionClienteId es RESTRICT, no CASCADE).
    const capas = await tx.estimacionClienteCapa.findMany({
      where: { estimacionClienteId: { in: estimacionIds } },
      select: { id: true },
    });
    const capaIds = capas.map((c) => c.id);
    const movimientos = await tx.movimientoFinancieroCliente.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const movimientoIds = movimientos.map((m) => m.id);

    const reposiciones = await tx.reposicionGastos.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const reposicionIds = reposiciones.map((r) => r.id);

    const ordenes = await tx.ordenCompra.findMany({
      where: { proyectoId: id },
      select: { id: true },
    });
    const ordenIds = ordenes.map((o) => o.id);

    // Compras (Requisición/Cotización/OC) y decoración fiscal (Egreso/
    // Ingreso), septiembre 2026 — no existían cuando esta función se
    // escribió originalmente; RESTRICT hacia Proyecto/GastoObra/
    // MovimientoFinancieroCliente, deben liberarse antes que esos tres.
    const requisiciones = await tx.requisicion.findMany({ where: { proyectoId: id }, select: { id: true } });
    const requisicionIds = requisiciones.map((r) => r.id);
    const reposicionesPrevias = await tx.reposicionGastos.findMany({ where: { proyectoId: id }, select: { id: true } });
    const reposicionIdsPrevias = reposicionesPrevias.map((r) => r.id);

    // Hijos antes que padres, respetando las llaves foráneas.
    // ComentarioMovimiento tiene onDelete: Cascade desde MovimientoSemanal a
    // nivel de base de datos — no hace falta borrarlo aparte. Igual
    // Proveedor/Contratista/PersonalAdministrativo desde Beneficiario, pero
    // Beneficiario nunca se toca aquí (es del catálogo de la Empresa, no de
    // este Proyecto).
    await tx.cotizacion.deleteMany({ where: { requisicionId: { in: requisicionIds } } });
    await tx.requisicion.deleteMany({ where: { proyectoId: id } });
    await tx.abonoReposicion.deleteMany({ where: { reposicionGastosId: { in: reposicionIdsPrevias } } });
    await tx.egreso.deleteMany({ where: { OR: [{ gastoObraId: { in: gastoIds } }, { proyectoId: id }] } });
    await tx.ingreso.deleteMany({ where: { OR: [{ movimientoFinancieroClienteId: { in: movimientoIds } }, { proyectoId: id }] } });
    await tx.corteSemanalConcepto.deleteMany({ where: { corteSemanalId: { in: corteIds } } });
    await tx.reciboPago.deleteMany({ where: { corteSemanalId: { in: corteIds } } });

    // Snapshot congelado por capa (EstimacionClienteCapaConcepto/
    // EstimacionClienteGasto) — RESTRICT hacia EstimacionClienteCapa/
    // EstimacionCliente y GastoObra respectivamente, así que deben
    // liberarse antes que esos tres (arquitectura por capas, agosto 2026).
    await tx.estimacionClienteCapaConcepto.deleteMany({
      where: { estimacionClienteCapaId: { in: capaIds } },
    });
    await tx.estimacionClienteGastoDetalle.deleteMany({
      where: { estimacionClienteGasto: { estimacionClienteId: { in: estimacionIds } } },
    });
    await tx.estimacionClienteGasto.deleteMany({
      where: { estimacionClienteId: { in: estimacionIds } },
    });
    await tx.estimacionClienteCapa.deleteMany({
      where: { id: { in: capaIds } },
    });
    await tx.estimacionClienteConcepto.deleteMany({
      where: { estimacionClienteId: { in: estimacionIds } },
    });
    await tx.ordenCompraConcepto.deleteMany({ where: { ordenCompraId: { in: ordenIds } } });
    await tx.movimientoFinancieroCliente.deleteMany({ where: { proyectoId: id } });
    // Detalle multilínea de gasto (GastoObraDetalle) — RESTRICT hacia
    // GastoObra, debe liberarse antes (captura multilínea de gastos, agosto
    // 2026). Gasto antes que Reposición/OC — un gasto puede referenciar
    // cualquiera de las dos (pagadorBeneficiarioId/proveedorBeneficiarioId
    // apuntan a Beneficiario, que nunca se toca; ordenCompraId/
    // reposicionGastosId sí apuntan aquí y deben liberarse primero).
    await tx.gastoObraDetalle.deleteMany({ where: { gastoObraId: { in: gastoIds } } });
    await tx.gastoObra.deleteMany({ where: { proyectoId: id } });
    // GastoObra.recurrenteId apunta aquí — debe liberarse después del gasto,
    // nunca antes (Gastos transversal — recurrentes, septiembre 2026).
    await tx.gastoRecurrente.deleteMany({ where: { proyectoId: id } });
    await tx.reposicionGastos.deleteMany({ where: { proyectoId: id } });
    await tx.ordenCompra.deleteMany({ where: { proyectoId: id } });
    await tx.corteSemanal.deleteMany({ where: { proyectoId: id } });
    await tx.movimientoSemanal.deleteMany({
      where: { beneficiarioProyectoId: { in: beneficiarioProyectoIds } },
    });
    await tx.estimacionCliente.deleteMany({ where: { proyectoId: id } });
    await tx.cierreSemanaProyecto.deleteMany({ where: { proyectoId: id } });
    await tx.avanceConcepto.deleteMany({ where: { conceptoId: { in: conceptoIds } } });
    await tx.contratoConcepto.deleteMany({ where: { conceptoId: { in: conceptoIds } } });
    await tx.aditiva.deleteMany({
      where: { beneficiarioProyectoId: { in: beneficiarioProyectoIds } },
    });
    await tx.contratoContratista.deleteMany({
      where: { beneficiarioProyectoId: { in: beneficiarioProyectoIds } },
    });
    await tx.concepto.deleteMany({ where: { partidaId: { in: partidaIds } } });
    await tx.partida.deleteMany({ where: { proyectoId: id } });
    await tx.beneficiarioProyecto.deleteMany({ where: { proyectoId: id } });

    await tx.registroAuditoria.deleteMany({
      where: {
        OR: [
          { entidad: "Partida", entidadId: { in: partidaIds } },
          { entidad: { in: ["Concepto", "ConceptoPrivado"] }, entidadId: { in: conceptoIds } },
          { entidad: "ContratoContratista", entidadId: { in: contratoIds } },
          { entidad: "ContratoConcepto", entidadId: { in: asignacionIds } },
          { entidad: "EstimacionCliente", entidadId: { in: estimacionIds } },
          { entidad: "EstimacionClienteCapa", entidadId: { in: capaIds } },
          { entidad: "MovimientoFinancieroCliente", entidadId: { in: movimientoIds } },
          { entidad: "GastoObra", entidadId: { in: gastoIds } },
          { entidad: "ReposicionGastos", entidadId: { in: reposicionIds } },
          { entidad: "OrdenCompra", entidadId: { in: ordenIds } },
          { entidad: "Requisicion", entidadId: { in: requisicionIds } },
        ],
      },
    });

    await tx.proyecto.delete({ where: { id } });

    await tx.registroAuditoria.create({
      data: {
        empresaId,
        usuarioId: usuario.id,
        entidad: "Proyecto",
        entidadId: id,
        accion: "ELIMINAR",
        valorAnterior: JSON.parse(JSON.stringify(proyecto)),
      },
    });
  }, { timeout: 30_000 });
}

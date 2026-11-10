import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import {
  puedeCapturarGastos,
  puedeAprobarGastos,
  puedeCapturarCategoriaGasto,
  puedeVerGastosEmpresaSensibles,
} from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { CATEGORIAS_GASTO, CATEGORIA_GASTO_SENSIBLE } from "@/lib/control-de-obra/categorias-gasto";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";
import { asignarGastoAReposicionTx } from "./reposiciones";
import { intentarReclamarGastoParaCapas } from "./estimacion-cliente";
import { EMPRESA_PROYECTO_LABEL } from "./proyecto-oficina";

function requerirEmpresa(usuario: UsuarioSesion): string {
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// Segundo gate, por categoría — se valida SIEMPRE server-side, nunca basta
// con que el <select> del formulario ya filtre las opciones sensibles
// (Gastos transversal, septiembre 2026).
function requerirPermisoCategoria(usuario: UsuarioSesion, categoria: string): void {
  const esSensible = CATEGORIA_GASTO_SENSIBLE[categoria as keyof typeof CATEGORIA_GASTO_SENSIBLE] ?? false;
  if (!puedeCapturarCategoriaGasto(usuario, esSensible)) throw new SinPermisoError();
}

// Editable mientras no haya salido de la revisión inicial — igual que el
// resto del sistema, "aprobado" es un punto sin retorno para el monto.
const ESTATUS_EDITABLES = ["BORRADOR", "PENDIENTE_REVISION"] as const;

export type EstatusFiscalGasto = "NO_APLICA" | "PENDIENTE_FACTURA" | "FACTURADO";

// No es columna — se deriva de requiereFactura + facturaRef (sección 24 del
// diseño de Gastos de Obra, agosto 2026).
export function calcularEstatusFiscal(g: {
  requiereFactura: boolean;
  facturaRef: string | null;
}): EstatusFiscalGasto {
  if (!g.requiereFactura) return "NO_APLICA";
  return g.facturaRef ? "FACTURADO" : "PENDIENTE_FACTURA";
}

// Detalle multilínea opcional — mismo patrón que LineaSchema de
// ordenes-compra.ts, sin el campo `concepto` (un gasto no lo necesita, solo
// descripción/unidad/cantidad/P.U.). Captura multilínea de gastos, agosto 2026.
const LineaGastoSchema = z.object({
  descripcion: z.string().trim().min(1, "La descripción de la línea es obligatoria."),
  unidad: z.string().trim().min(1, "La unidad es obligatoria."),
  cantidad: z.coerce.number().positive("La cantidad debe ser mayor a cero."),
  precioUnitario: z.coerce.number().nonnegative(),
});

function totalDetalleGasto(detalle: { cantidad: number; precioUnitario: number }[]): number {
  return detalle.reduce((t, l) => t + l.cantidad * l.precioUnitario, 0);
}

// El formulario ya no pide una "Descripción" aparte — cada gasto se captura
// siempre por líneas (mínimo una), y GastoObra.descripcion se deriva
// uniendo la descripción de cada línea (ej. "Cemento, Varilla"). Sigue
// siendo opcional aquí por compatibilidad con cualquier otro llamador que sí
// mande una descripción explícita sin detalle (captura multilínea de
// gastos, agosto 2026).
function descripcionDesdeDetalle(detalle: { descripcion: string }[]): string {
  return detalle.map((l) => l.descripcion).join(", ");
}

const DatosGastoSchema = z.object({
  fecha: z.coerce.date(),
  descripcion: z.string().trim().optional().nullable(),
  categoria: z.enum(CATEGORIAS_GASTO),
  // Cuando `detalle` trae líneas, este monto se ignora — el servidor lo
  // recalcula siempre como la suma de las líneas (nunca confía en el total
  // que mande el cliente). Sin detalle, sigue siendo el input directo de
  // siempre (captura simple, ej. "Gasolina — $850").
  monto: z.coerce.number().positive("El monto debe ser mayor a cero."),
  metodoPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO"]),
  // "YO" nunca confía en pagadorBeneficiarioId del cliente — se resuelve
  // server-side contra el Usuario de la sesión (ver resolverPagadorBeneficiarioId).
  // "OTRO" sí usa pagadorBeneficiarioId (quien captura no necesariamente
  // pagó). "EMPRESA" = sin reposición para nadie.
  // Obligatorio y sin valor por omisión (octubre 2026): antes, un valor
  // ausente se interpretaba como "OTRO" sin beneficiario — es decir, "pagó la
  // Empresa" — y una reposición podía perderse en silencio. El formulario de
  // Gastos siempre lo envía, así que su comportamiento no cambia.
  quienPagoModo: z.enum(["YO", "OTRO", "EMPRESA"], { error: "Indica quién pagó el gasto." }),
  pagadorBeneficiarioId: z.string().trim().optional().nullable(),
  proveedorBeneficiarioId: z.string().trim().optional().nullable(),
  comentario: z.string().trim().optional().nullable(),
  requiereFactura: z.coerce.boolean().default(false),
  tratamientoCliente: z
    .enum(["INCLUIDO_EN_CONTRATO", "COBRABLE_EN_ESTIMACION", "NO_COBRABLE"])
    .default("NO_COBRABLE"),
  ticketRef: z.string().trim().optional().nullable(),
  ticketNombre: z.string().trim().optional().nullable(),
  detalle: z.array(LineaGastoSchema).optional(),
});

export type DatosGasto = z.infer<typeof DatosGastoSchema>;

// Resuelve a quién reponerle sin confiar en el cliente para el caso "YO" —
// el beneficiario vinculado al usuario en sesión se consulta aquí mismo,
// nunca se toma de un id que venga en el FormData (decisión de sesión,
// agosto 2026: la semántica "yo pagué" no puede depender de un valor que el
// cliente podría manipular).
async function resolverPagadorBeneficiarioId(
  usuario: UsuarioSesion,
  empresaId: string,
  datos: Pick<DatosGasto, "quienPagoModo" | "pagadorBeneficiarioId">
): Promise<string | null> {
  if (datos.quienPagoModo === "EMPRESA") return null;

  if (datos.quienPagoModo === "YO") {
    const usuarioConBeneficiario = await db.usuario.findFirst({
      where: { id: usuario.id, empresaId },
      select: { beneficiario: { select: { id: true } } },
    });
    if (!usuarioConBeneficiario?.beneficiario) {
      throw new ValidacionError(
        "Este usuario no tiene un beneficiario de pago relacionado. Configúralo antes de generar la reposición."
      );
    }
    return usuarioConBeneficiario.beneficiario.id;
  }

  // "OTRO"
  if (!datos.pagadorBeneficiarioId) return null;
  const beneficiario = await db.beneficiario.findFirst({
    where: { id: datos.pagadorBeneficiarioId, empresaId },
  });
  if (!beneficiario) throw new RegistroNoEncontradoError("El beneficiario seleccionado");
  return beneficiario.id;
}

// Validaciones y datos derivados de TODA creación de un gasto (permisos,
// obra, categoría, semana, monto y descripción) — una sola fuente para
// crearGasto y para la confirmación de documentos de Captura Inteligente
// (Fase 0 WhatsApp + ARQENTO IA, octubre 2026). No resuelve el pagador: cada
// llamador lo resuelve server-side con su propia regla.
async function prepararGasto(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  datosCrudos: unknown,
  cliente: Prisma.TransactionClient = db
) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosGastoSchema.parse(datosCrudos);
  requerirPermisoCategoria(usuario, datos.categoria);
  const semana = await cliente.semana.findFirst({ where: { id: semanaId, empresaId } });
  if (!semana) throw new RegistroNoEncontradoError("La semana");
  const tieneDetalle = (datos.detalle?.length ?? 0) > 0;
  const monto = tieneDetalle ? totalDetalleGasto(datos.detalle!) : datos.monto;
  const descripcion = datos.descripcion || (tieneDetalle ? descripcionDesdeDetalle(datos.detalle!) : "");
  if (!descripcion) throw new ValidacionError("La descripción es obligatoria.");
  return { empresaId, datos, tieneDetalle, monto, descripcion };
}

// Nace siempre PENDIENTE_REVISION, sin importar el rol que captura — misma
// consistencia que AvanceConcepto: aprobar es siempre una acción explícita
// separada de capturar (decisión de sesión, agosto 2026). La auditoría va en
// la MISMA transacción que el gasto.
async function insertarGastoTx(
  tx: Prisma.TransactionClient,
  preparado: Awaited<ReturnType<typeof prepararGasto>>,
  ctx: {
    proyectoId: string;
    semanaId: string;
    pagadorBeneficiarioId: string | null;
    capturadoPorId: string;
    usuarioAuditoriaId: string;
    auditoriaAdicional?: Record<string, unknown>;
  }
) {
  const { empresaId, datos, tieneDetalle, monto, descripcion } = preparado;
  const creado = await tx.gastoObra.create({
    data: {
      empresaId,
      proyectoId: ctx.proyectoId,
      semanaId: ctx.semanaId,
      fecha: datos.fecha,
      descripcion,
      categoria: datos.categoria,
      monto,
      metodoPago: datos.metodoPago,
      pagadorBeneficiarioId: ctx.pagadorBeneficiarioId,
      proveedorBeneficiarioId: datos.proveedorBeneficiarioId || null,
      comentario: datos.comentario || null,
      requiereFactura: datos.requiereFactura,
      tratamientoCliente: datos.tratamientoCliente,
      ticketRef: datos.ticketRef || null,
      ticketNombre: datos.ticketNombre || null,
      capturadoPorId: ctx.capturadoPorId,
    },
  });
  if (tieneDetalle) {
    await tx.gastoObraDetalle.createMany({
      data: datos.detalle!.map((l, i) => ({
        gastoObraId: creado.id,
        descripcion: l.descripcion,
        unidad: l.unidad,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario,
        orden: i,
      })),
    });
  }
  await registrarAuditoriaTx(tx, {
    empresaId,
    usuarioId: ctx.usuarioAuditoriaId,
    entidad: "GastoObra",
    entidadId: creado.id,
    accion: "CREAR",
    valorNuevo: { descripcion: creado.descripcion, monto, categoria: creado.categoria, ...ctx.auditoriaAdicional },
  });
  return creado;
}

export async function crearGasto(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  datosCrudos: unknown
) {
  const preparado = await prepararGasto(usuario, proyectoId, semanaId, datosCrudos);
  const pagadorBeneficiarioId = await resolverPagadorBeneficiarioId(usuario, preparado.empresaId, preparado.datos);
  return db.$transaction((tx) =>
    insertarGastoTx(tx, preparado, {
      proyectoId,
      semanaId,
      pagadorBeneficiarioId,
      capturadoPorId: usuario.id,
      usuarioAuditoriaId: usuario.id,
    })
  );
}

// Creación de un gasto a partir de un documento de Captura Inteligente
// (Fase 0 WhatsApp + ARQENTO IA, octubre 2026) — dentro de la transacción
// del llamador, con las MISMAS validaciones que crearGasto sobre el usuario
// que confirma. Dos diferencias, ambas resueltas server-side por el
// llamador: el pagador ya viene resuelto (nunca del cliente) y el capturista
// es el REMITENTE original del documento; quien confirma queda en la
// auditoría y en el documento, y quien aprueba, al aprobar (aprobarGasto).
export async function crearGastoDesdeDocumentoTx(
  tx: Prisma.TransactionClient,
  usuario: UsuarioSesion,
  args: {
    proyectoId: string;
    semanaId: string;
    datosCrudos: unknown;
    pagadorBeneficiarioId: string | null;
    capturadoPorId: string;
    documentoEgresoId: string;
  }
) {
  const preparado = await prepararGasto(usuario, args.proyectoId, args.semanaId, args.datosCrudos, tx);
  return insertarGastoTx(tx, preparado, {
    proyectoId: args.proyectoId,
    semanaId: args.semanaId,
    pagadorBeneficiarioId: args.pagadorBeneficiarioId,
    capturadoPorId: args.capturadoPorId,
    usuarioAuditoriaId: usuario.id,
    auditoriaAdicional: {
      origen: "DOCUMENTO",
      documentoEgresoId: args.documentoEgresoId,
      capturadoPorId: args.capturadoPorId,
      pagadorBeneficiarioId: args.pagadorBeneficiarioId,
    },
  });
}

export async function editarGasto(usuario: UsuarioSesion, gastoId: string, datosCrudos: unknown) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosGastoSchema.parse(datosCrudos);

  const anterior = await db.gastoObra.findFirst({ where: { id: gastoId, empresaId } });
  if (!anterior) throw new RegistroNoEncontradoError("El gasto");
  // Se valida la categoría actual del gasto Y la nueva — nunca basta con
  // revisar solo a dónde se quiere mover si ya estaba en una categoría
  // sensible que este usuario ni siquiera debería tocar.
  requerirPermisoCategoria(usuario, anterior.categoria);
  requerirPermisoCategoria(usuario, datos.categoria);

  if (!ESTATUS_EDITABLES.includes(anterior.estatus as (typeof ESTATUS_EDITABLES)[number])) {
    throw new ValidacionError("Este gasto ya no se puede editar — su revisión ya avanzó.");
  }
  // Solo quien lo capturó puede editarlo, salvo Administrador/Director/Master
  // (mismo criterio que el resto del sistema: capturar no da acceso a editar
  // lo de alguien más, revisar sí).
  if (anterior.capturadoPorId !== usuario.id && !puedeAprobarGastos(usuario)) {
    throw new SinPermisoError();
  }

  const pagadorBeneficiarioId = await resolverPagadorBeneficiarioId(usuario, empresaId, datos);
  const tieneDetalle = (datos.detalle?.length ?? 0) > 0;
  const monto = tieneDetalle ? totalDetalleGasto(datos.detalle!) : datos.monto;
  const descripcion = datos.descripcion || (tieneDetalle ? descripcionDesdeDetalle(datos.detalle!) : "");
  if (!descripcion) throw new ValidacionError("La descripción es obligatoria.");

  const gasto = await db.$transaction(async (tx) => {
    const actualizado = await tx.gastoObra.update({
      where: { id: gastoId },
      data: {
        fecha: datos.fecha,
        descripcion,
        categoria: datos.categoria,
        monto,
        metodoPago: datos.metodoPago,
        pagadorBeneficiarioId,
        proveedorBeneficiarioId: datos.proveedorBeneficiarioId || null,
        comentario: datos.comentario || null,
        requiereFactura: datos.requiereFactura,
        tratamientoCliente: datos.tratamientoCliente,
        ticketRef: datos.ticketRef || anterior.ticketRef,
        ticketNombre: datos.ticketNombre || anterior.ticketNombre,
      },
    });

    // Detalle siempre se reemplaza entero (mismo patrón que
    // CorteSemanalConcepto al reconciliar un corte) — más simple y seguro
    // que diffear línea por línea, y un gasto editable (BORRADOR/
    // PENDIENTE_REVISION) nunca tiene todavía nada externo apuntando a una
    // línea específica de su detalle.
    await tx.gastoObraDetalle.deleteMany({ where: { gastoObraId: gastoId } });
    if (tieneDetalle) {
      await tx.gastoObraDetalle.createMany({
        data: datos.detalle!.map((l, i) => ({
          gastoObraId: gastoId,
          descripcion: l.descripcion,
          unidad: l.unidad,
          cantidad: l.cantidad,
          precioUnitario: l.precioUnitario,
          orden: i,
        })),
      });
    }

    return actualizado;
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "GastoObra",
    entidadId: gasto.id,
    accion: "EDITAR",
    valorAnterior: { descripcion: anterior.descripcion, monto: Number(anterior.monto) },
    valorNuevo: { descripcion: gasto.descripcion, monto: Number(gasto.monto) },
  });

  return gasto;
}

// Enviar a revisión — de BORRADOR a PENDIENTE_REVISION. En la práctica un
// gasto capturado por el formulario normal ya nace PENDIENTE_REVISION; este
// paso solo aplica a un BORRADOR guardado a medias.
export async function enviarGastoARevision(usuario: UsuarioSesion, gastoId: string) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const gasto = await db.gastoObra.findFirst({ where: { id: gastoId, empresaId } });
  if (!gasto) throw new RegistroNoEncontradoError("El gasto");
  if (gasto.capturadoPorId !== usuario.id && !puedeAprobarGastos(usuario)) {
    throw new SinPermisoError();
  }
  if (gasto.estatus !== "BORRADOR") return gasto;

  const actualizado = await db.gastoObra.update({
    where: { id: gastoId },
    data: { estatus: "PENDIENTE_REVISION" },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "GastoObra",
    entidadId: actualizado.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: "BORRADOR" },
    valorNuevo: { estatus: "PENDIENTE_REVISION" },
  });

  return actualizado;
}

// Única aprobación real de todo el flujo Gastos→Reposiciones — si el gasto
// fue pagado personalmente (pagadorBeneficiarioId no nulo), en la misma
// transacción se asigna a la reposición abierta de ese beneficiario en este
// proyecto+semana (o se crea una) y se crea/reconcilia su MovimientoSemanal.
// Nunca hace falta una segunda aprobación (colapso de doble aprobación
// Gastos→Reposiciones, agosto 2026). Bloqueo de fila sobre el propio gasto:
// un doble clic sobre uno ya APROBADO es un no-op idempotente, así que nunca
// se duplica el monto ni se crea una segunda reposición/movimiento.
export async function aprobarGasto(usuario: UsuarioSesion, gastoId: string) {
  if (!puedeAprobarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM gastos_obra WHERE id = ${gastoId} FOR UPDATE`;

    const gasto = await tx.gastoObra.findFirst({ where: { id: gastoId, empresaId } });
    if (!gasto) throw new RegistroNoEncontradoError("El gasto");
    if (gasto.estatus === "APROBADO") return gasto;
    if (gasto.estatus !== "PENDIENTE_REVISION") {
      throw new ValidacionError("Solo se puede aprobar un gasto pendiente de revisión.");
    }

    const actualizado = await tx.gastoObra.update({
      where: { id: gastoId },
      data: {
        estatus: "APROBADO",
        revisadoPorId: usuario.id,
        revisadoEn: new Date(),
        motivoRechazo: null,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "GastoObra",
      entidadId: actualizado.id,
      accion: "CONFIRMAR",
      valorAnterior: { estatus: "PENDIENTE_REVISION" },
      valorNuevo: { estatus: "APROBADO" },
    });

    // null = lo pagó la empresa directamente — no genera reposición para
    // nadie (mismo criterio ya usado en resolverPagadorBeneficiarioId). Esta
    // es la obligación INTERNA (Conkuali → quien pagó) — completamente
    // independiente del cobro al cliente de abajo (reposiciones ≠ cobro al
    // cliente, agosto 2026).
    if (gasto.pagadorBeneficiarioId) {
      await asignarGastoAReposicionTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        proyectoId: gasto.proyectoId,
        semanaId: gasto.semanaId,
        beneficiarioId: gasto.pagadorBeneficiarioId,
        gastoId: gasto.id,
      });
    }

    // Reclamo por capa — un gasto cobrable que se aprueba se reclama de
    // inmediato en cualquier capa (OPERATIVO/PRIVADO) que YA tenga una fila
    // EstimacionClienteCapa en BORRADOR elegible para su semana de origen
    // (regla cronológica en intentarReclamarGastoParaCapas,
    // estimacion-cliente.ts). Si ninguna capa elegible existe todavía
    // (su semana no ha cerrado, o esa capa nunca se generó), el gasto queda
    // sin reclamar — nunca se crea una capa por adelantado solo para tener
    // dónde ponerlo; se resuelve más tarde, en el próximo cierre de semana
    // que sí toque esa capa (arquitectura por capas, agosto 2026).
    if (gasto.tratamientoCliente === "COBRABLE_EN_ESTIMACION") {
      await intentarReclamarGastoParaCapas(tx, gasto.proyectoId, {
        id: gasto.id,
        semanaId: gasto.semanaId,
        incluidoEnCapaOperativoId: gasto.incluidoEnCapaOperativoId,
        incluidoEnCapaPrivadoId: gasto.incluidoEnCapaPrivadoId,
      });
    }

    return actualizado;
  });
}

const MotivoRechazoSchema = z.string().trim().min(1, "El motivo del rechazo es obligatorio.");

export async function rechazarGasto(usuario: UsuarioSesion, gastoId: string, motivoCrudo: unknown) {
  if (!puedeAprobarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const motivo = MotivoRechazoSchema.parse(motivoCrudo);

  const gasto = await db.gastoObra.findFirst({ where: { id: gastoId, empresaId } });
  if (!gasto) throw new RegistroNoEncontradoError("El gasto");
  if (gasto.estatus !== "PENDIENTE_REVISION") {
    throw new ValidacionError("Solo se puede rechazar un gasto pendiente de revisión.");
  }

  // Un gasto rechazado no se elimina — conserva quién, cuándo y por qué
  // (sección 9 del diseño de Gastos de Obra).
  const actualizado = await db.gastoObra.update({
    where: { id: gastoId },
    data: {
      estatus: "RECHAZADO",
      revisadoPorId: usuario.id,
      revisadoEn: new Date(),
      motivoRechazo: motivo,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "GastoObra",
    entidadId: actualizado.id,
    accion: "RECHAZAR",
    valorAnterior: { estatus: "PENDIENTE_REVISION" },
    valorNuevo: { estatus: "RECHAZADO", motivo },
  });

  return actualizado;
}

export async function registrarFacturaGasto(
  usuario: UsuarioSesion,
  gastoId: string,
  datos: { facturaRef: string; facturaNombre: string }
) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const gasto = await db.gastoObra.findFirst({ where: { id: gastoId, empresaId } });
  if (!gasto) throw new RegistroNoEncontradoError("El gasto");

  const actualizado = await db.gastoObra.update({
    where: { id: gastoId },
    data: { facturaRef: datos.facturaRef, facturaNombre: datos.facturaNombre },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "GastoObra",
    entidadId: actualizado.id,
    accion: "EDITAR",
    valorAnterior: { facturaRef: gasto.facturaRef },
    valorNuevo: { facturaRef: actualizado.facturaRef },
  });

  return actualizado;
}

// ---------------------------------------------------------------------------
// Lectura — listado de Gastos de un proyecto+semana, con lo necesario para
// el dashboard (sección 36) y para elegir qué incluir en una Reposición.
// ---------------------------------------------------------------------------

export type FilaGasto = {
  id: string;
  proyectoId: string;
  fecha: string;
  descripcion: string;
  categoria: string;
  monto: number;
  metodoPago: string;
  pagadorBeneficiarioId: string | null;
  pagadorNombre: string | null;
  proveedorBeneficiarioId: string | null;
  proveedorNombre: string | null;
  comentario: string | null;
  requiereFactura: boolean;
  estatusFiscal: EstatusFiscalGasto;
  tratamientoCliente: string;
  ticketRef: string | null;
  ticketNombre: string | null;
  facturaRef: string | null;
  facturaNombre: string | null;
  estatus: string;
  capturadoPorId: string;
  capturadoPorNombre: string;
  revisadoPorNombre: string | null;
  motivoRechazo: string | null;
  reposicionGastosId: string | null;
  ordenCompraId: string | null;
  detalle: { descripcion: string; unidad: string; cantidad: number; precioUnitario: number }[];
};

const SELECT_FILA_GASTO = {
  pagador: { select: { nombre: true } },
  proveedor: { select: { nombre: true } },
  capturadoPor: { select: { nombre: true } },
  revisadoPor: { select: { nombre: true } },
  detalle: { orderBy: { orden: "asc" as const } },
};

type GastoObraConRelaciones = Prisma.GastoObraGetPayload<{ include: typeof SELECT_FILA_GASTO }>;

function aFilaGasto(g: GastoObraConRelaciones): FilaGasto {
  return {
    id: g.id,
    proyectoId: g.proyectoId,
    fecha: g.fecha.toISOString(),
    descripcion: g.descripcion,
    categoria: g.categoria,
    monto: Number(g.monto),
    metodoPago: g.metodoPago,
    pagadorBeneficiarioId: g.pagadorBeneficiarioId,
    pagadorNombre: g.pagador?.nombre ?? null,
    proveedorBeneficiarioId: g.proveedorBeneficiarioId,
    proveedorNombre: g.proveedor?.nombre ?? null,
    comentario: g.comentario,
    requiereFactura: g.requiereFactura,
    estatusFiscal: calcularEstatusFiscal(g),
    tratamientoCliente: g.tratamientoCliente,
    ticketRef: g.ticketRef,
    ticketNombre: g.ticketNombre,
    facturaRef: g.facturaRef,
    facturaNombre: g.facturaNombre,
    estatus: g.estatus,
    capturadoPorId: g.capturadoPorId,
    capturadoPorNombre: g.capturadoPor.nombre,
    revisadoPorNombre: g.revisadoPor?.nombre ?? null,
    motivoRechazo: g.motivoRechazo,
    reposicionGastosId: g.reposicionGastosId,
    ordenCompraId: g.ordenCompraId,
    detalle: g.detalle.map((d) => ({
      descripcion: d.descripcion,
      unidad: d.unidad,
      cantidad: Number(d.cantidad),
      precioUnitario: Number(d.precioUnitario),
    })),
  };
}

// Categorías sensibles (solo existen en el ámbito Empresa — ver
// categorias-gasto.ts) se excluyen enteras de la lectura si el usuario no
// tiene puedeVerGastosEmpresaSensibles — nunca se manda el dato al cliente
// para que la UI decida ocultarlo (Gastos transversal, septiembre 2026).
// Exportada para que otros módulos (p. ej. avisos de posibles duplicados de
// Captura Inteligente) apliquen el MISMO filtro de categorías sensibles.
export function categoriasOcultasPara(usuario: UsuarioSesion): string[] {
  if (puedeVerGastosEmpresaSensibles(usuario)) return [];
  return (Object.keys(CATEGORIA_GASTO_SENSIBLE) as (keyof typeof CATEGORIA_GASTO_SENSIBLE)[]).filter(
    (c) => CATEGORIA_GASTO_SENSIBLE[c]
  );
}

export async function obtenerGastos(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string
): Promise<FilaGasto[]> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  await obtenerProyecto(usuario, proyectoId);

  const categoriasOcultas = categoriasOcultasPara(usuario);
  const gastos = await db.gastoObra.findMany({
    where: { proyectoId, semanaId, ...(categoriasOcultas.length > 0 && { categoria: { notIn: categoriasOcultas } }) },
    include: SELECT_FILA_GASTO,
    orderBy: { fecha: "desc" },
  });

  return gastos.map(aFilaGasto);
}

export type FilaGastoGlobal = FilaGasto & { proyectoNombre: string; esEmpresa: boolean };

// Vista global "Gastos" (fuera de una obra específica) — todos los gastos de
// la Empresa (obras reales + Empresa) para una semana, en una sola consulta.
// Mismo filtrado de categorías sensibles que obtenerGastos (Gastos
// transversal, septiembre 2026).
export async function obtenerGastosGlobal(
  usuario: UsuarioSesion,
  semanaId: string
): Promise<FilaGastoGlobal[]> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;

  const categoriasOcultas = categoriasOcultasPara(usuario);
  const gastos = await db.gastoObra.findMany({
    where: { empresaId, semanaId, ...(categoriasOcultas.length > 0 && { categoria: { notIn: categoriasOcultas } }) },
    include: { ...SELECT_FILA_GASTO, proyecto: { select: { nombre: true, tipo: true } } },
    orderBy: { fecha: "desc" },
  });

  return gastos.map((g) => ({
    ...aFilaGasto(g),
    proyectoNombre: g.proyecto.tipo === "OFICINA" ? EMPRESA_PROYECTO_LABEL : g.proyecto.nombre,
    esEmpresa: g.proyecto.tipo === "OFICINA",
  }));
}

// Referencia de almacenamiento (ticket o factura) de un Gasto puntual, para
// el endpoint de descarga autenticada — mismo gate que obtenerGastos
// (puedeCapturarGastos, operativo, sin relación con Vista Privada;
// verificado contra el código real, no el permiso de aprobar/autorizar que
// sería más restrictivo de lo que la pantalla de Gastos ya permite hoy).
export async function obtenerRefArchivoGasto(
  usuario: UsuarioSesion,
  gastoId: string,
  tipo: "ticket" | "factura"
): Promise<string | null> {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const gasto = await db.gastoObra.findFirst({
    where: { id: gastoId, empresaId },
    select: { ticketRef: true, facturaRef: true },
  });
  if (!gasto) throw new RegistroNoEncontradoError("El gasto");

  return tipo === "ticket" ? gasto.ticketRef : gasto.facturaRef;
}

export type DashboardGastos = {
  capturados: number;
  pendientesRevision: number;
  aprobados: number;
  totalAprobado: number;
};

// Catálogo de beneficiarios seleccionables para pagador/proveedor — mismo
// criterio que listarContratistasDisponibles (estructura-contractual.ts):
// catálogo de la empresa completa, no solo los ya asignados a este proyecto,
// porque un pagador/proveedor puede no tener todavía un BeneficiarioProyecto
// formal en esta obra específica. `mismaPersonaQueId: null` excluye los
// alias (una misma persona real con más de una fila Beneficiario, ej. un
// Contratista temporal que ya existía como Personal) — la fila canónica a
// la que apuntan ya está incluida, así que la persona nunca desaparece de
// la lista, solo deja de duplicarse (beneficiarios duplicados, agosto 2026).
export async function listarBeneficiariosParaGasto(
  usuario: UsuarioSesion
): Promise<{ id: string; nombre: string; tipo: string }[]> {
  if (!usuario.empresa) throw new SinPermisoError();
  return db.beneficiario.findMany({
    where: { empresaId: usuario.empresa.id, activo: true, mismaPersonaQueId: null },
    select: { id: true, nombre: true, tipo: true },
    orderBy: { nombre: "asc" },
  });
}

// Aviso en el sidebar (global "Proyectos" y, dentro de un proyecto,
// "Gastos") — mismo criterio y forma que contarPendientesPorProyecto en
// avance.ts, para la otra mitad de "algo necesita aprobación" (Gastos
// transversal → sidebar, septiembre 2026).
export async function contarGastosPendientesRevisionPorProyecto(
  empresaId: string
): Promise<Map<string, number>> {
  const filas = await db.gastoObra.groupBy({
    by: ["proyectoId"],
    where: { empresaId, estatus: "PENDIENTE_REVISION" },
    _count: { _all: true },
  });
  return new Map(filas.map((f) => [f.proyectoId, f._count._all]));
}

// Mismo motivo que hayAvancePendiente (avance.ts) pero para "Gastos" dentro
// del sidebar de un proyecto — escopado a un solo proyecto, sin agrupar
// primero toda la empresa.
export async function hayGastosPendientesRevision(proyectoId: string): Promise<boolean> {
  const total = await db.gastoObra.count({
    where: { proyectoId, estatus: "PENDIENTE_REVISION" },
  });
  return total > 0;
}

export function calcularDashboardGastos(filas: FilaGasto[]): DashboardGastos {
  const aprobados = filas.filter((f) => f.estatus === "APROBADO");
  return {
    capturados: filas.length,
    pendientesRevision: filas.filter((f) => f.estatus === "PENDIENTE_REVISION").length,
    aprobados: aprobados.length,
    totalAprobado: aprobados.reduce((t, f) => t + f.monto, 0),
  };
}

// ---------------------------------------------------------------------------
// Resumen de Gastos de Empresa por categoría — para el bloque "Gastos de
// Empresa" de Reporte General (separado de las obras reales, nunca mezclado
// como si fuera un contratista más — Gastos transversal, septiembre 2026).
// Solo cuenta APROBADO, mismo criterio que "totales oficiales" ya usado en
// obtenerReporteSemana (docs/negocio/03-modulo-reporte-general.md §2.6).
// ---------------------------------------------------------------------------

export type FilaCategoriaGastoEmpresa = {
  categoria: string;
  monto: number;
};

export type ResumenGastosEmpresa = {
  total: number;
  categorias: FilaCategoriaGastoEmpresa[];
};

export async function obtenerResumenGastosEmpresaPorCategoria(
  usuario: UsuarioSesion,
  proyectoOficinaId: string,
  semanaId: string
): Promise<ResumenGastosEmpresa> {
  // Sin permiso alguno de Gastos, esta empresa simplemente no ve nada —
  // consistente con el resto del módulo (puedeCapturarGastos es el techo
  // mínimo para siquiera saber que existen).
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();

  const categoriasVisibles = puedeVerGastosEmpresaSensibles(usuario)
    ? null
    : (Object.keys(CATEGORIA_GASTO_SENSIBLE) as (keyof typeof CATEGORIA_GASTO_SENSIBLE)[]).filter(
        (c) => !CATEGORIA_GASTO_SENSIBLE[c]
      );

  const agrupado = await db.gastoObra.groupBy({
    by: ["categoria"],
    where: {
      proyectoId: proyectoOficinaId,
      semanaId,
      estatus: "APROBADO",
      ...(categoriasVisibles && { categoria: { in: categoriasVisibles } }),
    },
    _sum: { monto: true },
  });

  const categorias = agrupado
    .map((g) => ({ categoria: g.categoria, monto: Number(g._sum.monto ?? 0) }))
    .sort((a, b) => b.monto - a.monto);

  return {
    total: categorias.reduce((t, c) => t + c.monto, 0),
    categorias,
  };
}

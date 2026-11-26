import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import {
  capturaSoloGastosPropios,
  puedeCapturarGastos,
  puedeAprobarGastos,
  puedeCapturarCategoriaGasto,
  puedeVerGastosEmpresaSensibles,
} from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { CATEGORIAS_GASTO, CATEGORIA_GASTO_SENSIBLE } from "@/lib/control-de-obra/categorias-gasto";
import { TRATAMIENTOS_CLIENTE, esCobrable, tratamientoAGuardar, tratamientoVisible } from "@/lib/control-de-obra/tratamiento-cliente";
import { puedeVerInformacionPrivada } from "@/lib/server/permisos";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { RegistroNoEncontradoError } from "./estructura-contractual";
import { asignarGastoAReposicionTx } from "./reposiciones";
import { asegurarEstimacionDeSemanaCerradaTx, intentarReclamarGastoParaCapas } from "./estimacion-cliente";
import { EMPRESA_PROYECTO_LABEL } from "./proyecto-oficina";
import { filtroGastosVisibles, limitadoASusObras } from "./obras-visibles";

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
  quienPagoModo: z.enum(["YO", "OTRO", "EMPRESA"]).default("OTRO"),
  pagadorBeneficiarioId: z.string().trim().optional().nullable(),
  proveedorBeneficiarioId: z.string().trim().optional().nullable(),
  comentario: z.string().trim().optional().nullable(),
  requiereFactura: z.coerce.boolean().default(false),
  tratamientoCliente: z
    .enum(TRATAMIENTOS_CLIENTE)
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
  // El Supervisor no elige: todo gasto que registra lo pagó él (se ignora lo
  // que mande el formulario).
  const modo = capturaSoloGastosPropios(usuario) ? "YO" : datos.quienPagoModo;
  if (modo === "EMPRESA") return null;

  if (modo === "YO") {
    const usuarioConBeneficiario = await db.usuario.findFirst({
      where: { id: usuario.id, empresaId },
      select: { beneficiario: { select: { id: true } } },
    });
    if (!usuarioConBeneficiario?.beneficiario) {
      throw new ValidacionError(
        capturaSoloGastosPropios(usuario)
          ? "Tu usuario no tiene un beneficiario de pago vinculado, así que no se te puede reponer este gasto. Pide a un Administrador que lo vincule en Catálogos."
          : "Este usuario no tiene un beneficiario de pago relacionado. Configúralo antes de generar la reposición."
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

export async function crearGasto(
  usuario: UsuarioSesion,
  proyectoId: string,
  semanaId: string,
  datosCrudos: unknown
) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  // Un Supervisor captura en sus obras y en Gastos de Empresa (que no es una
  // obra asignable: ahí solo ve lo que él captura).
  const esGastoEmpresa =
    limitadoASusObras(usuario) &&
    (await db.proyecto.count({ where: { id: proyectoId, empresaId, tipo: "OFICINA" } })) > 0;
  if (!esGastoEmpresa) await obtenerProyecto(usuario, proyectoId);
  const datos = DatosGastoSchema.parse(datosCrudos);
  requerirPermisoCategoria(usuario, datos.categoria);
  const tratamientoCliente = tratamientoAGuardar(datos.tratamientoCliente, null, puedeVerInformacionPrivada(usuario));
  if (!tratamientoCliente) throw new SinPermisoError();

  const semana = await db.semana.findFirst({ where: { id: semanaId, empresaId } });
  if (!semana) throw new RegistroNoEncontradoError("La semana");

  const pagadorBeneficiarioId = await resolverPagadorBeneficiarioId(usuario, empresaId, datos);
  const tieneDetalle = (datos.detalle?.length ?? 0) > 0;
  const monto = tieneDetalle ? totalDetalleGasto(datos.detalle!) : datos.monto;
  const descripcion = datos.descripcion || (tieneDetalle ? descripcionDesdeDetalle(datos.detalle!) : "");
  if (!descripcion) throw new ValidacionError("La descripción es obligatoria.");

  // Nace siempre PENDIENTE_REVISION, sin importar el rol que captura — misma
  // consistencia que AvanceConcepto: aprobar es siempre una acción explícita
  // separada de capturar (decisión de sesión, agosto 2026).
  const gasto = await db.$transaction(async (tx) => {
    const creado = await tx.gastoObra.create({
      data: {
        empresaId,
        proyectoId,
        semanaId,
        fecha: datos.fecha,
        descripcion,
        categoria: datos.categoria,
        monto,
        metodoPago: datos.metodoPago,
        pagadorBeneficiarioId,
        proveedorBeneficiarioId: datos.proveedorBeneficiarioId || null,
        comentario: datos.comentario || null,
        requiereFactura: datos.requiereFactura,
        tratamientoCliente,
        ticketRef: datos.ticketRef || null,
        ticketNombre: datos.ticketNombre || null,
        capturadoPorId: usuario.id,
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

    return creado;
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "GastoObra",
    entidadId: gasto.id,
    accion: "CREAR",
    valorNuevo: { descripcion: gasto.descripcion, monto, categoria: gasto.categoria },
  });

  return gasto;
}

export async function editarGasto(usuario: UsuarioSesion, gastoId: string, datosCrudos: unknown) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const datos = DatosGastoSchema.parse(datosCrudos);

  const anterior = await db.gastoObra.findFirst({ where: { AND: [{ id: gastoId, empresaId }, filtroGastosVisibles(usuario)] } });
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

  const tratamientoCliente = tratamientoAGuardar(
    datos.tratamientoCliente,
    anterior.tratamientoCliente,
    puedeVerInformacionPrivada(usuario)
  );
  if (!tratamientoCliente) throw new SinPermisoError();

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
        tratamientoCliente,
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

  const gasto = await db.gastoObra.findFirst({ where: { AND: [{ id: gastoId, empresaId }, filtroGastosVisibles(usuario)] } });
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
    if (esCobrable(gasto.tratamientoCliente)) {
      // Semana ya cerrada que nunca generó estimación: se crea ahora (misma
      // lógica que el cierre) para que el gasto tenga dónde reclamarse. No
      // hace nada si la semana está abierta o ya tiene estimación.
      await asegurarEstimacionDeSemanaCerradaTx(tx, {
        empresaId,
        proyectoId: gasto.proyectoId,
        semanaId: gasto.semanaId,
        usuarioId: usuario.id,
      });
      await intentarReclamarGastoParaCapas(tx, gasto.proyectoId, {
        id: gasto.id,
        semanaId: gasto.semanaId,
        incluidoEnCapaOperativoId: gasto.incluidoEnCapaOperativoId,
        incluidoEnCapaPrivadoId: gasto.incluidoEnCapaPrivadoId,
        tratamientoCliente: gasto.tratamientoCliente,
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

// ---------------------------------------------------------------------------
// Cancelar un gasto YA APROBADO (noviembre 2026, decisión de Charles) — para
// un gasto capturado con error (p. ej. sin indicar quién lo pagó): se cancela
// y quien lo capturó lo vuelve a subir bien. Nunca se elimina: queda
// CANCELADO con su motivo (en `motivoRechazo`, el mismo campo de «motivo» del
// rechazo; quién y cuándo canceló, en la bitácora) y conserva quién lo aprobó.
//
// Deshace, en la misma transacción, lo que hizo aprobarGasto:
// - Reposición SIN PAGAR: el gasto sale de ella y su MovimientoSemanal se
//   recalcula. Si se queda sin gastos, la reposición queda RECHAZADA y su
//   movimiento CANCELADO en $0 (dejan de contar en Reporte General).
// - Estimación al cliente en BORRADOR: el gasto se desliga (vuelve a no
//   estar cobrado en ninguna capa).
// Y se NIEGA, sin cambiar nada, cuando ya hay consecuencias reales:
// - la reposición ya tiene abonos, está liquidada/cerrada o pagada con
//   fondo puente (el dinero ya salió);
// - el gasto ya está en una estimación EMITIDA al cliente (nunca se modifica);
// - viene de una orden de compra (se corrige desde Compras);
// - Contabilidad ya registró su pago (medio financiero o fecha de pago).
// ---------------------------------------------------------------------------

const MotivoCancelacionSchema = z
  .string()
  .trim()
  .min(1, "El motivo de la cancelación es obligatorio.")
  .max(500, "El motivo no debe exceder 500 caracteres.");

export async function cancelarGastoAprobado(usuario: UsuarioSesion, gastoId: string, motivoCrudo: unknown) {
  if (!puedeAprobarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);
  const motivo = MotivoCancelacionSchema.parse(motivoCrudo);

  return db.$transaction(async (tx) => {
    // Mismo orden de bloqueo que aprobarGasto: gasto → movimiento → reposición.
    await tx.$queryRaw`SELECT id FROM gastos_obra WHERE id = ${gastoId} FOR UPDATE`;
    const gasto = await tx.gastoObra.findFirst({
      where: { id: gastoId, empresaId },
      include: {
        incluidoEnCapaOperativo: { select: { estatus: true } },
        incluidoEnCapaPrivado: { select: { estatus: true } },
        egreso: { select: { estatus: true, medioFinancieroId: true, fechaPago: true } },
      },
    });
    if (!gasto) throw new RegistroNoEncontradoError("El gasto");
    if (gasto.estatus === "CANCELADO") return gasto;
    if (gasto.estatus !== "APROBADO") {
      throw new ValidacionError(
        gasto.estatus === "PENDIENTE_REVISION"
          ? "Este gasto todavía no se aprueba: recházalo en lugar de cancelarlo."
          : "Solo se puede cancelar un gasto aprobado."
      );
    }
    requerirPermisoCategoria(usuario, gasto.categoria);

    if (gasto.ordenCompraId) {
      throw new ValidacionError("Este gasto se generó desde una orden de compra: corrígelo desde Compras.");
    }
    if (
      gasto.incluidoEnEstimacionClienteId ||
      gasto.incluidoEnCapaOperativo?.estatus === "EMITIDA" ||
      gasto.incluidoEnCapaPrivado?.estatus === "EMITIDA"
    ) {
      throw new ValidacionError(
        "Este gasto ya se cobró en una estimación emitida al cliente, que no se puede modificar. No se canceló."
      );
    }
    if (gasto.egreso && gasto.egreso.estatus === "VIGENTE" && (gasto.egreso.medioFinancieroId || gasto.egreso.fechaPago)) {
      throw new ValidacionError(
        "Contabilidad ya registró el pago de este gasto. Quita primero ese registro en Contabilidad. No se canceló."
      );
    }

    let reposicionAfectada: { id: string; folio: string; quedoVacia: boolean } | null = null;
    if (gasto.reposicionGastosId) {
      const ref = await tx.reposicionGastos.findUniqueOrThrow({
        where: { id: gasto.reposicionGastosId },
        select: { movimientoSemanalId: true },
      });
      if (ref.movimientoSemanalId) {
        await tx.$queryRaw`SELECT id FROM movimientos_semanales WHERE id = ${ref.movimientoSemanalId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM reposiciones_gastos WHERE id = ${gasto.reposicionGastosId} FOR UPDATE`;
      const reposicion = await tx.reposicionGastos.findUniqueOrThrow({
        where: { id: gasto.reposicionGastosId },
        include: {
          beneficiario: { select: { nombre: true } },
          gastos: { select: { id: true, monto: true } },
          _count: { select: { abonos: true } },
          movimientoSemanal: { select: { id: true, estatusPago: true, montoFinSemana: true } },
        },
      });
      const movimiento = reposicion.movimientoSemanal;
      if (reposicion._count.abonos > 0 || reposicion.cerrada || (movimiento && movimiento.estatusPago !== "PENDIENTE_PAGO")) {
        throw new ValidacionError(
          `La reposición ${reposicion.folio} de ${reposicion.beneficiario.nombre} ya tiene pagos registrados, así que este gasto no se puede cancelar. No se cambió nada.`
        );
      }

      const restantes = reposicion.gastos.filter((g) => g.id !== gasto.id);
      const total = restantes.reduce((t, g) => t + Number(g.monto), 0);
      if (movimiento) {
        const datosMovimiento =
          restantes.length > 0
            ? { montoFinSemana: total }
            : { montoFinSemana: 0, montoEntreSemana: 0, estatusAprobacion: "CANCELADO" as const, estatusPago: "SIN_MOVIMIENTO" as const };
        await tx.movimientoSemanal.update({ where: { id: movimiento.id }, data: datosMovimiento });
        await registrarAuditoriaTx(tx, {
          empresaId,
          usuarioId: usuario.id,
          entidad: "MovimientoSemanal",
          entidadId: movimiento.id,
          accion: restantes.length > 0 ? "EDITAR" : "CAMBIAR_ESTATUS",
          valorAnterior: { montoFinSemana: Number(movimiento.montoFinSemana) },
          valorNuevo: { ...datosMovimiento, motivo: `Gasto cancelado: ${motivo}` },
        });
      }
      if (restantes.length === 0) {
        // El índice único parcial de reposiciones excluye las RECHAZADAS: si
        // después se aprueba otro gasto de este beneficiario, se abre una
        // reposición nueva con su propio folio.
        await tx.reposicionGastos.update({
          where: { id: reposicion.id },
          data: {
            estatus: "RECHAZADA",
            revisadoPorId: usuario.id,
            revisadoEn: new Date(),
            motivoRechazo: "Se canceló el único gasto que incluía.",
          },
        });
        await registrarAuditoriaTx(tx, {
          empresaId,
          usuarioId: usuario.id,
          entidad: "ReposicionGastos",
          entidadId: reposicion.id,
          accion: "CAMBIAR_ESTATUS",
          valorAnterior: { estatus: reposicion.estatus },
          valorNuevo: { estatus: "RECHAZADA", motivo: "Se canceló el único gasto que incluía." },
        });
      }
      reposicionAfectada = { id: reposicion.id, folio: reposicion.folio, quedoVacia: restantes.length === 0 };
    }

    // Una capa en BORRADOR todavía no congeló nada (el snapshot solo se toma
    // al emitir): basta con desligar el gasto.
    const actualizado = await tx.gastoObra.update({
      where: { id: gasto.id },
      data: {
        estatus: "CANCELADO",
        motivoRechazo: motivo,
        reposicionGastosId: null,
        incluidoEnCapaOperativoId: null,
        incluidoEnCapaPrivadoId: null,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "GastoObra",
      entidadId: gasto.id,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: {
        estatus: "APROBADO",
        reposicionGastosId: gasto.reposicionGastosId,
        incluidoEnCapaOperativoId: gasto.incluidoEnCapaOperativoId,
        incluidoEnCapaPrivadoId: gasto.incluidoEnCapaPrivadoId,
      },
      valorNuevo: {
        estatus: "CANCELADO",
        motivo,
        ...(reposicionAfectada ? { reposicion: reposicionAfectada.folio, reposicionSinGastos: reposicionAfectada.quedoVacia } : {}),
      },
    });

    return actualizado;
  });
}

export async function registrarFacturaGasto(
  usuario: UsuarioSesion,
  gastoId: string,
  datos: { facturaRef: string; facturaNombre: string }
) {
  if (!puedeCapturarGastos(usuario)) throw new SinPermisoError();
  const empresaId = requerirEmpresa(usuario);

  const gasto = await db.gastoObra.findFirst({ where: { AND: [{ id: gastoId, empresaId }, filtroGastosVisibles(usuario)] } });
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

function aFilaGasto(usuario: UsuarioSesion, g: GastoObraConRelaciones): FilaGasto {
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
    tratamientoCliente: tratamientoVisible(g.tratamientoCliente, puedeVerInformacionPrivada(usuario)),
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
function categoriasOcultasPara(usuario: UsuarioSesion): string[] {
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
    where: { AND: [filtroGastosVisibles(usuario)], proyectoId, semanaId, ...(categoriasOcultas.length > 0 && { categoria: { notIn: categoriasOcultas } }) },
    include: SELECT_FILA_GASTO,
    orderBy: { fecha: "desc" },
  });

  return gastos.map((g) => aFilaGasto(usuario, g));
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
    where: { AND: [filtroGastosVisibles(usuario)], empresaId, semanaId, ...(categoriasOcultas.length > 0 && { categoria: { notIn: categoriasOcultas } }) },
    include: { ...SELECT_FILA_GASTO, proyecto: { select: { nombre: true, tipo: true } } },
    orderBy: { fecha: "desc" },
  });

  return gastos.map((g) => ({
    ...aFilaGasto(usuario, g),
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
    where: { AND: [{ id: gastoId, empresaId }, filtroGastosVisibles(usuario)] },
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

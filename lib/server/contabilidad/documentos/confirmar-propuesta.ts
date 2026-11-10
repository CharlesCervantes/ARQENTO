import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import type { Prisma } from "@/lib/generated/prisma/client";
import { crearGastoDesdeDocumentoTx } from "@/lib/server/control-de-obra/gastos";
import { crearEgresoManualTx, guardarDecoracionEgreso } from "../egresos";
import { obtenerOCrearSemanaActual } from "@/lib/server/semanas";
import { obtenerOCrearProyectoOficina } from "@/lib/server/control-de-obra/proyecto-oficina";
import { CATEGORIAS_GASTO, CATEGORIA_GASTO_AMBITO, type CategoriaGasto } from "@/lib/control-de-obra/categorias-gasto";
import { crearProveedor } from "@/lib/server/catalogos";
import { puedeVerContabilidad, puedeRegistrarMovimientoContable, puedeAdministrarCatalogos } from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import { SinPermisoError, ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { CLASIFICACIONES_EGRESO_MANUAL } from "../estado-resultados";
import { requerirCapturaInteligente } from "./habilitacion";
import { MODOS_PAGADOR, resolverPagadorDeDocumentoTx } from "./pagador";
import { exigirRevisionDeDuplicadosTx, identificadoresDePropuesta } from "./duplicados";

// Orquestador PURO — ninguna regla de negocio nueva aquí. Reutiliza
// exactamente las funciones que ya existían antes de esta funcionalidad;
// nunca registra una operación sin que un humano la haya confirmado (Carga
// inteligente de documentos, V1 — octubre 2026).

function requerirContabilidad(usuario: UsuarioSesion): string {
  if (!puedeVerContabilidad(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

async function documentoPropio(empresaId: string, documentoEgresoId: string, cliente: Prisma.TransactionClient = db) {
  const documento = await cliente.documentoEgreso.findFirst({ where: { id: documentoEgresoId, empresaId } });
  if (!documento) throw new RegistroNoEncontradoError("El documento");
  return documento;
}

async function marcarDocumentoConfirmado(
  args: {
    documentoEgresoId: string;
    egresoId: string;
    estatus: "VINCULADO" | "CONVERTIDO";
    valoresFinalesUsuario: unknown;
    usuarioId: string;
  },
  cliente: Prisma.TransactionClient = db
) {
  await cliente.documentoEgreso.update({
    where: { id: args.documentoEgresoId },
    data: {
      egresoId: args.egresoId,
      estatus: args.estatus,
      valoresFinalesUsuario: args.valoresFinalesUsuario as object,
      confirmadoPorId: args.usuarioId,
      confirmadoEn: new Date(),
    },
  });
}

// Bloqueo de fila del documento — toda confirmación o descarte se serializa
// por documento (doble clic, reintento, dos revisores a la vez).
async function bloquearDocumento(tx: Prisma.TransactionClient, documentoEgresoId: string) {
  await tx.$queryRaw`SELECT id FROM documentos_egreso WHERE id = ${documentoEgresoId} FOR UPDATE`;
}

// Resultado de una confirmación previa del documento, si ya la hubo — base
// de la idempotencia: confirmar dos veces devuelve lo mismo, nunca crea un
// segundo registro.
async function confirmacionPrevia(tx: Prisma.TransactionClient, documento: { estatus: string; egresoId: string | null }) {
  if ((documento.estatus !== "CONVERTIDO" && documento.estatus !== "VINCULADO") || !documento.egresoId) return null;
  const egreso = await tx.egreso.findUnique({ where: { id: documento.egresoId }, select: { id: true, gastoObraId: true } });
  if (!egreso) return null;
  return { estatus: documento.estatus, egresoId: egreso.id, gastoObraId: egreso.gastoObraId };
}

const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

const TRATAMIENTOS_CLIENTE = ["NO_COBRABLE", "COBRABLE_EN_ESTIMACION", "INCLUIDO_EN_CONTRATO"] as const;

const DatosConfirmarGastoNuevoSchema = z
  .object({
    // Destino del gasto — mismo Paso 1 que el formulario global de Gastos:
    // una obra, o la Empresa (el Proyecto interno de Oficina, resuelto en el
    // servidor con obtenerOCrearProyectoOficina — nunca un id del cliente).
    destino: z.enum(["OBRA", "EMPRESA"], { error: "Indica si el gasto es de una obra o de la Empresa." }),
    proyectoId: z.string().trim().optional().nullable(),
    // Cobrabilidad al cliente — el campo existente de Gastos, con sus tres
    // opciones y el mismo valor por omisión (no cobrable). Solo aplica a
    // obra: la Empresa no tiene cliente a quién cobrarle.
    tratamientoCliente: z.enum(TRATAMIENTOS_CLIENTE).default("NO_COBRABLE"),
    // Semana a la que se reporta el gasto: la que elige quien confirma (la
    // pantalla propone la semana actual), o "ACTUAL" resuelta en el
    // servidor. La fecha del comprobante nunca decide la semana por sí sola
    // — mismo criterio que el módulo de Gastos.
    semanaId: z.string().trim().optional().nullable(),
    semanaDe: z.enum(["ACTUAL"]).optional().nullable(),
    fecha: z.coerce.date(),
    descripcion: z.string().trim().min(1, "La descripción es obligatoria."),
    categoria: z.string().trim().min(1),
    monto: z.coerce.number().positive(),
    metodoPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO"]),
    proveedorBeneficiarioId: z.string().trim().optional().nullable(),
    comentario: z.string().trim().optional().nullable(),
    requiereFactura: checkbox.default(false),
    // R3 — obligatorio, sin valor por omisión: nunca se asume que pagó la
    // Empresa.
    pagadorModo: z.enum(MODOS_PAGADOR, { error: "Indica quién pagó este gasto." }),
    pagadorBeneficiarioId: z.string().trim().optional().nullable(),
    aceptaPosiblesDuplicados: checkbox.default(false),
  })
  .refine((d) => Boolean(d.semanaId) || Boolean(d.semanaDe), { message: "Indica la semana del gasto.", path: ["semanaDe"] });

// Destino → Proyecto, con las mismas reglas de ámbito del formulario de
// Gastos (Gastos transversal, septiembre 2026): las categorías de obra solo
// en una obra real; las de Empresa solo en el Proyecto de Oficina, que nunca
// se cobra al cliente. Los permisos de categorías sensibles los sigue
// validando crearGasto.
async function resolverDestinoDelGasto(
  empresaId: string,
  datos: z.infer<typeof DatosConfirmarGastoNuevoSchema>
): Promise<{ proyectoId: string; proyectoOficinaId: string | null }> {
  const categoria = datos.categoria as CategoriaGasto;
  if (!CATEGORIAS_GASTO.includes(categoria)) throw new ValidacionError("Selecciona una categoría válida.");
  if (datos.destino === "EMPRESA") {
    if (CATEGORIA_GASTO_AMBITO[categoria] !== "empresa") throw new ValidacionError("Selecciona una categoría de gastos de Empresa.");
    if (datos.tratamientoCliente !== "NO_COBRABLE") throw new ValidacionError("Un gasto de la Empresa no se cobra al cliente.");
    const proyectoOficinaId = await obtenerOCrearProyectoOficina(empresaId);
    return { proyectoId: proyectoOficinaId, proyectoOficinaId };
  }
  if (!datos.proyectoId) throw new ValidacionError("Selecciona la obra.");
  if (CATEGORIA_GASTO_AMBITO[categoria] !== "obra") throw new ValidacionError("Selecciona una categoría de gastos de obra.");
  const proyecto = await db.proyecto.findFirst({ where: { id: datos.proyectoId, empresaId }, select: { tipo: true } });
  if (proyecto?.tipo === "OFICINA") throw new ValidacionError("Para un gasto de la Empresa elige el destino Empresa.");
  return { proyectoId: datos.proyectoId, proyectoOficinaId: null };
}

async function resolverSemanaDelGasto(empresaId: string, datos: z.infer<typeof DatosConfirmarGastoNuevoSchema>): Promise<string> {
  if (datos.semanaId) return datos.semanaId; // crearGasto valida que sea de la Empresa
  return (await obtenerOCrearSemanaActual(empresaId)).id;
}

// Camino 1 — "Registrar como gasto de obra": el documento da origen a un
// GastoObra real. Atómico e idempotente (Fase 0 WhatsApp + ARQENTO IA,
// octubre 2026): gasto + decoración Egreso + marca del documento +
// auditoría en UNA transacción, con el documento bloqueado; confirmar dos
// veces devuelve el mismo gasto. Reglas (sin cambios en las financieras):
// - el pagador es obligatorio y se resuelve en el servidor (ver pagador.ts);
// - el capturista del gasto es el REMITENTE del documento; quien confirma
//   queda en el documento (confirmadoPor) y en la auditoría;
// - el gasto nace PENDIENTE_REVISION: aprobarlo y generar la reposición
//   sigue siendo una acción separada (aprobarGasto, R2);
// - R1: la decoración se crea vacía — nunca un pago bancario aquí;
// - posibles duplicados: avisan y requieren aceptación explícita.
export async function confirmarComoGastoNuevo(
  usuario: UsuarioSesion,
  documentoEgresoId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();
  await requerirCapturaInteligente(empresaId);
  const datos = DatosConfirmarGastoNuevoSchema.parse(datosCrudos);
  const { proyectoId, proyectoOficinaId } = await resolverDestinoDelGasto(empresaId, datos);
  const semanaId = await resolverSemanaDelGasto(empresaId, datos);

  return db.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoEgresoId);
    const documento = await documentoPropio(empresaId, documentoEgresoId, tx);

    const previa = await confirmacionPrevia(tx, documento);
    if (previa) {
      if (previa.estatus === "CONVERTIDO" && previa.gastoObraId) return { gastoObraId: previa.gastoObraId, egresoId: previa.egresoId };
      throw new ValidacionError("Este documento ya fue registrado con otra operación.");
    }

    const { pagadorBeneficiarioId } = await resolverPagadorDeDocumentoTx(tx, {
      empresaId,
      remitenteId: documento.subidoPorId,
      modo: datos.pagadorModo,
      beneficiarioId: datos.pagadorBeneficiarioId,
    });

    const { uuids, referencias } = identificadoresDePropuesta(documento.propuestaReconciliada);
    const duplicadosAceptados = await exigirRevisionDeDuplicadosTx(
      tx,
      usuario,
      {
        empresaId,
        monto: datos.monto,
        fecha: datos.fecha,
        proyectoId,
        esGastoDeEmpresa: datos.destino === "EMPRESA",
        proyectoOficinaId,
        proveedorBeneficiarioId: datos.proveedorBeneficiarioId || null,
        uuids,
        referencias,
      },
      datos.aceptaPosiblesDuplicados
    );

    const gasto = await crearGastoDesdeDocumentoTx(tx, usuario, {
      proyectoId,
      semanaId,
      datosCrudos: {
        fecha: datos.fecha,
        descripcion: datos.descripcion,
        categoria: datos.categoria,
        monto: datos.monto,
        metodoPago: datos.metodoPago,
        proveedorBeneficiarioId: datos.proveedorBeneficiarioId || null,
        comentario: datos.comentario || null,
        requiereFactura: datos.requiereFactura,
        tratamientoCliente: datos.tratamientoCliente,
        // Solo para la validación del esquema de Gastos: el pagador real ya
        // se resolvió arriba (YO = beneficiario del REMITENTE).
        quienPagoModo: datos.pagadorModo,
      },
      pagadorBeneficiarioId,
      capturadoPorId: documento.subidoPorId,
      documentoEgresoId,
    });

    // El nuevo gasto todavía no tiene Egreso — se crea la decoración vacía
    // (relación canónica única: DocumentoEgreso siempre cuelga de Egreso,
    // nunca de GastoObra directo).
    const egreso = await guardarDecoracionEgreso(usuario, gasto.id, {}, { tx });

    const valoresFinales = {
      ...datos,
      proyectoId,
      semanaId,
      pagadorBeneficiarioId,
      posiblesDuplicadosAceptados: duplicadosAceptados.map((d) => ({ tipo: d.tipo, id: d.id, nivel: d.nivel })),
    };
    await marcarDocumentoConfirmado(
      { documentoEgresoId, egresoId: egreso.id, estatus: "CONVERTIDO", valoresFinalesUsuario: valoresFinales, usuarioId: usuario.id },
      tx
    );

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "DocumentoEgreso",
      entidadId: documentoEgresoId,
      accion: "CONFIRMAR",
      valorAnterior: { estatus: documento.estatus, propuestaReconciliada: documento.propuestaReconciliada },
      valorNuevo: {
        estatus: "CONVERTIDO",
        gastoObraId: gasto.id,
        egresoId: egreso.id,
        remitenteId: documento.subidoPorId,
        pagadorModo: datos.pagadorModo,
        pagadorBeneficiarioId,
        datosConfirmados: valoresFinales,
      },
    });

    return { gastoObraId: gasto.id, egresoId: egreso.id };
  });
}

const DatosVincularExistenteSchema = z.object({
  gastoObraId: z.string().trim().min(1),
  fechaPago: z.coerce.date().optional().nullable(),
  referenciaPago: z.string().trim().optional().nullable(),
  medioFinancieroId: z.string().trim().optional().nullable(),
});

// Camino 2 — "Vincular a operación existente": el documento completa el
// pago de un GastoObra ya capturado — nunca crea un segundo gasto.
//
// Atómico (octubre 2026): decoración del Egreso + marca del documento +
// auditoría en UNA transacción — si cualquiera falla, nada queda escrito.
// Solo se envían los datos de pago que la vinculación trae: factura, notas
// y datos de pago no incluidos se conservan (contrato parcial de
// guardarDecoracionEgreso), y la regla R1 se aplica igual que en el
// formulario. Repetir la vinculación del mismo documento al mismo gasto no
// vuelve a escribir nada; vincularlo a otra operación se rechaza.
export async function confirmarVinculadoAExistente(
  usuario: UsuarioSesion,
  documentoEgresoId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirContabilidad(usuario);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();
  await requerirCapturaInteligente(empresaId);
  const datos = DatosVincularExistenteSchema.parse(datosCrudos);

  const decoracion: Record<string, unknown> = {};
  for (const campo of ["fechaPago", "referenciaPago", "medioFinancieroId"] as const) {
    if (datos[campo] !== undefined) decoracion[campo] = datos[campo];
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM documentos_egreso WHERE id = ${documentoEgresoId} FOR UPDATE`;
    const documento = await documentoPropio(empresaId, documentoEgresoId, tx);

    const gasto = await tx.gastoObra.findFirst({ where: { id: datos.gastoObraId, empresaId } });
    if (!gasto) throw new RegistroNoEncontradoError("El gasto");

    if (documento.estatus === "VINCULADO" || documento.estatus === "CONVERTIDO") {
      const egresoDelGasto = await tx.egreso.findUnique({ where: { gastoObraId: datos.gastoObraId }, select: { id: true } });
      if (documento.estatus === "VINCULADO" && egresoDelGasto && documento.egresoId === egresoDelGasto.id) {
        return { gastoObraId: datos.gastoObraId, egresoId: egresoDelGasto.id };
      }
      throw new ValidacionError("Este documento ya fue confirmado con otra operación.");
    }

    const egreso = await guardarDecoracionEgreso(usuario, datos.gastoObraId, decoracion, { tx });

    await marcarDocumentoConfirmado(
      {
        documentoEgresoId,
        egresoId: egreso.id,
        estatus: "VINCULADO",
        valoresFinalesUsuario: datos,
        usuarioId: usuario.id,
      },
      tx
    );

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "DocumentoEgreso",
      entidadId: documentoEgresoId,
      accion: "CONFIRMAR",
      valorAnterior: { propuestaReconciliada: documento.propuestaReconciliada },
      valorNuevo: { estatus: "VINCULADO", gastoObraId: datos.gastoObraId, egresoId: egreso.id, datosConfirmados: datos },
    });

    return { gastoObraId: datos.gastoObraId, egresoId: egreso.id };
  });
}

const DatosConfirmarEgresoManualSchema = z.object({
  fecha: z.coerce.date(),
  concepto: z.string().trim().min(1),
  monto: z.coerce.number().positive(),
  proyectoId: z.string().trim().optional().nullable(),
  clasificacionManual: z.enum(CLASIFICACIONES_EGRESO_MANUAL),
  fechaPago: z.coerce.date().optional().nullable(),
  referenciaPago: z.string().trim().optional().nullable(),
  medioFinancieroId: z.string().trim().optional().nullable(),
  // Antes se descartaban en silencio aunque el formulario los mostrara.
  facturaId: z.string().trim().optional().nullable(),
  notasContables: z.string().trim().optional().nullable(),
  // D2 (Fase 0 WhatsApp + ARQENTO IA): un egreso de empresa es, por
  // definición del modelo contable existente, un pago de la Empresa — no
  // admite pagador persona ni reposición. Se confirma explícitamente; si lo
  // pagó una persona, el documento se registra como gasto (con su pagador).
  pagadoPorEmpresa: z.preprocess(
    (v) => v === true || v === "on" || v === "true",
    z.literal(true, { error: "Confirma que este egreso lo pagó la Empresa. Si lo pagó una persona, regístralo como gasto de obra." })
  ),
  aceptaPosiblesDuplicados: checkbox.default(false),
});

// Camino 3 — "Registrar como egreso de empresa" (sin operación de obra
// detrás, ej. un gasto administrativo): Egreso manual, con las mismas reglas
// de crearEgresoManual. Atómico e idempotente: egreso + marca del documento
// + auditoría en una transacción, con el documento bloqueado.
export async function confirmarComoEgresoManual(
  usuario: UsuarioSesion,
  documentoEgresoId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirContabilidad(usuario);
  await requerirCapturaInteligente(empresaId);
  if (!puedeRegistrarMovimientoContable(usuario)) throw new SinPermisoError();
  const { pagadoPorEmpresa, aceptaPosiblesDuplicados, ...datos } = DatosConfirmarEgresoManualSchema.parse(datosCrudos);

  return db.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoEgresoId);
    const documento = await documentoPropio(empresaId, documentoEgresoId, tx);

    const previa = await confirmacionPrevia(tx, documento);
    if (previa) {
      if (previa.estatus === "CONVERTIDO" && !previa.gastoObraId) return { egresoId: previa.egresoId };
      throw new ValidacionError("Este documento ya fue registrado con otra operación.");
    }

    const { uuids, referencias } = identificadoresDePropuesta(documento.propuestaReconciliada);
    const duplicadosAceptados = await exigirRevisionDeDuplicadosTx(
      tx,
      usuario,
      {
        empresaId,
        monto: datos.monto,
        fecha: datos.fecha,
        proyectoId: datos.proyectoId || null,
        // Un egreso de empresa sin obra también se compara contra los gastos
        // del Proyecto de Oficina (mismo movimiento por otra vía).
        esGastoDeEmpresa: !datos.proyectoId,
        proyectoOficinaId: datos.proyectoId
          ? null
          : ((await tx.proyecto.findFirst({ where: { empresaId, tipo: "OFICINA" }, select: { id: true } }))?.id ?? null),
        uuids,
        referencias: [...referencias, ...(datos.referenciaPago ? [datos.referenciaPago] : [])],
      },
      aceptaPosiblesDuplicados
    );

    const egreso = await crearEgresoManualTx(tx, usuario, datos, { origen: "DOCUMENTO", documentoEgresoId });

    const valoresFinales = {
      ...datos,
      pagadoPorEmpresa,
      posiblesDuplicadosAceptados: duplicadosAceptados.map((d) => ({ tipo: d.tipo, id: d.id, nivel: d.nivel })),
    };
    await marcarDocumentoConfirmado(
      { documentoEgresoId, egresoId: egreso.id, estatus: "CONVERTIDO", valoresFinalesUsuario: valoresFinales, usuarioId: usuario.id },
      tx
    );

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "DocumentoEgreso",
      entidadId: documentoEgresoId,
      accion: "CONFIRMAR",
      valorAnterior: { estatus: documento.estatus, propuestaReconciliada: documento.propuestaReconciliada },
      valorNuevo: { estatus: "CONVERTIDO", egresoId: egreso.id, remitenteId: documento.subidoPorId, datosConfirmados: valoresFinales },
    });

    return { egresoId: egreso.id };
  });
}

const DatosCrearProveedorDesdeDocumentoSchema = z.object({
  nombre: z.string().trim().min(1),
  rfc: z.string().trim().optional().nullable(),
  clabe: z.string().trim().optional().nullable(),
});

// El usuario confirma explícitamente crear un Proveedor nuevo a partir de
// lo que la propuesta detectó — nunca ocurre solo porque el documento lo
// sugirió.
export async function crearProveedorDesdeDocumento(usuario: UsuarioSesion, datosCrudos: unknown) {
  if (!puedeAdministrarCatalogos(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  await requerirCapturaInteligente(usuario.empresa.id);
  const datos = DatosCrearProveedorDesdeDocumentoSchema.parse(datosCrudos);
  return crearProveedor(usuario, { nombre: datos.nombre, rfc: datos.rfc || null, clabe: datos.clabe || null });
}

// Descartar — atómico e idempotente: descartar dos veces no hace nada, y un
// documento ya registrado (gasto, egreso o vínculo) no se puede descartar.
// Un documento descartado sí puede registrarse después de todas formas
// (decisión explícita desde la bandeja).
export async function descartarDocumentoEgreso(usuario: UsuarioSesion, documentoEgresoId: string) {
  const empresaId = requerirContabilidad(usuario);
  await requerirCapturaInteligente(empresaId);
  await db.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoEgresoId);
    const documento = await documentoPropio(empresaId, documentoEgresoId, tx);
    if (documento.estatus === "DESCARTADO") return;
    if (documento.estatus === "CONVERTIDO" || documento.estatus === "VINCULADO") {
      throw new ValidacionError("Este documento ya fue registrado — no se puede descartar.");
    }
    await tx.documentoEgreso.update({ where: { id: documentoEgresoId }, data: { estatus: "DESCARTADO" } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: "DocumentoEgreso",
      entidadId: documentoEgresoId,
      accion: "CAMBIAR_ESTATUS",
      valorAnterior: { estatus: documento.estatus },
      valorNuevo: { estatus: "DESCARTADO" },
    });
  });
}

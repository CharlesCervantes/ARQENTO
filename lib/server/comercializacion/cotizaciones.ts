import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { ValidacionError } from "@/lib/server/control-de-obra/proyectos";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { SinPermisoComercialError, requerirUsoComercial } from "@/lib/server/comercializacion/acceso";
import {
  calcularImportePartida,
  calcularTotalesCotizacion,
  normalizarCantidad,
  normalizarImporte,
  type TotalesCotizacion,
  type TratamientoImpuesto,
  comoTratamientoVenta,
} from "@/lib/comercializacion/importes";
import { dateAFecha, fechaADate, hoyNegocio, normalizarFecha } from "@/lib/comercializacion/fechas";
import { leerDocumentoEmitido, type DocumentoCotizacion } from "@/lib/comercializacion/documento";

// Cotizaciones de venta en BORRADOR — B2 (noviembre 2026).
// docs/negocio/comercializacion.md §5.2, §6, §20. Reglas centrales:
// - Alcance: Administrador/Director ven y editan las de su Empresa; el
//   vendedor SOLO las asignadas a él. Fuera de alcance = "no existe".
// - Vendedor: el vendedor siempre es él mismo (no puede cambiarlo);
//   administración asigna un vendedor ELEGIBLE de su Empresa. Creador y
//   vendedor se guardan por separado.
// - Precios: solo administración fija un precio distinto al de catálogo. El
//   vendedor cambia cantidades, nunca precios, impuestos ni importes; un
//   precio que administración ajustó se conserva al editar cantidades.
// - Partidas: copia histórica del producto al agregarse. El catálogo no las
//   modifica después; cambiar su precio no modifica el catálogo. Solo
//   productos ACTIVOS pueden agregarse; un producto desactivado conserva sus
//   partidas existentes.
// - Importes y totales: SIEMPRE calculados aquí (lib/comercializacion/
//   importes.ts); campos de importe/impuesto enviados por el navegador se
//   rechazan.
// - Folio COT- por Empresa; idempotencia de creación por claveCreacion;
//   conflicto de edición por versión. Un borrador no crea OC, compra, cobro
//   ni deuda.

export const ENTIDAD_COTIZACION = "CotizacionVenta";
const PREFIJO_FOLIO = "COT-";
const MAX_PARTIDAS = 200;

export class ConflictoEdicionError extends ValidacionError {
  constructor() {
    super("Otra persona guardó cambios en esta cotización mientras la editabas. Recarga para ver la versión actual; tus cambios no se guardaron.");
    this.name = "ConflictoEdicionError";
  }
}

const formatoFolio = (n: number) => `${PREFIJO_FOLIO}${String(n).padStart(6, "0")}`;

/** Filtro de alcance: TODA lectura/escritura de cotizaciones pasa por aquí. */
export function alcance(usuario: UsuarioSesion, empresaId: string): Prisma.CotizacionVentaWhereInput {
  return esAdministradorComercial(usuario) ? { empresaId } : { empresaId, vendedorId: usuario.id };
}

// ---------------------------------------------------------------------------
// Vendedores elegibles
// ---------------------------------------------------------------------------

export type OpcionVendedor = { id: string; nombre: string };

/**
 * Elegibles para ser vendedor de una cotización: Supervisores activos con la
 * función Vendedor y Administradores/Directores activos de la Empresa
 * (administración también puede vender directamente). Para un vendedor, la
 * única opción es él mismo.
 */
export async function listarVendedoresElegibles(usuario: UsuarioSesion): Promise<OpcionVendedor[]> {
  const empresaId = requerirUsoComercial(usuario);
  if (!esAdministradorComercial(usuario)) return [{ id: usuario.id, nombre: usuario.nombre }];
  return db.usuario.findMany({
    where: {
      empresaId,
      activo: true,
      OR: [{ rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } }, { rol: "SUPERVISOR", vendedorComercial: true }],
    },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
}

async function vendedorEsElegible(tx: Prisma.TransactionClient, empresaId: string, vendedorId: string): Promise<boolean> {
  const u = await tx.usuario.findFirst({
    where: {
      id: vendedorId,
      empresaId,
      activo: true,
      OR: [{ rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } }, { rol: "SUPERVISOR", vendedorComercial: true }],
    },
    select: { id: true },
  });
  return Boolean(u);
}

// ---------------------------------------------------------------------------
// Validación de captura
// ---------------------------------------------------------------------------

const textoOpcional = (max: number, campo: string) =>
  z
    .string({ error: `${campo} inválido.` })
    .trim()
    .max(max, `${campo} admite máximo ${max} caracteres.`)
    .nullish()
    .transform((v) => (v ? v : null));

const idOpcional = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null));

// strictObject: cualquier campo no previsto (importe, subtotal, tasaIva,
// descuento, tratamientoImpuesto, precioBase…) se RECHAZA, no se ignora.
const esquemaPartida = z.strictObject(
  {
    id: idOpcional,
    productoId: z.string({ error: "Partida sin producto." }).min(1, "Partida sin producto."),
    cantidad: z.unknown(),
    precioUnitario: z.unknown().optional(),
  },
  { error: (i) => (i.code === "unrecognized_keys" ? `Campo no permitido en una partida: ${i.keys.join(", ")}.` : undefined) }
);

const esquemaCotizacion = z.strictObject(
  {
    clienteId: idOpcional,
    obraId: idOpcional,
    descripcion: textoOpcional(300, "La descripción"),
    vendedorId: idOpcional,
    fecha: z.unknown(),
    vigenciaHasta: z.unknown().optional(),
    condiciones: textoOpcional(2000, "Las condiciones"),
    observaciones: textoOpcional(2000, "Las observaciones"),
    partidas: z.array(esquemaPartida).max(MAX_PARTIDAS, `Máximo ${MAX_PARTIDAS} partidas por cotización.`),
  },
  { error: (i) => (i.code === "unrecognized_keys" ? `Campo no permitido: ${i.keys.join(", ")}.` : undefined) }
);

type DatosCotizacion = {
  clienteId: string | null;
  obraId: string | null;
  descripcion: string | null;
  vendedorId: string | null;
  fecha: string;
  vigenciaHasta: string | null;
  condiciones: string | null;
  observaciones: string | null;
  partidas: { id: string | null; productoId: string; cantidad: string; precioUnitario: string | null }[];
};

export function validarDatosCotizacion(datosCrudos: unknown): DatosCotizacion {
  const d = esquemaCotizacion.parse(datosCrudos);
  const fecha = normalizarFecha(d.fecha);
  if (!fecha) throw new ValidacionError("La fecha de la cotización es obligatoria (AAAA-MM-DD).");
  let vigenciaHasta: string | null = null;
  if (d.vigenciaHasta !== undefined && d.vigenciaHasta !== null && d.vigenciaHasta !== "") {
    vigenciaHasta = normalizarFecha(d.vigenciaHasta);
    if (!vigenciaHasta) throw new ValidacionError("La vigencia debe ser una fecha válida (AAAA-MM-DD).");
    if (vigenciaHasta < fecha) throw new ValidacionError("La vigencia no puede ser anterior a la fecha de la cotización.");
  }
  if (d.obraId && !d.clienteId) throw new ValidacionError("Selecciona el cliente de la obra.");

  const idsVistos = new Set<string>();
  const partidas = d.partidas.map((p, i) => {
    const n = i + 1;
    const cantidad = normalizarCantidad(p.cantidad);
    if (!cantidad) throw new ValidacionError(`Partida ${n}: la cantidad debe ser mayor que 0 con máximo 3 decimales.`);
    let precioUnitario: string | null = null;
    if (p.precioUnitario !== undefined && p.precioUnitario !== null && p.precioUnitario !== "") {
      precioUnitario = normalizarImporte(p.precioUnitario, { permitirCero: false });
      if (!precioUnitario) throw new ValidacionError(`Partida ${n}: el precio debe ser mayor que 0 con máximo 2 decimales.`);
    }
    if (p.id) {
      if (idsVistos.has(p.id)) throw new ValidacionError(`Partida ${n} repetida.`);
      idsVistos.add(p.id);
    }
    return { id: p.id, productoId: p.productoId, cantidad, precioUnitario };
  });

  // Mínimos de un borrador: folio, vendedor y fecha los pone el sistema; se
  // exige además AL MENOS un dato que lo identifique para el usuario
  // (cliente, descripción o una partida), para no guardar documentos vacíos.
  if (!d.clienteId && !d.descripcion && partidas.length === 0) {
    throw new ValidacionError("Para guardar el borrador indica al menos un cliente, una descripción o un material.");
  }

  return {
    clienteId: d.clienteId,
    obraId: d.obraId,
    descripcion: d.descripcion,
    vendedorId: d.vendedorId,
    fecha,
    vigenciaHasta,
    condiciones: d.condiciones,
    observaciones: d.observaciones,
    partidas,
  };
}

// ---------------------------------------------------------------------------
// Resolución de cliente/obra/vendedor/partidas dentro de la transacción
// ---------------------------------------------------------------------------

async function validarClienteObra(tx: Prisma.TransactionClient, empresaId: string, datos: DatosCotizacion) {
  if (datos.clienteId) {
    const cliente = await tx.clienteComercial.findFirst({ where: { id: datos.clienteId, empresaId }, select: { id: true } });
    if (!cliente) throw new RegistroNoEncontradoError("El cliente");
  }
  if (datos.obraId) {
    const obra = await tx.obraComercial.findFirst({ where: { id: datos.obraId, empresaId }, select: { clienteId: true } });
    if (!obra) throw new RegistroNoEncontradoError("La obra");
    if (obra.clienteId !== datos.clienteId) throw new ValidacionError("La obra seleccionada no pertenece al cliente.");
  }
}

/** Vendedor efectivo según quien guarda. `actual` = vendedor ya guardado (edición). */
async function resolverVendedor(
  tx: Prisma.TransactionClient,
  usuario: UsuarioSesion,
  empresaId: string,
  solicitado: string | null,
  actual: string | null
): Promise<string> {
  if (!esAdministradorComercial(usuario)) {
    if (solicitado && solicitado !== usuario.id) {
      throw new SinPermisoComercialError("Un vendedor no puede asignar la cotización a otra persona.");
    }
    return usuario.id;
  }
  const vendedorId = solicitado ?? actual ?? usuario.id;
  // Solo se valida elegibilidad al ASIGNAR (alta o cambio): conservar al
  // vendedor ya guardado no falla si después perdió la función.
  if (vendedorId !== actual && !(await vendedorEsElegible(tx, empresaId, vendedorId))) {
    throw new ValidacionError("El vendedor seleccionado no es elegible en tu empresa.");
  }
  return vendedorId;
}

type PartidaGuardada = {
  id: string;
  productoId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: Prisma.Decimal | null;
  precioBase: Prisma.Decimal;
  precioUnitario: Prisma.Decimal;
  precioAjustadoPorId: string | null;
  precioAjustadoEn: Date | null;
  cantidad: Prisma.Decimal;
};

type PartidaResuelta = {
  id: string | null;
  orden: number;
  productoId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null;
  precioBase: string;
  precioUnitario: string;
  precioAjustadoPorId: string | null;
  precioAjustadoEn: Date | null;
  cantidad: string;
  importe: string;
};

async function resolverPartidas(
  tx: Prisma.TransactionClient,
  usuario: UsuarioSesion,
  empresaId: string,
  entrada: DatosCotizacion["partidas"],
  guardadas: PartidaGuardada[]
): Promise<PartidaResuelta[]> {
  const esAdmin = esAdministradorComercial(usuario);
  const porId = new Map(guardadas.map((p) => [p.id, p]));
  const nuevasIds = [...new Set(entrada.filter((p) => !p.id).map((p) => p.productoId))];
  // Solo campos de venta del catálogo (nunca costo) y solo productos activos.
  const catalogo = new Map(
    (
      await tx.productoComercial.findMany({
        where: { id: { in: nuevasIds }, empresaId, activo: true },
        select: { id: true, codigo: true, descripcion: true, unidad: true, precioVenta: true, tratamientoImpuesto: true, tasaIva: true },
      })
    ).map((p) => [p.id, p])
  );
  const ahora = new Date();

  return entrada.map((p, orden) => {
    const n = orden + 1;
    let base: Omit<PartidaResuelta, "orden" | "cantidad" | "importe" | "precioUnitario" | "precioAjustadoPorId" | "precioAjustadoEn">;
    let precioVigente: string;
    let ajusteVigente: { por: string | null; en: Date | null };

    if (p.id) {
      const g = porId.get(p.id);
      if (!g) throw new ValidacionError(`Partida ${n}: no pertenece a esta cotización.`);
      if (g.productoId !== p.productoId) throw new ValidacionError(`Partida ${n}: no se puede cambiar el producto de una partida existente.`);
      base = {
        id: g.id,
        productoId: g.productoId,
        codigo: g.codigo,
        descripcion: g.descripcion,
        unidad: g.unidad,
        tratamientoImpuesto: g.tratamientoImpuesto,
        tasaIva: g.tasaIva === null ? null : g.tasaIva.toFixed(2),
        precioBase: g.precioBase.toFixed(2),
      };
      precioVigente = g.precioUnitario.toFixed(2);
      ajusteVigente = { por: g.precioAjustadoPorId, en: g.precioAjustadoEn };
    } else {
      const prod = catalogo.get(p.productoId);
      if (!prod) throw new ValidacionError(`Partida ${n}: el producto no existe o está inactivo.`);
      base = {
        id: null,
        productoId: prod.id,
        codigo: prod.codigo,
        descripcion: prod.descripcion,
        unidad: prod.unidad,
        tratamientoImpuesto: comoTratamientoVenta(prod.tratamientoImpuesto),
        tasaIva: prod.tasaIva === null ? null : prod.tasaIva.toFixed(2),
        precioBase: prod.precioVenta.toFixed(2),
      };
      precioVigente = base.precioBase;
      ajusteVigente = { por: null, en: null };
    }

    let precioUnitario = precioVigente;
    let ajuste = ajusteVigente;
    if (p.precioUnitario !== null && p.precioUnitario !== precioVigente) {
      if (!esAdmin) throw new SinPermisoComercialError("El vendedor no puede modificar precios. Solo administración ajusta precios.");
      precioUnitario = p.precioUnitario;
      ajuste = precioUnitario === base.precioBase ? { por: null, en: null } : { por: usuario.id, en: ahora };
    }

    let importe: string;
    try {
      importe = calcularImportePartida(p.cantidad, precioUnitario);
    } catch {
      throw new ValidacionError(`Partida ${n}: el importe excede el máximo permitido.`);
    }
    return { ...base, orden, cantidad: p.cantidad, precioUnitario, precioAjustadoPorId: ajuste.por, precioAjustadoEn: ajuste.en, importe };
  });
}

function totalesDe(partidas: { importe: string; tratamientoImpuesto: TratamientoImpuesto; tasaIva: string | null }[]): TotalesCotizacion {
  try {
    return calcularTotalesCotizacion(partidas);
  } catch {
    throw new ValidacionError("El total de la cotización excede el máximo permitido.");
  }
}

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

const esquemaClave = z.string().trim().min(8).max(100).nullish();

export async function crearCotizacionVenta(
  usuario: UsuarioSesion,
  datosCrudos: unknown,
  claveCreacionCruda?: unknown,
  // Solo uso interno del servidor (Duplicar, B3): nunca llega del navegador.
  opciones: { origenId?: string } = {}
): Promise<{ id: string; folio: string; reintento: boolean }> {
  const empresaId = requerirUsoComercial(usuario);
  const datos = validarDatosCotizacion(datosCrudos);
  const claveCreacion = esquemaClave.parse(claveCreacionCruda) ?? null;
  if (datos.partidas.some((p) => p.id)) throw new ValidacionError("Una cotización nueva no puede traer partidas existentes.");

  const previa = async () => {
    if (!claveCreacion) return null;
    const c = await db.cotizacionVenta.findFirst({
      where: { empresaId, claveCreacion },
      select: { id: true, folio: true, creadoPorId: true },
    });
    if (!c) return null;
    // La clave es del formulario de quien creó: otra persona no "recupera"
    // una cotización ajena reutilizando su clave.
    if (c.creadoPorId !== usuario.id) throw new ValidacionError("Clave de creación inválida. Recarga el formulario.");
    return { id: c.id, folio: c.folio, reintento: true };
  };

  const repetida = await previa();
  if (repetida) return repetida;

  try {
    return await db.$transaction(async (tx) => {
      await validarClienteObra(tx, empresaId, datos);
      const vendedorId = await resolverVendedor(tx, usuario, empresaId, datos.vendedorId, null);
      const partidas = await resolverPartidas(tx, usuario, empresaId, datos.partidas, []);
      const totales = totalesDe(partidas);

      // Consecutivo PROPIO de cotizaciones (no consume ultimoFolioOrdenCompra).
      const { ultimoFolioCotizacionVenta: numero } = await tx.empresa.update({
        where: { id: empresaId },
        data: { ultimoFolioCotizacionVenta: { increment: 1 } },
        select: { ultimoFolioCotizacionVenta: true },
      });
      const folio = formatoFolio(numero);

      const cotizacion = await tx.cotizacionVenta.create({
        data: {
          empresaId,
          folio,
          numeroFolio: numero,
          clienteId: datos.clienteId,
          obraId: datos.obraId,
          descripcion: datos.descripcion,
          vendedorId,
          creadoPorId: usuario.id,
          fecha: fechaADate(datos.fecha),
          vigenciaHasta: datos.vigenciaHasta ? fechaADate(datos.vigenciaHasta) : null,
          condiciones: datos.condiciones,
          observaciones: datos.observaciones,
          subtotal: totales.subtotal,
          iva: totales.iva,
          total: totales.total,
          claveCreacion,
          origenId: opciones.origenId ?? null,
        },
        select: { id: true },
      });
      if (partidas.length > 0) {
        await tx.partidaCotizacionVenta.createMany({
          data: partidas.map((p) => ({
            empresaId,
            cotizacionId: cotizacion.id,
            orden: p.orden,
            productoId: p.productoId,
            codigo: p.codigo,
            descripcion: p.descripcion,
            unidad: p.unidad,
            tratamientoImpuesto: p.tratamientoImpuesto,
            tasaIva: p.tasaIva,
            precioBase: p.precioBase,
            precioUnitario: p.precioUnitario,
            precioAjustadoPorId: p.precioAjustadoPorId,
            precioAjustadoEn: p.precioAjustadoEn,
            cantidad: p.cantidad,
            importe: p.importe,
          })),
        });
      }
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_COTIZACION,
        entidadId: cotizacion.id,
        accion: "CREAR",
        valorNuevo: {
          folio,
          estatus: "BORRADOR",
          ...(opciones.origenId ? { origenId: opciones.origenId } : {}),
          vendedorId,
          clienteId: datos.clienteId,
          obraId: datos.obraId,
          partidas: partidas.map((p) => ({ codigo: p.codigo, cantidad: p.cantidad, precioUnitario: p.precioUnitario, precioBase: p.precioBase })),
          total: totales.total,
        },
      });
      return { id: cotizacion.id, folio, reintento: false };
    });
  } catch (error) {
    // Dos envíos simultáneos con la misma clave: el índice único deja pasar
    // uno; el otro (y su incremento de folio) se revierte completo.
    if (claveCreacion && esUnica(error)) {
      const ganadora = await previa();
      if (ganadora) return ganadora;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Actualizar
// ---------------------------------------------------------------------------

const SELECT_PARTIDA_GUARDADA = {
  id: true,
  productoId: true,
  codigo: true,
  descripcion: true,
  unidad: true,
  tratamientoImpuesto: true,
  tasaIva: true,
  precioBase: true,
  precioUnitario: true,
  precioAjustadoPorId: true,
  precioAjustadoEn: true,
  cantidad: true,
} as const;

export async function actualizarCotizacionVenta(
  usuario: UsuarioSesion,
  cotizacionId: string,
  versionLeida: unknown,
  datosCrudos: unknown
): Promise<{ id: string; version: number; sinCambios: boolean }> {
  const empresaId = requerirUsoComercial(usuario);
  const datos = validarDatosCotizacion(datosCrudos);
  const version = z.number({ error: "Versión inválida." }).int().min(1).parse(versionLeida);
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");

  return db.$transaction(async (tx) => {
    // Bloqueo de la fila (y comprobación de alcance) antes de comparar versión.
    const filtro = alcance(usuario, empresaId);
    const veTodaLaEmpresa = esAdministradorComercial(usuario);
    const bloqueada = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cotizaciones_venta
      WHERE id = ${cotizacionId} AND "empresaId" = ${empresaId}
        AND (${veTodaLaEmpresa}::boolean OR "vendedorId" = ${usuario.id})
      FOR UPDATE`;
    if (bloqueada.length === 0) throw new RegistroNoEncontradoError("La cotización");

    const actual = await tx.cotizacionVenta.findFirstOrThrow({
      where: { id: cotizacionId, ...filtro },
      include: { partidas: { select: SELECT_PARTIDA_GUARDADA, orderBy: { orden: "asc" } } },
    });
    if (actual.version !== version) throw new ConflictoEdicionError();
    if (actual.estatus !== "BORRADOR") throw new ValidacionError("Solo se pueden editar cotizaciones en borrador.");

    await validarClienteObra(tx, empresaId, datos);
    const vendedorId = await resolverVendedor(tx, usuario, empresaId, datos.vendedorId, actual.vendedorId);
    const partidas = await resolverPartidas(tx, usuario, empresaId, datos.partidas, actual.partidas.map((p) => ({ ...p, tratamientoImpuesto: comoTratamientoVenta(p.tratamientoImpuesto) })));
    const totales = totalesDe(partidas);

    // --- Diferencias para bitácora (y para saber si hay algo que guardar) ---
    const encabezadoAntes: Record<string, string | null> = {
      clienteId: actual.clienteId,
      obraId: actual.obraId,
      descripcion: actual.descripcion,
      vendedorId: actual.vendedorId,
      fecha: dateAFecha(actual.fecha),
      vigenciaHasta: actual.vigenciaHasta ? dateAFecha(actual.vigenciaHasta) : null,
      condiciones: actual.condiciones,
      observaciones: actual.observaciones,
    };
    const encabezadoDespues: Record<string, string | null> = {
      clienteId: datos.clienteId,
      obraId: datos.obraId,
      descripcion: datos.descripcion,
      vendedorId,
      fecha: datos.fecha,
      vigenciaHasta: datos.vigenciaHasta,
      condiciones: datos.condiciones,
      observaciones: datos.observaciones,
    };
    const camposCambiados = Object.keys(encabezadoDespues).filter((k) => encabezadoAntes[k] !== encabezadoDespues[k]);

    const guardadasPorId = new Map(actual.partidas.map((p) => [p.id, p]));
    const conservadas = new Set(partidas.filter((p) => p.id).map((p) => p.id as string));
    const eliminadas = actual.partidas.filter((p) => !conservadas.has(p.id));
    const agregadas = partidas.filter((p) => !p.id);
    const modificadas = partidas
      .filter((p) => p.id)
      .map((p) => ({ p, g: guardadasPorId.get(p.id as string)! }))
      .filter(({ p, g }) => g.cantidad.toFixed(3) !== p.cantidad || g.precioUnitario.toFixed(2) !== p.precioUnitario);
    const reordenadas = partidas.some((p, i) => p.id && actual.partidas[i]?.id !== p.id);

    if (camposCambiados.length === 0 && eliminadas.length === 0 && agregadas.length === 0 && modificadas.length === 0 && !reordenadas) {
      return { id: cotizacionId, version: actual.version, sinCambios: true };
    }

    if (eliminadas.length > 0) {
      await tx.partidaCotizacionVenta.deleteMany({ where: { id: { in: eliminadas.map((p) => p.id) }, cotizacionId, empresaId } });
    }
    for (const p of partidas.filter((x) => x.id)) {
      await tx.partidaCotizacionVenta.update({
        where: { id: p.id as string },
        data: {
          orden: p.orden,
          cantidad: p.cantidad,
          precioUnitario: p.precioUnitario,
          precioAjustadoPorId: p.precioAjustadoPorId,
          precioAjustadoEn: p.precioAjustadoEn,
          importe: p.importe,
        },
      });
    }
    if (agregadas.length > 0) {
      await tx.partidaCotizacionVenta.createMany({
        data: agregadas.map((p) => ({
          empresaId,
          cotizacionId,
          orden: p.orden,
          productoId: p.productoId,
          codigo: p.codigo,
          descripcion: p.descripcion,
          unidad: p.unidad,
          tratamientoImpuesto: p.tratamientoImpuesto,
          tasaIva: p.tasaIva,
          precioBase: p.precioBase,
          precioUnitario: p.precioUnitario,
          precioAjustadoPorId: p.precioAjustadoPorId,
          precioAjustadoEn: p.precioAjustadoEn,
          cantidad: p.cantidad,
          importe: p.importe,
        })),
      });
    }

    const nuevaVersion = actual.version + 1;
    await tx.cotizacionVenta.update({
      where: { id: cotizacionId },
      data: {
        clienteId: datos.clienteId,
        obraId: datos.obraId,
        descripcion: datos.descripcion,
        vendedorId,
        fecha: fechaADate(datos.fecha),
        vigenciaHasta: datos.vigenciaHasta ? fechaADate(datos.vigenciaHasta) : null,
        condiciones: datos.condiciones,
        observaciones: datos.observaciones,
        subtotal: totales.subtotal,
        iva: totales.iva,
        total: totales.total,
        version: nuevaVersion,
        actualizadoPorId: usuario.id,
      },
    });

    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId: usuario.id,
      entidad: ENTIDAD_COTIZACION,
      entidadId: cotizacionId,
      accion: "EDITAR",
      valorAnterior: {
        ...Object.fromEntries(camposCambiados.map((k) => [k, encabezadoAntes[k]])),
        total: actual.total.toFixed(2),
        version: actual.version,
      },
      valorNuevo: {
        ...Object.fromEntries(camposCambiados.map((k) => [k, encabezadoDespues[k]])),
        total: totales.total,
        version: nuevaVersion,
        partidasAgregadas: agregadas.map((p) => ({ codigo: p.codigo, cantidad: p.cantidad, precioUnitario: p.precioUnitario })),
        partidasEliminadas: eliminadas.map((p) => ({ codigo: p.codigo, cantidad: p.cantidad.toFixed(3), precioUnitario: p.precioUnitario.toFixed(2) })),
        partidasModificadas: modificadas.map(({ p, g }) => ({
          codigo: p.codigo,
          cantidad: [g.cantidad.toFixed(3), p.cantidad],
          precioUnitario: [g.precioUnitario.toFixed(2), p.precioUnitario],
        })),
      },
    });

    return { id: cotizacionId, version: nuevaVersion, sinCambios: false };
  });
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export type EstatusCotizacion = "BORRADOR" | "EMITIDA" | "ACEPTADA";
const ESTATUS: readonly EstatusCotizacion[] = ["BORRADOR", "EMITIDA", "ACEPTADA"];

export type FiltrosCotizaciones = { busqueda?: string; clienteId?: string; obraId?: string; vendedorId?: string; estatus?: string };

export type FilaCotizacion = {
  id: string;
  folio: string;
  estatus: EstatusCotizacion;
  // Una cotización aceptada se muestra como su orden (OV) — una sola fila
  // por operación, con la referencia COT visible.
  ordenFolio: string | null;
  vencida: boolean;
  descripcion: string | null;
  clienteNombre: string | null;
  obraNombre: string | null;
  vendedorNombre: string;
  fecha: string;
  vigenciaHasta: string | null;
  total: string;
  partidas: number;
};

/** Vencida = emitida (no aceptada) con vigencia anterior a hoy (America/Monterrey). */
export function estaVencida(estatus: EstatusCotizacion, vigenciaHasta: string | null, hoy: string = hoyNegocio()): boolean {
  return estatus === "EMITIDA" && vigenciaHasta !== null && vigenciaHasta < hoy;
}

export async function listarCotizacionesVenta(usuario: UsuarioSesion, filtros: FiltrosCotizaciones = {}): Promise<FilaCotizacion[]> {
  const empresaId = requerirUsoComercial(usuario);
  const busqueda = filtros.busqueda?.trim().slice(0, 100);
  const estatus = ESTATUS.find((e) => e === filtros.estatus);
  const where: Prisma.CotizacionVentaWhereInput = {
    ...alcance(usuario, empresaId),
    ...(filtros.clienteId ? { clienteId: filtros.clienteId } : {}),
    ...(filtros.obraId ? { obraId: filtros.obraId } : {}),
    ...(estatus ? { estatus } : {}),
    // Un vendedor no puede ampliar su alcance con este filtro: alcance() ya
    // fijó vendedorId y aquí solo se aplica para administración.
    ...(filtros.vendedorId && esAdministradorComercial(usuario) ? { vendedorId: filtros.vendedorId } : {}),
    ...(busqueda
      ? {
          OR: [
            { folio: { contains: busqueda, mode: "insensitive" } },
            { ordenVenta: { folio: { contains: busqueda, mode: "insensitive" } } },
            { ordenVenta: { referenciaOcCliente: { contains: busqueda, mode: "insensitive" } } },
            { descripcion: { contains: busqueda, mode: "insensitive" } },
            { cliente: { nombre: { contains: busqueda, mode: "insensitive" } } },
            { obra: { nombre: { contains: busqueda, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const filas = await db.cotizacionVenta.findMany({
    where,
    orderBy: { numeroFolio: "desc" },
    take: 300,
    select: {
      id: true,
      folio: true,
      estatus: true,
      descripcion: true,
      fecha: true,
      vigenciaHasta: true,
      total: true,
      cliente: { select: { nombre: true } },
      obra: { select: { nombre: true } },
      vendedor: { select: { nombre: true } },
      ordenVenta: { select: { folio: true } },
      _count: { select: { partidas: true } },
    },
  });
  const hoy = hoyNegocio();
  return filas.map((c) => {
    const vigenciaHasta = c.vigenciaHasta ? dateAFecha(c.vigenciaHasta) : null;
    return {
      id: c.id,
      folio: c.folio,
      estatus: c.estatus,
      ordenFolio: c.ordenVenta?.folio ?? null,
      vencida: estaVencida(c.estatus, vigenciaHasta, hoy),
      descripcion: c.descripcion,
      clienteNombre: c.cliente?.nombre ?? null,
      obraNombre: c.obra?.nombre ?? null,
      vendedorNombre: c.vendedor.nombre,
      fecha: dateAFecha(c.fecha),
      vigenciaHasta,
      total: c.total.toFixed(2),
      partidas: c._count.partidas,
    };
  });
}

/** Vendedores con cotizaciones en la Empresa — opciones del filtro de administración. */
export async function listarVendedoresConCotizaciones(usuario: UsuarioSesion): Promise<OpcionVendedor[]> {
  const empresaId = requerirUsoComercial(usuario);
  if (!esAdministradorComercial(usuario)) return [];
  return db.usuario.findMany({
    where: { empresaId, cotizacionesVentaVendidas: { some: { empresaId } } },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
}

export type PartidaDetalle = {
  id: string;
  productoId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null;
  cantidad: string;
  precioBase: string;
  precioUnitario: string;
  precioAjustado: boolean;
  importe: string;
  productoActivo: boolean;
};

export type OrdenVentaResumen = {
  id: string;
  folio: string;
  fechaAceptacion: string;
  referenciaOcCliente: string | null;
  evidenciaNombre: string;
  registradaPorNombre: string;
  registradaEn: string;
};

export type CotizacionDetalle = {
  id: string;
  folio: string;
  estatus: EstatusCotizacion;
  version: number;
  clienteId: string | null;
  obraId: string | null;
  descripcion: string | null;
  vendedor: OpcionVendedor;
  creadoPorNombre: string;
  fecha: string;
  vigenciaHasta: string | null;
  condiciones: string | null;
  observaciones: string | null;
  partidas: PartidaDetalle[];
  totales: TotalesCotizacion;
  actualizadoEn: string;
  // B3
  vencida: boolean;
  emision: { emitidaEn: string; emitidaPorNombre: string; documento: DocumentoCotizacion } | null;
  orden: OrdenVentaResumen | null;
  origen: { id: string; folio: string } | null;
};

export async function obtenerCotizacionVenta(usuario: UsuarioSesion, cotizacionId: string): Promise<CotizacionDetalle> {
  const empresaId = requerirUsoComercial(usuario);
  if (typeof cotizacionId !== "string" || !cotizacionId) throw new RegistroNoEncontradoError("La cotización");
  const c = await db.cotizacionVenta.findFirst({
    where: { id: cotizacionId, ...alcance(usuario, empresaId) },
    select: {
      id: true,
      folio: true,
      estatus: true,
      version: true,
      clienteId: true,
      obraId: true,
      descripcion: true,
      fecha: true,
      vigenciaHasta: true,
      condiciones: true,
      observaciones: true,
      updatedAt: true,
      emitidaEn: true,
      documentoEmitido: true,
      emitidaPor: { select: { nombre: true } },
      origen: { select: { id: true, folio: true } },
      ordenVenta: {
        select: {
          id: true,
          folio: true,
          fechaAceptacion: true,
          referenciaOcCliente: true,
          evidenciaNombre: true,
          createdAt: true,
          registradaPor: { select: { nombre: true } },
        },
      },
      vendedor: { select: { id: true, nombre: true } },
      creadoPor: { select: { nombre: true } },
      partidas: {
        orderBy: { orden: "asc" },
        // Sin costo de referencia: la partida no lo guarda y del producto
        // solo se lee si sigue activo.
        select: { ...SELECT_PARTIDA_GUARDADA, importe: true, producto: { select: { activo: true } } },
      },
    },
  });
  if (!c) throw new RegistroNoEncontradoError("La cotización");

  const partidas: PartidaDetalle[] = c.partidas.map((p) => ({
    id: p.id,
    productoId: p.productoId,
    codigo: p.codigo,
    descripcion: p.descripcion,
    unidad: p.unidad,
    tratamientoImpuesto: comoTratamientoVenta(p.tratamientoImpuesto),
    tasaIva: p.tasaIva === null ? null : p.tasaIva.toFixed(2),
    cantidad: p.cantidad.toFixed(3),
    precioBase: p.precioBase.toFixed(2),
    precioUnitario: p.precioUnitario.toFixed(2),
    precioAjustado: p.precioAjustadoPorId !== null,
    importe: p.importe.toFixed(2),
    productoActivo: p.producto.activo,
  }));
  const vigenciaHasta = c.vigenciaHasta ? dateAFecha(c.vigenciaHasta) : null;

  return {
    id: c.id,
    folio: c.folio,
    estatus: c.estatus,
    version: c.version,
    clienteId: c.clienteId,
    obraId: c.obraId,
    descripcion: c.descripcion,
    vendedor: c.vendedor,
    creadoPorNombre: c.creadoPor.nombre,
    fecha: dateAFecha(c.fecha),
    vigenciaHasta,
    condiciones: c.condiciones,
    observaciones: c.observaciones,
    partidas,
    totales: calcularTotalesCotizacion(partidas),
    actualizadoEn: c.updatedAt.toISOString(),
    vencida: estaVencida(c.estatus, vigenciaHasta),
    emision:
      c.emitidaEn && c.documentoEmitido
        ? {
            emitidaEn: c.emitidaEn.toISOString(),
            emitidaPorNombre: c.emitidaPor?.nombre ?? "—",
            documento: leerDocumentoEmitido(c.documentoEmitido),
          }
        : null,
    orden: c.ordenVenta
      ? {
          id: c.ordenVenta.id,
          folio: c.ordenVenta.folio,
          fechaAceptacion: dateAFecha(c.ordenVenta.fechaAceptacion),
          referenciaOcCliente: c.ordenVenta.referenciaOcCliente,
          evidenciaNombre: c.ordenVenta.evidenciaNombre,
          registradaPorNombre: c.ordenVenta.registradaPor.nombre,
          registradaEn: c.ordenVenta.createdAt.toISOString(),
        }
      : null,
    origen: c.origen,
  };
}

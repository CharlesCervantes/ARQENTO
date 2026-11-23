import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { registrarAuditoria, registrarAuditoriaTx } from "@/lib/server/auditoria";
import {
  puedeAdministrarProyectos,
  puedeEliminarEstructuraContractual,
  puedeVerContratoGeneralPrivado,
} from "@/lib/server/permisos";
import type { UsuarioSesion } from "@/lib/server/session";
import type { ConceptoEstatus, EsquemaContractual } from "@/lib/generated/prisma/enums";
import { SinPermisoError, ValidacionError, obtenerProyecto } from "./proyectos";
import { CLAVES_ICONOS_PARTIDA, CLAVES_COLORES_PARTIDA } from "@/lib/control-de-obra/iconos-partida";
import { sumaHistoricaImportadaPorConcepto } from "./avance-calculo";

export class RegistroNoEncontradoError extends Error {
  constructor(entidad: string) {
    super(`${entidad} no existe o no pertenece a tu empresa.`);
    this.name = "RegistroNoEncontradoError";
  }
}

function requerirAdmin(usuario: UsuarioSesion) {
  if (!puedeAdministrarProyectos(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  return usuario.empresa.id;
}

// Compara un valor "anterior" (viene de una fila de Prisma — puede ser un
// Decimal) contra un valor "nuevo" (ya validado por Zod — string/number/null)
// para decidir si un campo realmente cambió. Sirve para no escribir en la
// bitácora cuando alguien le da "Guardar" sin haber tocado nada (la
// especificidad de la bitácora también significa no mostrar eventos que no
// pasaron — precisión de sesión, agosto 2026).
function valorIgual(anterior: unknown, nuevo: unknown): boolean {
  const a = anterior === undefined ? null : anterior;
  const n = nuevo === undefined ? null : nuevo;
  if (a === null || n === null) return a === n;
  if (typeof a === "object" && "toNumber" in (a as object)) {
    return (a as { toNumber: () => number }).toNumber() === Number(n);
  }
  return String(a) === String(n);
}

function huboCambios(anterior: Record<string, unknown>, datos: Record<string, unknown>): boolean {
  return Object.keys(datos).some((campo) => !valorIgual(anterior[campo], datos[campo]));
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function obtenerEstructuraContractual(
  usuario: UsuarioSesion,
  proyectoId: string
) {
  // obtenerProyecto ya valida que el proyecto pertenezca a la empresa del
  // usuario — a partir de aquí proyectoId es de confianza.
  await obtenerProyecto(usuario, proyectoId);

  const [partidas, contratos] = await Promise.all([
    partidasConConceptos(proyectoId),
    contratosConConceptos(proyectoId),
  ]);

  return { partidas, contratos };
}

// Solo lo que necesita la pestaña "Contrato General" (operativa, visible a
// los 4 roles): descripción, unidad, cantidad, P.U., materiales — nunca
// Indirectos/Herramienta/%/precio comercial. La protección de lo privado se
// aplica aquí, en el select de la consulta — no solo ocultando columnas en el
// componente (sección 49.6/49.9 de la documentación de negocio).
export async function obtenerPartidasProyecto(
  usuario: UsuarioSesion,
  proyectoId: string
) {
  await obtenerProyecto(usuario, proyectoId);
  return partidasConConceptosOperativo(proyectoId);
}

// Lo que necesita la pestaña "Contrato General Priv.": la estructura completa
// (incluye los campos privados). Quién puede llamar a esto se valida en la
// página (puedeVerContratoGeneralPrivado), no aquí — igual que
// obtenerPartidasProyecto no valida por sí sola quién puede ver lo operativo,
// porque eso ya es público para las 4 roles.
export async function obtenerPartidasProyectoPrivado(
  usuario: UsuarioSesion,
  proyectoId: string
) {
  await obtenerProyecto(usuario, proyectoId);
  return partidasConConceptos(proyectoId);
}

// Exportado: lo reutiliza también lib/server/control-de-obra/avance.ts —
// Avance de obra es una pantalla operativa (visible a Supervisor incluido),
// nunca debe traer columnas privadas de Concepto (auditoría de rendimiento,
// agosto 2026: antes reusaba partidasConConceptos, que trae todo).
export function partidasConConceptosOperativo(proyectoId: string) {
  return db.partida.findMany({
    // CANCELADA/CANCELADO nunca aparece en pantallas activas (Contrato
    // General, Avance, selector "asignar concepto" en Contratistas, todos
    // reutilizan esta consulta) — eliminar una Partida/Concepto debe verse
    // como eliminado aquí, aunque la fila se conserve en la base cuando tiene
    // historial (Eliminar Partidas/Conceptos, septiembre 2026).
    where: { proyectoId, estatus: "ACTIVA" },
    // `orden` casi siempre es 0 (nada en la UI lo captura hoy) — sin un
    // desempate estable, Postgres puede devolver los empates en distinto
    // orden entre una consulta y otra (más notorio justo después de un
    // UPDATE), lo que se veía como "el concepto se mueve de lugar solo".
    orderBy: [{ orden: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      nombre: true,
      orden: true,
      icono: true,
      color: true,
      conceptos: {
        where: { estatus: "ACTIVO" },
        orderBy: [{ orden: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          descripcion: true,
          unidad: true,
          cantidadContratada: true,
          orden: true,
          estatus: true,
          precioUnitarioContratista: true,
          precioUnitarioMateriales: true,
          // % Administración NO es privado (a diferencia de % Utilidad en
          // Precio Alzado) — el cliente/Supervisor sí puede verlo en este
          // esquema (sección 49.9 de la documentación de negocio, confirmado
          // de nuevo en sesión al revisar Contrato General de MEZQUITAL).
          porcentajeAdministracion: true,
        },
      },
    },
  });
}

// Lo que necesita la pestaña "Contratistas": los contratos con sus conceptos
// asignados, más las partidas/conceptos (sin datos de asignación) para poder
// ofrecer el selector "asignar concepto existente".
export async function obtenerContratistasProyecto(
  usuario: UsuarioSesion,
  proyectoId: string
) {
  await obtenerProyecto(usuario, proyectoId);

  // Contratistas solo usa partidas/conceptos para el selector "asignar
  // concepto existente" (nombre/unidad/id) — nunca precio ni nada privado
  // (auditoría de rendimiento, agosto 2026: antes reusaba partidasConConceptos,
  // que trae toda la capa privada de Concepto).
  const [partidas, contratos] = await Promise.all([
    partidasConConceptosOperativo(proyectoId),
    contratosConConceptos(proyectoId),
  ]);

  return { partidas, contratos };
}

// Exportado: lo reutiliza también lib/server/control-de-obra/avance.ts (misma
// consulta, evita duplicarla).
export function partidasConConceptos(proyectoId: string) {
  return db.partida.findMany({
    // Mismo filtro que partidasConConceptosOperativo — ver ese comentario.
    where: { proyectoId, estatus: "ACTIVA" },
    orderBy: [{ orden: "asc" }, { createdAt: "asc" }],
    include: {
      conceptos: {
        where: { estatus: "ACTIVO" },
        orderBy: [{ orden: "asc" }, { createdAt: "asc" }],
      },
    },
  });
}

// select explícito en vez de include profundo: Contratistas (única pantalla
// que consume esto) solo pinta estos campos — traer el resto (timestamps,
// notas, sueldo, etc.) es peso de red que nadie usa.
function contratosConConceptos(proyectoId: string) {
  return db.contratoContratista.findMany({
    where: { beneficiarioProyecto: { proyectoId } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      numeroContrato: true,
      descripcion: true,
      beneficiarioProyecto: {
        select: { id: true, beneficiario: { select: { nombre: true } } },
      },
      conceptos: {
        // Un concepto eliminado/cancelado (Eliminar Partidas/Conceptos,
        // septiembre 2026) no puede borrar la asignación ya congelada
        // (ContratoConcepto tiene su propio historial de avance/cortes), pero
        // sí debe dejar de contar en "Contrato vigente" del contratista y de
        // mostrarse en su tabla — mismo criterio que Contrato General, que ya
        // lo excluye.
        where: { concepto: { estatus: "ACTIVO" } },
        select: {
          id: true,
          conceptoId: true,
          cantidad: true,
          precioUnitarioContratista: true,
          concepto: { select: { descripcion: true, unidad: true } },
        },
      },
    },
  });
}

export type ResolucionContratista = {
  contratistasAsignados: number;
  // Solo tiene valor cuando contratistasAsignados === 1 — con más de un
  // contratista no hay forma inequívoca de saber qué precio aplica, y no se
  // inventa un promedio (ver sección 49.8 de la documentación de negocio).
  precioUnitarioContratista: number | null;
};

// Cuántos ContratoConcepto (contratistas) tiene cada Concepto del proyecto, y
// su precio unitario cuando es uno solo. Lo usan tanto Contratistas (avance
// atribuible) como Avance de obra (P.U./monto por concepto).
export async function resolverContratistaPorConcepto(
  proyectoId: string
): Promise<Map<string, ResolucionContratista>> {
  const asignaciones = await db.contratoConcepto.findMany({
    where: { concepto: { partida: { proyectoId } } },
    select: { conceptoId: true, precioUnitarioContratista: true },
  });

  const conteo = new Map<string, { count: number; precio: number | null }>();
  for (const a of asignaciones) {
    const actual = conteo.get(a.conceptoId) ?? { count: 0, precio: null };
    actual.count += 1;
    actual.precio = actual.count === 1 ? Number(a.precioUnitarioContratista) : null;
    conteo.set(a.conceptoId, actual);
  }

  const resultado = new Map<string, ResolucionContratista>();
  for (const [conceptoId, v] of conteo) {
    resultado.set(conceptoId, {
      contratistasAsignados: v.count,
      precioUnitarioContratista: v.count === 1 ? v.precio : null,
    });
  }
  return resultado;
}

// "Contrato vigente" de un contratista con la estructura nueva = suma de
// ContratoConcepto (cantidad × precioUnitarioContratista) agrupada por
// beneficiarioProyectoId — misma fórmula que ya usaba contratistas-view.tsx
// y obtenerResumenFinancieroContratistas (recibos.ts). Se extrae aquí para
// que Reporte General la reutilice en vez de recalcularla con otra fuente
// (BeneficiarioProyecto.montoContrato, el campo legacy — ver reporte-general/
// queries.ts). Recibe ya el resultado de la consulta (cada llamador decide
// si escopa por proyecto o por empresa) para no imponer una sola forma de
// consultar la base de datos.
export function sumarContratoVigentePorBeneficiario(
  contratos: {
    beneficiarioProyectoId: string;
    conceptos: { cantidad: unknown; precioUnitarioContratista: unknown }[];
  }[]
): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const c of contratos) {
    const suma = c.conceptos.reduce(
      (t, cc) => t + Number(cc.cantidad) * Number(cc.precioUnitarioContratista),
      0
    );
    mapa.set(c.beneficiarioProyectoId, (mapa.get(c.beneficiarioProyectoId) ?? 0) + suma);
  }
  return mapa;
}

// `contratista.descripcion` es la especialidad general del catálogo — el
// formulario "Nuevo contrato" la usa para precargar la Descripción de ESE
// contrato al elegir un contratista existente (editable ahí sin tocar el
// catálogo, ver FormNuevoContrato).
export async function listarContratistasDisponibles(usuario: UsuarioSesion) {
  if (!usuario.empresa) throw new SinPermisoError();
  return db.beneficiario.findMany({
    where: { empresaId: usuario.empresa.id, tipo: "CONTRATISTA", activo: true },
    orderBy: { nombre: "asc" },
    include: { contratista: { select: { descripcion: true } } },
  });
}

// ---------------------------------------------------------------------------
// Partidas
// ---------------------------------------------------------------------------

// icono/color se validan contra el catálogo curado — nunca un string libre
// (evita que alguien mande cualquier valor directo a la API).
const DatosPartidaSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre de la partida es obligatorio."),
  orden: z.coerce.number().int().default(0),
  icono: z.enum(CLAVES_ICONOS_PARTIDA as [string, ...string[]]).optional().nullable(),
  color: z.enum(CLAVES_COLORES_PARTIDA as [string, ...string[]]).optional().nullable(),
});

export async function crearPartida(
  usuario: UsuarioSesion,
  proyectoId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosPartidaSchema.parse(datosCrudos);

  const partida = await db.partida.create({ data: { ...datos, proyectoId } });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Partida",
    entidadId: partida.id,
    accion: "CREAR",
    valorNuevo: partida,
  });

  return partida;
}

export async function editarPartida(
  usuario: UsuarioSesion,
  id: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);
  const datos = DatosPartidaSchema.parse(datosCrudos);

  const anterior = await db.partida.findFirst({
    where: { id, proyecto: { empresaId } },
  });
  if (!anterior) throw new RegistroNoEncontradoError("La partida");

  const partida = await db.partida.update({ where: { id }, data: datos });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Partida",
    entidadId: partida.id,
    accion: "EDITAR",
    valorAnterior: anterior,
    valorNuevo: partida,
  });

  return partida;
}

// ---------------------------------------------------------------------------
// Conceptos
// ---------------------------------------------------------------------------

// Solo campos operativos/estructurales (Contrato General) — Indirectos,
// Herramienta, %Utilidad, %Administración, override y las copias *Privado
// son exclusivos de Contrato General Privado (DatosConceptoPrivadoSchema),
// nunca se capturan aquí ni al crear ni al editar (decisión de sesión,
// agosto 2026 — separación real por pestaña).
const DatosConceptoSchema = z.object({
  descripcion: z.string().trim().min(1, "La descripción es obligatoria."),
  unidad: z.string().trim().min(1, "La unidad es obligatoria."),
  cantidadContratada: z.coerce
    .number()
    .positive("La cantidad debe ser mayor a cero."),
  orden: z.coerce.number().int().default(0),
  notas: z.string().trim().optional().nullable(),
  precioUnitarioContratista: z.coerce.number().nonnegative().optional().nullable(),
  precioUnitarioMateriales: z.coerce.number().nonnegative().optional().nullable(),
});

const DatosConceptoEstructuralSchema = z.object({
  descripcion: z.string().trim().min(1, "La descripción es obligatoria."),
  unidad: z.string().trim().min(1, "La unidad es obligatoria."),
  cantidadContratada: z.coerce
    .number()
    .positive("La cantidad debe ser mayor a cero."),
  notas: z.string().trim().optional().nullable(),
  precioUnitarioContratista: z.coerce.number().nonnegative().optional().nullable(),
  precioUnitarioMateriales: z.coerce.number().nonnegative().optional().nullable(),
});

// Materiales presupuestado solo aplica a Precio Alzado — se fuerza a null aun
// si alguien lo manda al crear (decisión de sesión, sección 49.9). Solo se
// usa al CREAR: al crear no hay nada que destruir, así que forzar null aquí
// es seguro; editarConceptoEstructural NO llama a esta función porque si ya
// existiera un valor legado, forzarlo a null lo destruiría (precisión de
// sesión, agosto 2026).
function normalizarCostosParaCreacion<T extends { precioUnitarioMateriales?: number | null }>(
  datos: T,
  esquema: EsquemaContractual | null
): T {
  if (esquema === "ADMINISTRACION") {
    return { ...datos, precioUnitarioMateriales: null };
  }
  return datos;
}

export async function crearConcepto(
  usuario: UsuarioSesion,
  partidaId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);
  const partida = await db.partida.findFirst({
    where: { id: partidaId, proyecto: { empresaId } },
    include: { proyecto: { select: { esquemaContractual: true } } },
  });
  if (!partida) throw new RegistroNoEncontradoError("La partida");

  const datos = normalizarCostosParaCreacion(
    DatosConceptoSchema.parse(datosCrudos),
    partida.proyecto.esquemaContractual
  );
  const concepto = await db.concepto.create({ data: { ...datos, partidaId } });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Concepto",
    entidadId: concepto.id,
    accion: "CREAR",
    valorNuevo: concepto,
  });

  return concepto;
}

// Edita SOLO lo operativo/estructural de un concepto — el modal abierto
// desde Contrato General usa esta función. Nunca toca ningún campo *Privado
// ni Indirectos/Herramienta/%/override: esos son exclusivos del modal
// abierto desde Contrato General Privado (editarConceptoPrivado). Antes
// existía una única "editarConcepto" que tocaba todo desde cualquiera de los
// dos modales — se separó porque abrir el modal desde Contrato General
// mostraba (y podía modificar) información de Contrato General Privado, lo
// cual está mal (decisión de sesión, agosto 2026: separación real por
// pestaña, también para editar, no solo para ver).
export async function editarConceptoEstructural(
  usuario: UsuarioSesion,
  id: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);
  const anterior = await db.concepto.findFirst({
    where: { id, partida: { proyecto: { empresaId } } },
  });
  if (!anterior) throw new RegistroNoEncontradoError("El concepto");

  const datos = DatosConceptoEstructuralSchema.parse(datosCrudos);
  if (!huboCambios(anterior, datos)) return anterior;

  const concepto = await db.concepto.update({ where: { id }, data: datos });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Concepto",
    entidadId: concepto.id,
    accion: "EDITAR",
    valorAnterior: anterior,
    valorNuevo: concepto,
  });

  return concepto;
}

// Concepto completo (todos los campos, operativos y privados) + su
// bitácora — lo que necesita el modal de edición, en sus dos modos
// ("operativo", abierto desde Contrato General público, y "privado", abierto
// desde Contrato General Priv.). El gate de aquí (requerirAdmin) es el techo
// operativo — el mismo para los dos modos, y no cambia con Vista privada:
// el modal operativo debe seguir funcionando aunque Vista privada esté
// apagada. Lo que sí depende de Vista privada es el CONTENIDO: los campos
// *Privado/Indirectos/Herramienta/%utilidad/%administración (todo lo que
// protege puedeVerContratoGeneralPrivado) y la bitácora de ediciones
// privadas se podan aquí mismo si el usuario no tiene acceso privado en este
// momento — mismo patrón que soloOperativo() en estimacion-cliente.ts, para
// que ese payload nunca llegue al cliente en la pantalla pública (decisión
// de sesión, agosto 2026 — Vista Privada).
export async function obtenerConceptoDetalle(usuario: UsuarioSesion, conceptoId: string) {
  const empresaId = requerirAdmin(usuario);
  const concepto = await db.concepto.findFirst({
    where: { id: conceptoId, partida: { proyecto: { empresaId } } },
    include: { partida: { include: { proyecto: { select: { esquemaContractual: true } } } } },
  });
  if (!concepto) throw new RegistroNoEncontradoError("El concepto");

  // Bitácoras independientes: "Concepto" son los eventos de Contrato General
  // (creación, edición estructural, cambios de estatus) y "ConceptoPrivado"
  // son solo las ediciones hechas desde Contrato General Priv. — separadas a
  // propósito para que abrir el modal desde una pestaña nunca muestre eventos
  // de la otra (decisión de sesión, agosto 2026, misma regla que ya aplicaba
  // a qué se puede editar desde cada modo).
  const [bitacoraOperativo, bitacoraPrivadaCompleta] = await Promise.all([
    db.registroAuditoria.findMany({
      where: { entidad: "Concepto", entidadId: conceptoId },
      orderBy: { createdAt: "desc" },
      include: { usuario: { select: { nombre: true } } },
    }),
    db.registroAuditoria.findMany({
      where: { entidad: "ConceptoPrivado", entidadId: conceptoId },
      orderBy: { createdAt: "desc" },
      include: { usuario: { select: { nombre: true } } },
    }),
  ]);

  const conAccesoPrivado = puedeVerContratoGeneralPrivado(usuario);

  return {
    concepto: conAccesoPrivado
      ? concepto
      : {
          ...concepto,
          descripcionPrivado: null,
          unidadPrivado: null,
          cantidadContratadaPrivado: null,
          precioUnitarioContratistaPrivado: null,
          precioUnitarioIndirectos: null,
          precioUnitarioHerramienta: null,
          porcentajeUtilidad: null,
          porcentajeAdministracion: null,
        },
    bitacoraOperativo,
    bitacoraPrivado: conAccesoPrivado ? bitacoraPrivadaCompleta : [],
  };
}

// ---------------------------------------------------------------------------
// Conceptos — capa privada (Contrato General Priv.)
// ---------------------------------------------------------------------------

const DatosConceptoPrivadoSchema = z.object({
  // Copias estructurales propias de Contrato General Privado — nacen iguales
  // a las de Contrato General (null = usa la de Contrato General) y quedan
  // independientes en cuanto se editan aquí (decisión de sesión, agosto
  // 2026 — mismo patrón que precioUnitarioContratistaPrivado, extendido a lo
  // estructural a propósito).
  descripcionPrivado: z.string().trim().min(1).optional().nullable(),
  unidadPrivado: z.string().trim().min(1).optional().nullable(),
  cantidadContratadaPrivado: z.coerce.number().positive().optional().nullable(),
  precioUnitarioContratistaPrivado: z.coerce.number().nonnegative().optional().nullable(),
  precioUnitarioIndirectos: z.coerce.number().nonnegative().optional().nullable(),
  precioUnitarioHerramienta: z.coerce.number().nonnegative().optional().nullable(),
  porcentajeUtilidad: z.coerce.number().nonnegative().optional().nullable(),
  porcentajeAdministracion: z.coerce.number().nonnegative().optional().nullable(),
});

// Edita los campos privados de un concepto — descripción, unidad, cantidad y
// el P.U. de Contrato General (precioUnitarioContratista) NO se tocan aquí.
// El P.U. que se edita desde esta pantalla es precioUnitarioContratistaPrivado
// — una copia propia de Contrato General Privado, independiente desde que se
// edita por primera vez: nunca se sincroniza de vuelta hacia
// precioUnitarioContratista (decisión de sesión, agosto 2026 — editar aquí no
// debe afectar el Contrato General original). Tampoco toca
// ContratoConcepto.precioUnitarioContratista, que ya quedó congelado al
// asignar el contratista (ver asignarConcepto). Escribir precios privados es
// en sí misma una acción de la capa privada — requiere Vista privada activa
// además del rol (puedeVerContratoGeneralPrivado), no solo requerirAdmin
// (decisión de sesión, agosto 2026 — Vista Privada).
//
// Los campos de costo/porcentaje que NO aplican al esquema actual ni siquiera
// se incluyen en el `data` del update, así que un valor legado que ya
// existiera (de un cambio de esquema anterior a esta regla, por ejemplo) no
// se toca ni se destruye (precisión de sesión, agosto 2026).
export async function editarConceptoPrivado(
  usuario: UsuarioSesion,
  id: string,
  datosCrudos: unknown
) {
  if (!puedeVerContratoGeneralPrivado(usuario)) throw new SinPermisoError();
  const empresaId = requerirAdmin(usuario);
  const anterior = await db.concepto.findFirst({
    where: { id, partida: { proyecto: { empresaId } } },
    include: { partida: { include: { proyecto: { select: { esquemaContractual: true } } } } },
  });
  if (!anterior) throw new RegistroNoEncontradoError("El concepto");

  const datos = DatosConceptoPrivadoSchema.parse(datosCrudos);
  const esquema = anterior.partida.proyecto.esquemaContractual;

  // El P.U. y lo estructural privado aplican a los dos esquemas (sección D de
  // la propuesta) — se escriben siempre, no solo cuando se manda un valor,
  // para poder también borrarlos (volver a "igual que Contrato General")
  // desde este formulario.
  const data: {
    descripcionPrivado: string | null;
    unidadPrivado: string | null;
    cantidadContratadaPrivado: number | null;
    precioUnitarioContratistaPrivado: number | null;
    precioUnitarioIndirectos?: number | null;
    precioUnitarioHerramienta?: number | null;
    porcentajeUtilidad?: number | null;
    porcentajeAdministracion?: number | null;
  } = {
    descripcionPrivado: datos.descripcionPrivado ?? null,
    unidadPrivado: datos.unidadPrivado ?? null,
    cantidadContratadaPrivado: datos.cantidadContratadaPrivado ?? null,
    precioUnitarioContratistaPrivado: datos.precioUnitarioContratistaPrivado ?? null,
  };
  if (esquema === "PRECIO_ALZADO") {
    data.precioUnitarioIndirectos = datos.precioUnitarioIndirectos ?? null;
    data.precioUnitarioHerramienta = datos.precioUnitarioHerramienta ?? null;
    data.porcentajeUtilidad = datos.porcentajeUtilidad ?? null;
  } else if (esquema === "ADMINISTRACION") {
    data.porcentajeAdministracion = datos.porcentajeAdministracion ?? null;
  }

  if (!huboCambios(anterior, data)) return anterior;

  const concepto = await db.concepto.update({ where: { id }, data });

  // entidad "ConceptoPrivado" (no "Concepto") — así su bitácora nunca se
  // mezcla con la de Contrato General (ver obtenerConceptoDetalle).
  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "ConceptoPrivado",
    entidadId: concepto.id,
    accion: "EDITAR",
    valorAnterior: anterior,
    valorNuevo: concepto,
  });

  return concepto;
}

const ESTATUS_CONCEPTO_VALIDOS: ConceptoEstatus[] = ["ACTIVO", "CANCELADO"];

export async function cambiarEstatusConcepto(
  usuario: UsuarioSesion,
  id: string,
  nuevoEstatus: string
) {
  const empresaId = requerirAdmin(usuario);
  if (!ESTATUS_CONCEPTO_VALIDOS.includes(nuevoEstatus as ConceptoEstatus)) {
    throw new ValidacionError(`Estatus inválido: ${nuevoEstatus}`);
  }

  const anterior = await db.concepto.findFirst({
    where: { id, partida: { proyecto: { empresaId } } },
  });
  if (!anterior) throw new RegistroNoEncontradoError("El concepto");

  const concepto = await db.concepto.update({
    where: { id },
    data: { estatus: nuevoEstatus as ConceptoEstatus },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "Concepto",
    entidadId: concepto.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: anterior.estatus },
    valorNuevo: { estatus: concepto.estatus },
  });

  return concepto;
}

// ---------------------------------------------------------------------------
// Eliminar Partidas y Conceptos — Administrador/Director (septiembre 2026).
//
// Mismo patrón que evaluarEliminacionBeneficiario/eliminarBeneficiario en
// lib/server/catalogos.ts: se precalcula si el Concepto tiene historial real
// (nunca se depende solo de que la base de datos truene) y, según eso, se
// decide borrado físico o estado CANCELADO — nunca a medias.
//
// Relaciones que cuentan como "historial real" de un Concepto (todas FK sin
// onDelete explícito, protegidas por RESTRICT):
// - asignaciones (ContratoConcepto) — ya asignado a un contratista.
// - avances (AvanceConcepto) — avance físico ya reportado (aprobado o no).
// - corteDetalles (CorteSemanalConcepto) — ya en un corte de contratista.
// - estimacionCapaDetalles (EstimacionClienteCapaConcepto) — ya en una
//   Estimación Cliente EMITIDA (congelada para siempre).
// - requisiciones (Requisicion.conceptoContractualId) — ya referenciado en
//   una requisición de compra.
// Deliberadamente NO cuenta estimacionDetalles (EstimacionClienteConcepto):
// es un snapshot semanal que se borra y recrea en cada recálculo de
// borrador — existir ahí no es un evento de negocio irreversible.
// ---------------------------------------------------------------------------

async function evaluarEliminacionConcepto(conceptoId: string): Promise<boolean> {
  const [asignaciones, avances, cortes, estimacionesCapa, requisiciones] = await Promise.all([
    db.contratoConcepto.count({ where: { conceptoId } }),
    db.avanceConcepto.count({ where: { conceptoId } }),
    db.corteSemanalConcepto.count({ where: { conceptoId } }),
    db.estimacionClienteCapaConcepto.count({ where: { conceptoId } }),
    db.requisicion.count({ where: { conceptoContractualId: conceptoId } }),
  ]);
  return asignaciones + avances + cortes + estimacionesCapa + requisiciones === 0;
}

// Decide y ejecuta, para UN Concepto ya cargado: borrado físico si no tiene
// historial, o CANCELADO (con motivo) si sí lo tiene. Reutilizado tanto por
// eliminarConcepto como por eliminarPartida (cascada).
async function resolverEliminacionConcepto(
  tx: Prisma.TransactionClient,
  empresaId: string,
  usuarioId: string,
  concepto: { id: string; [campo: string]: unknown },
  motivo: string
): Promise<"ELIMINADO" | "CANCELADO"> {
  const puedeEliminar = await evaluarEliminacionConcepto(concepto.id);

  if (puedeEliminar) {
    await tx.concepto.delete({ where: { id: concepto.id } });
    await registrarAuditoriaTx(tx, {
      empresaId,
      usuarioId,
      entidad: "Concepto",
      entidadId: concepto.id,
      accion: "ELIMINAR",
      valorAnterior: { ...concepto, motivo },
    });
    return "ELIMINADO";
  }

  await tx.concepto.update({ where: { id: concepto.id }, data: { estatus: "CANCELADO" } });
  await registrarAuditoriaTx(tx, {
    empresaId,
    usuarioId,
    entidad: "Concepto",
    entidadId: concepto.id,
    accion: "CAMBIAR_ESTATUS",
    valorAnterior: { estatus: "ACTIVO" },
    valorNuevo: { estatus: "CANCELADO", motivo },
  });
  return "CANCELADO";
}

const MotivoSchema = z
  .string()
  .trim()
  .min(1, "El motivo es obligatorio.");

export async function eliminarConcepto(
  usuario: UsuarioSesion,
  id: string,
  motivoCrudo: unknown
): Promise<{ resultado: "ELIMINADO" | "CANCELADO" }> {
  if (!puedeEliminarEstructuraContractual(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;
  const motivo = MotivoSchema.parse(motivoCrudo);

  const concepto = await db.concepto.findFirst({
    where: { id, partida: { proyecto: { empresaId } } },
  });
  if (!concepto) throw new RegistroNoEncontradoError("El concepto");
  if (concepto.estatus === "CANCELADO") {
    throw new ValidacionError("Este concepto ya está cancelado.");
  }

  try {
    return await db.$transaction((tx) =>
      resolverEliminacionConcepto(tx, empresaId, usuario.id, concepto, motivo).then((resultado) => ({
        resultado,
      }))
    );
  } catch (error) {
    // Red de seguridad ante una carrera real (alguien creó una fila RESTRICT
    // justo entre el check y el delete) — mismo criterio que eliminarBeneficiario.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new ValidacionError(`No se puede eliminar "${concepto.descripcion}" porque tiene historial.`);
    }
    throw error;
  }
}

export async function eliminarPartida(
  usuario: UsuarioSesion,
  id: string,
  motivoCrudo: unknown
): Promise<{ resultado: "ELIMINADO" | "CANCELADO"; conceptosAfectados: number }> {
  if (!puedeEliminarEstructuraContractual(usuario)) throw new SinPermisoError();
  if (!usuario.empresa) throw new SinPermisoError();
  const empresaId = usuario.empresa.id;
  const motivo = MotivoSchema.parse(motivoCrudo);

  const partida = await db.partida.findFirst({
    where: { id, proyecto: { empresaId } },
    include: { conceptos: { where: { estatus: "ACTIVO" } } },
  });
  if (!partida) throw new RegistroNoEncontradoError("La partida");
  if (partida.estatus === "CANCELADA") {
    throw new ValidacionError("Esta partida ya está cancelada.");
  }

  try {
    return await db.$transaction(async (tx) => {
      // Cascada: cada Concepto activo se resuelve con el mismo criterio
      // individual (borrado físico o CANCELADO) antes de decidir la Partida.
      for (const concepto of partida.conceptos) {
        await resolverEliminacionConcepto(tx, empresaId, usuario.id, concepto, motivo);
      }

      // Si ya no queda ningún Concepto bajo esta Partida (todos se borraron
      // físicamente), la Partida también se borra físicamente. Si queda al
      // menos uno (cancelado, con historial), el FK lo impide — la Partida
      // queda como CANCELADA.
      const restantes = await tx.concepto.count({ where: { partidaId: id } });

      if (restantes === 0) {
        await tx.partida.delete({ where: { id } });
        await registrarAuditoriaTx(tx, {
          empresaId,
          usuarioId: usuario.id,
          entidad: "Partida",
          entidadId: id,
          accion: "ELIMINAR",
          valorAnterior: { nombre: partida.nombre, motivo },
        });
        return { resultado: "ELIMINADO" as const, conceptosAfectados: partida.conceptos.length };
      }

      await tx.partida.update({ where: { id }, data: { estatus: "CANCELADA" } });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: "Partida",
        entidadId: id,
        accion: "CAMBIAR_ESTATUS",
        valorAnterior: { estatus: "ACTIVA" },
        valorNuevo: { estatus: "CANCELADA", motivo },
      });
      return { resultado: "CANCELADO" as const, conceptosAfectados: partida.conceptos.length };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new ValidacionError(`No se puede eliminar "${partida.nombre}" porque tiene historial.`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Contratos de contratista
// ---------------------------------------------------------------------------

const DatosContratoSchema = z
  .object({
    beneficiarioId: z.string().trim().optional().nullable(),
    nombreNuevoContratista: z.string().trim().optional().nullable(),
    numeroContrato: z.string().trim().optional().nullable(),
    descripcion: z.string().trim().optional().nullable(),
    fecha: z.coerce.date().optional().nullable(),
  })
  .refine((datos) => Boolean(datos.beneficiarioId) !== Boolean(datos.nombreNuevoContratista), {
    message:
      "Elige un contratista existente o escribe el nombre de uno nuevo (no ambos, no ninguno).",
  });

// Resuelve la participación (BeneficiarioProyecto) del contratista en este
// proyecto — crea el Beneficiario y/o la participación si hace falta.
async function obtenerOCrearParticipacionContratista(
  empresaId: string,
  proyectoId: string,
  datos: {
    beneficiarioId?: string | null;
    nombreNuevoContratista?: string | null;
    // Solo se usa para SEMBRAR el catálogo (Contratista.descripcion) cuando
    // el contratista es nuevo — este primer contrato todavía no tiene una
    // especialidad capturada en Catálogos, así que su propia Descripción es
    // el mejor punto de partida. Un contratista ya existente nunca se
    // sobreescribe desde aquí (ver crearContratoContratista) — solo se edita
    // desde Catálogos.
    descripcionParaCatalogoSiEsNuevo?: string | null;
  }
) {
  let beneficiarioId = datos.beneficiarioId ?? undefined;

  if (!beneficiarioId && datos.nombreNuevoContratista) {
    const beneficiario = await db.beneficiario.create({
      data: {
        empresaId,
        tipo: "CONTRATISTA",
        nombre: datos.nombreNuevoContratista,
        contratista: {
          create: { descripcion: datos.descripcionParaCatalogoSiEsNuevo || null },
        },
      },
    });
    beneficiarioId = beneficiario.id;
  }

  if (!beneficiarioId) {
    throw new ValidacionError("Falta el contratista.");
  }

  const beneficiario = await db.beneficiario.findFirst({
    where: { id: beneficiarioId, empresaId, tipo: "CONTRATISTA" },
  });
  if (!beneficiario) throw new RegistroNoEncontradoError("El contratista");

  return db.beneficiarioProyecto.upsert({
    where: { beneficiarioId_proyectoId: { beneficiarioId, proyectoId } },
    update: {},
    create: { beneficiarioId, proyectoId },
  });
}

export async function crearContratoContratista(
  usuario: UsuarioSesion,
  proyectoId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);
  await obtenerProyecto(usuario, proyectoId);
  const datos = DatosContratoSchema.parse(datosCrudos);

  const beneficiarioProyecto = await obtenerOCrearParticipacionContratista(empresaId, proyectoId, {
    ...datos,
    descripcionParaCatalogoSiEsNuevo: datos.descripcion,
  });

  const contrato = await db.contratoContratista.create({
    data: {
      beneficiarioProyectoId: beneficiarioProyecto.id,
      numeroContrato: datos.numeroContrato,
      descripcion: datos.descripcion,
      fecha: datos.fecha,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "ContratoContratista",
    entidadId: contrato.id,
    accion: "CREAR",
    valorNuevo: contrato,
  });

  return contrato;
}

const DatosEditarContratoSchema = z.object({
  numeroContrato: z.string().trim().optional().nullable(),
  descripcion: z.string().trim().optional().nullable(),
  fecha: z.coerce.date().optional().nullable(),
});

export async function editarContratoContratista(
  usuario: UsuarioSesion,
  id: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);
  const anterior = await db.contratoContratista.findFirst({
    where: { id, beneficiarioProyecto: { proyecto: { empresaId } } },
  });
  if (!anterior) throw new RegistroNoEncontradoError("El contrato");

  const datos = DatosEditarContratoSchema.parse(datosCrudos);
  const contrato = await db.contratoContratista.update({
    where: { id },
    data: datos,
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "ContratoContratista",
    entidadId: contrato.id,
    accion: "EDITAR",
    valorAnterior: anterior,
    valorNuevo: contrato,
  });

  return contrato;
}

// ---------------------------------------------------------------------------
// Asignación de conceptos a un contrato
// ---------------------------------------------------------------------------

const DatosAsignacionSchema = z.object({
  conceptoId: z.string().trim().min(1),
});

// Asigna un concepto ya existente del Contrato General a un contratista.
// Cantidad y P.U. se HEREDAN del concepto (nunca se vuelven a capturar a
// mano) y quedan congelados en el momento de asignar — si después cambia el
// presupuesto del Contrato General, no afecta lo ya formalizado. Un concepto
// solo puede pertenecer a un contratista a la vez, nunca se reparte
// (decisión de sesión, agosto 2026, sección 49.9) — por eso esta operación es
// crear, no editar: no hay nada que un usuario pueda modificar aquí después.
export async function asignarConcepto(
  usuario: UsuarioSesion,
  contratoContratistaId: string,
  datosCrudos: unknown
) {
  const empresaId = requerirAdmin(usuario);

  const contrato = await db.contratoContratista.findFirst({
    where: { id: contratoContratistaId, beneficiarioProyecto: { proyecto: { empresaId } } },
    include: { beneficiarioProyecto: true },
  });
  if (!contrato) throw new RegistroNoEncontradoError("El contrato");

  const datos = DatosAsignacionSchema.parse(datosCrudos);

  // El concepto debe pertenecer al MISMO proyecto que el contrato (no solo a
  // la misma empresa) — si no, se estaría asignando trabajo de una obra al
  // contrato de otra.
  const concepto = await db.concepto.findFirst({
    where: {
      id: datos.conceptoId,
      partida: { proyectoId: contrato.beneficiarioProyecto.proyectoId },
    },
  });
  if (!concepto) throw new RegistroNoEncontradoError("El concepto");

  if (concepto.precioUnitarioContratista === null) {
    throw new ValidacionError(
      `"${concepto.descripcion}" todavía no tiene P.U. de contratista definido en Contrato General.`
    );
  }

  const yaAsignado = await db.contratoConcepto.findUnique({
    where: { conceptoId: datos.conceptoId },
  });
  if (yaAsignado) {
    throw new ValidacionError(
      yaAsignado.contratoContratistaId === contratoContratistaId
        ? `"${concepto.descripcion}" ya está asignado a este contrato.`
        : `"${concepto.descripcion}" ya está asignado a otro contratista.`
    );
  }

  // Obra migrada: lo ejecutado en semanas históricas importadas no se asigna
  // al contratista (no se le atribuye ni se vuelve saldo por pagar). Solo se
  // asigna lo que falta por ejecutar. Sin histórico, la cantidad es la del
  // concepto, como siempre.
  const historico =
    (await sumaHistoricaImportadaPorConcepto(contrato.beneficiarioProyecto.proyectoId, [concepto.id])).get(concepto.id) ?? 0;
  const cantidad = new Prisma.Decimal(concepto.cantidadContratada).minus(historico).toDecimalPlaces(3);
  if (cantidad.lte(0)) {
    throw new ValidacionError(
      `"${concepto.descripcion}" ya se ejecutó por completo en el histórico importado; no hay cantidad por asignar.`
    );
  }

  const asignacion = await db.contratoConcepto.create({
    data: {
      contratoContratistaId,
      conceptoId: datos.conceptoId,
      cantidad,
      precioUnitarioContratista: concepto.precioUnitarioContratista,
    },
  });

  await registrarAuditoria({
    empresaId,
    usuarioId: usuario.id,
    entidad: "ContratoConcepto",
    entidadId: asignacion.id,
    accion: "CREAR",
    valorNuevo: asignacion,
  });

  return asignacion;
}

import "server-only";
import * as z from "zod";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { RegistroNoEncontradoError } from "@/lib/server/control-de-obra/estructura-contractual";
import { requerirUsoComercial } from "@/lib/server/comercializacion/acceso";

// Clientes y obras comerciales — B2 (noviembre 2026). Entidades propias de
// Comercialización: no crean Proyecto, contratos ni semanas. Administración y
// vendedores pueden consultarlos y dar de alta los mínimos desde el
// formulario de cotización. Los selectores solo devuelven id y nombre: nunca
// cotizaciones, importes ni a qué vendedor pertenece cada cliente.

export const ENTIDAD_CLIENTE = "ClienteComercial";
export const ENTIDAD_OBRA = "ObraComercial";

export type OpcionCliente = { id: string; nombre: string };
export type OpcionObra = { id: string; nombre: string; clienteId: string };

export async function listarClientesYObras(usuario: UsuarioSesion): Promise<{ clientes: OpcionCliente[]; obras: OpcionObra[] }> {
  const empresaId = requerirUsoComercial(usuario);
  const [clientes, obras] = await Promise.all([
    db.clienteComercial.findMany({ where: { empresaId }, select: { id: true, nombre: true }, orderBy: { nombre: "asc" } }),
    db.obraComercial.findMany({
      where: { empresaId },
      select: { id: true, nombre: true, clienteId: true },
      orderBy: { nombre: "asc" },
    }),
  ]);
  return { clientes, obras };
}

const textoOpcional = (max: number, campo: string) =>
  z
    .string()
    .trim()
    .max(max, `${campo} admite máximo ${max} caracteres.`)
    .optional()
    .transform((v) => (v ? v : null));

const esquemaCliente = z.object({
  nombre: z.string({ error: "El nombre del cliente es obligatorio." }).trim().min(1, "El nombre del cliente es obligatorio.").max(200, "El nombre admite máximo 200 caracteres."),
  contacto: textoOpcional(200, "El contacto"),
  telefono: textoOpcional(40, "El teléfono"),
});

const esquemaObra = z.object({
  clienteId: z.string({ error: "Selecciona un cliente." }).min(1, "Selecciona un cliente."),
  nombre: z.string({ error: "El nombre de la obra es obligatorio." }).trim().min(1, "El nombre de la obra es obligatorio.").max(200, "El nombre admite máximo 200 caracteres."),
  ubicacion: textoOpcional(300, "La ubicación"),
});

const esUnica = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
  /23505|unique constraint/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

/**
 * Alta mínima de cliente. Si ya existe uno con el mismo nombre (sin
 * distinguir mayúsculas/espacios) en la Empresa, se devuelve ESE en lugar de
 * duplicarlo — también cubre el doble clic.
 */
export async function crearClienteComercial(
  usuario: UsuarioSesion,
  datosCrudos: unknown
): Promise<OpcionCliente & { existente: boolean }> {
  const empresaId = requerirUsoComercial(usuario);
  const datos = esquemaCliente.parse(datosCrudos);
  // Misma expresión que el índice único (no `mode: "insensitive"`, que usa
  // ILIKE y trata "_"/"%" como comodines).
  const buscar = async () =>
    (
      await db.$queryRaw<OpcionCliente[]>`
        SELECT id, nombre FROM clientes_comerciales
        WHERE "empresaId" = ${empresaId} AND lower(btrim(nombre)) = lower(btrim(${datos.nombre}))
        LIMIT 1`
    )[0] ?? null;

  const previo = await buscar();
  if (previo) return { ...previo, existente: true };
  try {
    return await db.$transaction(async (tx) => {
      const creado = await tx.clienteComercial.create({
        data: { empresaId, nombre: datos.nombre, contacto: datos.contacto, telefono: datos.telefono, creadoPorId: usuario.id },
        select: { id: true, nombre: true },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_CLIENTE,
        entidadId: creado.id,
        accion: "CREAR",
        valorNuevo: datos,
      });
      return { ...creado, existente: false };
    });
  } catch (error) {
    if (!esUnica(error)) throw error;
    const ganador = await buscar();
    if (!ganador) throw error;
    return { ...ganador, existente: true };
  }
}

/** Alta mínima de obra de un cliente de la misma Empresa (misma regla anti-duplicado). */
export async function crearObraComercial(
  usuario: UsuarioSesion,
  datosCrudos: unknown
): Promise<OpcionObra & { existente: boolean }> {
  const empresaId = requerirUsoComercial(usuario);
  const datos = esquemaObra.parse(datosCrudos);
  const cliente = await db.clienteComercial.findFirst({ where: { id: datos.clienteId, empresaId }, select: { id: true } });
  if (!cliente) throw new RegistroNoEncontradoError("El cliente");

  const buscar = async () =>
    (
      await db.$queryRaw<OpcionObra[]>`
        SELECT id, nombre, "clienteId" FROM obras_comerciales
        WHERE "empresaId" = ${empresaId} AND "clienteId" = ${cliente.id}
          AND lower(btrim(nombre)) = lower(btrim(${datos.nombre}))
        LIMIT 1`
    )[0] ?? null;

  const previa = await buscar();
  if (previa) return { ...previa, existente: true };
  try {
    return await db.$transaction(async (tx) => {
      const creada = await tx.obraComercial.create({
        data: { empresaId, clienteId: cliente.id, nombre: datos.nombre, ubicacion: datos.ubicacion, creadoPorId: usuario.id },
        select: { id: true, nombre: true, clienteId: true },
      });
      await registrarAuditoriaTx(tx, {
        empresaId,
        usuarioId: usuario.id,
        entidad: ENTIDAD_OBRA,
        entidadId: creada.id,
        accion: "CREAR",
        valorNuevo: datos,
      });
      return { ...creada, existente: false };
    });
  } catch (error) {
    if (!esUnica(error)) throw error;
    const ganadora = await buscar();
    if (!ganadora) throw error;
    return { ...ganadora, existente: true };
  }
}

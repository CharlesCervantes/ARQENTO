// Ajuste puntual del P.U. (y, solo si se indica, la cantidad) de una asignación concepto→contratista
// (ContratoConcepto). Existe porque hoy la UI no permite editar una asignación
// después de crearla: guarda una copia fija del P.U./cantidad de Contrato
// General al asignar, y Avance de obra valúa con esa copia.
//
// Lo histórico NO se toca: AvanceConcepto.montoEjecutado y
// CorteSemanalConcepto.precioUnitarioContratista guardan su propio precio,
// así que semanas ya capturadas/cerradas conservan el P.U. anterior.
//
// Uso (PowerShell), primero en vista previa (no escribe nada):
//   $env:DATABASE_URL = "<conexión de producción>"
//   $env:PROYECTO_ID = "<id del proyecto>"
//   $env:CONCEPTO_TEXTO = "<inicio de la descripción del concepto>"
//   $env:NUEVO_PU = "850"
//   $env:USUARIO_EMAIL = "<email del admin que autoriza>"
//   node --conditions=react-server --import tsx scripts/mantenimiento/ajustar-pu-asignacion.ts
// Para aplicar: agregar $env:APLICAR = "1" y volver a correr.
import "dotenv/config";
import { db } from "@/lib/server/db";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";
import { Prisma } from "@/lib/generated/prisma/client";

function requerido(nombre: string): string {
  const v = process.env[nombre]?.trim();
  if (!v) throw new Error(`Falta la variable ${nombre}.`);
  return v;
}

async function main() {
  const proyectoId = requerido("PROYECTO_ID");
  const textoConcepto = requerido("CONCEPTO_TEXTO");
  const nuevoPu = new Prisma.Decimal(requerido("NUEVO_PU"));
  const email = requerido("USUARIO_EMAIL");
  const aplicar = process.env.APLICAR === "1";

  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[/?].*$/, "");
  console.log(`Base: ${host}`);

  const proyecto = await db.proyecto.findUnique({
    where: { id: proyectoId },
    select: { id: true, nombre: true, empresaId: true },
  });
  if (!proyecto) throw new Error("El proyecto no existe en esta base.");

  const usuario = await db.usuario.findFirst({
    where: { email, empresaId: proyecto.empresaId, activo: true, rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } },
    select: { id: true, nombre: true },
  });
  if (!usuario) throw new Error("No hay un Administrador/Director activo con ese email en la empresa del proyecto.");

  const asignaciones = await db.contratoConcepto.findMany({
    where: {
      concepto: {
        partida: { proyectoId },
        descripcion: { startsWith: textoConcepto, mode: "insensitive" },
      },
    },
    include: { concepto: { select: { descripcion: true, cantidadContratada: true } } },
  });
  if (asignaciones.length !== 1) {
    throw new Error(`Se esperaba 1 asignación y hay ${asignaciones.length}. Afina CONCEPTO_TEXTO.`);
  }
  const a = asignaciones[0];
  // Por omisión SOLO cambia el P.U.: la cantidad asignada se conserva (en una
  // obra migrada ya excluye el avance histórico importado; reescribirla con
  // la cantidad del concepto lo volvería a cargar al contratista). Cambiarla
  // exige indicarla explícitamente con NUEVA_CANTIDAD.
  const nuevaCantidad = process.env.NUEVA_CANTIDAD?.trim()
    ? new Prisma.Decimal(process.env.NUEVA_CANTIDAD.trim())
    : a.cantidad;

  console.log(`Proyecto: ${proyecto.nombre}`);
  console.log(`Concepto: ${a.concepto.descripcion.slice(0, 80)}`);
  console.log(`Cantidad: ${a.cantidad} → ${nuevaCantidad}`);
  console.log(`P.U. contratista: ${a.precioUnitarioContratista} → ${nuevoPu}`);
  console.log(`Autoriza: ${usuario.nombre}`);

  if (!aplicar) {
    console.log("\nVista previa: no se escribió nada. Agrega APLICAR=1 para aplicar.");
    return;
  }

  await db.$transaction(async (tx) => {
    const actualizado = await tx.contratoConcepto.update({
      where: { id: a.id },
      data: { cantidad: nuevaCantidad, precioUnitarioContratista: nuevoPu },
    });
    await registrarAuditoriaTx(tx, {
      empresaId: proyecto.empresaId,
      usuarioId: usuario.id,
      entidad: "ContratoConcepto",
      entidadId: a.id,
      accion: "EDITAR",
      valorAnterior: { cantidad: a.cantidad, precioUnitarioContratista: a.precioUnitarioContratista },
      valorNuevo: {
        cantidad: actualizado.cantidad,
        precioUnitarioContratista: actualizado.precioUnitarioContratista,
        motivo: process.env.MOTIVO?.trim() || "Ajuste de P.U. contratado (script de mantenimiento)",
      },
    });
  });
  console.log("\nAplicado y registrado en auditoría.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

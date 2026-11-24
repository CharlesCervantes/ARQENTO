// Bloquea o desbloquea el cierre de semanas y las estimaciones de UNA obra
// (Proyecto.motivoBloqueoEstimaciones). No toca ningún otro dato.
//
// Variables: PROYECTO_ID, USUARIO_EMAIL (Administrador/Director que autoriza) y
//   MOTIVO="texto"   → bloquea (el texto lo ve cualquier rol: sin datos privados)
//   DESBLOQUEAR=1    → quita el bloqueo
// Vista previa por omisión; APLICAR=1 escribe y deja bitácora.
//   node --conditions=react-server --import tsx scripts/mantenimiento/bloqueo-estimaciones.ts
import "dotenv/config";
import { db } from "@/lib/server/db";
import { registrarAuditoriaTx } from "@/lib/server/auditoria";

function requerido(nombre: string): string {
  const v = process.env[nombre]?.trim();
  if (!v) throw new Error(`Falta la variable ${nombre}.`);
  return v;
}

async function main() {
  const proyectoId = requerido("PROYECTO_ID");
  const email = requerido("USUARIO_EMAIL");
  const desbloquear = process.env.DESBLOQUEAR === "1";
  const motivo = desbloquear ? null : requerido("MOTIVO");

  const proyecto = await db.proyecto.findUnique({
    where: { id: proyectoId },
    select: { nombre: true, empresaId: true, motivoBloqueoEstimaciones: true },
  });
  if (!proyecto) throw new Error("El proyecto no existe en esta base.");
  const usuario = await db.usuario.findFirst({
    where: { email, empresaId: proyecto.empresaId, activo: true, rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } },
    select: { id: true },
  });
  if (!usuario) throw new Error("No hay un Administrador/Director activo con ese email en la empresa del proyecto.");

  console.log(`Proyecto: ${proyecto.nombre}`);
  console.log(`Bloqueo: ${proyecto.motivoBloqueoEstimaciones ?? "(ninguno)"} → ${motivo ?? "(ninguno)"}`);
  if (process.env.APLICAR !== "1") {
    console.log("Vista previa: no se escribió nada. Agrega APLICAR=1 para aplicar.");
    return;
  }
  await db.$transaction(async (tx) => {
    await tx.proyecto.update({ where: { id: proyectoId }, data: { motivoBloqueoEstimaciones: motivo } });
    await registrarAuditoriaTx(tx, {
      empresaId: proyecto.empresaId,
      usuarioId: usuario.id,
      entidad: "Proyecto",
      entidadId: proyectoId,
      accion: "EDITAR",
      valorAnterior: { motivoBloqueoEstimaciones: proyecto.motivoBloqueoEstimaciones },
      valorNuevo: { motivoBloqueoEstimaciones: motivo },
    });
  });
  console.log("Aplicado y registrado en bitácora.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

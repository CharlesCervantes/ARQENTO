// Regresa a BORRADOR las capas EMITIDAS de la estimación de cliente de un
// proyecto+semana, para poder reabrir esa semana (reabrirSemana lo bloquea
// mientras alguna capa esté EMITIDA). Deshace exactamente lo que escribe
// emitirEstimacion + el primer documento PDF:
//   - borra el snapshot congelado de la capa (EstimacionClienteCapaConcepto,
//     EstimacionClienteGasto + detalle), que se vuelve a crear al re-emitir;
//   - limpia folio, totales, emisión y corte del documento;
//   - regresa el contador de folios del proyecto, solo si esta capa fue la
//     última emitida (así la re-emisión conserva el mismo número).
// NO toca: el detalle físico, los gastos reclamados por la capa (siguen
// ligados, igual que en una semana reabierta), avances, cortes ni cierres.
// Se niega si la capa tiene pagos/movimientos financieros, está incluida en
// contabilidad, o no es la última emitida. El estado anterior completo queda
// en la bitácora de auditoría.
//
// Uso: DATABASE_URL=<producción> USUARIO_EMAIL=<admin> PROYECTO_ID=<id>
//      SEMANA_NUMERO=<n> MOTIVO="<texto>" [APLICAR=1]
//   node --conditions=react-server --import tsx scripts/mantenimiento/desemitir-estimacion.ts
import "dotenv/config";
import { db } from "@/lib/server/db";
import { Prisma } from "@/lib/generated/prisma/client";

function requerido(nombre: string): string {
  const v = process.env[nombre]?.trim();
  if (!v) throw new Error(`Falta la variable ${nombre}.`);
  return v;
}

async function main() {
  const proyectoId = requerido("PROYECTO_ID");
  const semanaNumero = Number(requerido("SEMANA_NUMERO"));
  const email = requerido("USUARIO_EMAIL");
  const motivo = requerido("MOTIVO");
  const aplicar = process.env.APLICAR === "1";
  console.log(`Base: ${(process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[/?].*$/, "")}`);

  const proyecto = await db.proyecto.findUniqueOrThrow({
    where: { id: proyectoId },
    select: { nombre: true, empresaId: true, ultimoNumeroEstimacionOperativo: true, ultimoNumeroEstimacionPrivado: true },
  });
  const usuario = await db.usuario.findFirst({
    where: { email, empresaId: proyecto.empresaId, activo: true, rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } },
    select: { id: true, nombre: true },
  });
  if (!usuario) throw new Error("No hay un Administrador/Director activo con ese email.");

  const estimaciones = await db.estimacionCliente.findMany({
    where: { proyectoId, semana: { numero: semanaNumero } },
    include: {
      semana: { select: { numero: true, anio: true } },
      capas: {
        include: {
          detalle: true,
          gastos: { include: { detalle: true } },
          _count: { select: { movimientosFinancieros: true } },
        },
      },
    },
  });
  if (estimaciones.length !== 1) throw new Error(`Se esperaba 1 estimación en la semana ${semanaNumero} y hay ${estimaciones.length}.`);
  const est = estimaciones[0];
  const emitidas = est.capas.filter((c) => c.estatus === "EMITIDA");
  if (emitidas.length === 0) throw new Error("Ninguna capa está EMITIDA — nada que hacer.");

  for (const c of emitidas) {
    if (c._count.movimientosFinancieros > 0) throw new Error(`La capa ${c.capa} tiene pagos/movimientos registrados.`);
    if (c.incluidoEnContabilidad) throw new Error(`La capa ${c.capa} ya está incluida en contabilidad.`);
    const ultimo = c.capa === "OPERATIVO" ? proyecto.ultimoNumeroEstimacionOperativo : proyecto.ultimoNumeroEstimacionPrivado;
    if (c.numero !== ultimo) throw new Error(`La capa ${c.capa} (folio ${c.numero}) no es la última emitida (${ultimo}).`);
  }

  console.log(`Proyecto: ${proyecto.nombre}   Semana ${est.semana.numero}/${est.semana.anio}   Autoriza: ${usuario.nombre}`);
  for (const c of emitidas) {
    console.log(`  ${c.capa}: folio ${c.numero}, total $${Number(c.total)}, ${c.detalle.length} conceptos, ${c.gastos.length} gastos → BORRADOR${c.fechaCorteDocumento ? " (ya se había generado su PDF)" : ""}`);
  }

  if (!aplicar) {
    console.log("\nVista previa: no se escribió nada. Agrega APLICAR=1 para aplicar.");
    return;
  }

  await db.$transaction(async (tx) => {
    for (const c of emitidas) {
      const gastoIds = c.gastos.map((g) => g.id);
      await tx.estimacionClienteGastoDetalle.deleteMany({ where: { estimacionClienteGastoId: { in: gastoIds } } });
      await tx.estimacionClienteGasto.deleteMany({ where: { id: { in: gastoIds } } });
      await tx.estimacionClienteCapaConcepto.deleteMany({ where: { estimacionClienteCapaId: c.id } });
      await tx.estimacionClienteCapa.update({
        where: { id: c.id },
        data: {
          estatus: "BORRADOR",
          numero: null,
          emitidoPorId: null,
          emitidoEn: null,
          subtotal: 0,
          montoAdministracionTrabajos: 0,
          subtotalGastosCobrables: 0,
          porcentajeAdministracionGastos: null,
          montoAdministracionGastos: 0,
          montoIVA: 0,
          total: 0,
          fechaCorteDocumento: null,
          montoContratoCongelado: null,
          brandingSnapshot: Prisma.DbNull,
        },
      });
      const campo = c.capa === "OPERATIVO" ? "ultimoNumeroEstimacionOperativo" : "ultimoNumeroEstimacionPrivado";
      await tx.proyecto.update({ where: { id: proyectoId }, data: { [campo]: { decrement: 1 } } });

      const { detalle, gastos, _count, ...capaAnterior } = c;
      await tx.registroAuditoria.create({
        data: {
          empresaId: proyecto.empresaId,
          usuarioId: usuario.id,
          entidad: "EstimacionClienteCapa",
          entidadId: c.id,
          accion: "CAMBIAR_ESTATUS",
          valorAnterior: JSON.parse(JSON.stringify({ ...capaAnterior, detalle, gastos })),
          valorNuevo: { estatus: "BORRADOR", folioLiberado: c.numero, motivo, via: "script de mantenimiento" },
        },
      });
    }
  });
  console.log("\nAplicado y registrado en auditoría.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

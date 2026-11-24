// Ajuste puntual CIENEGA (18-nov-2026): el concepto "Supervisión e inspección"
// se asignó por error al contrato de Nelson Acosta; corresponde a Andrés Garza
// como supervisor. La semana 46 ya tiene estimación de cliente EMITIDA, así que
// no se puede reabrir/recerrar desde la app — se corrige aquí, en una sola
// transacción y con auditoría:
//   1. Crea un contrato "Supervisión de obra" para Andrés en CIENEGA.
//   2. Mueve la asignación del concepto de supervisión a ese contrato (mismo
//      P.U. y cantidad congelados).
//   3. Semana 46: quita la línea de supervisión del corte de Nelson
//      ($5,000 → $3,000) y ajusta su MovimientoSemanal.
//   4. Semana 46: crea el corte de Andrés por esa línea ($2,000) con su
//      MovimientoSemanal APROBADO / PENDIENTE_PAGO (el pago se liquida desde
//      Reporte General como cualquier otro).
// No toca AvanceConcepto ni la estimación de cliente emitida.
//
// Uso: DATABASE_URL=<producción> USUARIO_EMAIL=<admin> [APLICAR=1]
//   node --conditions=react-server --import tsx scripts/mantenimiento/reasignar-concepto-cienega.ts
import "dotenv/config";
import { db } from "@/lib/server/db";

const PROYECTO_ID = "cmwf3ujod000007l4fk9d57k6";
const BP_NELSON = "cmwfi2hjp000107jukqphigbo";
const BP_ANDRES = "cmwfgygs6000307l0vab6w3og";
const CONTRATO_NELSON = "cmwfi2hl3000207jumr3mmh1g";
const CC_SUPERVISION = "cmwfi4e1o000407jusnxzi3ch";
const CORTE_NELSON_S46 = "cmwfpsi2t000308jkgpnzeidz";

async function main() {
  const email = process.env.USUARIO_EMAIL?.trim();
  if (!email) throw new Error("Falta USUARIO_EMAIL.");
  const aplicar = process.env.APLICAR === "1";
  console.log(`Base: ${(process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[/?].*$/, "")}`);

  const proyecto = await db.proyecto.findUniqueOrThrow({
    where: { id: PROYECTO_ID },
    select: { nombre: true, empresaId: true },
  });
  const usuario = await db.usuario.findFirst({
    where: { email, empresaId: proyecto.empresaId, activo: true, rol: { in: ["ADMINISTRADOR", "DIRECTOR"] } },
    select: { id: true, nombre: true },
  });
  if (!usuario) throw new Error("No hay un Administrador/Director activo con ese email.");

  const andres = await db.beneficiarioProyecto.findFirstOrThrow({
    where: { id: BP_ANDRES, proyectoId: PROYECTO_ID },
    select: { beneficiario: { select: { nombre: true } } },
  });
  const cc = await db.contratoConcepto.findUniqueOrThrow({
    where: { id: CC_SUPERVISION },
    include: { concepto: { select: { descripcion: true } } },
  });
  if (cc.contratoContratistaId !== CONTRATO_NELSON) {
    throw new Error("La asignación de supervisión ya no está en el contrato de Nelson — nada que hacer.");
  }
  const corteNelson = await db.corteSemanal.findUniqueOrThrow({
    where: { id: CORTE_NELSON_S46 },
    include: { detalle: true, movimientoSemanal: true, recibos: true },
  });
  if (corteNelson.beneficiarioProyectoId !== BP_NELSON) throw new Error("El corte no es de Nelson.");
  if (corteNelson.movimientoSemanal?.estatusPago === "LIQUIDADO") {
    throw new Error("El corte de Nelson ya está LIQUIDADO — no se modifica.");
  }
  if (corteNelson.recibos.some((r) => r.estatus === "VIGENTE")) {
    throw new Error("El corte de Nelson tiene un recibo vigente — revisar antes de ajustar.");
  }
  const lineaSupervision = corteNelson.detalle.find((d) => d.contratoConceptoId === CC_SUPERVISION);
  if (!lineaSupervision) throw new Error("El corte de Nelson no trae la línea de supervisión.");
  const yaTieneCorteAndres = await db.corteSemanal.findFirst({
    where: { proyectoId: PROYECTO_ID, semanaId: corteNelson.semanaId, beneficiarioProyectoId: BP_ANDRES },
  });
  if (yaTieneCorteAndres) throw new Error("Andrés ya tiene corte en esa semana — revisar.");

  const importe = Number(lineaSupervision.importe);
  const nuevoNetoNelson = Number(corteNelson.montoNeto) - importe;
  const nuevoBrutoNelson = Number(corteNelson.montoBruto) - importe;

  console.log(`Proyecto: ${proyecto.nombre}   Autoriza: ${usuario.nombre}`);
  console.log(`Concepto: ${cc.concepto.descripcion.slice(0, 60)}`);
  console.log(`  Contrato: Nelson → nuevo contrato "Supervisión de obra" de ${andres.beneficiario.nombre}`);
  console.log(`Corte semana 46 de Nelson: $${Number(corteNelson.montoNeto)} → $${nuevoNetoNelson}`);
  console.log(`Corte semana 46 de ${andres.beneficiario.nombre}: nuevo por $${importe} (pendiente de pago)`);

  if (!aplicar) {
    console.log("\nVista previa: no se escribió nada. Agrega APLICAR=1 para aplicar.");
    return;
  }

  await db.$transaction(async (tx) => {
    const auditorias: { entidad: string; entidadId: string; accion: "CREAR" | "EDITAR"; valorAnterior?: object; valorNuevo: object }[] = [];
    const motivo = "Corrección: supervisión asignada por error a Nelson; corresponde a Andrés (supervisor)";

    const contrato = await tx.contratoContratista.create({
      data: { beneficiarioProyectoId: BP_ANDRES, descripcion: "Supervisión de obra" },
    });
    auditorias.push({ entidad: "ContratoContratista", entidadId: contrato.id, accion: "CREAR", valorNuevo: { beneficiarioProyectoId: BP_ANDRES, descripcion: contrato.descripcion, motivo } });

    await tx.contratoConcepto.update({ where: { id: CC_SUPERVISION }, data: { contratoContratistaId: contrato.id } });
    auditorias.push({ entidad: "ContratoConcepto", entidadId: CC_SUPERVISION, accion: "EDITAR", valorAnterior: { contratoContratistaId: CONTRATO_NELSON }, valorNuevo: { contratoContratistaId: contrato.id, motivo } });

    // Corte de Nelson: sin la línea de supervisión.
    await tx.corteSemanalConcepto.delete({ where: { id: lineaSupervision.id } });
    await tx.corteSemanal.update({ where: { id: corteNelson.id }, data: { montoBruto: nuevoBrutoNelson, montoNeto: nuevoNetoNelson } });
    await tx.movimientoSemanal.update({ where: { id: corteNelson.movimientoSemanalId! }, data: { montoFinSemana: nuevoNetoNelson } });
    auditorias.push({
      entidad: "CorteSemanal", entidadId: corteNelson.id, accion: "EDITAR",
      valorAnterior: { montoBruto: Number(corteNelson.montoBruto), montoNeto: Number(corteNelson.montoNeto), lineaRetirada: { ...lineaSupervision } },
      valorNuevo: { montoBruto: nuevoBrutoNelson, montoNeto: nuevoNetoNelson, motivo },
    });
    auditorias.push({
      entidad: "MovimientoSemanal", entidadId: corteNelson.movimientoSemanalId!, accion: "EDITAR",
      valorAnterior: { montoFinSemana: Number(corteNelson.movimientoSemanal!.montoFinSemana) },
      valorNuevo: { montoFinSemana: nuevoNetoNelson, motivo },
    });

    // Corte nuevo de Andrés, misma forma que lo crea cerrarSemana.
    const movimiento = await tx.movimientoSemanal.create({
      data: {
        beneficiarioProyectoId: BP_ANDRES,
        semanaId: corteNelson.semanaId,
        contratoContratistaId: contrato.id,
        origen: "CORTE_CONTRATISTA",
        montoFinSemana: importe,
        estatusAprobacion: "APROBADO",
        estatusPago: "PENDIENTE_PAGO",
        enviadoPorId: usuario.id,
        aprobadoPorId: usuario.id,
      },
    });
    const numero = (await tx.corteSemanal.count({ where: { proyectoId: PROYECTO_ID } })) + 1;
    const corte = await tx.corteSemanal.create({
      data: {
        empresaId: proyecto.empresaId,
        proyectoId: PROYECTO_ID,
        semanaId: corteNelson.semanaId,
        cierreSemanaProyectoId: corteNelson.cierreSemanaProyectoId,
        beneficiarioProyectoId: BP_ANDRES,
        numero,
        montoBruto: importe,
        montoNeto: importe,
        estatus: "GENERADO",
        movimientoSemanalId: movimiento.id,
        generadoPorId: usuario.id,
      },
    });
    await tx.corteSemanalConcepto.create({
      data: {
        corteSemanalId: corte.id,
        conceptoId: lineaSupervision.conceptoId,
        contratoConceptoId: CC_SUPERVISION,
        avanceConceptoId: lineaSupervision.avanceConceptoId,
        descripcionConcepto: lineaSupervision.descripcionConcepto,
        unidad: lineaSupervision.unidad,
        cantidadEjecutada: lineaSupervision.cantidadEjecutada,
        precioUnitarioContratista: lineaSupervision.precioUnitarioContratista,
        importe: lineaSupervision.importe,
      },
    });
    auditorias.push({ entidad: "CorteSemanal", entidadId: corte.id, accion: "CREAR", valorNuevo: { montoBruto: importe, montoNeto: importe, estatus: "GENERADO", motivo } });
    auditorias.push({ entidad: "MovimientoSemanal", entidadId: movimiento.id, accion: "CREAR", valorNuevo: { beneficiarioProyectoId: BP_ANDRES, montoFinSemana: importe, estatusAprobacion: "APROBADO", estatusPago: "PENDIENTE_PAGO", motivo } });

    await tx.registroAuditoria.createMany({
      data: auditorias.map((a) => ({
        empresaId: proyecto.empresaId,
        usuarioId: usuario.id,
        entidad: a.entidad,
        entidadId: a.entidadId,
        accion: a.accion,
        valorAnterior: a.valorAnterior ? JSON.parse(JSON.stringify(a.valorAnterior)) : undefined,
        valorNuevo: JSON.parse(JSON.stringify(a.valorNuevo)),
      })),
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

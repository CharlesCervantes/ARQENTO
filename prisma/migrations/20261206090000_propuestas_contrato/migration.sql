-- Partidas y conceptos propuestos por un Supervisor. Aditiva: tabla nueva, vacía.
CREATE TYPE "TipoPropuestaContrato" AS ENUM ('PARTIDA', 'CONCEPTO');
CREATE TYPE "EstatusPropuestaContrato" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA', 'RETIRADA');
CREATE TABLE "propuestas_contrato" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "tipo" "TipoPropuestaContrato" NOT NULL,
    "estatus" "EstatusPropuestaContrato" NOT NULL DEFAULT 'PENDIENTE',
    "partidaId" TEXT,
    "padreId" TEXT,
    "descripcion" TEXT NOT NULL,
    "icono" TEXT,
    "color" TEXT,
    "unidad" TEXT,
    "cantidad" DECIMAL(14,3),
    "precioUnitarioContratista" DECIMAL(14,2),
    "precioUnitarioMateriales" DECIMAL(14,2),
    "solicitadoPorId" TEXT NOT NULL,
    "resueltoPorId" TEXT,
    "resueltoEn" TIMESTAMP(3),
    "motivo" TEXT,
    "resultadoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propuestas_contrato_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "propuestas_contrato_concepto" CHECK ("tipo" = 'PARTIDA' OR ("unidad" IS NOT NULL AND "cantidad" > 0))
);
CREATE INDEX "propuestas_contrato_proyectoId_estatus_idx" ON "propuestas_contrato"("proyectoId", "estatus");
CREATE INDEX "propuestas_contrato_empresaId_estatus_idx" ON "propuestas_contrato"("empresaId", "estatus");
ALTER TABLE "propuestas_contrato" ADD CONSTRAINT "propuestas_contrato_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "propuestas_contrato" ADD CONSTRAINT "propuestas_contrato_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "partidas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "propuestas_contrato" ADD CONSTRAINT "propuestas_contrato_padreId_fkey" FOREIGN KEY ("padreId") REFERENCES "propuestas_contrato"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "propuestas_contrato" ADD CONSTRAINT "propuestas_contrato_solicitadoPorId_fkey" FOREIGN KEY ("solicitadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "propuestas_contrato" ADD CONSTRAINT "propuestas_contrato_resueltoPorId_fkey" FOREIGN KEY ("resueltoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

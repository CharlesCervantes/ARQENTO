-- Cantidad e importe estimados por capa (aditiva). No modifica filas existentes.

-- Cantidades propias de la capa congeladas al emitir (null en filas anteriores).
ALTER TABLE "estimacion_cliente_capa_conceptos"
    ADD COLUMN "partidaNombre" TEXT,
    ADD COLUMN "descripcionConcepto" TEXT,
    ADD COLUMN "unidad" TEXT,
    ADD COLUMN "cantidadContratada" DECIMAL(18,6),
    ADD COLUMN "cantidadAnterior" DECIMAL(18,6),
    ADD COLUMN "cantidadEstaSemana" DECIMAL(18,6),
    ADD COLUMN "cantidadAcumulada" DECIMAL(18,6),
    ADD COLUMN "cantidadPorEjercer" DECIMAL(18,6),
    ADD COLUMN "avancePorcentaje" DECIMAL(7,2);

-- CreateTable
CREATE TABLE "estimados_capa_concepto" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "conceptoId" TEXT NOT NULL,
    "semanaId" TEXT NOT NULL,
    "capa" "CapaEstimacion" NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "importeBase" DECIMAL(14,2),
    "origen" TEXT NOT NULL,
    "historicoImportado" BOOLEAN NOT NULL DEFAULT false,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimados_capa_concepto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "estimados_capa_concepto_conceptoId_semanaId_capa_key" ON "estimados_capa_concepto"("conceptoId", "semanaId", "capa");
CREATE INDEX "estimados_capa_concepto_proyectoId_capa_idx" ON "estimados_capa_concepto"("proyectoId", "capa");
CREATE INDEX "estimados_capa_concepto_semanaId_idx" ON "estimados_capa_concepto"("semanaId");

-- AddForeignKey
ALTER TABLE "estimados_capa_concepto" ADD CONSTRAINT "estimados_capa_concepto_conceptoId_fkey" FOREIGN KEY ("conceptoId") REFERENCES "conceptos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "estimados_capa_concepto" ADD CONSTRAINT "estimados_capa_concepto_semanaId_fkey" FOREIGN KEY ("semanaId") REFERENCES "semanas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Estimaciones emitidas antes de ARQENTO. Aditiva: tabla nueva, vacía.
CREATE TABLE "estimaciones_externas" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "semanaId" TEXT NOT NULL,
    "capa" "CapaEstimacion" NOT NULL,
    "numero" INTEGER NOT NULL,
    "importe" DECIMAL(18,6) NOT NULL,
    "iva" DECIMAL(18,6) NOT NULL,
    "importeNeto" DECIMAL(18,6) NOT NULL,
    "fechaRecepcion" TEXT,
    "fechaPago" TEXT,
    "concepto" TEXT,
    "origen" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimaciones_externas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "estimaciones_externas_neto" CHECK ("importeNeto" = "importe" + "iva")
);
CREATE UNIQUE INDEX "estimaciones_externas_proyectoId_capa_numero_key" ON "estimaciones_externas"("proyectoId", "capa", "numero");
CREATE UNIQUE INDEX "estimaciones_externas_proyectoId_semanaId_capa_key" ON "estimaciones_externas"("proyectoId", "semanaId", "capa");
ALTER TABLE "estimaciones_externas" ADD CONSTRAINT "estimaciones_externas_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "estimaciones_externas" ADD CONSTRAINT "estimaciones_externas_semanaId_fkey" FOREIGN KEY ("semanaId") REFERENCES "semanas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

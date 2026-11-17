-- Comercialización — B1: módulo, función Vendedor y catálogo de productos
-- (noviembre 2026). Ver docs/negocio/comercializacion.md.
-- Migración ADITIVA: compatible con el código anterior (columna nueva con
-- default, tabla y enum nuevos, fila de catálogo de módulos).

-- Catálogo de módulos: se registra el módulo SIN habilitarlo para ninguna
-- Empresa (sin PlanModulo ni EmpresaModulo). Master lo habilita por Empresa
-- desde Portal Master → Empresas → Módulos.
INSERT INTO "modulos" ("id", "clave", "nombre")
VALUES ('modulo_comercializacion', 'comercializacion', 'Comercialización')
ON CONFLICT ("clave") DO NOTHING;

-- CreateEnum
CREATE TYPE "TratamientoImpuestoComercial" AS ENUM ('GRAVADO', 'TASA_CERO', 'EXENTO');

-- AlterTable — nadie queda marcado como vendedor al migrar.
ALTER TABLE "usuarios" ADD COLUMN     "vendedorComercial" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "productos_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "precioVenta" DECIMAL(14,2) NOT NULL,
    "costoReferencia" DECIMAL(14,2),
    "tratamientoImpuesto" "TratamientoImpuestoComercial" NOT NULL DEFAULT 'GRAVADO',
    "tasaIva" DECIMAL(5,2),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoPorId" TEXT NOT NULL,
    "actualizadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productos_comerciales_pkey" PRIMARY KEY ("id"),
    -- Defensa en profundidad: el servicio ya valida, la base lo garantiza.
    CONSTRAINT "productos_comerciales_precio_positivo" CHECK ("precioVenta" > 0),
    CONSTRAINT "productos_comerciales_costo_no_negativo" CHECK ("costoReferencia" IS NULL OR "costoReferencia" >= 0),
    CONSTRAINT "productos_comerciales_tasa_segun_tratamiento" CHECK (
      ("tratamientoImpuesto" = 'GRAVADO' AND "tasaIva" IS NOT NULL AND "tasaIva" > 0 AND "tasaIva" <= 100)
      OR ("tratamientoImpuesto" <> 'GRAVADO' AND "tasaIva" IS NULL)
    ),
    CONSTRAINT "productos_comerciales_codigo_no_vacio" CHECK (length(btrim("codigo")) > 0)
);

-- CreateIndex
CREATE INDEX "productos_comerciales_empresaId_activo_idx" ON "productos_comerciales"("empresaId", "activo");

-- Código único por Empresa sin distinguir mayúsculas/minúsculas (no
-- representable en el DSL de Prisma — mismo criterio que los índices
-- parciales de otras migraciones). "ABC-1" y "abc-1" son el mismo producto.
CREATE UNIQUE INDEX "productos_comerciales_empresa_codigo_unico" ON "productos_comerciales"("empresaId", lower("codigo"));

-- AddForeignKey
ALTER TABLE "productos_comerciales" ADD CONSTRAINT "productos_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_comerciales" ADD CONSTRAINT "productos_comerciales_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_comerciales" ADD CONSTRAINT "productos_comerciales_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

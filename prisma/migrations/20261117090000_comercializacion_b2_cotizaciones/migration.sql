-- Comercialización — B2: clientes, obras comerciales y cotizaciones de venta
-- en borrador (noviembre 2026). Ver docs/negocio/comercializacion.md §20.
-- Migración ADITIVA: tablas/enum nuevos, una columna con default en
-- empresas y un índice único compuesto en productos_comerciales (sobre la
-- PK + empresaId, nunca puede fallar con datos existentes).
-- No crea Proyecto, contratos ni semanas, ni toca Compras (OrdenCompra/
-- Cotizacion) ni su contador de folios.

-- CreateEnum
CREATE TYPE "EstatusCotizacionVenta" AS ENUM ('BORRADOR');

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "ultimoFolioCotizacionVenta" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "clientes_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "contacto" TEXT,
    "telefono" TEXT,
    "creadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clientes_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "obras_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "ubicacion" TEXT,
    "creadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "obras_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cotizaciones_venta" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "numeroFolio" INTEGER NOT NULL,
    "estatus" "EstatusCotizacionVenta" NOT NULL DEFAULT 'BORRADOR',
    "clienteId" TEXT,
    "obraId" TEXT,
    "descripcion" TEXT,
    "vendedorId" TEXT NOT NULL,
    "creadoPorId" TEXT NOT NULL,
    "actualizadoPorId" TEXT,
    "fecha" DATE NOT NULL,
    "vigenciaHasta" DATE,
    "condiciones" TEXT,
    "observaciones" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "iva" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "claveCreacion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cotizaciones_venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partidas_cotizacion_venta" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "productoId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "tratamientoImpuesto" "TratamientoImpuestoComercial" NOT NULL,
    "tasaIva" DECIMAL(5,2),
    "precioBase" DECIMAL(14,2) NOT NULL,
    "precioUnitario" DECIMAL(14,2) NOT NULL,
    "precioAjustadoPorId" TEXT,
    "precioAjustadoEn" TIMESTAMP(3),
    "cantidad" DECIMAL(14,3) NOT NULL,
    "importe" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partidas_cotizacion_venta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clientes_comerciales_empresaId_idx" ON "clientes_comerciales"("empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "clientes_comerciales_id_empresaId_key" ON "clientes_comerciales"("id", "empresaId");

-- CreateIndex
CREATE INDEX "obras_comerciales_empresaId_clienteId_idx" ON "obras_comerciales"("empresaId", "clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "obras_comerciales_id_clienteId_empresaId_key" ON "obras_comerciales"("id", "clienteId", "empresaId");

-- CreateIndex
CREATE INDEX "cotizaciones_venta_empresaId_vendedorId_idx" ON "cotizaciones_venta"("empresaId", "vendedorId");

-- CreateIndex
CREATE INDEX "cotizaciones_venta_empresaId_clienteId_idx" ON "cotizaciones_venta"("empresaId", "clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "cotizaciones_venta_empresaId_numeroFolio_key" ON "cotizaciones_venta"("empresaId", "numeroFolio");

-- CreateIndex
CREATE UNIQUE INDEX "cotizaciones_venta_empresaId_folio_key" ON "cotizaciones_venta"("empresaId", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "cotizaciones_venta_empresaId_claveCreacion_key" ON "cotizaciones_venta"("empresaId", "claveCreacion");

-- CreateIndex
CREATE UNIQUE INDEX "cotizaciones_venta_id_empresaId_key" ON "cotizaciones_venta"("id", "empresaId");

-- CreateIndex
CREATE INDEX "partidas_cotizacion_venta_cotizacionId_idx" ON "partidas_cotizacion_venta"("cotizacionId");

-- CreateIndex
CREATE INDEX "partidas_cotizacion_venta_empresaId_productoId_idx" ON "partidas_cotizacion_venta"("empresaId", "productoId");

-- CreateIndex
CREATE UNIQUE INDEX "productos_comerciales_id_empresaId_key" ON "productos_comerciales"("id", "empresaId");

-- AddForeignKey
ALTER TABLE "clientes_comerciales" ADD CONSTRAINT "clientes_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clientes_comerciales" ADD CONSTRAINT "clientes_comerciales_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obras_comerciales" ADD CONSTRAINT "obras_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obras_comerciales" ADD CONSTRAINT "obras_comerciales_clienteId_empresaId_fkey" FOREIGN KEY ("clienteId", "empresaId") REFERENCES "clientes_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obras_comerciales" ADD CONSTRAINT "obras_comerciales_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_clienteId_empresaId_fkey" FOREIGN KEY ("clienteId", "empresaId") REFERENCES "clientes_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_obraId_clienteId_empresaId_fkey" FOREIGN KEY ("obraId", "clienteId", "empresaId") REFERENCES "obras_comerciales"("id", "clienteId", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_cotizacionId_empresaId_fkey" FOREIGN KEY ("cotizacionId", "empresaId") REFERENCES "cotizaciones_venta"("id", "empresaId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_productoId_empresaId_fkey" FOREIGN KEY ("productoId", "empresaId") REFERENCES "productos_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_precioAjustadoPorId_fkey" FOREIGN KEY ("precioAjustadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas no representables en el DSL de Prisma (defensa en profundidad: el
-- servicio ya valida; la base lo garantiza).
-- ---------------------------------------------------------------------------

-- Cliente: nombre único por Empresa sin distinguir mayúsculas ni espacios.
CREATE UNIQUE INDEX "clientes_comerciales_empresa_nombre_unico" ON "clientes_comerciales"("empresaId", lower(btrim("nombre")));
ALTER TABLE "clientes_comerciales" ADD CONSTRAINT "clientes_comerciales_nombre_no_vacio" CHECK (length(btrim("nombre")) > 0);

-- Obra: nombre único por cliente sin distinguir mayúsculas ni espacios.
CREATE UNIQUE INDEX "obras_comerciales_cliente_nombre_unico" ON "obras_comerciales"("clienteId", lower(btrim("nombre")));
ALTER TABLE "obras_comerciales" ADD CONSTRAINT "obras_comerciales_nombre_no_vacio" CHECK (length(btrim("nombre")) > 0);

-- Cotización: la FK compuesta (obraId, clienteId, empresaId) es MATCH SIMPLE
-- y no se verifica si clienteId es NULL — por eso una obra exige cliente.
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_obra_requiere_cliente" CHECK ("obraId" IS NULL OR "clienteId" IS NOT NULL);
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_vigencia_posterior" CHECK ("vigenciaHasta" IS NULL OR "vigenciaHasta" >= "fecha");
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_totales_no_negativos" CHECK ("subtotal" >= 0 AND "iva" >= 0 AND "total" = "subtotal" + "iva");
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_version_positiva" CHECK ("version" >= 1);
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_folio_formato" CHECK ("folio" = 'COT-' || lpad("numeroFolio"::text, 6, '0') AND "numeroFolio" > 0);

-- Partida: cantidades y precios positivos, importe no negativo, tasa
-- coherente con el tratamiento (misma regla que el catálogo).
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_valores" CHECK (
  "cantidad" > 0 AND "precioBase" > 0 AND "precioUnitario" > 0 AND "importe" >= 0 AND "orden" >= 0
);
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_tasa_segun_tratamiento" CHECK (
  ("tratamientoImpuesto" = 'GRAVADO' AND "tasaIva" IS NOT NULL AND "tasaIva" > 0 AND "tasaIva" <= 100)
  OR ("tratamientoImpuesto" <> 'GRAVADO' AND "tasaIva" IS NULL)
);

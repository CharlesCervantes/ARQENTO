-- Comercialización — B3: emisión de cotizaciones, copia histórica y orden de
-- venta (OV) por aceptación (noviembre 2026). Ver docs/negocio/
-- comercializacion.md §20. Migración ADITIVA: valores de enum nuevos,
-- columnas opcionales, una columna con default y una tabla nueva. No toca
-- Compras de construcción (OrdenCompra/Cotizacion) ni su contador de folios.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EstatusCotizacionVenta" ADD VALUE 'EMITIDA';
ALTER TYPE "EstatusCotizacionVenta" ADD VALUE 'ACEPTADA';

-- AlterTable
ALTER TABLE "cotizaciones_venta" ADD COLUMN     "documentoEmitido" JSONB,
ADD COLUMN     "emitidaEn" TIMESTAMP(3),
ADD COLUMN     "emitidaPorId" TEXT,
ADD COLUMN     "origenId" TEXT;

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "ultimoFolioOrdenVenta" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ordenes_venta" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "numeroFolio" INTEGER NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "fechaAceptacion" DATE NOT NULL,
    "referenciaOcCliente" TEXT,
    "evidenciaRef" TEXT NOT NULL,
    "evidenciaNombre" TEXT NOT NULL,
    "evidenciaTipo" TEXT NOT NULL,
    "evidenciaBytes" INTEGER NOT NULL,
    "registradaPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "iva" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "ordenes_venta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ordenes_venta_empresaId_idx" ON "ordenes_venta"("empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_venta_cotizacionId_empresaId_key" ON "ordenes_venta"("cotizacionId", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_venta_empresaId_numeroFolio_key" ON "ordenes_venta"("empresaId", "numeroFolio");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_venta_empresaId_folio_key" ON "ordenes_venta"("empresaId", "folio");

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_emitidaPorId_fkey" FOREIGN KEY ("emitidaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_origenId_fkey" FOREIGN KEY ("origenId") REFERENCES "cotizaciones_venta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_cotizacionId_empresaId_fkey" FOREIGN KEY ("cotizacionId", "empresaId") REFERENCES "cotizaciones_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_registradaPorId_fkey" FOREIGN KEY ("registradaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas no representables en el DSL de Prisma (defensa en profundidad: el
-- servicio ya valida; la base lo garantiza).
-- ---------------------------------------------------------------------------

-- Exactamente una OV por cotización.
CREATE UNIQUE INDEX "ordenes_venta_cotizacion_unica" ON "ordenes_venta"("cotizacionId");
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_folio_formato" CHECK ("folio" = 'OV-' || lpad("numeroFolio"::text, 6, '0') AND "numeroFolio" > 0);
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_evidencia_valida" CHECK ("evidenciaBytes" > 0 AND length(btrim("evidenciaRef")) > 0);
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_totales" CHECK ("subtotal" >= 0 AND "iva" >= 0 AND "total" = "subtotal" + "iva");

-- Una cotización que ya no es borrador siempre tiene su copia emitida.
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_emitida_con_copia" CHECK (
  "estatus" = 'BORRADOR' OR ("documentoEmitido" IS NOT NULL AND "emitidaEn" IS NOT NULL AND "emitidaPorId" IS NOT NULL)
);

-- Las partidas de una cotización emitida o aceptada no se crean, modifican
-- ni eliminan.
CREATE FUNCTION "comercializacion_partidas_solo_en_borrador"() RETURNS trigger AS $$
DECLARE
  estatus_actual text;
BEGIN
  SELECT "estatus"::text INTO estatus_actual FROM "cotizaciones_venta"
  WHERE "id" = COALESCE(NEW."cotizacionId", OLD."cotizacionId");
  IF estatus_actual IS NOT NULL AND estatus_actual <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Las partidas de una cotización emitida no se pueden modificar.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "partidas_cotizacion_venta_solo_borrador"
BEFORE INSERT OR UPDATE OR DELETE ON "partidas_cotizacion_venta"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_partidas_solo_en_borrador"();

-- Una cotización emitida/aceptada conserva sus datos comerciales y su copia
-- emitida; solo puede pasar de EMITIDA a ACEPTADA. Nunca vuelve a borrador.
CREATE FUNCTION "comercializacion_cotizacion_emitida_inmutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."estatus"::text <> 'BORRADOR' AND (
       NEW."documentoEmitido" IS DISTINCT FROM OLD."documentoEmitido"
    OR NEW."subtotal" <> OLD."subtotal" OR NEW."iva" <> OLD."iva" OR NEW."total" <> OLD."total"
    OR NEW."clienteId" IS DISTINCT FROM OLD."clienteId" OR NEW."obraId" IS DISTINCT FROM OLD."obraId"
    OR NEW."vendedorId" <> OLD."vendedorId" OR NEW."folio" <> OLD."folio"
    OR NEW."fecha" <> OLD."fecha" OR NEW."vigenciaHasta" IS DISTINCT FROM OLD."vigenciaHasta"
    OR NEW."descripcion" IS DISTINCT FROM OLD."descripcion"
    OR NEW."condiciones" IS DISTINCT FROM OLD."condiciones"
    OR NEW."observaciones" IS DISTINCT FROM OLD."observaciones"
    OR NEW."emitidaEn" IS DISTINCT FROM OLD."emitidaEn"
    OR NOT (NEW."estatus"::text = OLD."estatus"::text OR (OLD."estatus"::text = 'EMITIDA' AND NEW."estatus"::text = 'ACEPTADA'))
  ) THEN
    RAISE EXCEPTION 'Una cotización emitida no se puede modificar; duplícala para corregirla.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "cotizaciones_venta_emitida_inmutable"
BEFORE UPDATE ON "cotizaciones_venta"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_cotizacion_emitida_inmutable"();

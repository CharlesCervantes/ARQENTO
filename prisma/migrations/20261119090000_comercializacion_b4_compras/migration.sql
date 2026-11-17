-- Comercialización — B4: compras a proveedores de una orden de venta
-- (noviembre 2026). Ver docs/negocio/comercializacion.md §20.
-- Migración ADITIVA: enum y tablas nuevas, una columna con default en
-- empresas e índices únicos (id, empresaId) — sobre llaves primarias, nunca
-- fallan con datos existentes — para FKs compuestas por Empresa. El índice
-- único en "beneficiarios" no cambia el funcionamiento de construcción.
-- No toca OrdenCompra/Cotizacion/MovimientoSemanal ni su contador de folios.

-- CreateEnum
CREATE TYPE "EstatusCompraComercial" AS ENUM ('BORRADOR', 'CONFIRMADA', 'ANULADA');


-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "ultimoFolioCompraComercial" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "compras_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "numeroFolio" INTEGER NOT NULL,
    "estatus" "EstatusCompraComercial" NOT NULL DEFAULT 'BORRADOR',
    "ordenVentaId" TEXT NOT NULL,
    "proveedorId" TEXT,
    "proveedorConfirmado" JSONB,
    "fecha" DATE NOT NULL,
    "referenciaProveedor" TEXT,
    "notas" TEXT,
    "documentoRef" TEXT,
    "documentoNombre" TEXT,
    "documentoTipo" TEXT,
    "documentoBytes" INTEGER,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "iva" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "claveCreacion" TEXT,
    "creadoPorId" TEXT NOT NULL,
    "actualizadoPorId" TEXT,
    "confirmadaEn" TIMESTAMP(3),
    "confirmadaPorId" TEXT,
    "anuladaEn" TIMESTAMP(3),
    "anuladaPorId" TEXT,
    "motivoAnulacion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compras_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partidas_compra_comercial" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "partidaVentaId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "costoUnitario" DECIMAL(14,2),
    "tratamientoImpuesto" "TratamientoImpuestoComercial",
    "tasaIva" DECIMAL(5,2),
    "importe" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partidas_compra_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compras_comerciales_empresaId_ordenVentaId_idx" ON "compras_comerciales"("empresaId", "ordenVentaId");

-- CreateIndex
CREATE INDEX "compras_comerciales_empresaId_proveedorId_idx" ON "compras_comerciales"("empresaId", "proveedorId");

-- CreateIndex
CREATE UNIQUE INDEX "compras_comerciales_id_empresaId_key" ON "compras_comerciales"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "compras_comerciales_empresaId_numeroFolio_key" ON "compras_comerciales"("empresaId", "numeroFolio");

-- CreateIndex
CREATE UNIQUE INDEX "compras_comerciales_empresaId_folio_key" ON "compras_comerciales"("empresaId", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "compras_comerciales_empresaId_claveCreacion_key" ON "compras_comerciales"("empresaId", "claveCreacion");

-- CreateIndex
CREATE INDEX "partidas_compra_comercial_empresaId_partidaVentaId_idx" ON "partidas_compra_comercial"("empresaId", "partidaVentaId");

-- CreateIndex
CREATE UNIQUE INDEX "partidas_compra_comercial_compraId_partidaVentaId_key" ON "partidas_compra_comercial"("compraId", "partidaVentaId");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiarios_id_empresaId_key" ON "beneficiarios"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_venta_id_empresaId_key" ON "ordenes_venta"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "partidas_cotizacion_venta_id_empresaId_key" ON "partidas_cotizacion_venta"("id", "empresaId");

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_ordenVentaId_empresaId_fkey" FOREIGN KEY ("ordenVentaId", "empresaId") REFERENCES "ordenes_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_proveedorId_empresaId_fkey" FOREIGN KEY ("proveedorId", "empresaId") REFERENCES "beneficiarios"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_confirmadaPorId_fkey" FOREIGN KEY ("confirmadaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_anuladaPorId_fkey" FOREIGN KEY ("anuladaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_compra_comercial" ADD CONSTRAINT "partidas_compra_comercial_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_compra_comercial" ADD CONSTRAINT "partidas_compra_comercial_compraId_empresaId_fkey" FOREIGN KEY ("compraId", "empresaId") REFERENCES "compras_comerciales"("id", "empresaId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_compra_comercial" ADD CONSTRAINT "partidas_compra_comercial_partidaVentaId_empresaId_fkey" FOREIGN KEY ("partidaVentaId", "empresaId") REFERENCES "partidas_cotizacion_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas no representables en el DSL de Prisma (defensa en profundidad: el
-- servicio ya valida; la base lo garantiza).
-- ---------------------------------------------------------------------------

ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_folio_formato" CHECK ("folio" = 'COC-' || lpad("numeroFolio"::text, 6, '0') AND "numeroFolio" > 0);
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_totales" CHECK ("subtotal" >= 0 AND "iva" >= 0 AND "total" = "subtotal" + "iva");
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_version_positiva" CHECK ("version" >= 1);
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_confirmada_completa" CHECK (
  "estatus" = 'BORRADOR'
  OR ("proveedorId" IS NOT NULL AND "proveedorConfirmado" IS NOT NULL AND "confirmadaEn" IS NOT NULL AND "confirmadaPorId" IS NOT NULL)
  OR ("estatus" = 'ANULADA' AND "confirmadaEn" IS NULL)
);
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_anulada_con_motivo" CHECK (
  ("estatus" = 'ANULADA') = ("anuladaEn" IS NOT NULL AND "anuladaPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
);
ALTER TABLE "compras_comerciales" ADD CONSTRAINT "compras_comerciales_documento" CHECK (
  ("documentoRef" IS NULL AND "documentoNombre" IS NULL AND "documentoTipo" IS NULL AND "documentoBytes" IS NULL)
  OR ("documentoRef" IS NOT NULL AND "documentoNombre" IS NOT NULL AND "documentoTipo" IS NOT NULL AND "documentoBytes" > 0)
);

ALTER TABLE "partidas_compra_comercial" ADD CONSTRAINT "partidas_compra_comercial_valores" CHECK (
  "cantidad" > 0 AND ("costoUnitario" IS NULL OR "costoUnitario" > 0) AND ("importe" IS NULL OR "importe" >= 0) AND "orden" >= 0
);
ALTER TABLE "partidas_compra_comercial" ADD CONSTRAINT "partidas_compra_comercial_tasa_segun_tratamiento" CHECK (
  ("tratamientoImpuesto" IS NULL AND "tasaIva" IS NULL)
  OR ("tratamientoImpuesto" = 'GRAVADO' AND "tasaIva" IS NOT NULL AND "tasaIva" > 0 AND "tasaIva" <= 100)
  OR ("tratamientoImpuesto" IN ('TASA_CERO', 'EXENTO') AND "tasaIva" IS NULL)
);

-- Partidas de compra: solo en BORRADOR, y siempre de la OV de su compra.
CREATE FUNCTION "comercializacion_partidas_compra"() RETURNS trigger AS $$
DECLARE
  estatus_compra text;
  coincide boolean;
BEGIN
  SELECT c."estatus"::text INTO estatus_compra FROM "compras_comerciales" c
  WHERE c."id" = COALESCE(NEW."compraId", OLD."compraId");
  IF estatus_compra IS NOT NULL AND estatus_compra <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Las partidas de una compra confirmada o anulada no se pueden modificar.';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1 FROM "compras_comerciales" c
      JOIN "ordenes_venta" ov ON ov."id" = c."ordenVentaId"
      JOIN "partidas_cotizacion_venta" pv ON pv."cotizacionId" = ov."cotizacionId"
      WHERE c."id" = NEW."compraId" AND pv."id" = NEW."partidaVentaId"
    ) INTO coincide;
    IF NOT coincide THEN
      RAISE EXCEPTION 'La partida no pertenece a la orden de venta de la compra.';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "partidas_compra_comercial_reglas"
BEFORE INSERT OR UPDATE OR DELETE ON "partidas_compra_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_partidas_compra"();

-- Compra: confirmada = inmutable (solo puede anularse; el documento y la
-- referencia del proveedor pueden agregarse). Anulada = definitiva.
-- Al CONFIRMAR, la base comprueba que lo confirmado no supere lo vendido,
-- bloqueando antes la OV (serializa confirmaciones simultáneas).
CREATE FUNCTION "comercializacion_compra_reglas"() RETURNS trigger AS $$
DECLARE
  excedida text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."estatus"::text <> 'BORRADOR' THEN
    IF NEW."ordenVentaId" <> OLD."ordenVentaId" OR NEW."folio" <> OLD."folio"
       OR NEW."proveedorId" IS DISTINCT FROM OLD."proveedorId"
       OR NEW."proveedorConfirmado" IS DISTINCT FROM OLD."proveedorConfirmado"
       OR NEW."fecha" <> OLD."fecha"
       OR NEW."subtotal" <> OLD."subtotal" OR NEW."iva" <> OLD."iva" OR NEW."total" <> OLD."total"
       OR NEW."confirmadaEn" IS DISTINCT FROM OLD."confirmadaEn"
       OR NOT (NEW."estatus"::text = OLD."estatus"::text OR (OLD."estatus"::text = 'CONFIRMADA' AND NEW."estatus"::text = 'ANULADA'))
       OR (OLD."estatus"::text = 'ANULADA' AND (
            NEW."documentoRef" IS DISTINCT FROM OLD."documentoRef"
            OR NEW."referenciaProveedor" IS DISTINCT FROM OLD."referenciaProveedor"
            OR NEW."motivoAnulacion" IS DISTINCT FROM OLD."motivoAnulacion"))
    THEN
      RAISE EXCEPTION 'Una compra confirmada o anulada no se puede modificar; solo puede anularse con motivo.';
    END IF;
  END IF;

  IF NEW."estatus"::text = 'CONFIRMADA' AND (TG_OP = 'INSERT' OR OLD."estatus"::text <> 'CONFIRMADA') THEN
    PERFORM 1 FROM "ordenes_venta" WHERE "id" = NEW."ordenVentaId" FOR UPDATE;
    SELECT pv."codigo" INTO excedida
    FROM "partidas_compra_comercial" pc
    JOIN "partidas_cotizacion_venta" pv ON pv."id" = pc."partidaVentaId"
    WHERE pc."compraId" = NEW."id"
      AND pv."cantidad" < (
        SELECT COALESCE(SUM(otra."cantidad"), 0)
        FROM "partidas_compra_comercial" otra
        JOIN "compras_comerciales" c ON c."id" = otra."compraId"
        WHERE otra."partidaVentaId" = pc."partidaVentaId" AND c."estatus" = 'CONFIRMADA' AND c."id" <> NEW."id"
      ) + pc."cantidad"
    LIMIT 1;
    IF excedida IS NOT NULL THEN
      RAISE EXCEPTION 'La cantidad comprada de % supera la cantidad vendida.', excedida;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "compras_comerciales_reglas"
BEFORE INSERT OR UPDATE ON "compras_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_compra_reglas"();

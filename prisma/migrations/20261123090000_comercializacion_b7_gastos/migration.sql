-- Comercialización B7: gastos adicionales por OV con su cuenta por pagar (B5).
-- Aditiva: tabla nueva y columna opcional en cuentas_comerciales.
-- CreateEnum
CREATE TYPE "EstatusGastoComercial" AS ENUM ('VIGENTE', 'ANULADO');


-- AlterTable
ALTER TABLE "cuentas_comerciales" ADD COLUMN     "gastoId" TEXT;

-- CreateTable
CREATE TABLE "gastos_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "ordenVentaId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "concepto" TEXT NOT NULL,
    "beneficiarioId" TEXT NOT NULL,
    "beneficiarioNombre" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tratamientoImpuesto" "TratamientoImpuestoComercial" NOT NULL,
    "tasaIva" DECIMAL(5,2),
    "iva" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "observaciones" TEXT,
    "comprobanteRef" TEXT,
    "comprobanteNombre" TEXT,
    "comprobanteTipo" TEXT,
    "comprobanteBytes" INTEGER,
    "estatus" "EstatusGastoComercial" NOT NULL DEFAULT 'VIGENTE',
    "claveRegistro" TEXT NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anuladoEn" TIMESTAMP(3),
    "anuladoPorId" TEXT,
    "motivoAnulacion" TEXT,

    CONSTRAINT "gastos_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gastos_comerciales_empresaId_ordenVentaId_idx" ON "gastos_comerciales"("empresaId", "ordenVentaId");

-- CreateIndex
CREATE UNIQUE INDEX "gastos_comerciales_id_empresaId_key" ON "gastos_comerciales"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "gastos_comerciales_ordenVentaId_numero_key" ON "gastos_comerciales"("ordenVentaId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "gastos_comerciales_empresaId_claveRegistro_key" ON "gastos_comerciales"("empresaId", "claveRegistro");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_comerciales_gastoId_empresaId_key" ON "cuentas_comerciales"("gastoId", "empresaId");

-- AddForeignKey
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_gastoId_empresaId_fkey" FOREIGN KEY ("gastoId", "empresaId") REFERENCES "gastos_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_ordenVentaId_empresaId_fkey" FOREIGN KEY ("ordenVentaId", "empresaId") REFERENCES "ordenes_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_beneficiarioId_empresaId_fkey" FOREIGN KEY ("beneficiarioId", "empresaId") REFERENCES "beneficiarios"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_anuladoPorId_fkey" FOREIGN KEY ("anuladoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- B7 — reglas en la base (defensa en profundidad; el servicio ya las aplica).
-- ---------------------------------------------------------------------------

-- Una cuenta pertenece a UN solo documento origen: OV (por cobrar), o compra
-- o gasto (por pagar). Una sola cuenta por gasto.
ALTER TABLE "cuentas_comerciales" DROP CONSTRAINT "cuentas_comerciales_documento";
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_documento" CHECK (
  ("tipo" = 'POR_COBRAR' AND "ordenVentaId" IS NOT NULL AND "compraId" IS NULL AND "gastoId" IS NULL)
  OR ("tipo" = 'POR_PAGAR' AND "ordenVentaId" IS NULL AND (("compraId" IS NOT NULL) <> ("gastoId" IS NOT NULL)))
);
CREATE UNIQUE INDEX "cuentas_comerciales_gasto_unica" ON "cuentas_comerciales"("gastoId") WHERE "gastoId" IS NOT NULL;

-- Documento origen inmutable (se agrega gastoId a la regla de B5).
CREATE OR REPLACE FUNCTION "comercializacion_cuenta_reglas"() RETURNS trigger AS $$
BEGIN
  IF NEW."total" <> OLD."total" OR NEW."tipo" <> OLD."tipo"
     OR NEW."ordenVentaId" IS DISTINCT FROM OLD."ordenVentaId" OR NEW."compraId" IS DISTINCT FROM OLD."compraId"
     OR NEW."gastoId" IS DISTINCT FROM OLD."gastoId"
     OR (OLD."tuvoMovimientos" AND NOT NEW."tuvoMovimientos")
     OR (OLD."estatus"::text = 'ANULADA' AND NEW."estatus"::text <> 'ANULADA')
     OR (OLD."tuvoMovimientos" AND NEW."modalidad" IS DISTINCT FROM OLD."modalidad") THEN
    RAISE EXCEPTION 'Cambio no permitido en la cuenta comercial.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Valores del gasto: importes exactos y coherentes, impuesto explícito,
-- anulación y comprobante completos.
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_valores" CHECK (
  "numero" >= 1
  AND length(btrim("concepto")) BETWEEN 1 AND 200
  AND length(btrim("beneficiarioNombre")) > 0
  AND "subtotal" > 0 AND "iva" >= 0 AND "total" = "subtotal" + "iva"
  AND char_length("claveRegistro") BETWEEN 8 AND 100
);
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_impuesto" CHECK (
  ("tratamientoImpuesto" = 'GRAVADO' AND "tasaIva" IS NOT NULL AND "tasaIva" > 0)
  OR ("tratamientoImpuesto" <> 'GRAVADO' AND "tasaIva" IS NULL AND "iva" = 0)
);
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_anulacion" CHECK (
  ("estatus" = 'ANULADO') = ("anuladoEn" IS NOT NULL AND "anuladoPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
);
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_comprobante" CHECK (
  ("comprobanteRef" IS NULL AND "comprobanteNombre" IS NULL AND "comprobanteTipo" IS NULL AND "comprobanteBytes" IS NULL)
  OR ("comprobanteRef" IS NOT NULL AND "comprobanteNombre" IS NOT NULL AND "comprobanteTipo" IS NOT NULL AND "comprobanteBytes" > 0)
);

-- Un gasto no se borra; se registra VIGENTE; solo cambia de VIGENTE a ANULADO
-- (sin tocar nada más) y solo si su cuenta ya está anulada y nunca tuvo
-- movimientos. Bloquea la cuenta: resiste un pago y una anulación simultáneos.
CREATE FUNCTION "comercializacion_gastos_reglas"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un gasto no se elimina; se anula con motivo.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."estatus"::text <> 'VIGENTE' THEN
      RAISE EXCEPTION 'Un gasto se registra vigente.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."estatus"::text = 'ANULADO'
     OR NEW."estatus"::text <> 'ANULADO'
     OR (NEW."empresaId", NEW."ordenVentaId", NEW."numero", NEW."concepto", NEW."beneficiarioId", NEW."beneficiarioNombre", NEW."fecha",
         NEW."subtotal", NEW."tratamientoImpuesto", NEW."tasaIva", NEW."iva", NEW."total", NEW."observaciones",
         NEW."comprobanteRef", NEW."comprobanteNombre", NEW."comprobanteTipo", NEW."comprobanteBytes",
         NEW."claveRegistro", NEW."registradoPorId", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."empresaId", OLD."ordenVentaId", OLD."numero", OLD."concepto", OLD."beneficiarioId", OLD."beneficiarioNombre", OLD."fecha",
         OLD."subtotal", OLD."tratamientoImpuesto", OLD."tasaIva", OLD."iva", OLD."total", OLD."observaciones",
         OLD."comprobanteRef", OLD."comprobanteNombre", OLD."comprobanteTipo", OLD."comprobanteBytes",
         OLD."claveRegistro", OLD."registradoPorId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Un gasto no se modifica; solo se anula con motivo.';
  END IF;
  SELECT "estatus"::text AS estatus, "tuvoMovimientos" INTO c FROM "cuentas_comerciales" WHERE "gastoId" = NEW."id" FOR UPDATE;
  IF FOUND AND (c."tuvoMovimientos" OR c.estatus <> 'ANULADA') THEN
    RAISE EXCEPTION 'El gasto tiene historial de pagos o su cuenta por pagar sigue vigente; no se puede anular con la acción simple.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gastos_comerciales_reglas" BEFORE INSERT OR UPDATE OR DELETE ON "gastos_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_gastos_reglas"();

-- Al cerrar la transacción: todo gasto tiene su cuenta por pagar por su
-- total (se crean juntos).
CREATE FUNCTION "comercializacion_gasto_con_cuenta"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "cuentas_comerciales" c WHERE c."gastoId" = NEW."id" AND c."total" = NEW."total" AND c."tipo" = 'POR_PAGAR') THEN
    RAISE EXCEPTION 'El gasto % de la orden de venta no tiene su cuenta por pagar.', NEW."numero";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "gastos_comerciales_con_cuenta" AFTER INSERT ON "gastos_comerciales"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "comercializacion_gasto_con_cuenta"();

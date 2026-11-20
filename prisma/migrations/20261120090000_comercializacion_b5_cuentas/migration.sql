-- Comercialización — B5: cuentas por cobrar y por pagar, condiciones de pago,
-- calendario de cuotas y cobros/pagos con aplicación por cuota (noviembre
-- 2026). Ver docs/negocio/comercializacion.md §20 (B5). Migración ADITIVA:
-- enums, tablas, una columna opcional en empresas y la incorporación de
-- OV y compras confirmadas existentes. No toca Contabilidad ni construcción.

-- CreateEnum
CREATE TYPE "TipoCuentaComercial" AS ENUM ('POR_COBRAR', 'POR_PAGAR');

-- CreateEnum
CREATE TYPE "EstatusCuentaComercial" AS ENUM ('VIGENTE', 'ANULADA');

-- CreateEnum
CREATE TYPE "ModalidadPagoComercial" AS ENUM ('CONTADO', 'CREDITO');

-- CreateEnum
CREATE TYPE "EstatusMovimientoComercial" AS ENUM ('VIGENTE', 'ANULADO');

-- CreateEnum
CREATE TYPE "MetodoPagoComercial" AS ENUM ('TRANSFERENCIA', 'DEPOSITO', 'EFECTIVO', 'CHEQUE', 'TARJETA', 'OTRO');


-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "zonaHoraria" TEXT;

-- CreateTable
CREATE TABLE "cuentas_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "tipo" "TipoCuentaComercial" NOT NULL,
    "ordenVentaId" TEXT,
    "compraId" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "estatus" "EstatusCuentaComercial" NOT NULL DEFAULT 'VIGENTE',
    "modalidad" "ModalidadPagoComercial",
    "tuvoMovimientos" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "anuladaEn" TIMESTAMP(3),
    "anuladaPorId" TEXT,
    "motivoAnulacion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cuentas_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuotas_cuenta_comercial" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "cuentaId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "fechaVencimiento" DATE NOT NULL,
    "importe" DECIMAL(14,2) NOT NULL,
    "vigente" BOOLEAN NOT NULL DEFAULT true,
    "sustituidaEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cuotas_cuenta_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimientos_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "cuentaId" TEXT NOT NULL,
    "importe" DECIMAL(14,2) NOT NULL,
    "fecha" DATE NOT NULL,
    "metodo" "MetodoPagoComercial" NOT NULL,
    "referencia" TEXT,
    "observaciones" TEXT,
    "comprobanteRef" TEXT,
    "comprobanteNombre" TEXT,
    "comprobanteTipo" TEXT,
    "comprobanteBytes" INTEGER,
    "estatus" "EstatusMovimientoComercial" NOT NULL DEFAULT 'VIGENTE',
    "registradoPorId" TEXT NOT NULL,
    "anuladoEn" TIMESTAMP(3),
    "anuladoPorId" TEXT,
    "motivoAnulacion" TEXT,
    "claveRegistro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimientos_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aplicaciones_movimiento_comercial" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "movimientoId" TEXT NOT NULL,
    "cuotaId" TEXT NOT NULL,
    "importe" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "aplicaciones_movimiento_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cuentas_comerciales_empresaId_tipo_estatus_idx" ON "cuentas_comerciales"("empresaId", "tipo", "estatus");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_comerciales_ordenVentaId_empresaId_key" ON "cuentas_comerciales"("ordenVentaId", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_comerciales_compraId_empresaId_key" ON "cuentas_comerciales"("compraId", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_comerciales_id_empresaId_key" ON "cuentas_comerciales"("id", "empresaId");

-- CreateIndex
CREATE INDEX "cuotas_cuenta_comercial_cuentaId_vigente_idx" ON "cuotas_cuenta_comercial"("cuentaId", "vigente");

-- CreateIndex
CREATE UNIQUE INDEX "cuotas_cuenta_comercial_id_empresaId_key" ON "cuotas_cuenta_comercial"("id", "empresaId");

-- CreateIndex
CREATE INDEX "movimientos_comerciales_cuentaId_idx" ON "movimientos_comerciales"("cuentaId");

-- CreateIndex
CREATE UNIQUE INDEX "movimientos_comerciales_id_empresaId_key" ON "movimientos_comerciales"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "movimientos_comerciales_empresaId_claveRegistro_key" ON "movimientos_comerciales"("empresaId", "claveRegistro");

-- CreateIndex
CREATE INDEX "aplicaciones_movimiento_comercial_cuotaId_idx" ON "aplicaciones_movimiento_comercial"("cuotaId");

-- CreateIndex
CREATE UNIQUE INDEX "aplicaciones_movimiento_comercial_movimientoId_cuotaId_key" ON "aplicaciones_movimiento_comercial"("movimientoId", "cuotaId");

-- AddForeignKey
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_ordenVentaId_empresaId_fkey" FOREIGN KEY ("ordenVentaId", "empresaId") REFERENCES "ordenes_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_compraId_empresaId_fkey" FOREIGN KEY ("compraId", "empresaId") REFERENCES "compras_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_anuladaPorId_fkey" FOREIGN KEY ("anuladaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuotas_cuenta_comercial" ADD CONSTRAINT "cuotas_cuenta_comercial_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuotas_cuenta_comercial" ADD CONSTRAINT "cuotas_cuenta_comercial_cuentaId_empresaId_fkey" FOREIGN KEY ("cuentaId", "empresaId") REFERENCES "cuentas_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_cuentaId_empresaId_fkey" FOREIGN KEY ("cuentaId", "empresaId") REFERENCES "cuentas_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_anuladoPorId_fkey" FOREIGN KEY ("anuladoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aplicaciones_movimiento_comercial" ADD CONSTRAINT "aplicaciones_movimiento_comercial_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aplicaciones_movimiento_comercial" ADD CONSTRAINT "aplicaciones_movimiento_comercial_movimientoId_empresaId_fkey" FOREIGN KEY ("movimientoId", "empresaId") REFERENCES "movimientos_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aplicaciones_movimiento_comercial" ADD CONSTRAINT "aplicaciones_movimiento_comercial_cuotaId_empresaId_fkey" FOREIGN KEY ("cuotaId", "empresaId") REFERENCES "cuotas_cuenta_comercial"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas no representables en el DSL de Prisma (defensa en profundidad: el
-- servicio ya valida; la base lo garantiza).
-- ---------------------------------------------------------------------------

-- Una sola cuenta por documento.
CREATE UNIQUE INDEX "cuentas_comerciales_orden_unica" ON "cuentas_comerciales"("ordenVentaId") WHERE "ordenVentaId" IS NOT NULL;
CREATE UNIQUE INDEX "cuentas_comerciales_compra_unica" ON "cuentas_comerciales"("compraId") WHERE "compraId" IS NOT NULL;
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_documento" CHECK (
  ("tipo" = 'POR_COBRAR' AND "ordenVentaId" IS NOT NULL AND "compraId" IS NULL)
  OR ("tipo" = 'POR_PAGAR' AND "compraId" IS NOT NULL AND "ordenVentaId" IS NULL)
);
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_valores" CHECK ("total" >= 0 AND "version" >= 1);
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_anulacion" CHECK (
  ("estatus" = 'ANULADA') = ("anuladaEn" IS NOT NULL AND "anuladaPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
  AND ("estatus" = 'VIGENTE' OR ("tipo" = 'POR_PAGAR' AND NOT "tuvoMovimientos"))
);

ALTER TABLE "cuotas_cuenta_comercial" ADD CONSTRAINT "cuotas_cuenta_comercial_valores" CHECK (
  "importe" > 0 AND "numero" >= 1 AND ("vigente" = ("sustituidaEn" IS NULL))
);
CREATE UNIQUE INDEX "cuotas_cuenta_comercial_numero_vigente" ON "cuotas_cuenta_comercial"("cuentaId", "numero") WHERE "vigente";

ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_valores" CHECK ("importe" > 0);
ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_anulacion" CHECK (
  ("estatus" = 'ANULADO') = ("anuladoEn" IS NOT NULL AND "anuladoPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
);
ALTER TABLE "movimientos_comerciales" ADD CONSTRAINT "movimientos_comerciales_comprobante" CHECK (
  ("comprobanteRef" IS NULL AND "comprobanteNombre" IS NULL AND "comprobanteTipo" IS NULL AND "comprobanteBytes" IS NULL)
  OR ("comprobanteRef" IS NOT NULL AND "comprobanteNombre" IS NOT NULL AND "comprobanteTipo" IS NOT NULL AND "comprobanteBytes" > 0)
);
ALTER TABLE "aplicaciones_movimiento_comercial" ADD CONSTRAINT "aplicaciones_movimiento_comercial_valores" CHECK ("importe" > 0);

-- Cuenta: total, tipo y documento inmutables; tuvoMovimientos nunca regresa
-- a false; una cuenta anulada no revive; con movimientos no cambia modalidad
-- ni se anula.
CREATE FUNCTION "comercializacion_cuenta_reglas"() RETURNS trigger AS $$
BEGIN
  IF NEW."total" <> OLD."total" OR NEW."tipo" <> OLD."tipo"
     OR NEW."ordenVentaId" IS DISTINCT FROM OLD."ordenVentaId" OR NEW."compraId" IS DISTINCT FROM OLD."compraId"
     OR (OLD."tuvoMovimientos" AND NOT NEW."tuvoMovimientos")
     OR (OLD."estatus"::text = 'ANULADA' AND NEW."estatus"::text <> 'ANULADA')
     OR (OLD."tuvoMovimientos" AND NEW."modalidad" IS DISTINCT FROM OLD."modalidad") THEN
    RAISE EXCEPTION 'Cambio no permitido en la cuenta comercial.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "cuentas_comerciales_reglas" BEFORE UPDATE ON "cuentas_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_cuenta_reglas"();
CREATE FUNCTION "comercializacion_sin_borrado"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Los registros de cuentas comerciales no se eliminan; se anulan o sustituyen conservando el historial.';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "cuentas_comerciales_sin_borrado" BEFORE DELETE ON "cuentas_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_sin_borrado"();

-- Cuotas: el calendario solo se sustituye (nunca se edita ni borra) y solo
-- mientras la cuenta no haya tenido movimientos.
CREATE FUNCTION "comercializacion_cuotas_reglas"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las cuotas no se eliminan; el calendario se sustituye conservando el historial.';
  END IF;
  SELECT "tuvoMovimientos", "estatus"::text AS estatus INTO c FROM "cuentas_comerciales" WHERE "id" = NEW."cuentaId" FOR UPDATE;
  IF c."tuvoMovimientos" THEN
    RAISE EXCEPTION 'El calendario no se puede modificar porque la cuenta ya tiene cobros o pagos registrados.';
  END IF;
  IF c.estatus <> 'VIGENTE' THEN
    RAISE EXCEPTION 'La cuenta está anulada.';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW."importe" <> OLD."importe" OR NEW."fechaVencimiento" <> OLD."fechaVencimiento"
    OR NEW."numero" <> OLD."numero" OR NEW."cuentaId" <> OLD."cuentaId"
    OR NOT (OLD."vigente" AND NOT NEW."vigente")) THEN
    RAISE EXCEPTION 'Una cuota solo puede marcarse como sustituida.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "cuotas_cuenta_comercial_reglas" BEFORE INSERT OR UPDATE OR DELETE ON "cuotas_cuenta_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_cuotas_reglas"();

-- Al cerrar la transacción: las cuotas vigentes suman exactamente el total.
CREATE FUNCTION "comercializacion_cuotas_suman_total"() RETURNS trigger AS $$
DECLARE
  suma numeric;
  n int;
  total numeric;
BEGIN
  SELECT COALESCE(SUM("importe"), 0), COUNT(*) INTO suma, n FROM "cuotas_cuenta_comercial" WHERE "cuentaId" = NEW."cuentaId" AND "vigente";
  SELECT "total" INTO total FROM "cuentas_comerciales" WHERE "id" = NEW."cuentaId";
  IF n > 0 AND suma <> total THEN
    RAISE EXCEPTION 'Las cuotas vigentes (%) no suman el total de la cuenta (%).', suma, total;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "cuotas_cuenta_comercial_suman_total" AFTER INSERT OR UPDATE ON "cuotas_cuenta_comercial"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "comercializacion_cuotas_suman_total"();

-- Movimientos: solo en cuenta vigente con calendario; inmutables salvo su
-- anulación; el primero marca tuvoMovimientos para siempre.
CREATE FUNCTION "comercializacion_movimientos_reglas"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los cobros y pagos no se eliminan; se anulan con motivo.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "estatus"::text AS estatus INTO c FROM "cuentas_comerciales" WHERE "id" = NEW."cuentaId" FOR UPDATE;
    IF c.estatus <> 'VIGENTE' THEN
      RAISE EXCEPTION 'La cuenta está anulada.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "cuotas_cuenta_comercial" WHERE "cuentaId" = NEW."cuentaId" AND "vigente") THEN
      RAISE EXCEPTION 'Define las condiciones de pago antes de registrar el primer movimiento.';
    END IF;
    UPDATE "cuentas_comerciales" SET "tuvoMovimientos" = true, "updatedAt" = now() WHERE "id" = NEW."cuentaId" AND NOT "tuvoMovimientos";
    RETURN NEW;
  END IF;
  IF NEW."importe" <> OLD."importe" OR NEW."fecha" <> OLD."fecha" OR NEW."metodo" <> OLD."metodo"
     OR NEW."cuentaId" <> OLD."cuentaId"
     OR NEW."referencia" IS DISTINCT FROM OLD."referencia" OR NEW."observaciones" IS DISTINCT FROM OLD."observaciones"
     OR NEW."comprobanteRef" IS DISTINCT FROM OLD."comprobanteRef"
     OR NEW."registradoPorId" <> OLD."registradoPorId" OR NEW."claveRegistro" IS DISTINCT FROM OLD."claveRegistro"
     OR NOT (OLD."estatus"::text = 'VIGENTE' AND NEW."estatus"::text = 'ANULADO') THEN
    RAISE EXCEPTION 'Un cobro o pago registrado no se modifica; solo puede anularse con motivo.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "movimientos_comerciales_reglas" BEFORE INSERT OR UPDATE OR DELETE ON "movimientos_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_movimientos_reglas"();

-- Al cerrar la transacción: las aplicaciones de un movimiento suman su importe.
CREATE FUNCTION "comercializacion_movimiento_aplicado"() RETURNS trigger AS $$
DECLARE
  suma numeric;
BEGIN
  SELECT COALESCE(SUM("importe"), 0) INTO suma FROM "aplicaciones_movimiento_comercial" WHERE "movimientoId" = NEW."id";
  IF suma <> NEW."importe" THEN
    RAISE EXCEPTION 'Las aplicaciones (%) no suman el importe del movimiento (%).', suma, NEW."importe";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "movimientos_comerciales_aplicado" AFTER INSERT ON "movimientos_comerciales"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "comercializacion_movimiento_aplicado"();

-- Aplicaciones: misma cuenta, cuota vigente, movimiento vigente y sin
-- exceder el importe de la cuota. Inmutables.
CREATE FUNCTION "comercializacion_aplicaciones_reglas"() RETURNS trigger AS $$
DECLARE
  m record;
  q record;
  aplicado numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Las aplicaciones no se modifican ni eliminan; se anula el movimiento.';
  END IF;
  SELECT "cuentaId", "estatus"::text AS estatus INTO m FROM "movimientos_comerciales" WHERE "id" = NEW."movimientoId";
  SELECT "cuentaId", "vigente", "importe" INTO q FROM "cuotas_cuenta_comercial" WHERE "id" = NEW."cuotaId";
  IF m."cuentaId" <> q."cuentaId" THEN
    RAISE EXCEPTION 'La cuota no pertenece a la cuenta del movimiento.';
  END IF;
  IF m.estatus <> 'VIGENTE' OR NOT q."vigente" THEN
    RAISE EXCEPTION 'Solo se aplica un movimiento vigente a una cuota vigente.';
  END IF;
  PERFORM 1 FROM "cuentas_comerciales" WHERE "id" = m."cuentaId" FOR UPDATE;
  SELECT COALESCE(SUM(a."importe"), 0) INTO aplicado
  FROM "aplicaciones_movimiento_comercial" a
  JOIN "movimientos_comerciales" mv ON mv."id" = a."movimientoId"
  WHERE a."cuotaId" = NEW."cuotaId" AND mv."estatus" = 'VIGENTE';
  IF aplicado + NEW."importe" > q."importe" THEN
    RAISE EXCEPTION 'El importe aplicado supera el saldo de la cuota.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "aplicaciones_movimiento_comercial_reglas" BEFORE INSERT OR UPDATE OR DELETE ON "aplicaciones_movimiento_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_aplicaciones_reglas"();

-- B4 ↔ B5: una compra solo se anula si su cuenta ya está anulada (lo cual
-- exige que nunca haya tenido pagos). Bloquea la cuenta: resiste una
-- anulación y un pago simultáneos.
CREATE FUNCTION "comercializacion_compra_anulable"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF NEW."estatus"::text = 'ANULADA' AND OLD."estatus"::text <> 'ANULADA' THEN
    SELECT "estatus"::text AS estatus, "tuvoMovimientos" INTO c FROM "cuentas_comerciales" WHERE "compraId" = NEW."id" FOR UPDATE;
    IF FOUND AND (c."tuvoMovimientos" OR c.estatus <> 'ANULADA') THEN
      RAISE EXCEPTION 'La compra tiene historial de pagos o su cuenta por pagar sigue vigente; no se puede anular con la acción simple.';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "compras_comerciales_anulable" BEFORE UPDATE ON "compras_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_compra_anulable"();

-- Al cerrar la transacción: toda OV y toda compra confirmada tienen su cuenta
-- (se crea en la misma transacción que la aceptación/confirmación).
CREATE FUNCTION "comercializacion_documento_con_cuenta"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'ordenes_venta' THEN
    IF NOT EXISTS (SELECT 1 FROM "cuentas_comerciales" WHERE "ordenVentaId" = NEW."id") THEN
      RAISE EXCEPTION 'La orden de venta % no tiene cuenta por cobrar.', NEW."folio";
    END IF;
  ELSIF NEW."estatus"::text = 'CONFIRMADA' THEN
    IF NOT EXISTS (SELECT 1 FROM "cuentas_comerciales" WHERE "compraId" = NEW."id") THEN
      RAISE EXCEPTION 'La compra % confirmada no tiene cuenta por pagar.', NEW."folio";
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ordenes_venta_con_cuenta" AFTER INSERT ON "ordenes_venta"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "comercializacion_documento_con_cuenta"();
CREATE CONSTRAINT TRIGGER "compras_comerciales_con_cuenta" AFTER INSERT OR UPDATE ON "compras_comerciales"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "comercializacion_documento_con_cuenta"();

-- ---------------------------------------------------------------------------
-- Incorporación de documentos existentes (B3/B4): una cuenta por OV y por
-- compra CONFIRMADA, con id determinista y sin duplicados. Sin modalidad
-- ("Condiciones por definir"), sin cuotas y sin movimientos: no se inventan
-- pagos, modalidad ni vencimientos. Los totales de los documentos no cambian.
-- ---------------------------------------------------------------------------
INSERT INTO "cuentas_comerciales" ("id", "empresaId", "tipo", "ordenVentaId", "total", "updatedAt")
SELECT 'cxc-' || ov."id", ov."empresaId", 'POR_COBRAR', ov."id", ov."total", now()
FROM "ordenes_venta" ov
WHERE NOT EXISTS (SELECT 1 FROM "cuentas_comerciales" c WHERE c."ordenVentaId" = ov."id")
ON CONFLICT DO NOTHING;

INSERT INTO "cuentas_comerciales" ("id", "empresaId", "tipo", "compraId", "total", "updatedAt")
SELECT 'cxp-' || cc."id", cc."empresaId", 'POR_PAGAR', cc."id", cc."total", now()
FROM "compras_comerciales" cc
WHERE cc."estatus" = 'CONFIRMADA'
  AND NOT EXISTS (SELECT 1 FROM "cuentas_comerciales" c WHERE c."compraId" = cc."id")
ON CONFLICT DO NOTHING;

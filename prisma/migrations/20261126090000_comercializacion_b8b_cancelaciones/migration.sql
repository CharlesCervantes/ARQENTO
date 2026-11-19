-- Comercialización B8B (1/2): rechazo y cancelación de cotizaciones y
-- cancelación básica de la orden de venta. Sin cambios en datos existentes:
-- toda OV existente queda VIGENTE y ninguna cotización cambia de estado.
-- Los valores nuevos de enum se comparan como ::text porque no pueden usarse
-- como literal en la misma transacción en que se agregan.

-- CreateEnum
CREATE TYPE "EstatusOrdenVenta" AS ENUM ('VIGENTE', 'CANCELADA');

-- AlterEnum
ALTER TYPE "EstatusCotizacionVenta" ADD VALUE 'RECHAZADA';
ALTER TYPE "EstatusCotizacionVenta" ADD VALUE 'CANCELADA';

-- AlterTable
ALTER TABLE "cotizaciones_venta" ADD COLUMN     "cerradaEn" TIMESTAMP(3),
ADD COLUMN     "cerradaPorId" TEXT,
ADD COLUMN     "motivoCierre" TEXT;

-- AlterTable
ALTER TABLE "ordenes_venta" ADD COLUMN     "canceladaEn" TIMESTAMP(3),
ADD COLUMN     "canceladaPorId" TEXT,
ADD COLUMN     "estatus" "EstatusOrdenVenta" NOT NULL DEFAULT 'VIGENTE',
ADD COLUMN     "motivoCancelacion" TEXT;

-- AddForeignKey
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_cerradaPorId_fkey" FOREIGN KEY ("cerradaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_canceladaPorId_fkey" FOREIGN KEY ("canceladaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cotizaciones
-- ---------------------------------------------------------------------------

-- Copia emitida: obligatoria salvo en borrador y en un borrador cancelado
-- (que nunca se emitió).
ALTER TABLE "cotizaciones_venta" DROP CONSTRAINT "cotizaciones_venta_emitida_con_copia";
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_emitida_con_copia" CHECK (
  "estatus"::text = 'BORRADOR'
  OR ("estatus"::text = 'CANCELADA' AND "documentoEmitido" IS NULL AND "emitidaEn" IS NULL AND "emitidaPorId" IS NULL)
  OR ("documentoEmitido" IS NOT NULL AND "emitidaEn" IS NOT NULL AND "emitidaPorId" IS NOT NULL)
);
-- Rechazo/cancelación: autor, fecha y motivo completos solo en esos estados;
-- solo se rechaza una cotización emitida.
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_cierre" CHECK (
  ("estatus"::text IN ('RECHAZADA', 'CANCELADA')) = ("cerradaEn" IS NOT NULL AND "cerradaPorId" IS NOT NULL AND length(btrim(coalesce("motivoCierre", ''))) > 0)
  AND ("estatus"::text <> 'RECHAZADA' OR "emitidaEn" IS NOT NULL)
);

-- Transiciones (sustituye la regla de B3, que se conserva):
--   BORRADOR → EMITIDA | CANCELADA (cancelar no cambia nada más)
--   EMITIDA  → ACEPTADA | RECHAZADA | CANCELADA (sin tocar la copia emitida)
--   ACEPTADA, RECHAZADA y CANCELADA son terminales.
CREATE OR REPLACE FUNCTION "comercializacion_cotizacion_emitida_inmutable"() RETURNS trigger AS $$
DECLARE
  cierre text[] := ARRAY['estatus', 'cerradaEn', 'cerradaPorId', 'motivoCierre', 'version', 'actualizadoPorId', 'updatedAt'];
BEGIN
  IF OLD."estatus"::text IN ('RECHAZADA', 'CANCELADA') THEN
    IF (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'Una cotización rechazada o cancelada no se modifica; duplícala para una nueva venta.';
    END IF;
    RETURN NEW;
  END IF;
  -- Los datos del cierre solo se escriben al rechazar o cancelar.
  IF (NEW."cerradaEn" IS DISTINCT FROM OLD."cerradaEn" OR NEW."cerradaPorId" IS DISTINCT FROM OLD."cerradaPorId"
      OR NEW."motivoCierre" IS DISTINCT FROM OLD."motivoCierre")
     AND NEW."estatus"::text NOT IN ('RECHAZADA', 'CANCELADA') THEN
    RAISE EXCEPTION 'Los datos de rechazo o cancelación solo se registran al rechazar o cancelar.';
  END IF;
  IF OLD."estatus"::text = 'BORRADOR' THEN
    IF NEW."estatus"::text NOT IN ('BORRADOR', 'EMITIDA', 'CANCELADA') THEN
      RAISE EXCEPTION 'Un borrador solo puede emitirse o cancelarse.';
    END IF;
    IF NEW."estatus"::text = 'CANCELADA' AND (to_jsonb(NEW) - cierre) IS DISTINCT FROM (to_jsonb(OLD) - cierre) THEN
      RAISE EXCEPTION 'Cancelar un borrador no modifica sus datos.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."documentoEmitido" IS DISTINCT FROM OLD."documentoEmitido"
    OR NEW."subtotal" <> OLD."subtotal" OR NEW."iva" <> OLD."iva" OR NEW."total" <> OLD."total"
    OR NEW."clienteId" IS DISTINCT FROM OLD."clienteId" OR NEW."obraId" IS DISTINCT FROM OLD."obraId"
    OR NEW."vendedorId" <> OLD."vendedorId" OR NEW."folio" <> OLD."folio"
    OR NEW."fecha" <> OLD."fecha" OR NEW."vigenciaHasta" IS DISTINCT FROM OLD."vigenciaHasta"
    OR NEW."descripcion" IS DISTINCT FROM OLD."descripcion"
    OR NEW."condiciones" IS DISTINCT FROM OLD."condiciones"
    OR NEW."observaciones" IS DISTINCT FROM OLD."observaciones"
    OR NEW."emitidaEn" IS DISTINCT FROM OLD."emitidaEn"
    OR NOT (NEW."estatus"::text = OLD."estatus"::text
            OR (OLD."estatus"::text = 'EMITIDA' AND NEW."estatus"::text IN ('ACEPTADA', 'RECHAZADA', 'CANCELADA')))
  THEN
    RAISE EXCEPTION 'Una cotización emitida no se puede modificar; duplícala para corregirla.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Una OV solo nace de una cotización emitida (la aceptación la cambia a
-- ACEPTADA en la misma transacción): nunca de una rechazada o cancelada.
CREATE FUNCTION "comercializacion_orden_de_cotizacion_aceptable"() RETURNS trigger AS $$
DECLARE
  e text;
BEGIN
  SELECT "estatus"::text INTO e FROM "cotizaciones_venta" WHERE "id" = NEW."cotizacionId" FOR UPDATE;
  IF e IS NULL OR e NOT IN ('EMITIDA', 'ACEPTADA') THEN
    RAISE EXCEPTION 'Solo una cotización emitida puede aceptarse y generar una orden de venta.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "ordenes_venta_de_cotizacion_aceptable" BEFORE INSERT ON "ordenes_venta"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_orden_de_cotizacion_aceptable"();

-- ---------------------------------------------------------------------------
-- Orden de venta
-- ---------------------------------------------------------------------------

ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_cancelacion" CHECK (
  ("estatus" = 'CANCELADA') = ("canceladaEn" IS NOT NULL AND "canceladaPorId" IS NOT NULL AND length(btrim(coalesce("motivoCancelacion", ''))) > 0)
);

-- Cancelada = definitiva e inmutable. Cancelar solo cambia el estado y sus
-- datos, y exige (defensa en profundidad del servicio): cuenta por cobrar ya
-- anulada; ninguna cuenta de la OV, sus compras o gastos con historial de
-- movimientos (aunque estén anulados); sin compras en borrador o confirmadas,
-- gastos vigentes, entregas vigentes ni vínculos de surtido vigentes.
CREATE FUNCTION "comercializacion_orden_venta_reglas"() RETURNS trigger AS $$
DECLARE
  datos text[] := ARRAY['estatus', 'canceladaEn', 'canceladaPorId', 'motivoCancelacion'];
BEGIN
  IF OLD."estatus" = 'CANCELADA' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'Una orden de venta cancelada no se modifica ni se reabre.';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."canceladaEn" IS DISTINCT FROM OLD."canceladaEn" OR NEW."canceladaPorId" IS DISTINCT FROM OLD."canceladaPorId"
      OR NEW."motivoCancelacion" IS DISTINCT FROM OLD."motivoCancelacion")
     AND NEW."estatus" <> 'CANCELADA' THEN
    RAISE EXCEPTION 'Los datos de cancelación solo se registran al cancelar la orden de venta.';
  END IF;
  IF NEW."estatus" = 'CANCELADA' THEN
    IF (to_jsonb(NEW) - datos) IS DISTINCT FROM (to_jsonb(OLD) - datos) THEN
      RAISE EXCEPTION 'Cancelar la orden de venta no modifica sus datos.';
    END IF;
    IF EXISTS (SELECT 1 FROM "cuentas_comerciales" WHERE "ordenVentaId" = NEW."id" AND "estatus" <> 'ANULADA') THEN
      RAISE EXCEPTION 'La cuenta por cobrar de la orden sigue vigente.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "cuentas_comerciales" cu
      WHERE cu."tuvoMovimientos" AND (
        cu."ordenVentaId" = NEW."id"
        OR cu."compraId" IN (SELECT "id" FROM "compras_comerciales" WHERE "ordenVentaId" = NEW."id")
        OR cu."gastoId" IN (SELECT "id" FROM "gastos_comerciales" WHERE "ordenVentaId" = NEW."id"))
    ) THEN
      RAISE EXCEPTION 'La orden tiene historial de cobros o pagos; no se cancela con la acción básica.';
    END IF;
    IF EXISTS (SELECT 1 FROM "compras_comerciales" WHERE "ordenVentaId" = NEW."id" AND "estatus" <> 'ANULADA') THEN
      RAISE EXCEPTION 'La orden tiene compras vigentes o en borrador.';
    END IF;
    IF EXISTS (SELECT 1 FROM "gastos_comerciales" WHERE "ordenVentaId" = NEW."id" AND "estatus" <> 'ANULADO') THEN
      RAISE EXCEPTION 'La orden tiene gastos adicionales vigentes.';
    END IF;
    IF EXISTS (SELECT 1 FROM "entregas_comerciales" WHERE "ordenVentaId" = NEW."id" AND "estatus" <> 'ANULADA') THEN
      RAISE EXCEPTION 'La orden tiene entregas vigentes.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "vinculos_surtido_comercial" v
      JOIN "entregas_comerciales" e ON e."id" = v."entregaId" AND e."estatus" = 'CONFIRMADA'
      JOIN "compras_comerciales" c ON c."id" = v."compraId" AND c."estatus" = 'CONFIRMADA'
      WHERE v."ordenVentaId" = NEW."id" AND v."estatus" = 'VIGENTE'
    ) THEN
      RAISE EXCEPTION 'La orden tiene vínculos de surtido vigentes.';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "ordenes_venta_reglas" BEFORE UPDATE ON "ordenes_venta"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_orden_venta_reglas"();
CREATE TRIGGER "ordenes_venta_sin_borrado" BEFORE DELETE ON "ordenes_venta"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_sin_borrado"();

-- Dependencias nuevas solo en una OV vigente. Bloquea la OV (mismo orden que
-- los servicios: OV primero): una cancelación y un alta simultáneas se
-- serializan y la segunda ve el resultado de la primera.
CREATE FUNCTION "comercializacion_exige_orden_vigente"() RETURNS trigger AS $$
DECLARE
  e text;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (NEW."estatus"::text = 'CONFIRMADA' AND OLD."estatus"::text <> 'CONFIRMADA') THEN
    RETURN NEW;
  END IF;
  SELECT "estatus"::text INTO e FROM "ordenes_venta" WHERE "id" = NEW."ordenVentaId" FOR UPDATE;
  IF e = 'CANCELADA' THEN
    RAISE EXCEPTION 'La orden de venta está cancelada: no admite nuevas compras, gastos, entregas ni vínculos.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "compras_comerciales_orden_vigente" BEFORE INSERT OR UPDATE ON "compras_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_exige_orden_vigente"();
CREATE TRIGGER "gastos_comerciales_orden_vigente" BEFORE INSERT ON "gastos_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_exige_orden_vigente"();
CREATE TRIGGER "entregas_comerciales_orden_vigente" BEFORE INSERT ON "entregas_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_exige_orden_vigente"();
CREATE TRIGGER "vinculos_surtido_comercial_orden_vigente" BEFORE INSERT ON "vinculos_surtido_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_exige_orden_vigente"();

-- La cuenta por cobrar solo se anula junto con la cancelación de su OV
-- (comprobado al cerrar la transacción).
CREATE FUNCTION "comercializacion_cuenta_cobro_anulada"() RETURNS trigger AS $$
BEGIN
  IF NEW."ordenVentaId" IS NOT NULL AND NEW."estatus"::text = 'ANULADA' AND OLD."estatus"::text <> 'ANULADA'
     AND NOT EXISTS (SELECT 1 FROM "ordenes_venta" WHERE "id" = NEW."ordenVentaId" AND "estatus" = 'CANCELADA') THEN
    RAISE EXCEPTION 'La cuenta por cobrar solo se anula al cancelar su orden de venta.';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "cuentas_comerciales_cobro_anulada" AFTER UPDATE ON "cuentas_comerciales"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "comercializacion_cuenta_cobro_anulada"();

-- ---------------------------------------------------------------------------
-- Compras: descartar un borrador (BORRADOR → ANULADA, con motivo) no depende
-- del surtido a obra; las reglas de B5/B8A aplican solo a compras confirmadas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "comercializacion_compra_anulable"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF NEW."estatus"::text = 'ANULADA' AND OLD."estatus"::text = 'CONFIRMADA' THEN
    SELECT "estatus"::text AS estatus, "tuvoMovimientos" INTO c FROM "cuentas_comerciales" WHERE "compraId" = NEW."id" FOR UPDATE;
    IF FOUND AND (c."tuvoMovimientos" OR c.estatus <> 'ANULADA') THEN
      RAISE EXCEPTION 'La compra tiene historial de pagos o su cuenta por pagar sigue vigente; no se puede anular con la acción simple.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "vinculos_surtido_comercial" v JOIN "entregas_comerciales" e ON e."id" = v."entregaId"
      WHERE v."compraId" = NEW."id" AND v."estatus" = 'VIGENTE' AND e."estatus" = 'CONFIRMADA'
    ) THEN
      RAISE EXCEPTION 'La compra tiene cantidades vinculadas a entregas vigentes; no se puede anular con la acción simple.';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "partidas_compra_comercial" pcom
      JOIN "partidas_entrega_comercial" pe ON pe."partidaVentaId" = pcom."partidaVentaId"
      JOIN "entregas_comerciales" e ON e."id" = pe."entregaId" AND e."estatus" = 'CONFIRMADA'
      WHERE pcom."compraId" = NEW."id"
        AND pe."cantidad" > coalesce((
          SELECT sum(v."cantidad") FROM "vinculos_surtido_comercial" v JOIN "compras_comerciales" co ON co."id" = v."compraId"
          WHERE v."partidaEntregaId" = pe."id" AND v."estatus" = 'VIGENTE' AND co."estatus" = 'CONFIRMADA'
        ), 0)
    ) THEN
      RAISE EXCEPTION 'Hay cantidades entregadas sin vincular en materiales de esta compra; vincula esas entregas antes de anularla.';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

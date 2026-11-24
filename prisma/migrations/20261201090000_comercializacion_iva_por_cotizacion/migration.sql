-- IVA por cotización (noviembre 2026). docs/negocio/comercializacion.md §20.
--
-- El precio del catálogo es el precio de venta sin IVA. El impuesto ya no se
-- captura por producto: se decide UNA vez por cotización («Con IVA» = 16 %
-- sobre el subtotal, o «Sin IVA») y el servidor lo aplica a todas sus
-- partidas. No modifica datos existentes: productos, cotizaciones, documentos
-- emitidos y órdenes anteriores conservan sus tratamientos y tasas.

-- 1. Catálogo: los datos fiscales del producto quedan como dato histórico
--    opcional. Un producto nuevo se guarda sin tratamiento ni tasa; uno
--    anterior conserva los suyos (misma regla tratamiento ⇔ tasa).
ALTER TABLE "productos_comerciales" ALTER COLUMN "tratamientoImpuesto" DROP DEFAULT;
ALTER TABLE "productos_comerciales" ALTER COLUMN "tratamientoImpuesto" DROP NOT NULL;
ALTER TABLE "productos_comerciales" DROP CONSTRAINT "productos_comerciales_tasa_segun_tratamiento";
-- (IS NOT NULL explícito: con tratamiento NULL una comparación daría NULL y el
-- CHECK la dejaría pasar, p. ej. una tasa sin tratamiento.)
ALTER TABLE "productos_comerciales" ADD CONSTRAINT "productos_comerciales_tasa_segun_tratamiento" CHECK (
  ("tratamientoImpuesto" IS NULL AND "tasaIva" IS NULL)
  OR ("tratamientoImpuesto" IS NOT NULL AND "tratamientoImpuesto"::text = 'GRAVADO'
      AND "tasaIva" IS NOT NULL AND "tasaIva" > 0 AND "tasaIva" <= 100)
  OR ("tratamientoImpuesto" IS NOT NULL AND "tratamientoImpuesto"::text IN ('TASA_CERO', 'EXENTO') AND "tasaIva" IS NULL)
);

-- 2. Opción de IVA de la cotización. NULL = esquema anterior (tratamiento y
--    tasa por partida): todas las cotizaciones existentes quedan así, sin
--    cambios. PENDIENTE = copia de un documento anterior que no se representa
--    con las dos opciones; no puede emitirse hasta elegir.
CREATE TYPE "ImpuestoCotizacionVenta" AS ENUM ('CON_IVA', 'SIN_IVA', 'PENDIENTE');
ALTER TABLE "cotizaciones_venta" ADD COLUMN "impuestoVenta" "ImpuestoCotizacionVenta";
ALTER TABLE "cotizaciones_venta" ADD CONSTRAINT "cotizaciones_venta_impuesto_pendiente_solo_borrador" CHECK (
  "impuestoVenta" IS DISTINCT FROM 'PENDIENTE' OR "estatus"::text IN ('BORRADOR', 'CANCELADA')
);

-- 3. Partidas de venta: «Sin IVA» deja de ser exclusivo de compras (es la
--    opción comercial de la cotización). Tasa 0 % y Exento conservan su
--    significado; la regla tratamiento ⇔ tasa de B2 sigue vigente.
ALTER TABLE "partidas_cotizacion_venta" DROP CONSTRAINT "partidas_cotizacion_venta_sin_iva_solo_compras";

-- 4. Una cotización emitida tampoco cambia su opción de IVA. Misma función
--    que 20261130090100, agregando solo la comparación de "impuestoVenta".
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
    OR NEW."impuestoVenta" IS DISTINCT FROM OLD."impuestoVenta"
    OR NEW."clienteId" IS DISTINCT FROM OLD."clienteId" OR NEW."obraId" IS DISTINCT FROM OLD."obraId"
    OR NEW."vendedorId" IS DISTINCT FROM OLD."vendedorId" OR NEW."folio" <> OLD."folio"
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

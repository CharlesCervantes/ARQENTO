-- Vendedor opcional durante toda la venta (noviembre 2026).
-- docs/negocio/comercializacion.md §20.
--
-- Administración y Dirección pueden operar cotización → emisión → PDF →
-- aceptación → orden de venta SIN vendedor asignado. «Sin vendedor» es
-- vendedorId NULL. Quién realizó cada acción se sigue registrando aparte
-- (creadoPorId, actualizadoPorId, emitidaPorId, cerradaPorId y
-- ordenes_venta.registradaPorId).
--
-- Solo relaja la columna: las cotizaciones existentes conservan su vendedor
-- y su documento emitido sin cambios. La llave foránea se mantiene.
ALTER TABLE "cotizaciones_venta" ALTER COLUMN "vendedorId" DROP NOT NULL;

-- La regla de inmutabilidad de una cotización emitida comparaba
-- vendedorId con «<>», que con NULL no detecta el cambio. Se reemplaza la
-- función con la misma definición de B8B, cambiando solo esa comparación a
-- IS DISTINCT FROM. El trigger cotizaciones_venta_emitida_inmutable sigue
-- apuntando a esta función.
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

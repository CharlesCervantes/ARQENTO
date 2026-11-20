-- Compras a proveedor: selector «Sin IVA» / «IVA 16 %» (ajuste de nov-2026).
-- SIN_IVA es un tratamiento propio de las partidas de compra: el cálculo no
-- agrega impuesto y NO declara exención ni tasa 0 %. Los registros existentes
-- no se modifican (conservan TASA_CERO, EXENTO y sus tasas originales).

-- AlterEnum
ALTER TYPE "TratamientoImpuestoComercial" ADD VALUE 'SIN_IVA';

-- Las comparaciones usan ::text porque el valor nuevo del enum no puede
-- usarse como literal en la misma transacción en que se agrega.

-- Partidas de compra: SIN_IVA sin tasa (sustituye la regla de B4).
ALTER TABLE "partidas_compra_comercial" DROP CONSTRAINT "partidas_compra_comercial_tasa_segun_tratamiento";
ALTER TABLE "partidas_compra_comercial" ADD CONSTRAINT "partidas_compra_comercial_tasa_segun_tratamiento" CHECK (
  ("tratamientoImpuesto" IS NULL AND "tasaIva" IS NULL)
  OR ("tratamientoImpuesto"::text = 'GRAVADO' AND "tasaIva" IS NOT NULL AND "tasaIva" > 0 AND "tasaIva" <= 100)
  OR ("tratamientoImpuesto"::text IN ('TASA_CERO', 'EXENTO', 'SIN_IVA') AND "tasaIva" IS NULL)
);

-- Catálogo, cotizaciones de venta y gastos adicionales no usan SIN_IVA.
ALTER TABLE "productos_comerciales" ADD CONSTRAINT "productos_comerciales_sin_iva_solo_compras" CHECK ("tratamientoImpuesto"::text <> 'SIN_IVA');
ALTER TABLE "partidas_cotizacion_venta" ADD CONSTRAINT "partidas_cotizacion_venta_sin_iva_solo_compras" CHECK ("tratamientoImpuesto"::text <> 'SIN_IVA');
ALTER TABLE "gastos_comerciales" ADD CONSTRAINT "gastos_comerciales_sin_iva_solo_compras" CHECK ("tratamientoImpuesto"::text <> 'SIN_IVA');

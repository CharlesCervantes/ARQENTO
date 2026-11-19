-- Comercialización B8B: la cuenta por cobrar de una OV también puede quedar
-- ANULADA (solo al cancelar su OV, sin historial de movimientos). Sustituye la
-- regla de B5, que limitaba la anulación a cuentas por pagar. Que la OV esté
-- cancelada lo exige el trigger diferido "cuentas_comerciales_cobro_anulada".
ALTER TABLE "cuentas_comerciales" DROP CONSTRAINT "cuentas_comerciales_anulacion";
ALTER TABLE "cuentas_comerciales" ADD CONSTRAINT "cuentas_comerciales_anulacion" CHECK (
  ("estatus" = 'ANULADA') = ("anuladaEn" IS NOT NULL AND "anuladaPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
  AND ("estatus" = 'VIGENTE' OR NOT "tuvoMovimientos")
);

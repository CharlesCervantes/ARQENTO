-- Corrección de 20261120090000_comercializacion_b5_cuentas: en la función que
-- verifica que las cuotas vigentes sumen el total de la cuenta, la variable
-- local "total" era ambigua con la columna "total" (error 42702 al guardar
-- cualquier calendario). Solo reemplaza la función; no cambia datos.
CREATE OR REPLACE FUNCTION "comercializacion_cuotas_suman_total"() RETURNS trigger AS $$
DECLARE
  v_suma numeric;
  v_cuotas int;
  v_total numeric;
BEGIN
  SELECT COALESCE(SUM(q."importe"), 0), COUNT(*) INTO v_suma, v_cuotas
  FROM "cuotas_cuenta_comercial" q WHERE q."cuentaId" = NEW."cuentaId" AND q."vigente";
  SELECT c."total" INTO v_total FROM "cuentas_comerciales" c WHERE c."id" = NEW."cuentaId";
  IF v_cuotas > 0 AND v_suma <> v_total THEN
    RAISE EXCEPTION 'Las cuotas vigentes (%) no suman el total de la cuenta (%).', v_suma, v_total;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

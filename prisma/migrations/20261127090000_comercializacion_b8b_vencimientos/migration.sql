-- Comercialización B8B (2/2): cambio individual del vencimiento de una cuota
-- con saldo, aunque la cuenta tenga movimientos. Solo cambia la fecha de esa
-- cuota y queda historial (anterior, nueva, motivo, autor, fecha). No toca
-- importes, número de cuotas, modalidad, aplicaciones ni las demás cuotas, y
-- se conserva la regla de B5: con movimientos no se sustituye el calendario.
-- Sin cambios en datos existentes.

-- CreateTable
CREATE TABLE "cambios_vencimiento_cuota" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "cuentaId" TEXT NOT NULL,
    "cuotaId" TEXT NOT NULL,
    "fechaAnterior" DATE NOT NULL,
    "fechaNueva" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claveRegistro" TEXT NOT NULL,

    CONSTRAINT "cambios_vencimiento_cuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cambios_vencimiento_cuota_cuotaId_idx" ON "cambios_vencimiento_cuota"("cuotaId");

-- CreateIndex
CREATE INDEX "cambios_vencimiento_cuota_cuentaId_idx" ON "cambios_vencimiento_cuota"("cuentaId");

-- CreateIndex
CREATE UNIQUE INDEX "cambios_vencimiento_cuota_empresaId_claveRegistro_key" ON "cambios_vencimiento_cuota"("empresaId", "claveRegistro");

-- AddForeignKey
ALTER TABLE "cambios_vencimiento_cuota" ADD CONSTRAINT "cambios_vencimiento_cuota_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cambios_vencimiento_cuota" ADD CONSTRAINT "cambios_vencimiento_cuota_cuentaId_empresaId_fkey" FOREIGN KEY ("cuentaId", "empresaId") REFERENCES "cuentas_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cambios_vencimiento_cuota" ADD CONSTRAINT "cambios_vencimiento_cuota_cuotaId_empresaId_fkey" FOREIGN KEY ("cuotaId", "empresaId") REFERENCES "cuotas_cuenta_comercial"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cambios_vencimiento_cuota" ADD CONSTRAINT "cambios_vencimiento_cuota_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cambios_vencimiento_cuota" ADD CONSTRAINT "cambios_vencimiento_cuota_valores" CHECK (
  "fechaNueva" <> "fechaAnterior"
  AND length(btrim("motivo")) BETWEEN 3 AND 500
  AND char_length("claveRegistro") BETWEEN 8 AND 200
);

-- El historial no se edita ni se borra. Un cambio solo se registra para una
-- cuota VIGENTE de la misma cuenta, con saldo, en una cuenta VIGENTE, y su
-- fecha anterior es la vigente (bloquea la cuenta: un pago simultáneo espera).
CREATE FUNCTION "comercializacion_cambios_vencimiento"() RETURNS trigger AS $$
DECLARE
  c record;
  q record;
  saldo numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'El historial de vencimientos no se modifica ni se elimina.';
  END IF;
  SELECT "estatus"::text AS estatus INTO c FROM "cuentas_comerciales" WHERE "id" = NEW."cuentaId" FOR UPDATE;
  IF c.estatus IS DISTINCT FROM 'VIGENTE' THEN
    RAISE EXCEPTION 'La cuenta está anulada: no se cambian vencimientos.';
  END IF;
  SELECT "cuentaId", "vigente", "fechaVencimiento", "importe" INTO q FROM "cuotas_cuenta_comercial" WHERE "id" = NEW."cuotaId";
  IF q."cuentaId" IS DISTINCT FROM NEW."cuentaId" OR NOT q."vigente" THEN
    RAISE EXCEPTION 'La cuota no pertenece al calendario vigente de la cuenta.';
  END IF;
  IF q."fechaVencimiento" <> NEW."fechaAnterior" THEN
    RAISE EXCEPTION 'La fecha anterior no coincide con el vencimiento vigente de la cuota.';
  END IF;
  SELECT q."importe" - coalesce(sum(a."importe"), 0) INTO saldo
  FROM "aplicaciones_movimiento_comercial" a
  JOIN "movimientos_comerciales" m ON m."id" = a."movimientoId" AND m."estatus" = 'VIGENTE'
  WHERE a."cuotaId" = NEW."cuotaId";
  IF saldo <= 0 THEN
    RAISE EXCEPTION 'La cuota está liquidada: su vencimiento ya no cambia.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "cambios_vencimiento_cuota_reglas" BEFORE INSERT OR UPDATE OR DELETE ON "cambios_vencimiento_cuota"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_cambios_vencimiento"();

-- Cuotas (sustituye la regla de B5, que se conserva): además de marcarse como
-- sustituidas (solo sin movimientos), una cuota vigente puede cambiar SOLO su
-- fecha —aunque la cuenta tenga movimientos— si en esta misma transacción se
-- registró el cambio correspondiente en el historial.
CREATE OR REPLACE FUNCTION "comercializacion_cuotas_reglas"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las cuotas no se eliminan; el calendario se sustituye conservando el historial.';
  END IF;
  SELECT "tuvoMovimientos", "estatus"::text AS estatus INTO c FROM "cuentas_comerciales" WHERE "id" = NEW."cuentaId" FOR UPDATE;
  IF TG_OP = 'UPDATE' AND NEW."fechaVencimiento" <> OLD."fechaVencimiento" THEN
    IF c.estatus <> 'VIGENTE' THEN
      RAISE EXCEPTION 'La cuenta está anulada.';
    END IF;
    IF NEW."importe" <> OLD."importe" OR NEW."numero" <> OLD."numero" OR NEW."cuentaId" <> OLD."cuentaId"
       OR NOT OLD."vigente" OR NOT NEW."vigente" OR NEW."sustituidaEn" IS DISTINCT FROM OLD."sustituidaEn" THEN
      RAISE EXCEPTION 'Un cambio de vencimiento solo modifica la fecha de una cuota vigente.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "cambios_vencimiento_cuota" h
      WHERE h."cuotaId" = NEW."id" AND h."fechaAnterior" = OLD."fechaVencimiento" AND h."fechaNueva" = NEW."fechaVencimiento"
        AND "comercializacion_creada_en_esta_transaccion"(h.xmin)
    ) THEN
      RAISE EXCEPTION 'El vencimiento de una cuota solo cambia con su registro en el historial.';
    END IF;
    RETURN NEW;
  END IF;
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

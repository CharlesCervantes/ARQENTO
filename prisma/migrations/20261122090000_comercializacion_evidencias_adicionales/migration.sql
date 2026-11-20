-- Comercialización (cierre de B6): agregar evidencias a una entrega vigente.
-- Aditiva: una tabla de cargas (autor, fecha y clave idempotente de cada
-- incorporación) y una columna opcional en las evidencias. Las evidencias
-- existentes quedan con cargaId NULL (= registradas con la entrega).

-- AlterTable
ALTER TABLE "evidencias_entrega_comercial" ADD COLUMN     "cargaId" TEXT;

-- CreateTable
CREATE TABLE "cargas_evidencia_entrega" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "entregaId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "registradaPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cargas_evidencia_entrega_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cargas_evidencia_entrega_entregaId_idx" ON "cargas_evidencia_entrega"("entregaId");

-- CreateIndex
CREATE UNIQUE INDEX "cargas_evidencia_entrega_empresaId_clave_key" ON "cargas_evidencia_entrega"("empresaId", "clave");

-- CreateIndex
CREATE INDEX "evidencias_entrega_comercial_cargaId_idx" ON "evidencias_entrega_comercial"("cargaId");

-- AddForeignKey
ALTER TABLE "evidencias_entrega_comercial" ADD CONSTRAINT "evidencias_entrega_comercial_cargaId_fkey" FOREIGN KEY ("cargaId") REFERENCES "cargas_evidencia_entrega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargas_evidencia_entrega" ADD CONSTRAINT "cargas_evidencia_entrega_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargas_evidencia_entrega" ADD CONSTRAINT "cargas_evidencia_entrega_entregaId_empresaId_fkey" FOREIGN KEY ("entregaId", "empresaId") REFERENCES "entregas_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargas_evidencia_entrega" ADD CONSTRAINT "cargas_evidencia_entrega_registradaPorId_fkey" FOREIGN KEY ("registradaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cargas_evidencia_entrega" ADD CONSTRAINT "cargas_evidencia_entrega_clave_longitud" CHECK (char_length("clave") BETWEEN 8 AND 100);

-- ---------------------------------------------------------------------------
-- Reglas en la base (defensa en profundidad; el servicio ya las aplica).
-- ---------------------------------------------------------------------------

-- Una carga se crea solo sobre una entrega CONFIRMADA de la misma Empresa y
-- después no se modifica ni se borra. FOR SHARE espera a una anulación en
-- curso y vuelve a leer: si la entrega quedó ANULADA, se rechaza.
CREATE FUNCTION "comercializacion_cargas_evidencia"() RETURNS trigger AS $$
DECLARE
  v_estatus text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Una carga de evidencias no se modifica ni se borra.';
  END IF;
  SELECT e."estatus"::text INTO v_estatus
  FROM "entregas_comerciales" e
  WHERE e."id" = NEW."entregaId" AND e."empresaId" = NEW."empresaId"
  FOR SHARE;
  IF v_estatus IS DISTINCT FROM 'CONFIRMADA' THEN
    RAISE EXCEPTION 'No se agregan evidencias a una entrega anulada.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "cargas_evidencia_entrega_reglas"
BEFORE INSERT OR UPDATE OR DELETE ON "cargas_evidencia_entrega"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_cargas_evidencia"();

-- Evidencias: solo se insertan (nunca se modifican ni se borran), y solo
-- (a) en la transacción que crea la entrega (registro original, B6A), o
-- (b) en la transacción que crea una carga de esa misma entrega confirmada.
-- Máximo acumulado: 20 evidencias por entrega.
CREATE OR REPLACE FUNCTION "comercializacion_evidencias_entrega"() RETURNS trigger AS $$
DECLARE
  v_entrega RECORD;
  v_carga RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Las evidencias de una entrega no se modifican ni se borran.';
  END IF;
  SELECT e."estatus"::text AS estatus, e.xmin AS fila_xmin INTO v_entrega
  FROM "entregas_comerciales" e WHERE e."id" = NEW."entregaId";
  IF v_entrega.estatus IS DISTINCT FROM 'CONFIRMADA' THEN
    RAISE EXCEPTION 'No se agregan evidencias a una entrega anulada.';
  END IF;
  IF NEW."cargaId" IS NULL THEN
    IF NOT "comercializacion_creada_en_esta_transaccion"(v_entrega.fila_xmin) THEN
      RAISE EXCEPTION 'Las evidencias posteriores al registro se agregan mediante una carga.';
    END IF;
  ELSE
    SELECT c."entregaId", c."empresaId", c.xmin AS fila_xmin INTO v_carga
    FROM "cargas_evidencia_entrega" c WHERE c."id" = NEW."cargaId";
    IF v_carga."entregaId" IS DISTINCT FROM NEW."entregaId" OR v_carga."empresaId" IS DISTINCT FROM NEW."empresaId" THEN
      RAISE EXCEPTION 'La carga de evidencias no corresponde a la entrega.';
    END IF;
    IF NOT "comercializacion_creada_en_esta_transaccion"(v_carga.fila_xmin) THEN
      RAISE EXCEPTION 'Las evidencias solo se adjuntan al crear su carga.';
    END IF;
  END IF;
  IF (SELECT count(*) FROM "evidencias_entrega_comercial" WHERE "entregaId" = NEW."entregaId") >= 20 THEN
    RAISE EXCEPTION 'Una entrega admite máximo 20 evidencias en total.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Al confirmar la transacción, toda carga tiene al menos una evidencia.
CREATE FUNCTION "comercializacion_carga_completa"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "evidencias_entrega_comercial" WHERE "cargaId" = NEW."id") THEN
    RAISE EXCEPTION 'Una carga requiere al menos una evidencia.';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "cargas_evidencia_entrega_completa"
AFTER INSERT ON "cargas_evidencia_entrega"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "comercializacion_carga_completa"();

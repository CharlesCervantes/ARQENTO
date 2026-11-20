-- Comercialización B6A: entregas parciales al cliente/obra con evidencias.
-- Aditiva. Ver docs/negocio/comercializacion.md §20 (B6A).

-- CreateEnum
CREATE TYPE "EstatusEntregaComercial" AS ENUM ('CONFIRMADA', 'ANULADA');

-- CreateEnum
CREATE TYPE "ClaseEvidenciaEntrega" AS ENUM ('FOTOGRAFIA', 'REMISION');


-- CreateTable
CREATE TABLE "entregas_comerciales" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "ordenVentaId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "estatus" "EstatusEntregaComercial" NOT NULL DEFAULT 'CONFIRMADA',
    "fechaEntrega" DATE NOT NULL,
    "recibidoPor" TEXT,
    "observaciones" TEXT,
    "claveRegistro" TEXT NOT NULL,
    "registradaPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anuladaEn" TIMESTAMP(3),
    "anuladaPorId" TEXT,
    "motivoAnulacion" TEXT,

    CONSTRAINT "entregas_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partidas_entrega_comercial" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "entregaId" TEXT NOT NULL,
    "partidaVentaId" TEXT NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "partidas_entrega_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidencias_entrega_comercial" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "entregaId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "clase" "ClaseEvidenciaEntrega" NOT NULL,
    "ref" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidencias_entrega_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entregas_comerciales_empresaId_ordenVentaId_idx" ON "entregas_comerciales"("empresaId", "ordenVentaId");

-- CreateIndex
CREATE UNIQUE INDEX "entregas_comerciales_id_empresaId_key" ON "entregas_comerciales"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "entregas_comerciales_ordenVentaId_numero_key" ON "entregas_comerciales"("ordenVentaId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "entregas_comerciales_empresaId_claveRegistro_key" ON "entregas_comerciales"("empresaId", "claveRegistro");

-- CreateIndex
CREATE INDEX "partidas_entrega_comercial_empresaId_partidaVentaId_idx" ON "partidas_entrega_comercial"("empresaId", "partidaVentaId");

-- CreateIndex
CREATE UNIQUE INDEX "partidas_entrega_comercial_entregaId_partidaVentaId_key" ON "partidas_entrega_comercial"("entregaId", "partidaVentaId");

-- CreateIndex
CREATE INDEX "evidencias_entrega_comercial_entregaId_idx" ON "evidencias_entrega_comercial"("entregaId");

-- AddForeignKey
ALTER TABLE "entregas_comerciales" ADD CONSTRAINT "entregas_comerciales_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas_comerciales" ADD CONSTRAINT "entregas_comerciales_ordenVentaId_empresaId_fkey" FOREIGN KEY ("ordenVentaId", "empresaId") REFERENCES "ordenes_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas_comerciales" ADD CONSTRAINT "entregas_comerciales_registradaPorId_fkey" FOREIGN KEY ("registradaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas_comerciales" ADD CONSTRAINT "entregas_comerciales_anuladaPorId_fkey" FOREIGN KEY ("anuladaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_entrega_comercial" ADD CONSTRAINT "partidas_entrega_comercial_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_entrega_comercial" ADD CONSTRAINT "partidas_entrega_comercial_entregaId_empresaId_fkey" FOREIGN KEY ("entregaId", "empresaId") REFERENCES "entregas_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partidas_entrega_comercial" ADD CONSTRAINT "partidas_entrega_comercial_partidaVentaId_empresaId_fkey" FOREIGN KEY ("partidaVentaId", "empresaId") REFERENCES "partidas_cotizacion_venta"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidencias_entrega_comercial" ADD CONSTRAINT "evidencias_entrega_comercial_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidencias_entrega_comercial" ADD CONSTRAINT "evidencias_entrega_comercial_entregaId_empresaId_fkey" FOREIGN KEY ("entregaId", "empresaId") REFERENCES "entregas_comerciales"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Reglas no representables en el DSL de Prisma (defensa en profundidad: el
-- servicio ya valida; la base lo garantiza).
-- ---------------------------------------------------------------------------

ALTER TABLE "entregas_comerciales" ADD CONSTRAINT "entregas_comerciales_valores" CHECK (
  "numero" >= 1 AND length(btrim("claveRegistro")) >= 8
);
ALTER TABLE "entregas_comerciales" ADD CONSTRAINT "entregas_comerciales_anulada_con_motivo" CHECK (
  ("estatus" = 'ANULADA') = ("anuladaEn" IS NOT NULL AND "anuladaPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
);
ALTER TABLE "partidas_entrega_comercial" ADD CONSTRAINT "partidas_entrega_comercial_cantidad_positiva" CHECK ("cantidad" > 0);
ALTER TABLE "evidencias_entrega_comercial" ADD CONSTRAINT "evidencias_entrega_comercial_valores" CHECK (
  "bytes" > 0 AND "orden" >= 0 AND length("ref") > 0 AND length("nombre") > 0
  AND (("clase" = 'REMISION' AND "tipo" = 'application/pdf') OR ("clase" = 'FOTOGRAFIA' AND "tipo" IN ('image/jpeg', 'image/png')))
);

-- ¿La fila (por su xmin) fue creada en la transacción actual?
CREATE FUNCTION "comercializacion_creada_en_esta_transaccion"(fila_xmin xid) RETURNS boolean AS $$
  SELECT fila_xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::text;
$$ LANGUAGE sql VOLATILE;

-- Entrega: se crea CONFIRMADA y nunca se borra. Solo admite el cambio
-- CONFIRMADA → ANULADA con sus datos de anulación; nada más cambia.
CREATE FUNCTION "comercializacion_entregas_reglas"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una entrega no se borra; se anula con motivo.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."estatus"::text <> 'CONFIRMADA' THEN
      RAISE EXCEPTION 'Una entrega se registra confirmada.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."estatus"::text = 'ANULADA'
     OR NEW."estatus"::text <> 'ANULADA'
     OR NEW."empresaId" <> OLD."empresaId" OR NEW."ordenVentaId" <> OLD."ordenVentaId" OR NEW."numero" <> OLD."numero"
     OR NEW."fechaEntrega" <> OLD."fechaEntrega"
     OR NEW."recibidoPor" IS DISTINCT FROM OLD."recibidoPor"
     OR NEW."observaciones" IS DISTINCT FROM OLD."observaciones"
     OR NEW."claveRegistro" <> OLD."claveRegistro"
     OR NEW."registradaPorId" <> OLD."registradaPorId" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Una entrega registrada no se modifica; solo puede anularse con motivo.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "entregas_comerciales_reglas"
BEFORE INSERT OR UPDATE OR DELETE ON "entregas_comerciales"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_entregas_reglas"();

-- Partidas entregadas: solo se agregan en la transacción que crea la entrega;
-- deben ser de la OV de la entrega y, con la OV bloqueada (serializa
-- registros simultáneos), no superar lo vendido entre entregas vigentes.
CREATE FUNCTION "comercializacion_partidas_entrega"() RETURNS trigger AS $$
DECLARE
  v_entrega RECORD;
  v_vendido numeric;
  v_codigo text;
  v_entregado numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Las partidas de una entrega no se modifican ni se borran; la entrega se anula con motivo.';
  END IF;
  SELECT e."estatus"::text AS estatus, e."ordenVentaId", e.xmin AS fila_xmin INTO v_entrega
  FROM "entregas_comerciales" e WHERE e."id" = NEW."entregaId";
  IF v_entrega.estatus IS DISTINCT FROM 'CONFIRMADA' OR NOT "comercializacion_creada_en_esta_transaccion"(v_entrega.fila_xmin) THEN
    RAISE EXCEPTION 'Las partidas solo se capturan al registrar la entrega.';
  END IF;
  PERFORM 1 FROM "ordenes_venta" WHERE "id" = v_entrega."ordenVentaId" FOR UPDATE;
  SELECT pv."cantidad", pv."codigo" INTO v_vendido, v_codigo
  FROM "ordenes_venta" ov
  JOIN "partidas_cotizacion_venta" pv ON pv."cotizacionId" = ov."cotizacionId"
  WHERE ov."id" = v_entrega."ordenVentaId" AND pv."id" = NEW."partidaVentaId";
  IF v_vendido IS NULL THEN
    RAISE EXCEPTION 'La partida no pertenece a la orden de venta de la entrega.';
  END IF;
  SELECT COALESCE(SUM(pe."cantidad"), 0) INTO v_entregado
  FROM "partidas_entrega_comercial" pe
  JOIN "entregas_comerciales" e ON e."id" = pe."entregaId"
  WHERE pe."partidaVentaId" = NEW."partidaVentaId" AND e."estatus" = 'CONFIRMADA';
  IF v_entregado + NEW."cantidad" > v_vendido THEN
    RAISE EXCEPTION 'La cantidad entregada de % supera la cantidad vendida.', v_codigo;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "partidas_entrega_comercial_reglas"
BEFORE INSERT OR UPDATE OR DELETE ON "partidas_entrega_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_partidas_entrega"();

-- Evidencias: solo se agregan al registrar la entrega; se conservan siempre
-- (también cuando la entrega se anula).
CREATE FUNCTION "comercializacion_evidencias_entrega"() RETURNS trigger AS $$
DECLARE
  v_entrega RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Las evidencias de una entrega no se modifican ni se borran.';
  END IF;
  SELECT e."estatus"::text AS estatus, e.xmin AS fila_xmin INTO v_entrega
  FROM "entregas_comerciales" e WHERE e."id" = NEW."entregaId";
  IF v_entrega.estatus IS DISTINCT FROM 'CONFIRMADA' OR NOT "comercializacion_creada_en_esta_transaccion"(v_entrega.fila_xmin) THEN
    RAISE EXCEPTION 'Las evidencias solo se adjuntan al registrar la entrega.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "evidencias_entrega_comercial_reglas"
BEFORE INSERT OR UPDATE OR DELETE ON "evidencias_entrega_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_evidencias_entrega"();

-- Al confirmar la transacción, toda entrega nueva tiene al menos una partida
-- y al menos una evidencia válida.
CREATE FUNCTION "comercializacion_entrega_completa"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "partidas_entrega_comercial" WHERE "entregaId" = NEW."id") THEN
    RAISE EXCEPTION 'Una entrega requiere al menos una partida.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "evidencias_entrega_comercial" WHERE "entregaId" = NEW."id") THEN
    RAISE EXCEPTION 'Una entrega requiere al menos una evidencia (fotografía o remisión).';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "entregas_comerciales_completa"
AFTER INSERT ON "entregas_comerciales"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "comercializacion_entrega_completa"();

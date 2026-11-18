-- Comercialización B8A: vínculo entre partidas entregadas (B6A) y partidas de
-- compra confirmadas (B4) — surtido directo a obra. Aditiva: tabla nueva e
-- índices únicos (id, empresaId) en las partidas. Las entregas existentes
-- quedan sin vínculos (no se infieren proveedores).
-- CreateEnum
CREATE TYPE "EstatusVinculoSurtido" AS ENUM ('VIGENTE', 'ANULADO');


-- CreateTable
CREATE TABLE "vinculos_surtido_comercial" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "partidaEntregaId" TEXT NOT NULL,
    "partidaCompraId" TEXT NOT NULL,
    "ordenVentaId" TEXT NOT NULL,
    "entregaId" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "partidaVentaId" TEXT NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "estatus" "EstatusVinculoSurtido" NOT NULL DEFAULT 'VIGENTE',
    "claveRegistro" TEXT NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anuladoEn" TIMESTAMP(3),
    "anuladoPorId" TEXT,
    "motivoAnulacion" TEXT,

    CONSTRAINT "vinculos_surtido_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vinculos_surtido_comercial_empresaId_ordenVentaId_idx" ON "vinculos_surtido_comercial"("empresaId", "ordenVentaId");

-- CreateIndex
CREATE INDEX "vinculos_surtido_comercial_partidaEntregaId_idx" ON "vinculos_surtido_comercial"("partidaEntregaId");

-- CreateIndex
CREATE INDEX "vinculos_surtido_comercial_partidaCompraId_idx" ON "vinculos_surtido_comercial"("partidaCompraId");

-- CreateIndex
CREATE UNIQUE INDEX "vinculos_surtido_comercial_empresaId_claveRegistro_key" ON "vinculos_surtido_comercial"("empresaId", "claveRegistro");

-- CreateIndex
CREATE UNIQUE INDEX "partidas_compra_comercial_id_empresaId_key" ON "partidas_compra_comercial"("id", "empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "partidas_entrega_comercial_id_empresaId_key" ON "partidas_entrega_comercial"("id", "empresaId");

-- AddForeignKey
ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_partidaEntregaId_empresaId_fkey" FOREIGN KEY ("partidaEntregaId", "empresaId") REFERENCES "partidas_entrega_comercial"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_partidaCompraId_empresaId_fkey" FOREIGN KEY ("partidaCompraId", "empresaId") REFERENCES "partidas_compra_comercial"("id", "empresaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_anuladoPorId_fkey" FOREIGN KEY ("anuladoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- B8A — reglas en la base (defensa en profundidad; el servicio ya las aplica).
-- Orden de bloqueos de Comercialización: OV → compra/entrega → cuenta. Toda
-- operación que afecta entregas, compras o vínculos de una OV bloquea primero
-- la OV (registrar/anular entrega, confirmar/anular compra, crear/anular
-- vínculo). Un pago bloquea compra → cuenta, igual que la anulación.
-- ---------------------------------------------------------------------------

ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_valores" CHECK (
  "cantidad" > 0 AND char_length("claveRegistro") BETWEEN 8 AND 200
);
ALTER TABLE "vinculos_surtido_comercial" ADD CONSTRAINT "vinculos_surtido_comercial_anulacion" CHECK (
  ("estatus" = 'ANULADO') = ("anuladoEn" IS NOT NULL AND "anuladoPorId" IS NOT NULL AND length(btrim(coalesce("motivoAnulacion", ''))) > 0)
);

-- Alta: misma Empresa, OV y partida de venta; entrega y compra vigentes
-- (CONFIRMADA); sin exceder lo entregado ni lo comprado (solo cuentan
-- vínculos vigentes de documentos vigentes). Bloquea la OV.
-- Cambios: solo VIGENTE → ANULADO, sin tocar nada más. Nunca se borra.
CREATE FUNCTION "comercializacion_vinculos_surtido"() RETURNS trigger AS $$
DECLARE
  pe record;
  pc record;
  v_entrega record;
  v_compra record;
  v_vinculado numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un vínculo de surtido no se elimina; se anula con motivo.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."estatus"::text <> 'VIGENTE' OR NEW."estatus"::text <> 'ANULADO'
       OR (NEW."empresaId", NEW."partidaEntregaId", NEW."partidaCompraId", NEW."ordenVentaId", NEW."entregaId", NEW."compraId", NEW."partidaVentaId",
           NEW."cantidad", NEW."claveRegistro", NEW."registradoPorId", NEW."createdAt")
          IS DISTINCT FROM
          (OLD."empresaId", OLD."partidaEntregaId", OLD."partidaCompraId", OLD."ordenVentaId", OLD."entregaId", OLD."compraId", OLD."partidaVentaId",
           OLD."cantidad", OLD."claveRegistro", OLD."registradoPorId", OLD."createdAt") THEN
      RAISE EXCEPTION 'Un vínculo de surtido no se modifica; solo se anula con motivo.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."estatus"::text <> 'VIGENTE' THEN
    RAISE EXCEPTION 'Un vínculo de surtido se registra vigente.';
  END IF;
  PERFORM 1 FROM "ordenes_venta" WHERE "id" = NEW."ordenVentaId" AND "empresaId" = NEW."empresaId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La orden de venta del vínculo no existe en la Empresa.';
  END IF;
  SELECT "entregaId", "partidaVentaId", "cantidad" INTO pe FROM "partidas_entrega_comercial" WHERE "id" = NEW."partidaEntregaId" AND "empresaId" = NEW."empresaId";
  SELECT "compraId", "partidaVentaId", "cantidad" INTO pc FROM "partidas_compra_comercial" WHERE "id" = NEW."partidaCompraId" AND "empresaId" = NEW."empresaId";
  IF pe IS NULL OR pc IS NULL OR pe."entregaId" <> NEW."entregaId" OR pc."compraId" <> NEW."compraId"
     OR pe."partidaVentaId" <> NEW."partidaVentaId" OR pc."partidaVentaId" <> NEW."partidaVentaId" THEN
    RAISE EXCEPTION 'La partida entregada y la partida comprada deben corresponder a la misma partida de venta.';
  END IF;
  SELECT "ordenVentaId", "estatus"::text AS estatus INTO v_entrega FROM "entregas_comerciales" WHERE "id" = NEW."entregaId";
  SELECT "ordenVentaId", "estatus"::text AS estatus INTO v_compra FROM "compras_comerciales" WHERE "id" = NEW."compraId";
  IF v_entrega."ordenVentaId" <> NEW."ordenVentaId" OR v_compra."ordenVentaId" <> NEW."ordenVentaId" THEN
    RAISE EXCEPTION 'La entrega y la compra deben ser de la misma orden de venta.';
  END IF;
  IF v_entrega.estatus <> 'CONFIRMADA' THEN
    RAISE EXCEPTION 'No se vinculan compras a una entrega anulada.';
  END IF;
  IF v_compra.estatus <> 'CONFIRMADA' THEN
    RAISE EXCEPTION 'Solo se vinculan compras confirmadas y vigentes.';
  END IF;
  SELECT coalesce(sum(v."cantidad"), 0) INTO v_vinculado
  FROM "vinculos_surtido_comercial" v JOIN "compras_comerciales" c ON c."id" = v."compraId"
  WHERE v."partidaEntregaId" = NEW."partidaEntregaId" AND v."estatus" = 'VIGENTE' AND c."estatus" = 'CONFIRMADA';
  IF v_vinculado + NEW."cantidad" > pe."cantidad" THEN
    RAISE EXCEPTION 'La cantidad vinculada supera la cantidad entregada.';
  END IF;
  SELECT coalesce(sum(v."cantidad"), 0) INTO v_vinculado
  FROM "vinculos_surtido_comercial" v JOIN "entregas_comerciales" e ON e."id" = v."entregaId"
  WHERE v."partidaCompraId" = NEW."partidaCompraId" AND v."estatus" = 'VIGENTE' AND e."estatus" = 'CONFIRMADA';
  IF v_vinculado + NEW."cantidad" > pc."cantidad" THEN
    RAISE EXCEPTION 'La cantidad vinculada supera la cantidad comprada.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "vinculos_surtido_comercial_reglas" BEFORE INSERT OR UPDATE OR DELETE ON "vinculos_surtido_comercial"
FOR EACH ROW EXECUTE FUNCTION "comercializacion_vinculos_surtido"();

-- Anulación simple de una compra (B4/B5 + B8A): además de exigir su cuenta
-- anulada sin pagos (B5), se rechaza si
--  (a) tiene cantidades vinculadas a entregas vigentes, o
--  (b) alguna partida de venta que abastece tiene cantidades entregadas
--      (entregas vigentes) sin vincular a una compra vigente.
CREATE OR REPLACE FUNCTION "comercializacion_compra_anulable"() RETURNS trigger AS $$
DECLARE
  c record;
BEGIN
  IF NEW."estatus"::text = 'ANULADA' AND OLD."estatus"::text <> 'ANULADA' THEN
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

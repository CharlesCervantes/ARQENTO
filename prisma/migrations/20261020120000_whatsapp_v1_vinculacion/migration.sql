-- WhatsApp + ARQENTO IA — Fase 1: configuración por Empresa y vinculación de
-- usuarios (octubre 2026). Migración ADITIVA: solo agrega columnas con valor
-- por defecto, enums, tablas e índices; no modifica ni borra datos
-- existentes. WhatsApp queda deshabilitado para todas las Empresas y ningún
-- usuario queda autorizado.

-- CreateEnum
CREATE TYPE "EstadoVinculoWhatsapp" AS ENUM ('PENDIENTE', 'VERIFICADO', 'REVOCADO');

-- CreateEnum
CREATE TYPE "EstadoProcesoMensajeWhatsapp" AS ENUM ('PENDIENTE', 'PROCESADO', 'ERROR');

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "whatsappHabilitado" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "whatsappAutorizado" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "vinculos_whatsapp" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "telefonoE164" TEXT NOT NULL,
    "waId" TEXT,
    "estado" "EstadoVinculoWhatsapp" NOT NULL DEFAULT 'PENDIENTE',
    "verificadoEn" TIMESTAMP(3),
    "revocadoEn" TIMESTAMP(3),
    "revocadoPorId" TEXT,
    "motivoRevocacion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vinculos_whatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codigos_vinculacion_whatsapp" (
    "id" TEXT NOT NULL,
    "vinculoId" TEXT NOT NULL,
    "codigoHash" TEXT NOT NULL,
    "expiraEn" TIMESTAMP(3) NOT NULL,
    "usadoEn" TIMESTAMP(3),
    "invalidadoEn" TIMESTAMP(3),
    "intentosFallidos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codigos_vinculacion_whatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensajes_whatsapp" (
    "id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "remitenteHash" TEXT NOT NULL,
    "remitentePendiente" TEXT,
    "tipo" TEXT NOT NULL,
    "textoPendiente" TEXT,
    "estadoProceso" "EstadoProcesoMensajeWhatsapp" NOT NULL DEFAULT 'PENDIENTE',
    "resultado" TEXT,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "respondido" BOOLEAN NOT NULL DEFAULT false,
    "vinculoId" TEXT,
    "empresaId" TEXT,
    "usuarioId" TEXT,
    "recibidoEn" TIMESTAMP(3) NOT NULL,
    "procesadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensajes_whatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesiones_whatsapp" (
    "id" TEXT NOT NULL,
    "remitenteHash" TEXT NOT NULL,
    "vinculoId" TEXT NOT NULL,
    "expiraEn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sesiones_whatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vinculos_whatsapp_empresaId_idx" ON "vinculos_whatsapp"("empresaId");

-- CreateIndex
CREATE INDEX "vinculos_whatsapp_usuarioId_idx" ON "vinculos_whatsapp"("usuarioId");

-- CreateIndex
CREATE INDEX "vinculos_whatsapp_telefonoE164_idx" ON "vinculos_whatsapp"("telefonoE164");

-- CreateIndex
CREATE UNIQUE INDEX "codigos_vinculacion_whatsapp_codigoHash_key" ON "codigos_vinculacion_whatsapp"("codigoHash");

-- CreateIndex
CREATE INDEX "codigos_vinculacion_whatsapp_vinculoId_idx" ON "codigos_vinculacion_whatsapp"("vinculoId");

-- CreateIndex
CREATE UNIQUE INDEX "mensajes_whatsapp_wamid_key" ON "mensajes_whatsapp"("wamid");

-- CreateIndex
CREATE INDEX "mensajes_whatsapp_remitenteHash_createdAt_idx" ON "mensajes_whatsapp"("remitenteHash", "createdAt");

-- CreateIndex
CREATE INDEX "mensajes_whatsapp_estadoProceso_createdAt_idx" ON "mensajes_whatsapp"("estadoProceso", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sesiones_whatsapp_remitenteHash_key" ON "sesiones_whatsapp"("remitenteHash");

-- AddForeignKey
ALTER TABLE "vinculos_whatsapp" ADD CONSTRAINT "vinculos_whatsapp_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vinculos_whatsapp" ADD CONSTRAINT "vinculos_whatsapp_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vinculos_whatsapp" ADD CONSTRAINT "vinculos_whatsapp_revocadoPorId_fkey" FOREIGN KEY ("revocadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codigos_vinculacion_whatsapp" ADD CONSTRAINT "codigos_vinculacion_whatsapp_vinculoId_fkey" FOREIGN KEY ("vinculoId") REFERENCES "vinculos_whatsapp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones_whatsapp" ADD CONSTRAINT "sesiones_whatsapp_vinculoId_fkey" FOREIGN KEY ("vinculoId") REFERENCES "vinculos_whatsapp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Índices únicos PARCIALES — Prisma no los modela (solo viven aquí), mismo
-- patrón que reposiciones_gastos_abierta_unica:
-- a lo más UN vínculo vigente (PENDIENTE o VERIFICADO) por usuario…
CREATE UNIQUE INDEX "vinculos_whatsapp_usuario_vigente_unico"
  ON "vinculos_whatsapp" ("usuarioId")
  WHERE "estado" <> 'REVOCADO';

-- …y un mismo número a lo más en UN usuario vigente por Empresa (sí puede
-- estar vinculado a usuarios de otras Empresas).
CREATE UNIQUE INDEX "vinculos_whatsapp_telefono_empresa_vigente_unico"
  ON "vinculos_whatsapp" ("empresaId", "telefonoE164")
  WHERE "estado" <> 'REVOCADO';

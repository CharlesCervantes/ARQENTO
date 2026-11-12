-- WhatsApp + ARQENTO IA — Fase 2A: recepción de comprobantes por WhatsApp
-- (noviembre 2026). Migración ADITIVA: solo agrega enums, columnas (con valor
-- por defecto o anulables) e índices; no modifica ni borra datos existentes.
-- Todos los documentos existentes quedan con origen WEB y ningún mensaje
-- existente cambia de estado.

-- CreateEnum
CREATE TYPE "OrigenDocumentoEgreso" AS ENUM ('WEB', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "EtapaArchivoWhatsapp" AS ENUM ('ASIGNADO', 'ALMACENADO', 'GUARDADO', 'RECHAZADO');

-- AlterTable
ALTER TABLE "documentos_egreso" ADD COLUMN     "archivoEliminadoEn" TIMESTAMP(3),
ADD COLUMN     "origen" "OrigenDocumentoEgreso" NOT NULL DEFAULT 'WEB';

-- AlterTable
ALTER TABLE "mensajes_whatsapp" ADD COLUMN     "archivoPendiente" JSONB,
ADD COLUMN     "documentoEgresoId" TEXT,
ADD COLUMN     "etapaArchivo" "EtapaArchivoWhatsapp";

-- CreateIndex
CREATE INDEX "documentos_egreso_empresaId_origen_estatus_idx" ON "documentos_egreso"("empresaId", "origen", "estatus");

-- CreateIndex
CREATE INDEX "mensajes_whatsapp_documentoEgresoId_idx" ON "mensajes_whatsapp"("documentoEgresoId");

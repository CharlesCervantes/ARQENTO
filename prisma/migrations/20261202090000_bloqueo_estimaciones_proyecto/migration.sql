-- Bloqueo de cierre y estimaciones por obra. Aditiva: null = sin bloqueo, que
-- es como quedan todas las obras existentes.
ALTER TABLE "proyectos" ADD COLUMN "motivoBloqueoEstimaciones" TEXT;

-- Marca de semana histórica importada (migración de obras desde Excel).
-- Aditiva y compatible con el código anterior: el default false deja a todos
-- los cierres existentes exactamente como estaban.
ALTER TABLE "cierres_semana_proyecto" ADD COLUMN "historicoImportado" BOOLEAN NOT NULL DEFAULT false;

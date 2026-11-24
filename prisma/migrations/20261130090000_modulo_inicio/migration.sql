-- «Inicio» (panel ejecutivo /dashboard) pasa a ser un módulo del catálogo,
-- habilitable y deshabilitable por Empresa desde Portal Master → Empresas →
-- Módulos, igual que los demás (noviembre 2026).
--
-- Solo datos, sin cambios de esquema. Conserva el comportamiento actual de
-- TODAS las Empresas existentes:
-- - Se agrega a todos los Planes existentes (las Empresas lo heredan).
-- - Las Empresas sin Plan reciben un override habilitado explícito.
-- Los overrides ya existentes no se tocan. Una Empresa sin Inicio entra al
-- primer módulo que puede usar (ver lib/server/destino-inicial.ts).
INSERT INTO "modulos" ("id", "clave", "nombre")
VALUES ('modulo_inicio', 'inicio', 'Inicio')
ON CONFLICT ("clave") DO NOTHING;

INSERT INTO "plan_modulos" ("planId", "moduloId")
SELECT p."id", m."id"
FROM "planes" p CROSS JOIN "modulos" m
WHERE m."clave" = 'inicio'
ON CONFLICT DO NOTHING;

INSERT INTO "empresa_modulos" ("empresaId", "moduloId", "habilitado")
SELECT e."id", m."id", true
FROM "empresas" e CROSS JOIN "modulos" m
WHERE m."clave" = 'inicio' AND e."planId" IS NULL
ON CONFLICT DO NOTHING;

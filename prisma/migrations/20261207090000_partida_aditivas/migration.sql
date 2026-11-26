-- Partida «ADITIVAS» en todas las obras, siempre al final (noviembre 2026).
-- Solo datos, sin cambios de esquema. «Al final» = Partida.orden reservado
-- 1000000 (ORDEN_PARTIDA_ADITIVAS en lib/control-de-obra/partida-aditivas.ts).
-- Gastos de Empresa (tipo OFICINA) no es una obra y queda fuera.
-- Cuenta como partida de aditivas una ACTIVA llamada «Aditiva», «Aditivas» o
-- con esa palabra al inicio («ADITIVA 01»); esas obras no reciben otra.
-- Cada cambio deja su registro en registros_auditoria.

-- 1) Las partidas de aditivas que ya existen pasan al final.
WITH "antes" AS (
  SELECT x."id", x."orden"
  FROM "partidas" x
  JOIN "proyectos" p ON p."id" = x."proyectoId"
  WHERE p."tipo" <> 'OFICINA'
    AND x."estatus" = 'ACTIVA'
    AND upper(btrim(x."nombre")) ~ '^ADITIVAS?([^A-Z]|$)'
    AND x."orden" <> 1000000
), "movidas" AS (
  UPDATE "partidas" x
  SET "orden" = 1000000, "updatedAt" = CURRENT_TIMESTAMP
  FROM "antes" a
  WHERE x."id" = a."id"
  RETURNING x."id", x."proyectoId", a."orden" AS "ordenAnterior"
)
INSERT INTO "registros_auditoria" ("id", "empresaId", "usuarioId", "entidad", "entidadId", "accion", "valorAnterior", "valorNuevo")
SELECT 'aud_aditivas_orden_' || md5(m."id"), p."empresaId", NULL, 'Partida', m."id", 'EDITAR',
       jsonb_build_object('orden', m."ordenAnterior"),
       jsonb_build_object('orden', 1000000, 'motivo', 'Partida de aditivas siempre al final (migración 20261207090000_partida_aditivas)')
FROM "movidas" m
JOIN "proyectos" p ON p."id" = m."proyectoId";

-- 2) Las obras sin partida de aditivas reciben «ADITIVAS» al final.
WITH "nuevas" AS (
  INSERT INTO "partidas" ("id", "proyectoId", "nombre", "orden", "estatus", "createdAt", "updatedAt")
  SELECT 'par_aditivas_' || md5(p."id"), p."id", 'ADITIVAS', 1000000, 'ACTIVA', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "proyectos" p
  WHERE p."tipo" <> 'OFICINA'
    AND NOT EXISTS (
      SELECT 1 FROM "partidas" x
      WHERE x."proyectoId" = p."id"
        AND x."estatus" = 'ACTIVA'
        AND upper(btrim(x."nombre")) ~ '^ADITIVAS?([^A-Z]|$)'
    )
  RETURNING "id", "proyectoId", "nombre", "orden"
)
INSERT INTO "registros_auditoria" ("id", "empresaId", "usuarioId", "entidad", "entidadId", "accion", "valorAnterior", "valorNuevo")
SELECT 'aud_aditivas_alta_' || md5(n."id"), p."empresaId", NULL, 'Partida', n."id", 'CREAR', NULL,
       jsonb_build_object('id', n."id", 'proyectoId', n."proyectoId", 'nombre', n."nombre", 'orden', n."orden",
                          'motivo', 'Toda obra lleva la partida ADITIVAS (migración 20261207090000_partida_aditivas)')
FROM "nuevas" n
JOIN "proyectos" p ON p."id" = n."proyectoId";

-- Obras visibles por Supervisor. Los supervisores actuales conservan el acceso
-- a todas las obras de su Empresa hasta que Administración lo ajuste; las obras
-- y los supervisores nuevos empiezan sin acceso.
CREATE TABLE "accesos_obra" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accesos_obra_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "accesos_obra_usuarioId_proyectoId_key" ON "accesos_obra"("usuarioId", "proyectoId");
CREATE INDEX "accesos_obra_proyectoId_idx" ON "accesos_obra"("proyectoId");
ALTER TABLE "accesos_obra" ADD CONSTRAINT "accesos_obra_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accesos_obra" ADD CONSTRAINT "accesos_obra_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "accesos_obra" ("id", "usuarioId", "proyectoId")
SELECT 'acc_' || md5(u."id" || '|' || p."id"), u."id", p."id"
FROM "usuarios" u JOIN "proyectos" p ON p."empresaId" = u."empresaId"
WHERE u."rol" = 'SUPERVISOR' AND p."tipo" <> 'OFICINA';

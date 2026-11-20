import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";

// Después de aplicar TODAS las migraciones, los objetos manuales de
// Comercialización que schema.prisma no representa siguen existiendo con su
// definición. Protege contra una migración generada que los elimine.
// Ver docs/arquitectura/01-despliegue.md → «Objetos manuales que Prisma no representa».

after(() => db.$disconnect());

describe("Integración — objetos manuales de Comercialización", () => {
  test("índice único de una OV por cotización (solo cotizacionId)", async () => {
    const filas = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ordenes_venta_cotizacion_unica'`;
    assert.equal(filas.length, 1);
    assert.match(filas[0].indexdef, /CREATE UNIQUE INDEX .* ON public\.ordenes_venta USING btree \("cotizacionId"\)$/);
  });

  test("índices únicos parciales y por expresión", async () => {
    const filas = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('cuentas_comerciales_compra_unica', 'cuentas_comerciales_gasto_unica')`;
    assert.deepEqual(filas.map((f) => f.indexname).sort(), ["cuentas_comerciales_compra_unica", "cuentas_comerciales_gasto_unica"]);
    const porExpresion = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'productos_comerciales' AND indexdef ILIKE '%UNIQUE%lower%codigo%'`;
    assert.equal(porExpresion[0].n, 1);
  });

  test("triggers de reglas clave presentes", async () => {
    const esperados = [
      "ordenes_venta_reglas",
      "ordenes_venta_sin_borrado",
      "cotizaciones_venta_emitida_inmutable",
      "compras_comerciales_orden_vigente",
      "movimientos_comerciales_reglas",
      "cambios_vencimiento_cuota_reglas",
    ];
    const filas = await db.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY(${esperados})`;
    assert.deepEqual(filas.map((f) => f.tgname).sort(), [...esperados].sort());
  });
});

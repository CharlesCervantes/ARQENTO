import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Objetos de base de Comercialización escritos a mano en las migraciones que
// schema.prisma no puede representar. `prisma migrate dev` / `migrate diff`
// propondría eliminar el índice único ordenes_venta_cotizacion_unica (una sola
// OV por cotización): ninguna migración posterior puede borrarlo, ni tampoco
// los índices parciales o por expresión que protegen unicidad.
// Ver docs/arquitectura/01-despliegue.md → «Objetos manuales que Prisma no representa».
export const INDICES_MANUALES_PROTEGIDOS = [
  "ordenes_venta_cotizacion_unica",
  "cuentas_comerciales_compra_unica",
  "cuentas_comerciales_gasto_unica",
];

const DIR = join(process.cwd(), "prisma", "migrations");

describe("Migraciones — objetos manuales de Comercialización protegidos", () => {
  test("ninguna migración elimina los índices únicos manuales", () => {
    const infractoras: string[] = [];
    for (const carpeta of readdirSync(DIR).filter((d) => /^\d{14}_/.test(d))) {
      const sql = readFileSync(join(DIR, carpeta, "migration.sql"), "utf8");
      for (const nombre of INDICES_MANUALES_PROTEGIDOS) {
        if (new RegExp(`DROP\\s+INDEX[^;]*"?${nombre}"?`, "i").test(sql)) infractoras.push(`${carpeta}: ${nombre}`);
      }
    }
    assert.deepEqual(infractoras, [], "Una migración elimina un índice manual protegido; quita ese DROP del SQL generado.");
  });

  test("el índice de una OV por cotización sigue definido en las migraciones", () => {
    const todas = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .map((d) => readFileSync(join(DIR, d, "migration.sql"), "utf8"))
      .join("\n");
    assert.match(todas, /CREATE UNIQUE INDEX "ordenes_venta_cotizacion_unica" ON "ordenes_venta"\("cotizacionId"\)/);
  });
});

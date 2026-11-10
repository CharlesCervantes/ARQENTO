import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { modoPagadorInicial, pagadorElegido } from "@/lib/control-de-obra/pagador-gasto";

// Formulario de Gastos (octubre 2026): un gasto nuevo no preselecciona
// "Empresa" — se elige explícitamente; al editar se conserva el pagador.

describe("Formulario de Gastos — quién pagó", () => {
  test("Gasto nuevo: sin pagador preseleccionado y sin poder continuar", () => {
    assert.equal(modoPagadorInicial(null, "benef-sergio"), "");
    assert.equal(modoPagadorInicial(undefined, null), "");
    assert.equal(pagadorElegido(""), false);
  });

  test("Editar: se conserva el pagador actual", () => {
    assert.equal(modoPagadorInicial({ pagadorBeneficiarioId: null }, "benef-sergio"), "EMPRESA");
    assert.equal(modoPagadorInicial({ pagadorBeneficiarioId: "benef-sergio" }, "benef-sergio"), "YO");
    assert.equal(modoPagadorInicial({ pagadorBeneficiarioId: "benef-andres" }, "benef-sergio"), "OTRO");
    assert.equal(modoPagadorInicial({ pagadorBeneficiarioId: "benef-andres" }, null), "OTRO");
  });

  test("Cualquiera de las tres opciones permite continuar", () => {
    for (const modo of ["EMPRESA", "YO", "OTRO"] as const) assert.equal(pagadorElegido(modo), true);
  });
});

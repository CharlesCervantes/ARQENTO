// Quién pagó un gasto en el formulario de Gastos (octubre 2026): un gasto
// NUEVO no tiene pagador preseleccionado — se elige explícitamente Empresa,
// "yo" u otra persona (antes arrancaba en "Empresa" y una reposición podía
// perderse por no cambiarlo). Al EDITAR se conserva el pagador actual. El
// servidor exige el valor de todas formas (DatosGastoSchema).

export type QuienPagoModo = "YO" | "OTRO" | "EMPRESA";

export function modoPagadorInicial(
  gasto: { pagadorBeneficiarioId: string | null } | null | undefined,
  beneficiarioVinculadoId: string | null | undefined
): QuienPagoModo | "" {
  if (!gasto) return "";
  if (!gasto.pagadorBeneficiarioId) return "EMPRESA";
  if (beneficiarioVinculadoId && gasto.pagadorBeneficiarioId === beneficiarioVinculadoId) return "YO";
  return "OTRO";
}

// El paso "¿Quién pagó?" no deja continuar sin una elección.
export function pagadorElegido(modo: QuienPagoModo | ""): modo is QuienPagoModo {
  return modo === "YO" || modo === "OTRO" || modo === "EMPRESA";
}

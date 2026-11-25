// Tratamiento de un gasto u orden de compra frente al cliente.
export const TRATAMIENTOS_CLIENTE = ["INCLUIDO_EN_CONTRATO", "COBRABLE_EN_ESTIMACION", "COBRABLE_SOLO_PRIVADO", "NO_COBRABLE"] as const;
export type TratamientoCliente = (typeof TRATAMIENTOS_CLIENTE)[number];

// Tratamientos que entran a alguna estimación.
export const TRATAMIENTOS_COBRABLES: TratamientoCliente[] = ["COBRABLE_EN_ESTIMACION", "COBRABLE_SOLO_PRIVADO"];

export function esCobrable(t: string): boolean {
  return (TRATAMIENTOS_COBRABLES as string[]).includes(t);
}

export function cobrableEnCapa(t: string, capa: "OPERATIVO" | "PRIVADO"): boolean {
  return t === "COBRABLE_EN_ESTIMACION" || (t === "COBRABLE_SOLO_PRIVADO" && capa === "PRIVADO");
}

/** Opciones del selector; la privada solo para quien ve información privada. */
export function opcionesTratamientoCliente(verPrivado: boolean): { value: TratamientoCliente; label: string }[] {
  return [
    { value: "NO_COBRABLE", label: "No cobrable al cliente" },
    { value: "COBRABLE_EN_ESTIMACION", label: verPrivado ? "Cobrable en estimación (General y Privado)" : "Cobrable en estimación" },
    ...(verPrivado ? [{ value: "COBRABLE_SOLO_PRIVADO" as const, label: "Cobrable solo en Privado" }] : []),
    { value: "INCLUIDO_EN_CONTRATO", label: "Incluido en contrato" },
  ];
}

/** Lo que ve cada usuario: sin acceso a Privado se muestra como no cobrable. */
export function tratamientoVisible(t: string, verPrivado: boolean): string {
  return t === "COBRABLE_SOLO_PRIVADO" && !verPrivado ? "NO_COBRABLE" : t;
}

/**
 * Tratamiento a guardar. Sin acceso a Privado no se puede elegir «solo
 * Privado» (null = rechazar), y editar uno que ya lo tiene lo conserva.
 */
export function tratamientoAGuardar(solicitado: TratamientoCliente, anterior: string | null, verPrivado: boolean): TratamientoCliente | null {
  if (verPrivado) return solicitado;
  if (anterior === "COBRABLE_SOLO_PRIVADO") return "COBRABLE_SOLO_PRIVADO";
  return solicitado === "COBRABLE_SOLO_PRIVADO" ? null : solicitado;
}

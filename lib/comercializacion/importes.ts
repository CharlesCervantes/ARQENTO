// Importes y tasas de Comercialización — funciones PURAS (sin base de datos),
// usables en servidor y en navegador. Aritmética EXACTA en enteros
// (centavos y centésimas de punto porcentual con BigInt): nunca float.
//
// Convenciones (docs/negocio/comercializacion.md §6):
// - Precios y costos SIEMPRE sin IVA, 2 decimales, columna Decimal(14,2):
//   máximo 12 dígitos enteros.
// - Tasa de IVA en porcentaje con 2 decimales (16.00 = 16 %), 0 < tasa ≤ 100.
// - Redondeo: medio hacia arriba (half-up) al centavo, una sola vez por
//   cálculo. El navegador solo muestra una vista previa; el servidor siempre
//   vuelve a calcular y nunca confía en importes enviados por el cliente.

export type TratamientoImpuesto = "GRAVADO" | "TASA_CERO" | "EXENTO";

export const TRATAMIENTOS_IMPUESTO: readonly TratamientoImpuesto[] = ["GRAVADO", "TASA_CERO", "EXENTO"];

export const ETIQUETA_TRATAMIENTO: Record<TratamientoImpuesto, string> = {
  GRAVADO: "Gravado",
  TASA_CERO: "Tasa 0 %",
  EXENTO: "Exento",
};

// Valor inicial del formulario de producto, editable por administración —
// nunca una regla fija para todos los productos.
export const TASA_IVA_INICIAL = "16.00";

const MAX_DIGITOS_ENTEROS = 12;

/**
 * Normaliza un importe capturado ("$1,234.5", "1234.50", " 80 ") a la forma
 * canónica "1234.50". Devuelve null si no es un importe válido: vacío,
 * negativo, notación científica, más de 2 decimales, más de 12 dígitos
 * enteros, o cero cuando `permitirCero` es false.
 */
export function normalizarImporte(valor: unknown, opciones: { permitirCero: boolean }): string | null {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const texto = String(valor).trim().replace(/^\$/, "").replace(/,/g, "").trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(texto);
  if (!m) return null;
  const enteros = m[1].replace(/^0+(?=\d)/, "");
  if (enteros.length > MAX_DIGITOS_ENTEROS) return null;
  const decimales = (m[2] ?? "").padEnd(2, "0");
  const canonico = `${enteros}.${decimales}`;
  if (!opciones.permitirCero && aCentavos(canonico) === BigInt(0)) return null;
  return canonico;
}

/**
 * Normaliza una tasa de IVA en porcentaje ("16", "16.0", "8.00") a "16.00".
 * Solo tasas mayores que 0 y hasta 100: la tasa 0 % es un TRATAMIENTO
 * distinto (TASA_CERO), no una tasa del tratamiento GRAVADO.
 */
export function normalizarTasa(valor: unknown): string | null {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const texto = String(valor).trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(texto);
  if (!m) return null;
  const canonico = `${Number(m[1])}.${(m[2] ?? "").padEnd(2, "0")}`;
  const centesimas = aCentavos(canonico);
  if (centesimas <= BigInt(0) || centesimas > BigInt(10000)) return null;
  return canonico;
}

/** "1234.50" → 123450n. Solo acepta la forma canónica de 2 decimales. */
export function aCentavos(canonico: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(canonico);
  if (!m) throw new Error(`Importe no canónico: ${canonico}`);
  const valor = BigInt(m[2]) * BigInt(100) + BigInt(m[3]);
  return m[1] === "-" ? -valor : valor;
}

/** 123450n → "1234.50". */
export function deCentavos(centavos: bigint): string {
  const negativo = centavos < BigInt(0);
  const abs = negativo ? -centavos : centavos;
  const enteros = abs / BigInt(100);
  const resto = (abs % BigInt(100)).toString().padStart(2, "0");
  return `${negativo ? "-" : ""}${enteros}.${resto}`;
}

/**
 * IVA de un importe sin IVA según el tratamiento del producto. GRAVADO
 * exige tasa; TASA_CERO y EXENTO dan IVA $0.00 (siguen siendo distintos
 * fiscalmente — por eso el tratamiento se conserva aparte, no se infiere
 * de que el IVA sea cero). Redondeo half-up al centavo.
 */
export function calcularImpuesto(
  importeSinIva: string,
  tratamiento: TratamientoImpuesto,
  tasa: string | null
): { iva: string; total: string } {
  const base = aCentavos(importeSinIva);
  let iva = BigInt(0);
  if (tratamiento === "GRAVADO") {
    if (!tasa) throw new Error("Un producto gravado requiere tasa de IVA.");
    // base (centavos) × tasa (centésimas de %) / 10 000 → centavos, half-up.
    const producto = base * aCentavos(tasa);
    iva = (producto + BigInt(5000)) / BigInt(10000);
  }
  return { iva: deCentavos(iva), total: deCentavos(base + iva) };
}

/** Formato de pantalla en pesos mexicanos desde la forma canónica. */
export function formatearImporte(canonico: string | null): string {
  if (canonico === null) return "—";
  const negativo = canonico.startsWith("-");
  const [enteros, decimales] = canonico.replace("-", "").split(".");
  const conComas = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negativo ? "-" : ""}$${conComas}.${decimales}`;
}

// ---------------------------------------------------------------------------
// B2 — cantidades, importe por partida y totales de la cotización.
//
// Reglas (documentadas en docs/negocio/comercializacion.md §20, B2):
// - Cantidad: mayor que 0, hasta 3 decimales (metros, toneladas…), máximo
//   11 dígitos enteros (Decimal(14,3)). Nunca se redondea a entero.
// - Precio unitario: mayor que 0, 2 decimales, sin IVA.
// - Importe de partida = cantidad × precio, calculado EXACTO (milésimas ×
//   centavos) y redondeado UNA vez, half-up, al centavo.
// - Subtotal = Σ importes de partida (ya redondeados).
// - IVA: se agrupa la base por tasa de los productos GRAVADOS; IVA de cada
//   tasa = round_half_up(base_tasa × tasa / 100) al centavo; IVA = Σ por tasa.
//   Tasa 0 % y Exento se reportan como bases separadas con IVA $0.00 — nunca
//   se mezclan entre sí ni con una tasa gravada.
// - Total = Subtotal + IVA.
// ---------------------------------------------------------------------------

const MAX_DIGITOS_ENTEROS_CANTIDAD = 11;
const MAX_CENTAVOS_IMPORTE = BigInt("99999999999999"); // 999,999,999,999.99 — Decimal(14,2)

/** "2.5" → "2.500"; null si no es una cantidad válida (> 0, ≤ 3 decimales). */
export function normalizarCantidad(valor: unknown): string | null {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const texto = String(valor).trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(texto);
  if (!m) return null;
  const enteros = m[1].replace(/^0+(?=\d)/, "");
  if (enteros.length > MAX_DIGITOS_ENTEROS_CANTIDAD) return null;
  const canonico = `${enteros}.${(m[2] ?? "").padEnd(3, "0")}`;
  if (aMilesimas(canonico) === BigInt(0)) return null;
  return canonico;
}

/** "2.500" → 2500n. Solo acepta la forma canónica de 3 decimales. */
export function aMilesimas(canonico: string): bigint {
  const m = /^(\d+)\.(\d{3})$/.exec(canonico);
  if (!m) throw new Error(`Cantidad no canónica: ${canonico}`);
  return BigInt(m[1]) * BigInt(1000) + BigInt(m[2]);
}

/**
 * Importe de una partida: cantidad (3 dec.) × precio (2 dec.), exacto en
 * cienmilésimas y redondeado half-up al centavo una sola vez. Lanza si el
 * resultado excede la capacidad de la columna (Decimal(14,2)).
 */
export function calcularImportePartida(cantidad: string, precioUnitario: string): string {
  const exacto = aMilesimas(cantidad) * aCentavos(precioUnitario); // centavos × 1000
  const centavos = (exacto + BigInt(500)) / BigInt(1000);
  if (centavos > MAX_CENTAVOS_IMPORTE) throw new RangeError("El importe excede el máximo permitido.");
  return deCentavos(centavos);
}

export type PartidaParaTotales = {
  importe: string;
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null;
};

export type DesgloseImpuesto = { tasa: string; base: string; iva: string };

export type TotalesCotizacion = {
  subtotal: string;
  gravado: DesgloseImpuesto[]; // una fila por tasa, de mayor a menor
  baseTasaCero: string;
  baseExenta: string;
  iva: string;
  total: string;
};

export function calcularTotalesCotizacion(partidas: PartidaParaTotales[]): TotalesCotizacion {
  let subtotal = BigInt(0);
  let tasaCero = BigInt(0);
  let exenta = BigInt(0);
  const porTasa = new Map<string, bigint>();
  for (const p of partidas) {
    const importe = aCentavos(p.importe);
    subtotal += importe;
    if (p.tratamientoImpuesto === "GRAVADO") {
      if (!p.tasaIva) throw new Error("Una partida gravada requiere tasa de IVA.");
      porTasa.set(p.tasaIva, (porTasa.get(p.tasaIva) ?? BigInt(0)) + importe);
    } else if (p.tratamientoImpuesto === "TASA_CERO") {
      tasaCero += importe;
    } else {
      exenta += importe;
    }
  }
  const gravado = [...porTasa.entries()]
    .sort(([a], [b]) => (aCentavos(b) > aCentavos(a) ? 1 : aCentavos(b) < aCentavos(a) ? -1 : 0))
    .map(([tasa, base]) => ({ tasa, base: deCentavos(base), iva: calcularImpuesto(deCentavos(base), "GRAVADO", tasa).iva }));
  const iva = gravado.reduce((s, g) => s + aCentavos(g.iva), BigInt(0));
  const total = subtotal + iva;
  if (total > MAX_CENTAVOS_IMPORTE) throw new RangeError("El total excede el máximo permitido.");
  return {
    subtotal: deCentavos(subtotal),
    gravado,
    baseTasaCero: deCentavos(tasaCero),
    baseExenta: deCentavos(exenta),
    iva: deCentavos(iva),
    total: deCentavos(total),
  };
}

/** Formato de cantidad para pantalla: sin ceros decimales sobrantes. */
export function formatearCantidad(canonico: string): string {
  const [enteros, decimales = ""] = canonico.split(".");
  const limpio = decimales.replace(/0+$/, "");
  const conComas = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return limpio ? `${conComas}.${limpio}` : conComas;
}

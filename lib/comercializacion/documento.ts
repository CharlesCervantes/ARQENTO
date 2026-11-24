import * as z from "zod";
import type { TotalesCotizacion, TratamientoImpuesto } from "@/lib/comercializacion/importes";

// Copia histórica de una cotización de venta (B3). Se congela al EMITIR y es
// la ÚNICA fuente del PDF y de la vista de una cotización emitida/aceptada:
// cambiar después el catálogo, el cliente, la obra, el vendedor o la Empresa
// no la altera. Solo datos visibles para el cliente — nunca costos, utilidad,
// precio de catálogo ni marcas internas de ajuste de precio.
// La vista previa de un BORRADOR se arma con esta misma forma (en vivo).

export type PartidaDocumento = {
  codigo: string;
  descripcion: string;
  unidad: string;
  cantidad: string; // "2.375"
  precioUnitario: string; // "123.45", sin IVA
  importe: string; // "293.19"
  tratamientoImpuesto: TratamientoImpuesto;
  tasaIva: string | null;
};

export type DocumentoCotizacion = {
  version: 1;
  folio: string;
  fecha: string; // AAAA-MM-DD
  vigenciaHasta: string | null;
  descripcion: string | null;
  condiciones: string | null;
  observaciones: string | null;
  empresa: { nombre: string; razonSocial: string | null; logoRef: string | null };
  cliente: { nombre: string; contacto: string | null; telefono: string | null } | null;
  obra: { nombre: string; ubicacion: string | null } | null;
  // null = «Sin vendedor» (desde nov-2026). Las copias emitidas antes siempre
  // traen vendedor y se leen igual.
  vendedor: { nombre: string } | null;
  partidas: PartidaDocumento[];
  totales: TotalesCotizacion;
};

const importe = z.string().regex(/^-?\d+\.\d{2}$/);

const esquema = z.object({
  version: z.literal(1),
  folio: z.string(),
  fecha: z.string(),
  vigenciaHasta: z.string().nullable(),
  descripcion: z.string().nullable(),
  condiciones: z.string().nullable(),
  observaciones: z.string().nullable(),
  empresa: z.object({ nombre: z.string(), razonSocial: z.string().nullable(), logoRef: z.string().nullable() }),
  cliente: z.object({ nombre: z.string(), contacto: z.string().nullable(), telefono: z.string().nullable() }).nullable(),
  obra: z.object({ nombre: z.string(), ubicacion: z.string().nullable() }).nullable(),
  vendedor: z.object({ nombre: z.string() }).nullable(),
  partidas: z.array(
    z.object({
      codigo: z.string(),
      descripcion: z.string(),
      unidad: z.string(),
      cantidad: z.string().regex(/^\d+\.\d{3}$/),
      precioUnitario: importe,
      importe,
      tratamientoImpuesto: z.enum(["GRAVADO", "TASA_CERO", "EXENTO"]),
      tasaIva: importe.nullable(),
    })
  ),
  totales: z.object({
    subtotal: importe,
    gravado: z.array(z.object({ tasa: importe, base: importe, iva: importe })),
    baseTasaCero: importe,
    baseExenta: importe,
    iva: importe,
    total: importe,
  }),
});

/** Valida la forma de la copia guardada (columna Json) antes de usarla. */
export function leerDocumentoEmitido(valor: unknown): DocumentoCotizacion {
  return esquema.parse(valor) as DocumentoCotizacion;
}

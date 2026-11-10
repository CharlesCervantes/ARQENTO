// Extraído de las Server Actions de Gastos (proyecto y global) — un archivo
// "use server" solo puede exportar funciones async (Server Actions), así que
// este parser de FormData, compartido por ambos flujos, vive aparte (Gastos
// transversal, septiembre 2026).

function opcional(valor: FormDataEntryValue | null): string | null {
  const texto = typeof valor === "string" ? valor.trim() : "";
  return texto.length > 0 ? texto : null;
}

// Mismo patrón que detalleOCDesdeFormData (orden de compra) — un input
// hidden con JSON, porque un <form> nativo no soporta arreglos de objetos
// (captura multilínea de gastos, agosto 2026).
function detalleGastoDesdeFormData(formData: FormData): {
  descripcion: string;
  unidad: string;
  cantidad: string;
  precioUnitario: string;
}[] {
  const raw = formData.get("detalle");
  if (typeof raw !== "string" || raw.length === 0) return [];
  return JSON.parse(raw);
}

export function datosGastoDesdeFormData(formData: FormData) {
  return {
    fecha: formData.get("fecha"),
    descripcion: opcional(formData.get("descripcion")),
    categoria: formData.get("categoria"),
    monto: formData.get("monto"),
    metodoPago: formData.get("metodoPago"),
    // Nunca se asume "Empresa": si el formulario no lo envía, el servidor
    // rechaza el gasto pidiendo indicar quién pagó (ver DatosGastoSchema).
    quienPagoModo: opcional(formData.get("quienPagoModo")),
    pagadorBeneficiarioId: opcional(formData.get("pagadorBeneficiarioId")),
    proveedorBeneficiarioId: opcional(formData.get("proveedorBeneficiarioId")),
    comentario: opcional(formData.get("comentario")),
    requiereFactura: formData.get("requiereFactura") === "on",
    tratamientoCliente: formData.get("tratamientoCliente") || "NO_COBRABLE",
    detalle: detalleGastoDesdeFormData(formData),
  };
}

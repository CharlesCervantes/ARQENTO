// Lectura TOLERANTE del payload de webhooks de WhatsApp Business Platform
// (Fase 1, octubre 2026): solo extrae lo mínimo de cada mensaje entrante y
// descarta cualquier evento de otro número de ARQENTO (phone_number_id) o con
// una forma inesperada. Nunca lanza: un payload malformado da una lista vacía.
// Los "statuses" (confirmaciones de entrega) se ignoran en esta fase.

export type MensajeEntrante = {
  wamid: string;
  waId: string;
  recibidoEn: Date;
  tipo: string; // text | interactive | image | document | audio | …
  texto: string | null;
  // Respuesta a una lista interactiva (selección de Empresa).
  seleccionId: string | null;
};

const texto = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export function extraerMensajesEntrantes(payload: unknown, phoneNumberIdEsperado: string): MensajeEntrante[] {
  const mensajes: MensajeEntrante[] = [];
  const entradas = (payload as { object?: unknown; entry?: unknown })?.entry;
  if ((payload as { object?: unknown })?.object !== "whatsapp_business_account" || !Array.isArray(entradas)) return mensajes;
  for (const entrada of entradas) {
    const cambios = (entrada as { changes?: unknown })?.changes;
    if (!Array.isArray(cambios)) continue;
    for (const cambio of cambios) {
      const valor = (cambio as { field?: unknown; value?: Record<string, unknown> })?.value;
      if ((cambio as { field?: unknown })?.field !== "messages" || !valor) continue;
      const metadata = valor.metadata as { phone_number_id?: unknown } | undefined;
      if (metadata?.phone_number_id !== phoneNumberIdEsperado) continue;
      const lista = valor.messages;
      if (!Array.isArray(lista)) continue;
      for (const m of lista as Record<string, unknown>[]) {
        const wamid = texto(m?.id, 200);
        const waId = texto(m?.from, 20);
        if (!wamid || !waId || !/^\d{8,15}$/.test(waId)) continue;
        const segundos = Number(m.timestamp);
        const tipo = texto(m.type, 30) ?? "desconocido";
        const interactivo = m.interactive as { list_reply?: { id?: unknown }; button_reply?: { id?: unknown } } | undefined;
        mensajes.push({
          wamid,
          waId,
          recibidoEn: Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date(),
          tipo,
          // Solo se conservan los primeros caracteres: en esta fase basta
          // para leer un código o un comando.
          texto: tipo === "text" ? texto((m.text as { body?: unknown } | undefined)?.body, 200) : null,
          seleccionId: texto(interactivo?.list_reply?.id ?? interactivo?.button_reply?.id, 100),
        });
      }
    }
  }
  return mensajes;
}

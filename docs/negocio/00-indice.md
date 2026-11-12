# Índice de Documentación de Negocio — Grupo Conkuali

Este directorio contiene la documentación funcional del sistema, generada de forma
iterativa en sesiones de análisis de negocio (chat con Claude), **antes** de escribir
código. Claude Code debe consultar estos documentos antes de trabajar sobre cualquier
módulo relacionado.

## Personas y roles
- **Sergio Cervantes** — Director/dueño. Máxima autoridad. Autoriza pagos y aditivas.
- **Charles** — Administrador. Captura y valida oficialmente toda la información.
- **Andrés** — Supervisor de campo. Reporta avances y gastos con evidencia fotográfica, no captura montos oficiales.

## Documentos disponibles

| Archivo | Contenido |
|---|---|
| `01-administracion-pagos-semanales.md` | Ciclo semanal de pagos, capas de información, permisos, aditivas, bitácora |
| `02-control-de-obra.md` | Control de obra (versión supervisor vs. privada), Reporte General, Recibo de Pago, Préstamos, Gastos Semanales, Requisición de Materiales |
| `03-modulo-reporte-general.md` | Especificación detallada del módulo Reporte General (entidades, flujos, reglas) — primer módulo a construir |
| `05-modulo-contabilidad.md` | Rediseño del módulo Contabilidad: los cuatro ejes (inclusión/reconocimiento/CFDI/movimiento de dinero), Estado de Resultados, Cuentas por Cobrar/Pagar, Bancos/Tesorería |
| `06-whatsapp-recepcion-comprobantes.md` | Recepción de fotografías y PDF de comprobantes por WhatsApp (Fase 2A): quién envía y quién revisa, Empresa del comprobante, repetidos, recepción interrumpida, límites y descarte |

## Principios no negociables (aplican a todo el sistema)
1. **No eliminar información histórica.** Todo cambio de estado o monto se preserva; los rechazos se conservan con motivo.
2. **Bitácora obligatoria.** Toda acción relevante (crear, editar, confirmar, rechazar, cambiar estatus) se registra: quién, cuándo, qué cambió.
3. **Confidencialidad de precios por rol.** La versión que ve un supervisor (cantidades, sin precios reales) es distinta de la versión privada (Charles/Sergio, con precios reales) — deben sincronizarse en tiempo real.
4. **Todo proyecto nuevo sigue el formato de referencia de Villas de Herradura.**
5. **Fuera de alcance en esta fase:** portal para clientes (visibilidad contractual + fotos de avance).

## Estado de la documentación
Este documento se actualiza conforme se cierran más procesos de negocio en las sesiones
de análisis. Si un módulo no tiene documento aquí, **no debe construirse todavía** —
falta cerrar su documentación primero.

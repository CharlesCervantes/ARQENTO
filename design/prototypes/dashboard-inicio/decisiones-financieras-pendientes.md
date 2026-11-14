# Decisiones financieras pendientes: Dashboard Inicio V2

**Para:** quien define las reglas contables y financieras de Grupo Conkuali.
**Fecha:** 8 de octubre de 2026.
**Estado:** sin decidir. No se ha modificado ningún cálculo. Las referencias `archivo:línea` corresponden al código de esta fecha.

Hay cinco temas abiertos. Mientras no se resuelvan, el Dashboard Inicio V2:
- no muestra la utilidad real;
- no muestra el resultado contable;
- marca como "en corrección" el flujo neto.

---

## 1. Utilidad real (D6)

**Fórmula actual:** utilidad real = facturado General − costo real pagado (`dashboard.ts:779`, consolidado en `:995`); margen = utilidad / facturado (`:785`, `:1000`).

**Inconsistencias:**

| Lado | Qué suma hoy | Problema |
|---|---|---|
| Ingreso | `subtotal + montoAdministracionTrabajos` de las estimaciones de capa **OPERATIVO** emitidas (`dashboard.ts:733-735`) | **Sin IVA** (el IVA está en `montoIVA`, `schema.prisma:1421`). **Excluye gastos cobrables** (`schema.prisma:1418-1420`). Usa la capa General incluso en vista Privado, aunque la capa PRIVADO tiene precios propios |
| Costo: movimientos | Pagos liquidados y pagos puente de cortes, reposiciones y órdenes de compra (`dashboard.ts:763-765`) | Reposiciones y órdenes de compra se basan en `GastoObra.monto`, que se compara contra el **total del CFDI** (`facturas.ts:255-256`): todo indica que **incluye IVA**. En los cortes de contratista el IVA no está modelado |
| Costo: gasto directo | Gastos de obra **aprobados** sin pagador ni orden de compra (`dashboard.ts:614-629`) | Aprobado no es pagado: el doc 05 §6.4 define pagado por `Egreso.fechaPago` |
| Bases | Ingreso reconocido contra costo en efectivo | El doc 05 §7 prohíbe mezclar esos ejes |
| Alcance | Solo obras, sin gastos de oficina | Es una utilidad bruta, y Contabilidad dejó la rentabilidad por obra fuera de la primera entrega (doc 05 §15) |

**Nota:** el Estado de Resultados de Contabilidad usa `capa.total`, con IVA, como ingreso (`estado-resultados.ts:163`). El tratamiento del IVA tampoco está definido allí.

**Opciones posibles** (sin elegir):
- **A.** Reutilizar el Estado de Resultados por obra (doc 05 §15). Hereda el criterio de IVA de Contabilidad.
- **B.** Todo en efectivo: cobrado real − costo pagado, ambos con IVA.
- **C.** Todo sin IVA: ingreso con gastos cobrables sin IVA, y costo neto de IVA. Requiere desglosar el IVA en `GastoObra`, lo que implica un cambio de schema.
- **D.** Corrección parcial: gastos cobrables en ambos lados y gasto directo solo cuando está pagado, sin resolver el IVA.

**Preguntas:**
1. ¿`GastoObra.monto` incluye IVA siempre, o solo cuando hay factura?
2. ¿Los cortes de contratista llevan IVA?
3. ¿El ingreso real de una obra es la capa General, la Privada u otra?
4. ¿La utilidad se mide en base de reconocimiento o de efectivo? ¿Opción A, B, C o D?
5. ¿Los gastos cobrables y su recuperación entran en la utilidad?

---

## 2. `montoEntreSemana` (D1)

**Evidencia:**
- **Escritura:** el campo existe con valor por omisión 0 (`schema.prisma:747`; migración `20260813044503_reporte_general`). **Ningún código lo escribe:** ni la aplicación, ni el seed, ni los backfills. Todos los procesos que crean movimientos semanales llenan solo `montoFinSemana`: `cierre-semana.ts:404, 467`, `ordenes-compra.ts:240`, `reposiciones.ts:157, 175`. El origen `MANUAL` existe pero nadie lo usa; puede estar reservado para captura manual o para la migración del Excel (doc 03 §6–7).
- **Lectura en Reporte General y liquidación:** suman `montoEntreSemana + montoFinSemana` (`reporte-general/queries.ts:110, 135, 233-240, 293`; `liquidar.ts:46`). La interfaz muestra la columna (`obra-card.tsx:207, 245, 283`).
- **Lectura en Inicio:** suma solo `montoFinSemana` (`dashboard.ts:468, 665, 742, 765, 891, 946`).
- **Documentación:** el doc 03 §2.6 dice "importes reales" y §3 desglosa entre semana y fin de semana. Pero §4.1 dice que los montos pueden cambiar de lunes a viernes, lo que también admite leer "entre semana" como una estimación previa.

**Impacto hoy:** cero, porque el campo siempre vale 0.

**Recomendación técnica, condicionada a la respuesta de negocio:** si son importes que se suman, Inicio debe usar la misma expresión que `liquidar.ts:46` en por pagar, ejercido, costo pagado y salidas del flujo. No hay duplicación, porque son dos partes distintas del mismo movimiento.

**Limitación del modelo:** cada movimiento tiene una sola `fechaPago` y un solo `estatusPago`. Si las dos partes se pagan en fechas distintas, no se pueden ubicar por separado en el flujo.

**Comparabilidad:** Reporte General muestra un pendiente por semana; Inicio muestra el pendiente de todas las semanas. Deben coincidir movimiento por movimiento, no en el total de pantalla.

**Preguntas:**
6. ¿`montoEntreSemana` es un pago adicional (se suma) o una estimación previa (no se suma)? ¿Lo llenará la migración del Excel o una captura manual?
7. Si son dos pagos en fechas distintas, ¿hace falta fechar cada parte por separado?

---

## 3. Saldos de obras cerradas (D5)

- **Estados existentes:** ACTIVO, PAUSADO, CERRADO, CANCELADO (`schema.prisma:387-392`). El doc 03 §2.1 define Cerrado como histórico consultable fuera de la vista operativa y Cancelado como obra no concluida.
- **Al cerrar una obra no se validan saldos pendientes** (`proyectos.ts:278-300`).
- **Reporte General e Inicio** solo consideran ACTIVO y PAUSADO (`queries.ts:86`, `dashboard.ts:385`). Un pago pendiente de una obra cerrada queda fuera de la pantalla donde se liquida.
- **El Estado de Resultados** no filtra por estatus (`estado-resultados.ts:144-146`).
- **El doc 05 §8**, de cuentas por cobrar, no menciona el estatus de la obra.

**Preguntas:**
8. ¿Se permite cerrar o cancelar una obra con pagos o cobros pendientes, o debe bloquearse o advertirse?
9. ¿Dónde se liquida un pendiente de una obra cerrada?
10. ¿Inicio debe mostrar esos saldos (por ejemplo, "de obras cerradas: $X") o solo un aviso?
11. ¿Los saldos por cobrar de una obra cancelada se consideran incobrables?

---

## 4. Costo pagado, costo comprometido y gasto aprobado (D8)

**Definiciones propuestas**, para no mezclarlos:

| Concepto | Definición propuesta | Base documental |
|---|---|---|
| **Gasto aprobado** (reconocido) | `GastoObra` en APROBADO y `CorteSemanal` en GENERADO (`montoNeto`) | doc 05 §4 |
| **Costo comprometido** | Reconocido y aún no pagado: movimientos semanales APROBADO + PENDIENTE_PAGO, gasto directo APROBADO sin `Egreso.fechaPago` y saldo de reposiciones con abonos parciales | doc 05 §9 |
| **Costo pagado** | Movimientos semanales LIQUIDADO (¿más PAGADO_PUENTE?), abonos de reposición y gasto directo con `Egreso.fechaPago` | doc 05 §6.2–6.4, §10 |

**Hoy el dashboard usa tres definiciones distintas de "pagado":**
- **Flujo:** solo LIQUIDADO (`dashboard.ts:943-946`).
- **Ejercido:** LIQUIDADO + PAGADO_PUENTE (`dashboard.ts:763-765`).
- **Costo real pagado:** ejercido + gasto directo **aprobado** (`dashboard.ts:777`). Esta es la que mezcla pagado con aprobado.

**Por pagar** (`dashboard.ts:741, 889`) es solo una parte de lo comprometido: deja fuera los gastos directos no pagados, que el doc 05 §9 sí incluye.

**El prototipo V2** usa "ejercido" (LIQUIDADO + PAGADO_PUENTE, sin gasto aprobado) para el indicador "Costo pagado frente al presupuesto", que es la misma definición del % por obra. Esto se mantiene hasta que se responda:

12. ¿PAGADO_PUENTE cuenta como costo pagado? Se pagó al beneficiario, pero se le debe al fondo.
13. ¿El costo comprometido incluye órdenes de compra autorizadas aún no ejecutadas, o el saldo de contratos de contratista?
14. ¿El gasto directo pagado debe leerse de `Egreso.fechaPago`?

---

## 5. Prioridad de alertas (D13)

Esta es una propuesta para **ordenar** las alertas. No cambia las reglas que las generan.

| Alerta | Severidad actual | Gravedad propuesta | Urgencia | Razón |
|---|---|---|---|---|
| Pagos pendientes | Requiere acción si ≥14 días | Alta | Alta (se paga el viernes) | Puede detener la obra o la relación con el contratista. En V2 la cubre el indicador Por pagar |
| Semanas sin cerrar | Requiere acción si ≥2 semanas | Alta | Alta | Bloquea cortes, pagos y estimaciones |
| Reposición pendiente antigua | Requiere acción si ≥14 días | Media-alta | Media-alta | Es una deuda con una persona que adelantó dinero |
| Desviación (solo Privado) | Requiere acción si >30 pp | Alta | Media | Es el problema de negocio confirmado del doc 01. En V2 la cubre un indicador de Privado |
| Estimaciones listas para emitir | Atención | Media-alta | Alta | Retrasa el cobro |
| Pendiente de cobro | Atención | Alta | Media | En V2 la cubre el indicador Por cobrar |
| Gastos pendientes de revisión | Atención | Media | Media | Bloquea la reposición y la estimación |
| Gasto recurrente sin monto | Atención | Media | Media | Bloquea su aprobación |
| Factura con diferencia de monto | Atención | Media | Baja | Corrección fiscal |
| Facturas pendientes | Atención | Baja-media | Baja (cierre mensual) | Seguimiento fiscal |
| Sin avance reciente (Supervisor) | Requiere acción si ≥4 semanas | Alta para su rol | Alta | Es su tarea principal |

**Orden propuesto:** severidad actual, luego gravedad, luego urgencia y, por último, el orden en que se construyen hoy.

**Señal que falta:** "avance pendiente de aprobación" existe (`avance.ts:500`) pero no genera alerta.

15. ¿Se agrega la alerta "avance pendiente de aprobación" para Director y Administrador? Sería una regla nueva.

---

## 6. Posible duplicación de ingresos en el Estado de Resultados (nuevo)

Si un usuario con permiso privado tiene marcadas como incluidas en Contabilidad las dos capas de la misma estimación, el Estado de Resultados suma ambas y reconoce dos veces el mismo trabajo. Ningún control lo impide.

El ejemplo numérico, la lógica actual, las consecuencias y una consulta de verificación de solo lectura están en `plan-correccion-d2-d4.md`, bloque 4. La fórmula no se ha modificado.

---

## Resumen de preguntas

| # | Tema | Pregunta |
|---|---|---|
| 1 | D6 | ¿`GastoObra.monto` incluye IVA siempre o solo con factura? |
| 2 | D6 | ¿Los cortes de contratista llevan IVA? |
| 3 | D6 | ¿El ingreso real de una obra es la capa General, la Privada u otra? |
| 4 | D6 | ¿Reconocimiento o efectivo? ¿Opción A, B, C o D? |
| 5 | D6 | ¿Los gastos cobrables entran en la utilidad? |
| 6 | D1 | ¿`montoEntreSemana` se suma o es una estimación previa? ¿Quién lo llenará? |
| 7 | D1 | ¿Hace falta fechar por separado cada parte del pago? |
| 8 | D5 | ¿Se puede cerrar una obra con saldos pendientes? |
| 9 | D5 | ¿Dónde se liquidan los pendientes de obras cerradas? |
| 10 | D5 | ¿Inicio debe mostrar esos saldos? |
| 11 | D5 | ¿Los saldos de obras canceladas son incobrables? |
| 12 | D8 | ¿PAGADO_PUENTE cuenta como costo pagado? |
| 13 | D8 | ¿Qué incluye el costo comprometido? |
| 14 | D8 | ¿El gasto directo pagado se lee de `Egreso.fechaPago`? |
| 15 | D13 | ¿Se agrega la alerta de avance pendiente de aprobación? |

---

## Inicio V2 implementado (14 de noviembre de 2026)

Elecciones de **presentación** de esta entrega. No cierran ninguna decisión de este documento:

- **D8:** el indicador "Costo cubierto vs presupuesto" (vista Privado) suma pagos LIQUIDADO y PAGADO_PUENTE y excluye el gasto directo solo aprobado. El flujo neto sigue contando solo LIQUIDADO. Las preguntas 12–14 siguen abiertas.
- **D6:** "Utilidad real a la fecha" deja de mostrarse en Inicio. Su fórmula no cambió y el dato sigue calculándose para quien tiene acceso privado.
- **D13:** el bloque "Requiere tu atención" usa el orden propuesto en §5 (severidad y luego gravedad) solo para ordenar. No cambia qué genera una alerta ni su severidad.
- **Resumen fiscal:** se retira de Inicio (plan D2/D4, punto 1.9). Contabilidad lo conserva.

Pendientes técnicos registrados (fuera de esta entrega):

1. Validar en el servidor el tipo y el tamaño de la imagen de portada al subirla (hoy solo filtra el selector del navegador). Permitir cargarla al crear el proyecto.
2. Cortes de periodo por zona horaria: `resolverRangoPeriodo` usa la hora del servidor (UTC en Vercel), así que "Esta semana" y "Este mes" se recorren unas 6 horas respecto a México.
3. Gráfica de entradas y salidas del V2.
4. Navegación móvil: el menú lateral de la app (AppShell) no se colapsa en pantallas angostas; afecta a todas las pantallas, no solo a Inicio.

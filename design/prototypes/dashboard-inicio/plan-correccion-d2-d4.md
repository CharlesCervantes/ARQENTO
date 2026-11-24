# Plan de corrección: separación General / Privado (D2, D4) y hallazgos relacionados

**Versión:** 2. Incorpora las decisiones del 8 de octubre de 2026.
**Estado:** plan aprobado en dirección, sin implementar. No se ha modificado código, base de datos ni cálculos.
**Referencias:** las de tipo `archivo:línea` corresponden al código del 8 de octubre de 2026.

## Estado de implementación (8 de octubre de 2026)

| Bloque | Estado |
|---|---|
| 1. Exposición de información privada | **Implementado**, salvo el punto 10 (resumen fiscal en Inicio). Por decisión del 8 de octubre se retira junto con V2: hoy solo lo ven usuarios con acceso privado |
| 2. E1 | **Implementado el 9 de octubre de 2026** (ver `diseno-e1-por-cobrar.md`): Flujo General con tope cronológico, Por cobrar con el cobro real de ambas capas (P2 en Privado) y validación de saldo real en todas las rutas de cobro. Con esto el punto 1 queda cerrado y la protección temporal T1 se retiró |
| 3. Facturas en Contabilidad | **Implementado** |
| 4. Auditoría del Estado de Resultados | **No ejecutada.** No hay un entorno de consulta seguro de solo lectura |
| Pruebas | `npm test`: 95 pruebas en verde, 0 pendientes. `npm run test:integracion` queda listo, protegido y sin ejecutar, porque no hay un PostgreSQL aislado |

## Decisiones tomadas

| Pregunta | Decisión |
|---|---|
| 1. Entradas del flujo en General | **E1 condicionada.** Se adopta como dirección la proyección de cobros con tope OPERATIVO, conservando las aportaciones de fondo. No se implementa hasta confirmar la definición financiera final (bloque 2). |
| 2. Facturas en Contabilidad | **Opción B.** Se corrige también en Contabilidad, con la misma política de acceso por capa que ya aplican los ingresos. Es un cambio independiente, con pruebas de permisos y de regresión (bloque 3). |
| 3. Salud y orden de las obras | **Aprobada.** En la Vista General dependen solo de información General. La desviación privada solo influye en la Vista Privada (bloque 1). |
| 4. Pruebas | **Aprobada.** Se usa `node:test` + `tsx`. Primero pruebas unitarias de permisos, cálculos y serialización; después integración contra un PostgreSQL aislado, con protección explícita contra producción. |
| Hallazgo adicional | Auditar la posible duplicación de ingresos en el Estado de Resultados, sin cambiar su fórmula (bloque 4). |

## Garantías comunes a todos los bloques

- **Reporte General no se toca.** Sus consultas (`reporte-general/queries.ts`, `liquidar.ts`) no dependen del dashboard y ningún bloque las modifica.
- **Ninguna fórmula financiera cambia en los bloques 1 y 3.** Solo cambia qué insumo privado entra en la Vista General, o qué filas ve quien no tiene permiso privado.
- **El bloque 2 sí cambia una cifra visible** (las entradas de General) y no se implementa sin autorización expresa.
- **El bloque 4 es solo auditoría.**

## Qué es exposición real y qué no

| # | Punto | Clasificación |
|---|---|---|
| 1 | Entradas del flujo con cobros de capa privada | Exposición real a usuarios **sin** permiso. Cualquier Director o Administrador la ve → bloque 2 |
| 8 | "Estimaciones listas" cuenta capas privadas en borrador | Exposición real menor (un conteo), a cualquier Director o Administrador → bloque 1 |
| 9 | Alertas de facturas con ingresos de capa privada | Exposición real menor en Inicio (conteo). En Contabilidad incluye montos → bloques 1 y 3 |
| 2 | Alerta de desviación decidida por permiso | Visible solo para quien tiene permiso, pero rompe la separación de vistas → bloque 1 |
| 3 | Salud con desviación privada | Visible indirectamente (estado y orden), solo para quien tiene permiso → bloque 1 |
| 10 | Resumen "fiscal" con capa privada según permiso | Visible solo para quien tiene permiso, en vista General → bloque 1 |
| 4, 5, 6, 7, 11 | Cálculos privados internos | Solo en el servidor; hoy no llegan al navegador → bloque 1 (que se cumpla en el servidor) |
| 12 | Payload RSC | Riesgo latente si se agrega un componente cliente → bloque 1 (regla de DTO recortado) |

---

# Bloque 1 — Exposición de información privada, sin cambiar fórmulas

**Objetivo:** cuando la vista efectiva es General, el servidor no calcula ni devuelve ningún dato privado, y nada de lo privado influye en salud, orden ni alertas.

**Fuera de este bloque:** las entradas del flujo (bloque 2) y la política de facturas dentro de Contabilidad (bloque 3).

## Cambios listos para implementar

| ID | Archivo | Cambio | Efecto visible |
|---|---|---|---|
| **1.1** | `package.json` + `tests/` | Script `"test": "node --conditions=react-server --import tsx --test"` y carpeta de pruebas. Sin dependencias nuevas | Ninguno |
| **1.2** | `tests/helpers/db-guard.ts` | Protección contra producción, usada por toda prueba de integración: exige `TEST_DATABASE_URL`, falla si no existe, si es igual a `DATABASE_URL` o si el nombre de la base no termina en `_test`. Nunca lee `DATABASE_URL` como respaldo | Ninguno |
| **1.3** | `lib/server/dashboard.ts` | Exportar `calcularSaludProyecto` y `construirAlertas`, que ya son funciones puras, para poder probarlas unitariamente. Sin cambiar su lógica | Ninguno |
| **1.4** | `lib/server/dashboard.ts` | Separar la carga de datos (consultas) de la proyección del resultado: una función pura `proyectarResumenEjecutivo(datos, { nivelAcceso, incluirPrivado, vista, periodo })`. Refactor sin cambio de comportamiento; lo verifica la prueba de regresión 1.T6 | Ninguno |
| **1.5** | `lib/server/dashboard.ts` | Bandera única `const incluirPrivado = vistaEfectiva === "privado"`. Sustituye a `puedeVerPrivado` en la consulta de gasto directo (`:614`), en `financieroPrivado` (`:749`), en el contexto de alertas (`:971`) y en `utilidadConsolidada` (`:992`). `puedeVerPrivado` queda solo para decidir si se muestra el selector de vista | En General desaparecen la alerta de desviación y el efecto de la desviación en la salud. **No cambia ningún monto General** |
| **1.6** | `lib/server/dashboard.ts` | En General, `utilidad`, `desviacionPrivadaPP` (por obra) y `utilidadConsolidada` son `null` porque no se calculan, no porque se borren después | Ninguno en pantalla (hoy no se dibujan en General) |
| **1.7** | `lib/server/dashboard.ts:515` | En `capasBorrador`, agregar `capa: "OPERATIVO"` cuando `!incluirPrivado`. La regla de "lista para emitir" no cambia | El conteo de General ya no incluye borradores privados |
| **1.8** | `lib/server/dashboard.ts:437-441` | Seleccionar los precios privados de `Concepto` solo cuando `incluirPrivado` | Ninguno |
| **1.9** | `lib/server/dashboard.ts:641` | Resumen "fiscal": se retira de Inicio, como se decidió en D3/D12. Se deja de llamar `obtenerResumenFiscalPeriodo` y su definición no cambia. **Decidir el momento:** ahora (desaparecen las tres cifras del Inicio actual) o junto con V2 | Desaparecen las tarjetas fiscales de Inicio |
| **1.10** | `lib/server/dashboard.ts:642-643` | Pasar `incluirPrivado` al parámetro opcional de facturas que crea el bloque 3 | Los conteos de General ya no incluyen ingresos privados. **Depende del bloque 3** |
| **1.11** | `components/dashboard/inicio-view.tsx` | Ninguna lógica nueva. Regla documentada en el código: todo componente cliente recibe un objeto ya recortado en el servidor | Ninguno |

## Pruebas del bloque 1

**Unitarias** (sin base de datos, sobre `proyectarResumenEjecutivo` con datos sembrados en memoria):

- **1.T1 Matriz de permisos.** DIRECTOR/ADMINISTRADOR/SUPERVISOR × switch personal × `privadoHabilitado` × vista pedida (24 casos), más MASTER (lanza `SinPermisoError`). Por cada caso se verifica qué campos deben ser `null`. La tabla completa está en el anexo A.
- **1.T2 No exposición por serialización.** Sobre `JSON.stringify` del resultado en General: ninguna llave privada distinta de `null` y ningún monto "trampa" sembrado solo en capas privadas (por ejemplo 777,777.77, o el presupuesto de costo privado).
- **1.T3 Invariancia de salud.** Cambiar precios o costos privados no altera `salud` ni el orden de las obras en General. En Privado sí puede alterarlos.
- **1.T4 Alertas.** En General nunca aparece `desviacion`. "Estimaciones listas" no cuenta borradores privados.
- **1.T5 URL manipulada.** Un usuario sin permiso que pide `vista=privado` recibe `vistaEfectiva = "general"` y su resultado cumple todo lo de General.
- **1.T6 Regresión.** Con los mismos datos, Por pagar, Por cobrar, pagos de obra, avance físico y las alertas no privadas son idénticos antes y después.

**Integración** (PostgreSQL aislado, protegido por 1.2):

- **1.T7** `obtenerResumenEjecutivo` real sobre un seed de matriz, repitiendo 1.T1, 1.T2 y 1.T6.

## Orden de implementación

1. 1.1, 1.2 y 1.3, con las pruebas 1.T1–1.T6 escritas antes de corregir (deben fallar en los puntos 2, 3, 5, 6, 7 y 8).
2. 1.4 (refactor), con 1.T6 en verde.
3. 1.5 a 1.8.
4. 1.9 (según el momento que decidas).
5. 1.10 cuando exista el bloque 3.
6. `npm run build`, pruebas y verificación manual (anexo B).

**Aviso para usuarios:** los Directores y Administradores con permiso privado verán en General una salud y un orden de obras que ya no reflejan la desviación privada. Esa información pasa a vivir solo en Privado.

---

# Bloque 2 — Corrección E1: entradas del flujo en General (requiere validación)

**Estado:** dirección aprobada; **no se implementa** hasta confirmar la definición financiera final.

## Situación actual

- Las entradas del flujo suman todos los `PAGO_ESTIMACION` del periodo, de cualquier capa, más las `APORTACION_FONDO` (`dashboard.ts:937-942`).
- Cuando una estimación tiene emitidas ambas capas, el cobro real se registra solo en la capa PRIVADO ("una sola realidad de dinero", `financiero-cliente.ts:56-70`). Por eso el monto que hoy ve General es el cobro real a precio privado.
- Por cobrar en General ya proyecta: `pendiente = total OPERATIVO − min(cobrado real, total OPERATIVO)` (`financiero-cliente.ts:89-104`).

## Definición propuesta: tope cronológico

Por cada estimación con capa privada emitida:

1. Ordenar sus movimientos reales vigentes (`PAGO_ESTIMACION` y `APLICACION_ESTIMACION`) por fecha.
2. Acumular el cobrado real. El cobrado General acumulado en cada fecha es `min(cobrado real acumulado, total OPERATIVO)`.
3. El incremento de ese acumulado en cada movimiento se atribuye a ese movimiento.
4. **Solo cuenta como entrada el incremento atribuido a un `PAGO_ESTIMACION`.** Las `APLICACION_ESTIMACION` nunca son entrada, porque el dinero del fondo ya entró como aportación.

Además:
- Las estimaciones solo OPERATIVO no cambian: entran sus pagos tal como hoy.
- `APORTACION_FONDO` sigue contando como entrada General en su fecha. Hoy ya se trata como dato General en Control de obra (`financiero-cliente.ts:745`) y en Contabilidad (`ingresos.ts:98-100`).

**Por qué cronológico y no proporcional:**
- Con el tope cronológico, la suma de entradas General hasta cualquier fecha es igual a lo que Por cobrar General da por cobrado en esa fecha. Las dos cifras quedan consistentes en todo momento.
- Un reparto proporcional (factor total OPERATIVO ÷ total PRIVADO por pago) solo coincide al final, no en las fechas intermedias.

## Casos de validación con ejemplos

En todos los casos la estimación es ficticia: **total OPERATIVO $980,000.00 y total PRIVADO $1,150,000.00**, salvo que se indique otra cosa.

### Caso 1 — Solo OPERATIVO, cobros parciales

Pagos sobre OPERATIVO: $400,000.00 el 15 de septiembre y $580,000.00 el 6 de octubre.

| Fecha | Entradas hoy | Entradas con E1 | Por cobrar General después |
|---|---|---|---|
| 15 sep | $400,000.00 | $400,000.00 | $580,000.00 |
| 6 oct | $580,000.00 | $580,000.00 | $0.00 |

**Resultado:** sin cambios. E1 solo actúa cuando existe una capa privada emitida.

### Caso 2 — Ambas capas, cobros parciales en distintas fechas

Pagos sobre PRIVADO: $500,000.00 (15 sep), $400,000.00 (29 sep) y $250,000.00 (6 oct).

| Fecha | Real acumulado | General acumulado (tope $980,000) | Entrada hoy | Entrada con E1 | Por cobrar General después |
|---|---|---|---|---|---|
| 15 sep | $500,000.00 | $500,000.00 | $500,000.00 | $500,000.00 | $480,000.00 |
| 29 sep | $900,000.00 | $900,000.00 | $400,000.00 | $400,000.00 | $80,000.00 |
| 6 oct | $1,150,000.00 | $980,000.00 | $250,000.00 | **$80,000.00** | $0.00 |
| **Total** | | | **$1,150,000.00** | **$980,000.00** | |

**Comparación con un reparto proporcional** (factor 0.8522): $426,087 / $340,870 / $213,043. Al 15 de septiembre, General mostraría $426,087 cobrados mientras Por cobrar da $500,000 por cobrados, y las dos cifras no cuadrarían. Por eso se recomienda el tope cronológico.

### Caso 3 — Aplicaciones de fondo y prevención de duplicados

Aportación de fondo de $300,000.00 (1 sep). Aplicación de $300,000.00 sobre PRIVADO (15 sep). Pago de $850,000.00 sobre PRIVADO (29 sep).

| Fecha | Movimiento | General acumulado | Entrada con E1 |
|---|---|---|---|
| 1 sep | Aportación | — | $300,000.00 (aportación, dato General) |
| 15 sep | Aplicación | $300,000.00 | $0.00 (nunca es entrada) |
| 29 sep | Pago | $980,000.00 (tope) | $680,000.00 |
| **Total General** | | | **$980,000.00** |
| **Total real** | | | **$1,150,000.00** ($300,000 + $850,000) |

No hay duplicación: la aportación cuenta una vez; la aplicación nunca.

**Variante (orden inverso):** pago de $850,000.00 el 15 de septiembre y aplicación de $300,000.00 el 29 de septiembre. General cuenta $850,000.00 de pago (por debajo del tope) y la aplicación no es entrada. Total de entradas General: $300,000.00 + $850,000.00 = $1,150,000.00, igual al real.
- No revela el precio privado: cada cifra es efectivo real y ningún pago excede el total General.
- Pero el total de entradas General de la obra supera su total OPERATIVO. **Hay que validar si esto es aceptable.**

### Caso 4 — Consistencia con Por cobrar

**Invariante a probar:** para toda estimación y toda fecha, `Σ entradas General atribuidas a la estimación hasta esa fecha` (sin aportaciones) + `Σ aplicaciones atribuidas` = `total OPERATIVO − Por cobrar General a esa fecha`.

**Observación fuera del alcance de E1:** en vista Privado, Por cobrar solo recorre capas PRIVADO (`dashboard.ts:901, 916`), así que las estimaciones que solo tienen capa OPERATIVO no cuentan en el Por cobrar Privado. V2 no muestra Por cobrar en Privado, pero hay que validarlo antes de reutilizar ese número.

### Caso 5 — Cobros registrados en OPERATIVO antes de emitir la capa privada

No se encontró una validación que impida emitir la capa PRIVADO cuando la OPERATIVO ya recibió cobros (`estimacion-cliente.ts`, emisión).

Si ocurre, Por cobrar General ignora esos cobros previos, porque con una hermana privada solo lee los movimientos de la privada (`financiero-cliente.ts:89-92`).

**E1 necesita una regla explícita para este caso:**
- **a.** Sumar los cobros previos de OPERATIVO al real acumulado antes de aplicar el tope.
- **b.** Bloquear la emisión de la capa privada si hay cobros en OPERATIVO. Sería una regla nueva de negocio.

### Caso 6 — Flujo proyectado General frente a efectivo real

Con el caso 2, en la semana del 6 de octubre:

| Concepto | General (E1) | Real |
|---|---|---|
| Entradas | $80,000.00 | $250,000.00 |
| Pagos de obra | $868,400.00 | $868,400.00 |
| **Neto** | **−$788,400.00** | **−$618,400.00** |

- La diferencia de $170,000.00 es exactamente el excedente del precio privado.
- Con E1, **el "Flujo neto" de General deja de ser efectivo bancario**: es efectivo proyectado a precios General.
- El efectivo real sigue disponible en Control de obra y, para quien tiene permiso, en Contabilidad.
- **Hay que decidir la etiqueta**, por ejemplo "Flujo neto de obras (base General)", y si en Privado se muestra el real.

## Decisiones pendientes antes de implementar E1

1. ¿Se confirma el tope **cronológico** (consistente con Por cobrar) frente al proporcional?
2. Variante del caso 3: ¿es aceptable que las entradas General de una obra superen su total OPERATIVO cuando el fondo cubre la diferencia?
3. Caso 5: ¿regla **a** o **b** para los cobros previos a la emisión de la capa privada?
4. ¿Etiqueta del flujo en General? ¿La Vista Privada muestra el flujo real?
5. ¿Las aportaciones de fondo siguen sin tope en General? (Hoy son un dato General.)

## Pruebas previstas para E1 (cuando se apruebe)

- **2.T1 a 2.T6:** los casos 1 a 6 anteriores, como pruebas unitarias con los mismos importes.
- **2.T7 Invariante del caso 4**, sobre series aleatorias de pagos y aplicaciones.
- **2.T8 Movimientos cancelados:** nunca cuentan (`estatus = VIGENTE`).
- **2.T9 No exposición:** ninguna entrada General revela un monto mayor al total OPERATIVO de la estimación.
- **2.T10 Regresión:** las obras sin capa privada mantienen exactamente sus entradas actuales.

---

# Bloque 3 — Corrección independiente en Contabilidad: facturas pendientes y con diferencia

**Estado:** aprobado (opción B). Es un cambio independiente de Inicio.

## Situación actual

- `obtenerFacturasPendientes` (`facturas-pendientes.ts:38-53`) y `obtenerFacturasConDiferencia` (`facturas.ts:237-249`) incluyen ingresos ligados a movimientos de cualquier capa. Solo exigen `puedeVerContabilidad`.
- La lista de ingresos de Contabilidad sí aplica la regla del doc 05 §17: sin permiso privado solo se ven movimientos sin capa o de capa OPERATIVO (`ingresos.ts:95-100`).
- Resultado: un usuario sin permiso privado puede ver en la pantalla de facturas el monto esperado de un ingreso ligado a un cobro de capa privada.

## Cambios listos para implementar

| ID | Archivo | Cambio |
|---|---|---|
| **3.1** | `lib/server/contabilidad/facturas-pendientes.ts` | Agregar a `obtenerFacturasPendientes` un parámetro opcional `{ incluirPrivado?: boolean }`, por omisión `puedeVerInformacionPrivada(usuario)`. Si es `false`, la consulta de ingresos excluye los ligados a un movimiento de capa PRIVADO, con el mismo filtro de `ingresos.ts`: `OR: [{ movimientoFinancieroClienteId: null }, { movimientoFinancieroCliente: { OR: [{ estimacionClienteCapaId: null }, { estimacionClienteCapa: { capa: "OPERATIVO" } }] } }]` |
| **3.2** | `lib/server/contabilidad/facturas.ts` | El mismo parámetro y el mismo filtro en la consulta de ingresos de `obtenerFacturasConDiferencia` |
| **3.3** | Pantallas de Contabilidad que las consumen | Ningún cambio: usan el valor por omisión (permiso del usuario) |
| **3.4** | Egresos | Ningún cambio: los gastos de obra no son información privada |

**Qué no cambia:**
- Usuarios con permiso privado: ven exactamente las mismas filas.
- Ingresos manuales sin movimiento: se siguen viendo.
- Aportaciones de fondo (sin capa): se siguen viendo.
- No cambia ningún total ni ninguna regla de "pendiente" o "diferencia".

## Pruebas del bloque 3

- **3.T1 Permisos.** Sin permiso privado (switch apagado, o Empresa sin `privadoHabilitado`): no aparece ninguna fila ligada a capa PRIVADO.
- **3.T2 Regresión con permiso.** Exactamente las mismas filas que antes del cambio.
- **3.T3 Ingresos manuales y aportaciones.** Se ven con y sin permiso.
- **3.T4 Egresos.** Sin cambios en ningún caso.
- **3.T5 Integración** contra PostgreSQL aislado (protección 1.2).

**Orden:** 3.1–3.2 con sus pruebas. Después se habilita 1.10 en el dashboard.

---

# Bloque 4 — Auditoría del Estado de Resultados: posible duplicación de ingresos

**Estado:** solo auditoría. **La fórmula no se cambia.**

## Lógica actual

- **Ingresos por obra** = Σ `EstimacionClienteCapa.total` con `estatus = EMITIDA`, `incluidoEnContabilidad = true` y `emitidoEn` dentro del periodo (`estado-resultados.ts:152-164`).
- Si el usuario **tiene** permiso privado, se suman **ambas capas**. Si no lo tiene, solo OPERATIVO (`:140`, `:161`).
- `incluidoEnContabilidad` es un indicador **por capa**, con valor inicial `false` (`schema.prisma:1447`), y se marca a mano con `marcarInclusionCapa` (`inclusion.ts:40-58`).
- **No hay ninguna validación que impida marcar ambas capas de la misma estimación.** El valor inicial por Empresa (`Empresa.defaultInclusionContabilidad`) está documentado, pero no encontré código que lo aplique al crear la capa.
- El doc 05 §4 dice: "la capa (Operativo **o** Privado) queda emitida — nace el derecho de cobro formal". Implica una sola capa reconocida por estimación, pero el código no lo garantiza.

## Ejemplo numérico

Estimación ficticia de octubre: capa OPERATIVO de $980,000.00 y capa PRIVADO de $1,150,000.00, ambas emitidas el 6 de octubre. Las dos representan **el mismo trabajo** a dos precios.

| Escenario de inclusión | Ingresos que ve un usuario con permiso privado | Ingresos que ve un usuario sin permiso | Comentario |
|---|---|---|---|
| Ambas capas incluidas | **$2,130,000.00** | $980,000.00 | **Duplicado:** el mismo trabajo se reconoce dos veces. Sobrestimación de $980,000.00 frente a la realidad privada |
| Solo OPERATIVO incluida | $980,000.00 | $980,000.00 | Sin duplicado, pero quien tiene permiso no ve los $170,000.00 de excedente privado |
| Solo PRIVADO incluida | $1,150,000.00 | **$0.00** | Sin duplicado, pero quien no tiene permiso no ve ningún ingreso de esa obra, aunque sí ve sus costos |
| Ninguna incluida | $0.00 | $0.00 | La obra no aparece |

**Efecto en cascada** con costos directos del periodo de $800,000.00:

| Escenario | Utilidad bruta (con permiso) | Margen bruto |
|---|---|---|
| Ambas incluidas | $1,330,000.00 | 62.4 % |
| Realidad privada (una sola capa, PRIVADO) | $350,000.00 | 30.4 % |

## Consecuencias contables

- **Ingresos, utilidad bruta, utilidad operativa y resultado del periodo sobrestimados**, tanto en el periodo como en el acumulado anual.
- **Dos usuarios ven estados de resultados incompatibles** sobre la misma operación, no solo más o menos detallados.
- **Ningún escenario de inclusión por capa es correcto a la vez para ambos tipos de usuario.** Falta una regla de "sustitución": que la capa PRIVADO reemplace a la OPERATIVO para quien tiene permiso, como ya hace el módulo de cobros.
- **No afecta los cobros ni el saldo de bancos.** Esos usan MovimientoFinancieroCliente y la regla de una sola realidad de dinero.
- **Se suma al tema del IVA** pendiente en D6: `capa.total` incluye IVA y gastos cobrables, así que el ingreso reconocido ya va con IVA.

## Verificación sugerida (solo lectura)

Para saber si el caso ya ocurre en datos reales, quien tenga acceso de lectura a la base puede ejecutar:

```sql
SELECT "estimacionClienteId", COUNT(*) AS capas_incluidas, SUM(total) AS suma_total
FROM estimacion_cliente_capas
WHERE estatus = 'EMITIDA' AND "incluidoEnContabilidad" = true
GROUP BY "estimacionClienteId"
HAVING COUNT(*) > 1;
```

Si devuelve filas, esos Estados de Resultados ya están duplicados para los usuarios con permiso privado.

## Preguntas para Contabilidad

1. ¿Una estimación con dos capas debe reconocer **un solo** ingreso? ¿Cuál: la PRIVADO para quien tiene permiso y la OPERATIVO para quien no lo tiene?
2. Mientras se decide, ¿se debe impedir marcar como incluidas ambas capas de la misma estimación? Sería una regla nueva.
3. ¿Se debe aplicar `Empresa.defaultInclusionContabilidad` al emitir una capa, como describe el doc 05 §3.2?
4. ¿El ingreso reconocido debe ser `total` (con IVA y gastos cobrables) o una base sin IVA? Se relaciona con D6.

---

# Lista consolidada: listo para implementar

Esto puede implementarse en cuanto lo autorices. No cambia ninguna fórmula financiera.

| Orden | ID | Descripción |
|---|---|---|
| 1 | 1.1, 1.2 | Script de pruebas con `node:test` + `tsx` y protección contra la base de producción |
| 2 | 1.3 | Exportar `calcularSaludProyecto` y `construirAlertas` sin cambiar su lógica |
| 3 | 1.T1–1.T6 | Pruebas unitarias de matriz, no exposición, salud, alertas, URL y regresión (fallan antes de la corrección) |
| 4 | 1.4 | Refactor sin cambio de comportamiento: carga de datos separada de la proyección |
| 5 | 1.5–1.8 | Bandera `incluirPrivado`: sin cálculo privado en General, sin desviación en salud ni alertas, sin borradores privados en el conteo, precios privados solo cuando corresponde |
| 6 | 3.1–3.2, 3.T1–3.T4 | Filtro por capa en facturas pendientes y con diferencia (Contabilidad), con pruebas |
| 7 | 1.10 | El dashboard usa ese filtro según la vista |
| 8 | 1.T7, 3.T5 | Integración contra PostgreSQL aislado |
| 9 | — | `npm run build`, todas las pruebas y verificación manual |

**Requieren tu confirmación antes de implementar:**
- **1.9:** momento de retirar el resumen fiscal de Inicio (ahora o junto con V2).
- **Bloque 2 (E1):** las cinco decisiones de su sección.
- **Bloque 4:** las cuatro preguntas para Contabilidad. Es solo auditoría.

---

## Anexo A — Matriz de permisos esperada

| Rol | Switch personal | Empresa habilitada | Vista pedida | Vista efectiva | Debe ser `null` o estar ausente |
|---|---|---|---|---|---|
| DIRECTOR / ADMINISTRADOR | sí | sí | privado | privado | Nada privado se anula |
| DIRECTOR / ADMINISTRADOR | sí | sí | general | general | `utilidadConsolidada`, `utilidad` y `desviacionPrivadaPP` por obra; sin alerta `desviacion`; borradores privados fuera del conteo |
| DIRECTOR / ADMINISTRADOR | alguno en no | — | cualquiera | general | Lo mismo que la fila anterior; el selector de vista no se muestra |
| SUPERVISOR | cualquiera | cualquiera | cualquiera | general | Además: `porPagar*`, `porCobrar`, `flujoDinero`, `ejecutado`, `montoContrato`, `avanceFinancieroPorcentaje`, por pagar por obra; compromisos vacíos; solo alertas operativas |
| MASTER | — | — | — | — | Lanza `SinPermisoError` |

## Anexo B — Verificación manual

1. Con un Director con permiso privado, comparar General y Privado sobre una obra con costo adelantado y una estimación con capa privada. En General no debe haber alerta de desviación, la salud no debe reflejar la desviación y no debe aparecer utilidad.
2. En DevTools, buscar los montos trampa en la respuesta RSC.
3. Apagar el switch personal y repetir.
4. Entrar como Supervisor y verificar que no aparece ningún "$".
5. En Contabilidad → Facturas, con y sin permiso privado, verificar que sin permiso no aparecen ingresos de capa privada y que con permiso las filas son las mismas que antes.

# Diseño técnico: E1 (Flujo General) y corrección de Por cobrar

**Estado:** **implementado el 9 de octubre de 2026**, con las fórmulas de la sección 2, P2 para Por cobrar Privado y la validación de saldo real de la sección 3. La protección temporal T1 se retiró al pasar las pruebas de E1.
**Fecha del diseño:** 8 de octubre de 2026.
**Código:** `lib/control-de-obra/cobro-estimacion.ts` (fórmulas puras), `lib/server/control-de-obra/financiero-cliente.ts` (rutas de cobro y pantallas de Cliente), `lib/server/dashboard.ts` (Inicio). Pruebas en `tests/cobro/` y `tests/dashboard/e1-flujo-general.test.ts`.
**Referencias:** las de tipo `archivo:línea` corresponden al código de esta fecha. Todas las cifras son ficticias.

## Decisiones aprobadas que este diseño aplica

1. Tope cronológico por estimación, con desempate determinista. Cancelaciones y correcciones recalculan el historial.
2. Las aplicaciones de fondo consumen el tope, pero nunca son entradas. Las aportaciones cuentan completas al recibirse.
3. Se reconocen los cobros OPERATIVO anteriores a la emisión de PRIVADO, sin mover ni modificar esos movimientos.
4. Nombres: "Flujo General" en vista General, con la aclaración de que se calcula a valores General y no representa necesariamente el efectivo bancario. "Flujo real" en vista Privado, con los cálculos actuales.
5. Las aportaciones de fondo se mantienen completas en General.

---

## 1. Principio único: el cobro real de una estimación

Hoy el cobro se lee de una sola capa: la PRIVADO si está emitida y, si no, la OPERATIVO (`financiero-cliente.ts:86-112`). Por eso, cuando la OPERATIVO recibió cobros antes de que se emitiera la PRIVADO, esos cobros desaparecen de Por cobrar en ambas vistas, y el sistema permite registrar más dinero del que realmente falta.

**Propuesta:** un solo concepto de cobro real por estimación, que suma los movimientos vigentes de **ambas** capas. Esto no duplica dinero: el sistema ya impide registrar el mismo depósito en dos capas, porque después de emitir la PRIVADO la OPERATIVO no acepta movimientos (`financiero-cliente.ts:892-899`, `224-231`). Los movimientos no se mueven ni se modifican: se leen tal como están, con su fecha y su capa originales.

### Definiciones (por estimación E)

| Símbolo | Significado |
|---|---|
| `OP(E)` | Total de la capa OPERATIVO emitida (no existe si no está emitida). Congelado al emitir |
| `PR(E)` | Total de la capa PRIVADO emitida (no existe si no está emitida). Congelado al emitir |
| `T(E)` | Total real: `PR(E)` si existe; si no, `OP(E)` |
| `M(E)` | Movimientos `VIGENTE` de tipo `PAGO_ESTIMACION` o `APLICACION_ESTIMACION` de **cualquiera** de las dos capas de E |
| Orden de `M(E)` | Por `fecha`, luego `createdAt`, luego `id`. Es determinista y no depende del orden en que lleguen los datos |
| `R(E)` | Cobro real total = Σ montos de `M(E)` |
| `R_k(E)` | Cobro real acumulado hasta el movimiento k, inclusive, en ese orden |

Las cancelaciones salen de `M(E)` (solo cuenta lo `VIGENTE`). Un cambio de fecha o de monto cambia el orden o los acumulados. **Todo se recalcula desde cero en cada lectura; no se guarda ningún resultado.**

---

## 2. Por cobrar (cambia cifras visibles; requiere aprobación)

| Indicador | Fórmula actual | Fórmula propuesta |
|---|---|---|
| Por cobrar General de E (si `OP(E)` existe) | Con PRIVADO emitida: `OP − min(Σ movimientos de la capa PRIVADO, OP)`. Sin PRIVADO: `OP − Σ movimientos de la capa OPERATIVO` | `OP − min(R, OP)` |
| Por cobrar Privado de E (si `PR(E)` existe) | `PR − Σ movimientos de la capa PRIVADO` | `PR − min(R, PR)` |
| Composición (aplicado de fondo / pago directo) | Reparto proporcional sobre los movimientos de una capa | Mismo reparto proporcional, sobre los movimientos de ambas capas |
| Estado (Pendiente / Parcial / Cubierta) | Según el pendiente de una capa | Según el pendiente propuesto |

**Cuándo cambia la cifra:** solo en estimaciones con cobros en la capa OPERATIVO y la capa PRIVADO emitida (el caso 3). En los demás casos ambas fórmulas dan exactamente lo mismo:
- **Sin capa PRIVADO:** `R` = movimientos de la OPERATIVO, y cada cobro ya se validó contra su saldo.
- **Con PRIVADO y sin cobros en OPERATIVO:** `R` = movimientos de la PRIVADO.

**Sobrecobro histórico.** Si datos existentes ya tienen `R(E) > T(E)` (dinero registrado de más en el caso 3), Por cobrar queda en 0. El excedente se reporta con la consulta de la sección 7. **No se corrige ningún dato.**

### Decisión pendiente P

En vista Privado, hoy Por cobrar solo recorre capas PRIVADO, así que una estimación sin capa privada no aparece.

| Opción | Qué hace | Efecto |
|---|---|---|
| **P1** | Mantener el alcance actual (solo estimaciones con PRIVADO emitida) | Solo cambia el caso 3 |
| **P2** | Incluir todas las estimaciones con su total real `T(E)` | El Por cobrar Privado sube en las obras sin capa privada. Es más completo |

**Recomendación:** P2, porque Por cobrar Privado pasa a representar todo el dinero pendiente real. Cambia una cifra visible, así que requiere aprobación explícita. En V2, Privado no muestra Por cobrar; la diferencia solo se ve en el Inicio actual.

---

## 3. Validación de nuevos cobros (regla que se ajusta; requiere aprobación)

**Hoy:** el saldo disponible se calcula solo con los movimientos de la capa donde se registra (`financiero-cliente.ts:901-911`, `1062-1076`, `158-162`).

**Propuesta:** `saldo real = T(E) − R(E)`, con los movimientos de ambas capas, en:

- `registrarPagoEstimacion`
- `editarMontoPagoEstimacion` (excluyendo el movimiento que se edita)
- `aplicarFondoAEstimacionTx`

**Efecto:** solo cambia en el caso 3, donde hoy permite registrar más dinero del que realmente falta. En los demás casos el saldo es idéntico. Nunca exige cancelar ni volver a registrar cobros existentes.

---

## 4. E1: Flujo General

Para cada estimación E con `OP(E)` emitida, y para el movimiento k de `M(E)` en orden:

- **Avance General del movimiento:** `G_k = min(R_k, OP) − min(R_{k−1}, OP)`, con `R_0 = 0`.
- **Entrada General del movimiento:** `G_k` si es `PAGO_ESTIMACION`; **0** si es `APLICACION_ESTIMACION`. La aplicación sí consume el tope, pero nunca es entrada.

Además:
- **Estimación sin OPERATIVO emitida** (solo PRIVADO): no genera entradas General, porque General no conoce esa estimación. Es consistente con Por cobrar General, que tampoco la incluye.
- **`APORTACION_FONDO`:** entrada General completa en su fecha (decisión 5).
- **`PAGO_ESTIMACION` sin capa** (registros antiguos, si existen): entrada General completa en su fecha, igual que el criterio de Contabilidad.

**Flujo General del periodo:**
- Entradas = Σ entradas General de movimientos con fecha en el periodo + Σ aportaciones en el periodo.
- Neto = Entradas General − Pagos de obra (sin cambio).

**Flujo real (vista Privado):** la fórmula actual sin cambios. Entradas = Σ `PAGO_ESTIMACION` + Σ `APORTACION_FONDO` del periodo.

**Visibilidad:**
- Vista General, para todos los niveles completos: Flujo General. Al implementar E1 se retira T1, porque ya no hay nada privado que proteger.
- Vista Privado: Flujo real.
- Supervisor: sin flujo, como hoy.

### Invariantes (se prueban)

| # | Invariante |
|---|---|
| I1 | Para toda E con `OP` y todo k: `Σ_{j≤k} G_j = min(R_k, OP)`. El tope se consume **en conjunto** entre pagos y aplicaciones |
| I2 | Al final de E: Σ entradas General atribuidas + Σ aplicaciones atribuidas = `OP − Por cobrar General(E)`. Cuadra con Por cobrar |
| I3 | Ninguna entrada General de un movimiento supera su monto real; ninguna aplicación genera entrada |
| I4 | Cada movimiento se cuenta a lo más una vez; cada aportación exactamente una vez |
| I5 | Ninguna entrada General revela un monto mayor a `OP(E)` |
| I6 | Mismo resultado sin importar el orden de los datos de entrada |
| I7 | Sin capa PRIVADO y sin caso 3: entradas y Por cobrar idénticos a los de hoy (regresión) |

---

## 5. Ejemplos

Salvo que se indique otra cosa: **OP = $980,000.00 y PR = $1,150,000.00**.

### A. Cobros parciales con ambas capas (sin caso 3)

Pagos en PRIVADO: $500,000 (15 sep), $400,000 (29 sep) y $250,000 (6 oct).

| Movimiento | R acumulado | Entrada General | Entrada real | Por cobrar General | Por cobrar Privado |
|---|---|---|---|---|---|
| 15 sep, pago $500,000 | $500,000 | $500,000 | $500,000 | $480,000 | $650,000 |
| 29 sep, pago $400,000 | $900,000 | $400,000 | $400,000 | $80,000 | $250,000 |
| 6 oct, pago $250,000 | $1,150,000 | **$80,000** | $250,000 | $0 | $0 |

Por cobrar es igual al de hoy (I7). Las entradas General suman $980,000 y las reales $1,150,000.

### B. Aplicación de fondo antes del pago

Aportación de $300,000 (1 sep), aplicación de $300,000 sobre PRIVADO (15 sep) y pago de $850,000 sobre PRIVADO (29 sep).

| Movimiento | R | G_k | Entrada General | Entrada real |
|---|---|---|---|---|
| 1 sep, aportación | — | — | $300,000 | $300,000 |
| 15 sep, aplicación | $300,000 | $300,000 | $0 | $0 |
| 29 sep, pago | $1,150,000 | $680,000 | $680,000 | $850,000 |

- Entradas General: $980,000. Entradas reales: $1,150,000. Ningún monto se cuenta dos veces.
- Por cobrar General y Privado: $0.

### C. Pago antes de la aplicación

Aportación de $300,000 (1 sep), pago de $850,000 sobre PRIVADO (15 sep) y aplicación de $300,000 sobre PRIVADO (29 sep).

| Movimiento | R | G_k | Entrada General |
|---|---|---|---|
| 1 sep, aportación | — | — | $300,000 |
| 15 sep, pago | $850,000 | $850,000 | $850,000 |
| 29 sep, aplicación | $1,150,000 | $130,000 | $0 |

- El tope se consume en conjunto: $850,000 + $130,000 = $980,000 (I1).
- Entradas General: $1,150,000, igual a las reales. Cada cifra es efectivo real y ningún pago supera `OP`, así que no se revela el precio privado. Es el caso que se aceptó en la decisión 2.

### D. Cambio de fecha (recalcula el historial)

Partiendo de A, el pago de $250,000 se corrige del 6 de octubre al 10 de septiembre. Nuevo orden: $250,000 (10 sep), $500,000 (15 sep), $400,000 (29 sep).

| Movimiento | R | Entrada General |
|---|---|---|
| 10 sep, pago $250,000 | $250,000 | $250,000 |
| 15 sep, pago $500,000 | $750,000 | $500,000 |
| 29 sep, pago $400,000 | $1,150,000 | $230,000 |

- Por mes: septiembre pasa de $900,000 a **$980,000** y octubre pasa de $80,000 a **$0**.
- El total no cambia; cambia el periodo en que se reconoce.

### E. Cancelación (recalcula el historial)

Partiendo de A, se cancela el pago del 15 de septiembre. Quedan $400,000 (29 sep) y $250,000 (6 oct): R = $400,000 y luego $650,000; no se alcanza el tope.

| | Antes | Después |
|---|---|---|
| Entrada General de octubre | $80,000 | **$250,000** |
| Por cobrar General | $0 | $330,000 |
| Por cobrar Privado | $0 | $500,000 |

### F. Cobro en OPERATIVO antes de emitir PRIVADO (caso 3)

La OPERATIVO se emite el 1 de septiembre. Se cobran $300,000 sobre OPERATIVO el 8 de septiembre, mientras la PRIVADO sigue en borrador. La PRIVADO se emite el 20 de septiembre. Después se cobran sobre PRIVADO $600,000 (29 sep) y $250,000 (6 oct).

| Movimiento (capa) | R | Entrada General | Entrada real |
|---|---|---|---|
| 8 sep, $300,000 (OPERATIVO) | $300,000 | $300,000 | $300,000 |
| 29 sep, $600,000 (PRIVADO) | $900,000 | $600,000 | $600,000 |
| 6 oct, $250,000 (PRIVADO) | $1,150,000 | $80,000 | $250,000 |

| Cifra | Hoy | Propuesta |
|---|---|---|
| Por cobrar General | $130,000 (ignora el cobro del 8 de septiembre) | **$0** |
| Por cobrar Privado | $300,000 (ignora el cobro del 8 de septiembre) | **$0** |
| Saldo permitido para el pago del 6 de octubre | $550,000 (permitiría cobrar $300,000 de más) | **$250,000** (exacto) |
| Estado en Control de obra (Cliente / Cliente Priv.) | Parcial / Parcial | Cubierta / Cubierta |

El cobro del 8 de septiembre conserva su capa, su fecha y su trazabilidad. Solo se lee.

### G. Solo capa PRIVADO emitida (la OPERATIVO sigue en borrador)

Pago de $400,000 sobre PRIVADO.
- **General:** sin entrada, porque la estimación no existe en General. Hoy la Vista General muestra esos $400,000.
- **Privado:** Por cobrar de $750,000. Flujo real de $400,000.

### H. Sin capa privada (regresión)

OP de $300,000 y pago de $100,000.
- Entrada General: $100,000. Por cobrar General: $200,000. Ambas cifras son iguales a las de hoy.
- Por cobrar Privado: excluida con P1, $200,000 con P2.

---

## 6. Alcance de los cambios de código (cuando se apruebe)

| Pieza | Cambio | Pantallas que cambian (solo en el caso 3, salvo lo indicado) |
|---|---|---|
| `calcularFinancieroCapaEstimacion` (`financiero-cliente.ts:86`) | Recibe los movimientos de ambas capas y calcula con `R(E)` | Control de obra: historial y Control contractual de Cliente y Cliente Priv. Inicio: Por cobrar |
| `obtenerHistorialEstimacionesCliente`, `obtenerControlContractual` | Cargar los movimientos de ambas capas, respetando el corte histórico vigente (`createdAt ≤ fechaCorte`) | Igual que la fila anterior |
| `registrarPagoEstimacion`, `editarMontoPagoEstimacion`, `aplicarFondoAEstimacionTx` | Saldo real `T − R` | Validación al registrar o editar cobros |
| Nueva función pura `atribuirCobrosGeneral(estimaciones, movimientos)` | Calcula `G_k` y las entradas General por movimiento | Inicio: Flujo General |
| `proyectarResumenEjecutivo` | Vista General: Flujo General y retiro de T1. Vista Privado: Flujo real. Por cobrar con la fórmula nueva | Inicio |
| `inicio-view.tsx` | Etiquetas "Flujo General" (con aclaración) y "Flujo real" | Inicio |

**No cambian:** Estado de Resultados, Contabilidad (ingresos y facturas), Reporte General, liquidaciones, datos existentes y esquema. No hay migraciones.

---

## 7. Detección de casos existentes (solo lectura, sin modificar datos)

Requieren un entorno de consulta seguro de solo lectura. Devuelven solo conteos.

**Caso 3: estimaciones con cobros en OPERATIVO y capa PRIVADO emitida**

```sql
SELECT COUNT(DISTINCT op."estimacionClienteId")
FROM estimacion_cliente_capas op
JOIN estimacion_cliente_capas pr ON pr."estimacionClienteId" = op."estimacionClienteId"
  AND pr.capa = 'PRIVADO' AND pr.estatus = 'EMITIDA'
JOIN movimientos_financieros_cliente m ON m."estimacionClienteCapaId" = op.id AND m.estatus = 'VIGENTE'
WHERE op.capa = 'OPERATIVO';
```

**Sobrecobro: cobro real mayor que el total real**

```sql
WITH r AS (
  SELECT c."estimacionClienteId" AS e, SUM(m.monto) AS cobrado
  FROM movimientos_financieros_cliente m
  JOIN estimacion_cliente_capas c ON c.id = m."estimacionClienteCapaId"
  WHERE m.estatus = 'VIGENTE' AND m.tipo IN ('PAGO_ESTIMACION', 'APLICACION_ESTIMACION')
  GROUP BY 1
), t AS (
  SELECT "estimacionClienteId" AS e,
         MAX(CASE WHEN capa = 'PRIVADO' THEN total END) AS pr,
         MAX(CASE WHEN capa = 'OPERATIVO' THEN total END) AS op
  FROM estimacion_cliente_capas WHERE estatus = 'EMITIDA' GROUP BY 1
)
SELECT COUNT(*) FROM r JOIN t USING (e) WHERE r.cobrado > COALESCE(t.pr, t.op) + 0.005;
```

**Pagos sin capa (registros antiguos)**

```sql
SELECT COUNT(*) FROM movimientos_financieros_cliente
WHERE tipo = 'PAGO_ESTIMACION' AND "estimacionClienteCapaId" IS NULL AND estatus = 'VIGENTE';
```

---

## 8. Pruebas de regresión y de no exposición

Todas son unitarias, sin base de datos, con `node:test`, y usan las cifras de la sección 5.

| # | Prueba | Resultado esperado |
|---|---|---|
| R1 | Ejemplo A | Entradas General 500/400/80 · Por cobrar G 480/80/0 · Por cobrar P 650/250/0 · **Por cobrar igual al actual** |
| R2 | Ejemplo B | Entradas General: 300 (aportación) + 680 · aplicación = 0 · Por cobrar 0/0 |
| R3 | Ejemplo C | G_k 850 + 130 = 980 · entradas General 300 + 850 |
| R4 | Ejemplo D | Septiembre 980 / octubre 0, antes 900 / 80 |
| R5 | Ejemplo E | Octubre 250 · Por cobrar G 330 · P 500 |
| R6 | Ejemplo F | Entradas 300/600/80 · Por cobrar G y P = 0 · saldo de validación = 250 |
| R7 | Ejemplo G | Sin entrada General · Por cobrar P 750 |
| R8 | Ejemplo H | Entrada 100 · Por cobrar G 200, **igual al actual** |
| R9 | Invariantes I1–I6 sobre 500 escenarios aleatorios con semilla fija | Se cumplen en todos |
| R10 | Regresión global | En el escenario actual de `tests/helpers/datos-dashboard.ts` (sin caso 3): Por cobrar G 680,000 y P 650,000 sin cambio |
| R11 | Desempate | Dos cobros con la misma fecha: el orden por `createdAt` y luego por `id` da el mismo resultado al barajar la entrada |
| R12 | Cancelados | Un movimiento cancelado nunca cuenta, aunque sea el primero |
| R13 | No exposición | En vista General, la respuesta serializada no contiene el excedente privado ni montos de entrada mayores a `OP` |
| R14 | Validación | Caso 3: registrar $250,001 se rechaza y $250,000 se acepta. Sin caso 3: mismos límites que hoy |
| R15 | Pantallas de Control de obra | Historial y Control contractual: estado y pendiente iguales a los de hoy salvo en el caso 3, donde quedan como en el ejemplo F |

---

## 9. Orden de implementación propuesto

1. Ejecutar las consultas de la sección 7 en un entorno seguro, si existe, para conocer el alcance real.
2. Función pura `R(E)` y `atribuirCobrosGeneral`, con R1–R13.
3. `calcularFinancieroCapaEstimacion` y sus llamadores (Por cobrar), con R15.
4. Validaciones de saldo real (R14).
5. Inicio: Flujo General / Flujo real, retiro de T1 y etiquetas.
6. Build, pruebas y verificación manual.

## 10. Decisiones que faltan para implementar

1. Aprobar las fórmulas de Por cobrar de la sección 2. Cambian cifras visibles en el caso 3, tanto en Inicio como en Control de obra.
2. Decisión P: P1 o P2 para el Por cobrar Privado.
3. Aprobar el ajuste de validación de la sección 3. Es una regla de negocio más estricta, que solo cambia en el caso 3.
4. Si la consulta de sobrecobro devuelve casos: cómo mostrarlos. Por ejemplo, un aviso "cobrado de más" en Control de obra, sin modificar datos.

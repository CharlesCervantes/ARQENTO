# Documentación de Proceso — Módulo "Reporte General"
**Grupo Conkuali — Sistema de Administración de Pagos Semanales**
Versión 1.0 — para revisión de Charles antes de diseño técnico

> **Nota de arquitectura (ver `/docs/arquitectura/00-decisiones-fundamentales.md`):**
> el sistema es multi-tenant desde el día 1. Todas las entidades descritas aquí
> (Proyecto, Beneficiario, Movimiento Semanal, etc.) pertenecen a una Empresa.
> Conkuali es la primera empresa (tenant), no un caso especial.
>
> **Versión 2 de esta sección (revisada en sesión de diseño técnico, agosto 2026):**
> el modelo de datos se refinó respecto a la v1 de este documento — ver sección 2.
> Implementado en `prisma/schema.prisma`.

---

## 1. Propósito del módulo

Digitalizar el "Reporte General" que hoy vive en Excel: el registro semanal de pagos
(contratistas, proveedores/servicios y administración/sueldos) por proyecto, con su
resumen consolidado, evitando la mezcla actual de datos y comentarios en una sola celda.

---

## 2. Entidades principales

### 2.1 Proyecto (Obra)

| Campo | Descripción |
|---|---|
| Nombre | Ej. MISSISSIPPI, VILLAS HERRADURA |
| Tipo | `Formal` / `Momentánea` (reporte simplificado del supervisor) / `Oficina` (partición de gastos administrativos generales — no es una obra real, pero entra al Reporte General igual que una obra) |
| Estatus | `Activo` / `Pausado` / `Cerrado` / `Cancelado` |
| Fecha de inicio / cierre | Para historial |

**Reglas de estatus (confirmadas por Charles):**
- **Activo** → visible en la vista principal, opera con normalidad.
- **Pausado** → sigue visible igual que un activo, pero marcado visualmente como pausado. Se **detiene** la generación automática de renglones semanales hasta reactivarse.
- **Cerrado** → pasa a un histórico; se puede seguir consultando pero ya no aparece en la vista operativa del día a día.
- **Cancelado** → estatus adicional para proyectos que no se concluyeron (distinto de "cerrado" porque cerrado implica que sí se terminó).

---

### 2.2 Beneficiario — identidad única de a quién se le paga

Unifica Contratista/Proveedor/Administración en un solo concepto para evitar duplicar
a la misma persona o empresa varias veces. Todo Beneficiario tiene un **tipo**
(`Contratista` / `Proveedor` / `Administración`) que determina cómo aparece organizado
en el Reporte General.

No tiene relación con `Usuario` (login del sistema) — son conceptos independientes
aunque correspondan a la misma persona real (ej. Charles inicia sesión como Usuario,
pero cobra sueldo como Beneficiario tipo Administración).

- **Proveedor** (datos que no cambian de una obra a otra): Giro, Vendedor, Teléfono,
  Crédito y Cuenta bancaria — estos dos últimos **solo informativos, no afectan
  cálculos** (confirmado).
- **Administración** (datos biográficos): N.S.S., fecha de nacimiento.

---

### 2.3 Participación del Beneficiario en un Proyecto — *pieza clave del rediseño*

Un mismo Beneficiario puede participar en **varias obras a la vez**, cada una con su
propio contrato/puesto/saldo — nunca se mezclan salvo que se pida explícitamente un
total global. Aquí vive todo lo que depende de la combinación beneficiario+obra:

| Campo | Aplica a | Descripción |
|---|---|---|
| Concepto / especialidad | Contratista | Ej. "Obra Civil", "Electricidad" |
| Contrato | Contratista | Monto total contratado en **esa** obra |
| Puesto | Administración | Puede variar según la obra asignada |
| Sueldo / Sueldo variable | Administración | — |
| Fecha de ingreso | Administración | A esa obra específica |

Para un contratista:
- **Monto contractual vigente** = Contrato + Aditivas autorizadas (ver 2.4) **de esa obra**
- **Pagado** = acumulado de Movimientos Semanales `Aprobados` **de esa obra** (no manual)
- **Saldo** = Monto contractual vigente − Pagado, **por obra**

Una vista "global" del beneficiario (ej. "cuánto se le debe a Juan sumando todas sus
obras") se calcula sumando todas sus participaciones — no es un campo guardado.

---

### 2.4 Aditivas

Trabajo fuera del alcance contratado original. Pertenecen a la participación del
beneficiario en un proyecto específico (no al beneficiario en general), porque el
mismo contratista puede tener aditivas distintas en cada obra.

**Flujo confirmado:** el Supervisor (Andrés) la solicita → el Director (Sergio) debe
autorizarla → **solo una aditiva autorizada aumenta el monto contractual vigente**.
Se conserva historial completo (monto, descripción, quién la solicitó, quién la
autorizó, fechas) — nunca se convierte en un número editable a mano sobre el contrato.

*(Nota: la mecánica de precio unitario/cantidad y su relación con la versión privada
de Control de Obra se resuelve en ese módulo, no aquí — ver sección 7.)*

---

### 2.5 Semana

Compartida por todas las obras de la empresa — el ciclo semanal de pagos es a nivel
compañía, no por proyecto.

| Campo | Descripción |
|---|---|
| Número / Año | Ej. Semana 32, 2026 |
| Fecha inicio / fin | |
| Estado | `Abierta` / `Cerrada` |

---

### 2.6 Movimiento Semanal — *rediseño clave*

Aplica a Contratista, Proveedor y Administración por igual, vía la participación del
beneficiario en el proyecto (2.3). **Reemplaza la columna ambigua "Comentario y/o
Estimación" del Excel actual**, separando el reporte de gasto real de las notas de
contexto. Único por participación+semana — nunca se duplica un registro, siempre se
edita el existente.

| Campo | Descripción |
|---|---|
| Semana | Referencia a la semana correspondiente |
| Monto entre semana / fin de semana | Los importes reales |
| **Estado de aprobación** | `Pendiente de validación` / `Aprobado` / `Rechazado` / `Pospuesto a siguiente semana` / `Cancelado` — el flujo de "¿esto ya es oficial?" |
| **Estado de pago** | `Sin movimiento` (Neutral) / `Pendiente de pago` (Rojo) / `Pagado puente` (Naranja) / `Liquidado` (Verde) — el color del Reporte General (`02-control-de-obra.md`). Solo aplica una vez que el estado de aprobación es `Aprobado` |
| Cubierto por fondo puente | Sí/No + quién lo puso (Sergio, o fondos de la empresa) — bandera para el futuro módulo de Préstamos/Reposiciones; se conserva aunque el movimiento ya esté `Liquidado` |
| Enviado por | Usuario |
| Aprobado por | Usuario |
| Fechas de envío / aprobación | |

**Estos dos estados van separados a propósito — no se mezclan en un solo campo:**

**Flujo de aprobación (confirmado):**
- Lo captura el **Supervisor** (Andrés) → nace `Pendiente de validación`. **No entra a
  ningún total oficial del Reporte General hasta que se apruebe.**
- Lo captura directamente el **Administrador** (Charles) o el **Director** (Sergio) →
  nace ya `Aprobado`, porque son quienes validan y administran el Reporte General.

Todos los totales (pagado, saldo, resumen semanal, resumen por obra) se calculan
**solo con movimientos en estado de aprobación `Aprobado`**.

### 2.7 Comentarios (separado del monto)

Hilo de notas libres, ligado a un movimiento semanal. Cualquier usuario autorizado
puede dejar contexto sin que se confunda con el monto a pagar (esto es justo lo que
hoy resuelves metiendo texto libre en la misma celda del importe).

### 2.8 Bitácora / Auditoría

Todo movimiento (creación, edición, aprobación, rechazo, cambio de estatus de
proyecto) queda registrado: quién, cuándo, qué cambió, valor anterior → nuevo.
*(Ya establecido como requisito no negociable en sesiones anteriores; implementado
como tabla genérica `RegistroAuditoria`, reutilizable por cualquier módulo.)*

---

## 3. Vista resumen (Reporte General / Dashboard)

Igual que en el Excel actual:
- **Resumen General**: total de la semana en curso a nivel compañía.
- **Resumen Desglosado**: total por proyecto, separado por Entre Semana / Fin de Semana.

Este resumen se calcula automáticamente a partir de los Movimientos Semanales en
estado de aprobación `Aprobado` — ya no se captura manualmente como en el Excel.

**Noviembre 2026 (pantalla):**
- Ya no se muestra «Entre semana» (ni tarjeta ni columnas). Nunca se usó: todo movimiento tenía $0 ahí. El dato se conserva y el Total semana lo sigue sumando.
- En Contratistas, «Concepto» muestra «Ver concepto». Al hacer clic se ven los conceptos del contrato del contratista en esa obra (cantidad, unidad e importe). Un beneficiario antiguo sin contrato por conceptos muestra su texto de concepto.
- Columna «Recibo», a la derecha de «Fin de semana»: si el movimiento viene de un corte de contratista, ofrece «Descargar» el recibo vigente o «Generar» si todavía no existe. Es el mismo recibo de Contratistas → Expediente (folio, datos congelados y bitácora). Solo Administrador y Director.

---

## 4. Reglas de negocio confirmadas (acumuladas de sesiones anteriores + esta sesión)

1. Los montos pueden cambiar entre la estimación inicial (lunes) y el pago final (viernes).
2. Los pagos recurrentes generan renglones semanales automáticos con **monto en blanco**.
3. Los renglones no pagados pueden pasar a la siguiente semana o cancelarse — nunca se eliminan.
4. Toda acción queda en bitácora.
5. Cada contratista está ligado a un expediente de cotización/contrato con su monto total y alcance (proceso a documentar en sesión aparte).
6. Los "extras" (trabajo fuera de alcance) se registran como Aditivas, separado del contrato base.
7. Roles genéricos: "Supervisor" (hoy Andrés) puede reportar gastos con evidencia en sus proyectos asignados, pero no captura ni modifica montos directamente — los sube como propuesta y Charles valida.
8. Proyecto tiene 4 estatus posibles: Activo, Pausado, Cerrado, Cancelado, con las reglas de visibilidad descritas en 2.1.
9. El campo de comentario libre se separa del reporte real de gasto (sección 2.6 y 2.7).
10. Los campos "Crédito" y "Cuenta bancaria" de Proveedores son solo informativos.
11. Un mismo Beneficiario puede participar en varias obras a la vez; su saldo/pagado siempre es por obra, no se mezcla salvo un total global explícito (sección 2.3).
12. El estado de aprobación (flujo interno) y el estado de pago (color del Reporte General) son dos campos independientes — nunca se mezclan (sección 2.6).
13. Un movimiento capturado directamente por Administrador o Director nace `Aprobado`; uno capturado por Supervisor nace `Pendiente de validación` y no cuenta en los totales hasta aprobarse.
14. "Oficina" (gastos administrativos generales) se maneja como un Proyecto más (`tipo = Oficina`), no como un caso especial aparte.

---

## 5. Pendientes / preguntas abiertas antes de diseño final

- [x] Comportamiento exacto de generación automática de renglones cuando un proyecto está `Pausado`: se detiene; requiere reactivación explícita a `Activo` para reanudar (ver sección 2.1).
- [x] ¿Quién puede confirmar movimientos además de Charles? **Tanto Charles como Sergio pueden confirmar/rechazar movimientos.**
- [x] Relación Beneficiario ↔ Proyecto: resuelta vía `BeneficiarioProyecto` (sección 2.3), permite múltiples participaciones sin duplicar al beneficiario.
- [x] Separación entre estado de aprobación y estado de pago: resuelta (sección 2.6).
- [ ] Matriz de permisos completa por rol (Supervisor / Administrador / Director / Master) sobre cada entidad: crear, editar, confirmar, cancelar, ver histórico. Jerarquía tentativa documentada en `/docs/arquitectura/00-decisiones-fundamentales.md` (sección Roles) — falta detallar permiso por permiso.
- [ ] Proceso de cotización/contrato de contratistas — sesión aparte ya agendada.
- [ ] Módulo de Préstamos/Reposiciones (a quién y cuánto se le debe reponer por pagos con fondo puente) — el Reporte General solo deja la bandera lista (sección 2.6), el módulo en sí se diseña después.

---

## 6. Fuera de alcance en esta etapa (Reporte General)

No se implementa todavía, aunque el modelo de datos no lo bloquea a futuro:
- Sincronización entre la versión supervisor y la versión privada de **Control de Obra**
  (precios unitarios reales, conceptos exclusivamente privados de Sergio, revisión de
  aditivas con ajuste de precio). Esto es un módulo aparte.
- Migración del histórico del Excel — se hace después de que el módulo esté funcionando,
  de forma controlada (no automática).
- Exportables (Excel/PDF) y reportes para cliente.

---

## 7. Próximos pasos

1. ~~Confirmar los pendientes de la sección 5~~ — permisos detallados y cotización de
   contratistas quedan para sesión aparte; no bloquean el Reporte General.
2. ~~Construir módulo de Usuarios / Inicio de sesión~~ — hecho.
3. Construir módulo **Reporte General** por etapas (base de datos → vista de una semana
   → captura/edición → histórico → catálogos → migración del Excel → exportables).

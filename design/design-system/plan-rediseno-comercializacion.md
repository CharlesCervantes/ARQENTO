# ARQENTO · Rediseño de Comercialización

Propuesta de organización y guía de implementación · 19 de noviembre de 2026

## 1. Objetivo y punto de partida

Que una persona entre, identifique su operación y registre lo que necesita sin recorrer una página extensa. Recuperar el estilo de la propuesta original: fondo gris cálido, tarjetas blancas, carbón como color principal, estados con color y acciones fáciles de encontrar.

Este documento se basa en las capturas y los reportes compartidos por Charly. No constituye una auditoría del repositorio. Es una propuesta de interfaz; no modifica acuerdos de negocio ni certifica que B8B esté terminado.

**B8B sigue en curso.** Terminarlo, verificarlo y confirmar su commit antes de modificar los mismos componentes. El último reporte terminado compartido corresponde a `d939737`, documento de negocio v0.13. Al comenzar, consultar el estado real y las instrucciones vigentes del repositorio, incluido el resultado final de B8B.

Mantener las tres pantallas principales: listado, formulario de cotización y detalle de operación. Las compras conservarán su vista existente, identificada como parte de la operación. No agregar otro menú principal para cada función.

## 2. Qué está causando la confusión

- El bloque completo de avisos desplaza el listado de operaciones fuera del primer vistazo.
- Los folios encabezan la información; la descripción, el cliente y la obra tienen poca presencia o aparecen al final.
- Aceptación, entregas, cobros, compras, gastos, resultado y cancelación están abiertos al mismo tiempo.
- Hay formularios visibles aunque la persona solo esté consultando. El de gastos ocupa gran parte de la página sin haber solicitado una captura.
- Las acciones importantes se parecen a enlaces secundarios. El PDF y los materiales quedan enterrados.
- Los textos explican muchas reglas internas en cada bloque. Las advertencias de cancelación aparecen incluso cuando nadie intenta cancelar.

## 3. Una operación, varios documentos relacionados

**Operación** será la forma de presentar el expediente completo. Se construye sobre los registros existentes; no requiere otra tabla, otro folio ni duplicar cuentas.

| Elemento | Cómo lo explicamos en pantalla | Qué conserva |
| --- | --- | --- |
| COT | Cotización al cliente | Su folio, versión, materiales, precios y estado |
| OV | Venta confirmada al cliente | La orden de venta creada al aceptar la cotización |
| COC | Compra a proveedor | Su proveedor, materiales, total, cuenta y folio propios |
| OC del cliente | Referencia del cliente | La referencia externa, si fue capturada |

Ejemplo de encabezado: **Suministro de perfiles para Torre A**. Debajo: **Constructora Norte · Torre A**, y como referencias secundarias **Venta OV-000019 · Cotización COT-000028**. En una compra: **Compra a Láminas del Norte · COC-000010**, con enlace de regreso a esa operación.

Antes de aceptar, el expediente muestra la COT. Después de aceptar, muestra la OV con su COT de origen. No crear dos filas para la misma relación aceptada. Mantener intactos los identificadores y las reglas de B3/B8B.

La acción de entrada sigue siendo **Nueva cotización**. No recuperar el texto antiguo «Nueva operación» del primer mockup.

## 4. Listado: Operaciones

Orden visual propuesto:

1. **Operaciones**, subtítulo breve y botón principal **+ Nueva cotización**.
2. Tres tarjetas: **Por cobrar**, **Por pagar**, **Entregas pendientes**. Integrar lo vencido como dato secundario visible dentro de las primeras dos; mantener cobros y pagos separados.
3. **Por atender** en una franja compacta con el resumen de vencidos y vencimientos de hoy. Un botón **Ver pendientes** abre el detalle existente en un panel. Los importes y conteos de cada categoría conservan sus reglas, paginación y ámbito.
4. Buscador, estado y **Más filtros**. Dentro de Más filtros: cliente, obra y vendedor, según permisos. Mostrar los filtros activos y permitir limpiarlos.
5. Tabla principal dentro de una tarjeta blanca.

| Columna | Contenido |
| --- | --- |
| Operación | Descripción destacada; folio y estado comercial como información secundaria |
| Cliente / obra | Nombre del cliente y obra debajo |
| Venta total | Importe de venta con la convención vigente |
| Por cobrar | Saldo y estado breve, solo para administración |
| Entrega | Pendiente, parcial o completa; «No aplica» cuando corresponda |
| Acción | Botón o enlace claramente identificable **Abrir** |

No hace falta repetir vendedor, todas las fechas y todos los folios en columnas distintas. Siguen disponibles en filtros y detalle. El buscador mantiene su alcance actual.

No ocultar canceladas o rechazadas sin un filtro visible. No crear un filtro «Terminadas» que dependa de una regla de cierre todavía inexistente. Conservar el alcance actual de los indicadores; si muestran toda la empresa y la tabla está filtrada, dejarlo claro.

**Resultado esperado:** a 1366 × 768 y zoom normal, se ven el título, la información prioritaria, los filtros y el comienzo del listado sin atravesar una tabla completa de avisos.

## 5. Detalle: tres vistas internas

El encabezado permanece reconocible al cambiar de vista: volver a Operaciones, descripción, cliente, obra, folios y estado. **Ver cotización PDF** queda arriba. **Duplicar** y las acciones de rechazo/cancelación se agrupan en **Más acciones** según las reglas y permisos existentes.

Tres vistas dentro del mismo expediente, sin agregar entradas al sidebar:

| Vista | Contenido y acciones |
| --- | --- |
| **Resumen** | Datos comerciales, total de venta, por cobrar y por pagar para administración; seguimiento de cotización, compras y entregas; materiales; pendientes concretos; acceso a aceptación y documentos; actividad desplegable |
| **Compras y entregas** | Compras relacionadas y pendiente por comprar; entregas con evidencias y pendiente por entregar; acciones **Nueva compra**, **Registrar entrega** y **Vincular compras** en su contexto |
| **Cobros y pagos** | Cobros del cliente; pagos de compras y gastos identificados por su documento; calendarios y prórrogas de B8B; gastos adicionales; resultado estimado y simulación vigente |

En **Cobros y pagos**, cada registro debe decir a quién corresponde y a qué OV, COC o gasto se aplica. Se puede usar una lista resumida de documentos y abrir su bloque actual al seleccionarlo. Evitar desplegar todos los calendarios y movimientos juntos. Mantener separados los totales por cobrar y por pagar.

En **Resumen**, mostrar los materiales de forma compacta; para listas extensas, una vista previa y **Ver todos los materiales**. La evidencia de aceptación queda accesible mediante **Ver aceptación**, sin ocupar una tarjeta completa permanente.

Un borrador o una cotización aún no aceptada conserva su edición o consulta correspondiente. No mostrar compras y cuentas como si ya existieran. El vendedor ve **Resumen** y **Entregas**, solo de sus operaciones. No recibe compras, costos, gastos, cuentas, simulaciones ni estados financieros.

## 6. Seguimiento y línea del tiempo

El resumen debe responder «¿qué está pendiente?» con estados existentes:

- **Cotización:** borrador, emitida, aceptada, rechazada o cancelada, según el estado real.
- **Compras:** pendiente, parcial o completa según cantidades confirmadas vigentes; solo administración.
- **Entregas:** pendiente, parcial o completa según cantidades entregadas vigentes.
- **Cobros y pagos:** sus saldos y situaciones se muestran por separado en las tarjetas financieras y su vista correspondiente, solo administración.

Los indicadores pueden llevar al bloque correspondiente. Son navegación; hacer clic no cambia ningún estado.

**Estos frentes pueden avanzar al mismo tiempo.** El crédito permite entregar antes de liquidar. Una entrega puede tener el origen pendiente de vincular. No imponer pasos consecutivos, bloquear una función por el orden del dibujo, mezclar unidades en un porcentaje ni marcar toda la operación como cerrada por haber entregado.

Además, incluir **Actividad** como una línea del tiempo desplegable: emisión, aceptación, compra, entrega, cobro, pago, prórroga o cancelación, cuando el evento exista y el usuario pueda verlo. Mostrar fecha, acción y responsable cuando estén registrados. Distinguir la fecha operativa de la fecha de captura si difieren.

Reutilizar los eventos existentes, sin otra tabla de eventos ni registrar la misma acción dos veces. Si construir una cronología unificada requiere trabajo adicional relevante, entregar hoy el seguimiento y los historiales existentes, y dejar explícita la cronología pendiente. No fabricar eventos o fechas para completar el dibujo.

## 7. Capturar sin perderse

- **Registrar entrega**, **Registrar cobro**, **Registrar pago**, **Agregar gasto** y **Cambiar vencimiento** abren el formulario al solicitarlo. En escritorio, panel lateral; en móvil, panel a pantalla completa. Reutilizar los formularios y validaciones actuales.
- Las cotizaciones y compras con muchas partidas mantienen su vista amplia. La compra siempre muestra la operación de origen y un regreso claro.
- Un formulario abierto tiene título, documento, destinatario cuando aplique, acción principal y Cancelar. Evitar paneles superpuestos y acciones ambiguas como «Guardar» sin contexto.
- Conservar datos ante errores, mostrar el mensaje junto a la acción y llevar el foco a él. Advertir al descartar una captura no guardada.
- Mantener todas las reglas de archivos, evidencias obligatorias y tipos permitidos. Mostrar el límite vigente donde se adjunta, sin cambiarlo en este bloque.
- Una acción bloqueada explica la causa cuando se intenta usar o junto al control. Las cancelaciones conservan motivo, consecuencias y confirmación. No ocupar el resumen con un bloque permanente de cancelación.
- Los textos largos de ayuda se convierten en una frase útil y **Ver condiciones** cuando haga falta. Mantener visibles las advertencias que afectan la decisión, como resultado incompleto o simulación que no representa dinero disponible.

## 8. Dirección visual

Referencia principal: el mockup original de Operaciones compartido por Charly. Las capturas actuales sirven para inventariar funciones y estados.

| Elemento | Propuesta |
| --- | --- |
| Fondo | Gris cálido suave, por ejemplo `#F1EFED` |
| Superficies | Blanco, esquinas de 18–24 px y sombra ligera |
| Primario | Carbón `#222629`, botones sólidos con texto blanco |
| Texto | Carbón; secundario gris legible, evitando textos tenues para acciones |
| Marca | Logo configurado de la empresa; acento dorado discreto cuando corresponda a su identidad |
| Estados | Verde completado; ámbar parcial/pendiente de atención; azul información; rojo vencido, error o acción destructiva; siempre con texto |
| Tipografía | La familia existente; título de página aproximadamente 28–32 px, secciones 18–20 px, contenido 14–16 px |
| Acciones | Botones con texto e icono, altura objetivo de 44 px para acciones principales; foco visible |
| Espaciado | 24 px entre bloques principales, 16–24 px interiores; adaptar a móvil |

Aplicar los estilos dentro del módulo y reutilizar componentes existentes. Evitar una librería nueva o cambios globales de estilos que alteren construcción. Mantener el sidebar actual y su filtrado real por módulos; una empresa con varios módulos debe conservarlos. No fijar el logo de Conkuali para todas las empresas. Revisar el uso del logo configurado antes de tratar el fallback «GC» como un problema de diseño.

## 9. Reglas que el rediseño debe conservar

- Administración: Administrador y Director. Vendedor: Supervisor con marca, solo sus cotizaciones y ventas. Mantener autorización en el servidor, también para documentos e historiales; esconder una sección con CSS no sustituye el permiso.
- Solo administración modifica precios de venta. El catálogo y los documentos mantienen sus copias históricas, cálculos exactos y estados.
- Compras nuevas: **Sin IVA** e **IVA 16 %**, conservando la interpretación interna y los tratamientos históricos implementados. No extender ese cambio a ventas, catálogo o gastos.
- Mensualidades automáticas **3, 6, 12, 18 y 24 meses** solo para crédito de compras a proveedor; alternativa manual; sin intereses; cálculo del servidor y diferencia en última cuota. Con movimientos, no regenerar calendarios. Aplicar únicamente la prórroga individual que termine autorizando B8B.
- Crédito del cliente, pagos parciales, anticipos dentro de documento y asignaciones a cuotas conservan sus reglas. No añadir saldos a favor, pagos entre varios documentos ni movimientos ficticios.
- Avisos internos: mismas fuentes, zona horaria y ventana de tres días. No agregar WhatsApp, correo, cron ni una fuente paralela de saldos.
- Entrega, compra, vínculo de surtido y pago conservan significados independientes. No inferir proveedor ni convertir una entrega en recepción de inventario.
- Resultado: venta sin IVA menos compras y gastos vigentes sin IVA; incompleto si faltan compras. Simulación 50/50 solo bajo las reglas existentes. No generar repartos reales.
- Conservar anulaciones, auditoría, idempotencia, control de conflictos y bloqueos de B8B. Una reorganización visual no habilita una corrección antes prohibida.
- Respetar los enlaces actuales de avisos hacia `#cobros`, `#pagos` y documentos. Si el destino queda dentro de una vista o panel cerrado, abrirlo automáticamente y llevar al bloque correcto. Conservar Atrás, Recargar, filtros y enlaces directos.

## 10. Orden de ejecución para hoy

**Primero: cerrar B8B.** Registrar su commit y estado real, sin mezclar cambios visuales mientras todavía se prueban sus reglas.

**Después: listado y estructura del detalle.** Recuperar los estilos comunes, tres indicadores del listado, avisos compactos, encabezado de operación y tres vistas internas. Reutilizar servicios y cálculos.

**Luego: acciones y formularios.** Pasar las capturas cortas a paneles, dar contexto a las compras, simplificar ayudas, colocar PDF y acciones visibles. Aplicar los mismos controles al formulario de cotización sin rehacer su lógica.

**Al final: verificación de recorridos.** Probar escritorio y móvil, permisos, enlaces de avisos y conservación de datos. Capturar antes/después con los mismos registros. No usar el cumplimiento de tests como sustituto de mirar las pantallas.

Para mantener el alcance de hoy, priorizar listado, detalle, entrega, cobro y compra. La cronología unificada y el refinamiento de catálogos quedan después si requieren desarrollo adicional. El uso desde móvil y la legibilidad de acciones forman parte del objetivo; no tratarlos como decoración opcional.

No es una promesa de duración: el esfuerzo depende del estado final de B8B y de cómo estén separados los componentes. Si aparece una dependencia funcional nueva, identificarla y continuar con los cambios de presentación que sí sean independientes.

## 11. Verificación y criterio de entrega

- Listado: en laptop se ve el comienzo de las operaciones; pendientes urgentes siguen visibles y su detalle es accesible.
- Detalle: al entrar se entiende qué se vende, a quién, en qué obra y qué está pendiente. Folios y documentos se distinguen sin conocer sus siglas.
- Cotización: crear, emitir, aceptar y abrir su operación sin duplicar filas ni perder referencias.
- Administración: abrir una compra, registrar pago y regresar a su operación; registrar entrega, vincular surtido, agregar gasto, registrar cobro y cambiar vencimiento conforme a B8B.
- Vendedor: solo sus registros, precios de solo lectura, entregas con evidencias; datos financieros y compras ausentes también del payload y de la actividad.
- Rechazo, cancelación, anulación y conflictos: mismos permisos y bloqueos que antes. Mantener las explicaciones útiles al intentar la acción.
- Después de cada mutación: cifras y avisos se actualizan. Entrar desde un aviso abre el destino correcto; Atrás conserva el contexto.
- Formulario con error: no borra cantidades ni texto; archivos y límites se comportan conforme a las reglas vigentes.
- Comprobar 1440, 1366, 1280 y 390 px. No admitir desbordes de página; una tabla amplia puede tener desplazamiento contenido. En móvil: navegación, paneles, teclado y selección de archivos utilizables.
- Documentar por separado una prueba en teléfono real y una emulación: no afirmar que se verificó cámara/carga móvil real si solo se cambió el tamaño de la ventana.
- Ejecutar lint, tipos, build y regresiones pertinentes con el mecanismo del repo; no agregar tests que solo comparen clases CSS. Atender cualquier regresión funcional.
- Entregar commit(s), archivos relevantes, capturas, pruebas y pendientes precisos. Mantener el trabajo local, sin push, merge ni despliegue en este bloque.

## 12. Prompt breve para acompañar este documento y las imágenes

```text
Cuando B8B esté terminado, verificado y confirmado, implementa el rediseño de Comercialización descrito en plan-rediseno-comercializacion.md.

Primero lee las instrucciones del repositorio y comercializacion.md vigentes. Verifica el commit y el estado de B8B; no mezcles el rediseño con su trabajo pendiente ni reviertas reglas para adaptar la interfaz.

Usa la primera imagen, el mockup original, como referencia de estilo. Usa las capturas actuales como inventario de lo que ya funciona. La dirección propuesta es: Operaciones como expediente, botón Nueva cotización, listado como contenido principal, avisos compactos y detalle con Resumen / Compras y entregas / Cobros y pagos. Para vendedor, solo su Resumen y Entregas. Sigue las reglas del documento sobre permisos y estados independientes.

Conserva cálculos, servicios, folios, estados, historial y restricciones existentes. No introduzcas tablas ni migraciones para representar una operación o su avance. Si necesitas una consulta de lectura para el resumen, reutiliza las fuentes autorizadas y evita duplicar cálculos de negocio. No cambies construcción, el sidebar global ni las reglas de acceso.

Implementa en este orden: estructura y estilo del listado; encabezado y organización del detalle; acciones y formularios; verificación de escritorio y móvil. Los formularios cortos se abren al solicitar una acción. Las compras amplias conservan su pantalla con contexto y regreso a la operación. Los enlaces de avisos deben abrir la vista y el bloque correctos.

Revisa visualmente antes/después con los mismos datos. Ejecuta las comprobaciones apropiadas del repo y deja un informe de resultados y limitaciones. Prioriza completar el alcance de hoy; no construyas un motor nuevo de flujos ni de eventos.

Trabaja en el worktree de Comercialización y con sus bases locales dedicadas, verificando destinos sin imprimir secretos. No hagas push, merge ni despliegue. No toques Neon compartido, PRD ni el árbol original de develop. Confirma el trabajo terminado en commits claros y detente al cerrar este bloque.
```

## 13. Referencias adicionales útiles

Las capturas recibidas alcanzan para organizar el listado y el detalle. Para ajustar también la cotización y la compra sin suposiciones visuales, sirven una captura actual de **Nueva cotización** y una de **Compra a proveedor**, incluida su sección de crédito. No bloquean el plan ni el inicio del trabajo principal.

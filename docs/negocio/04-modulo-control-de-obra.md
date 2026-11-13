# Módulo: Control de Obra

## 1. Propósito del documento

Este documento define la lógica funcional del módulo **Control de Obra** de Grupo
Conkuali.

Control de Obra es la principal fuente operativa de información de cada proyecto.
Desde este módulo se administran:

- proyectos;
- estructura contractual;
- partidas y conceptos;
- contratos de contratistas;
- estimaciones semanales de contratistas;
- avances físicos;
- aditivas;
- gastos y materiales relacionados con obra;
- Estimación Cliente;
- Control Contractual Cliente;
- versión normal/supervisor;
- versión privada;
- histórico de estimaciones;
- y posteriormente generación de reportes PDF.

El objetivo principal es que la información sea capturada **una sola vez en su punto
de origen** y fluya automáticamente hacia los demás procesos.

Ejemplo:

Estimación contratista
→ Estimación Cliente
→ Control Contractual
→ Reporte General

No se debe obligar al usuario a volver a capturar manualmente información que ya
existe dentro del sistema.

---

# 2. Relación con otros documentos

Este documento amplía la sección de Control de Obra descrita en:

`02-control-de-obra.md`

También debe respetar las reglas generales establecidas en:

- `00-decisiones-fundamentales.md`
- `01-administracion-pagos-semanales.md`
- `02-control-de-obra.md`
- `03-modulo-reporte-general.md`

En caso de desarrollar funcionalidades correspondientes específicamente a Control
de Obra, este documento (`04-modulo-control-de-obra.md`) debe considerarse la fuente
funcional principal.

---

# 3. Principios fundamentales

## 3.1 Una sola fuente de verdad

La información física de una obra no debe duplicarse entre versión normal y versión
privada.

Por ejemplo:

- proyecto;
- partidas;
- conceptos;
- unidades;
- cantidades;
- avances físicos;
- estimaciones;
- acumulados.

deben partir de una misma fuente de información.

La versión normal y la privada son diferentes **capas de visualización y valoración
financiera** de la misma realidad física.

---

## 3.2 No duplicar Normal y Privado

NO se deben crear dos controles de obra completamente independientes que requieran
capturar dos veces el mismo avance.

Ejemplo incorrecto:

- Estimación Normal independiente.
- Estimación Privada independiente.
- Capturar manualmente 35 m² en ambas.

Ejemplo correcto:

Se registran una sola vez:

`35 m² ejecutados`

y el sistema puede valuarlos utilizando distintos precios según la capa correspondiente.

---

# 4. Roles principales

Los nombres siguientes representan el funcionamiento actual de Grupo Conkuali.
La implementación debe continuar utilizando roles genéricos del sistema.

## Supervisor de campo — actualmente Andrés

Puede:

- consultar los proyectos a los que tiene acceso;
- consultar contratos y conceptos permitidos;
- trabajar con contratistas;
- preparar estimaciones semanales;
- registrar cantidades proyectadas;
- posteriormente registrar avance físico real;
- proponer aditivas;
- registrar trabajos extraordinarios;
- registrar gastos de obra;
- subir evidencia;
- consultar información operativa permitida.

NO debe tener acceso a precios financieros privados.

> **Nota de arquitectura técnica (ver sección 49.9):** esta línea se
> precisa en la sesión de agosto 2026 — el Supervisor sí ve el presupuesto
> operativo del Contrato General (Contratista, Materiales, cantidades,
> avance), pero no el Contrato General Privado (Indirectos, Herramienta, %
> utilidad/administración, precio final al cliente, márgenes comerciales).

---

## Administrador — actualmente Charles

Puede:

- administrar proyectos;
- revisar información capturada por supervisores;
- validar gastos;
- revisar estimaciones;
- consultar Reporte General;
- consultar información financiera permitida;
- acceder a la versión privada cuando tenga permiso;
- preparar/revisar la información que será presentada al cliente.

Actualmente Charles realiza manualmente gran parte de la consolidación de
estimaciones de contratistas hacia la Estimación Cliente. El sistema debe automatizar
este trabajo.

---

## Director — actualmente Sergio

Tiene acceso total dentro de la empresa.

Entre otras acciones puede:

- autorizar aditivas;
- consultar información privada;
- definir/modificar precios privados;
- registrar conceptos exclusivamente privados;
- registrar gastos/materiales exclusivamente privados;
- autorizar información financiera;
- participar en el flujo de pagos.

---

# 5. Administración de proyectos

El módulo **Control de Obra** es el módulo responsable de administrar los proyectos.

Reporte General utiliza los proyectos creados aquí, pero no es el módulo dueño del
catálogo de proyectos.

La pantalla principal de Control de Obra debe permitir posteriormente:

- consultar proyectos;
- crear proyecto;
- editar información general;
- activar proyecto;
- pausar proyecto;
- cerrar proyecto;
- consultar proyecto histórico.

No se debe eliminar físicamente un proyecto que ya tenga información.

---

# 6. Información general del proyecto

Cada proyecto debe poder almacenar, como mínimo:

- Empresa propietaria (tenant)
- Nombre del proyecto
- Cliente
- Ubicación
- Tipo de proyecto
- Estatus
- Fecha de inicio
- Fecha estimada de terminación
- Fecha real de cierre
- Número/referencia contractual cuando aplique
- Descripción general
- Notas

Los campos exactos podrán ampliarse al revisar los archivos históricos existentes.

---

# 7. Estructura base del proyecto

Actualmente, al iniciar una obra, Grupo Conkuali crea dentro del archivo de control
una hoja similar a:

`ADM OBRA GRIS`

Esta hoja contiene la estructura inicial de la obra y los precios acordados con los
contratistas.

En el sistema esta información NO debe modelarse simplemente como una hoja de Excel.

Debe convertirse en la **estructura contractual interna del proyecto**.

Conceptualmente:

Proyecto
→ Partidas
→ Conceptos
→ Contratista asignado
→ Cantidad contratada
→ Unidad
→ Precio unitario acordado con contratista
→ Importe contractual

Ejemplo:

PARTIDA: Albañilería

| Concepto | Unidad | Cantidad | Contratista | P.U. contratista |
|---|---|---:|---|---:|
| Block #6 | m² | 850 | Contratista A | $X |
| Castillos | ml | 175 | Contratista A | $X |
| Cerramientos | ml | 130 | Contratista A | $X |

Esta estructura permite generar posteriormente el contrato del contratista.

---

# 8. Partidas y conceptos

Cada proyecto puede contener múltiples partidas.

Ejemplos reales:

- Obra Civil
- Firmes y Exteriores
- Zarpeo y Afines
- Plomería
- Electricidad
- Retiros
- Piloteadora y Retro
- IMSS
- Otros / Materiales

Cada partida contiene uno o varios conceptos.

Un concepto debe poder manejar al menos:

- código;
- descripción;
- unidad;
- cantidad contratada;
- orden;
- partida;
- notas;
- estatus.

La información financiera relacionada con el concepto debe manejarse según la capa
correspondiente y no mezclarse con el avance físico.

---

# 9. Contratistas dentro del proyecto

Los contratistas son beneficiarios que participan en uno o más proyectos.

Un mismo contratista puede:

- trabajar en múltiples proyectos;
- tener diferentes contratos por proyecto;
- participar en diferentes conceptos;
- potencialmente tener más de un contrato/concepto dentro del mismo proyecto.

No se debe duplicar la identidad global del beneficiario por cada proyecto.

Debe existir una relación entre:

Beneficiario
→ Proyecto
→ Participación/Contrato
→ Partidas/Conceptos

Cada participación contractual puede tener:

- proyecto;
- contratista;
- número de contrato;
- descripción;
- fecha;
- conceptos asignados;
- monto contractual calculado;
- aditivas;
- estimaciones;
- pagos acumulados;
- saldo.

> **Nota de arquitectura técnica (ver sección 49):** `BeneficiarioProyecto` (la
> relación única beneficiario-proyecto de `03-modulo-reporte-general.md`) **no**
> se convierte en el contrato. Un mismo contratista con varios contratos en la
> misma obra se modela con una entidad `ContratoContratista` (1:N debajo de
> `BeneficiarioProyecto`), no con múltiples `BeneficiarioProyecto`.

---

# 10. Contrato del contratista

El contrato de un contratista debe poder construirse a partir de los conceptos
asignados.

Conceptualmente:

`Importe concepto = Cantidad contratada × P.U. contratista`

y:

`Contrato original = suma de conceptos contractuales`

Las aditivas autorizadas deben aumentar el contrato vigente.

`Contrato vigente = Contrato original + Aditivas autorizadas`

Los pagos realizados NO deben modificar el monto contractual.

Se utilizarán para calcular:

`Saldo financiero = Contrato vigente - pagos aplicables`

La definición exacta de qué estados de pago se consideran para este cálculo debe
respetar las reglas del módulo Reporte General.

---

# 11. Ciclo semanal de estimación del contratista

Actualmente el proceso real funciona de la siguiente manera:

1. Entre lunes y martes Andrés revisa la obra.
2. Habla con cada contratista.
3. Definen qué trabajos se realizarán durante esa semana.
4. Revisan los conceptos que pertenecen al contrato.
5. Proyectan cuánto avanzarán.
6. Se genera una estimación por contratista.
7. Actualmente Andrés entrega estas estimaciones a Charles en PDF.
8. Charles utiliza los PDF para construir manualmente la Estimación Cliente.
9. Charles vuelve a consultar los mismos PDF para capturar en Reporte General cuánto
   solicita cobrar cada contratista.

El sistema debe eliminar estas recapturas.

---

# 12. Pre-estimación semanal

La estimación preparada al inicio de la semana debe considerarse conceptualmente una
**pre-estimación/proyección semanal**.

Representa:

> Lo que el contratista proyecta ejecutar y solicita cobrar durante esa semana.

Debe contener:

- proyecto;
- contratista/contrato;
- semana;
- número de estimación;
- conceptos;
- cantidad anterior;
- cantidad proyectada de la semana;
- cantidad acumulada proyectada;
- monto solicitado;
- observaciones;
- usuario que la creó;
- fechas;
- estatus.

La aplicación debe poder generar posteriormente un PDF formal de esta información.

---

# 13. Pago solicitado no equivale a avance físico real

Esta es una regla fundamental.

El monto solicitado por el contratista y el avance físico real NO son necesariamente
iguales.

Ejemplo:

Monto solicitado semana: $40,000  
Avance físico realmente ejecutado equivalente: $28,000  
Pago realizado: $35,000

Los tres valores son válidos y deben conservarse.

Nunca se debe modificar retroactivamente el avance físico para hacerlo coincidir con
el dinero pagado.

Tampoco se debe modificar automáticamente el pago para hacerlo coincidir con el
avance real.

---

# 14. Avance físico real

Además de la pre-estimación, el sistema debe permitir registrar posteriormente cuánto
se ejecutó realmente.

Por concepto se debe poder comparar:

- cantidad contractual;
- cantidad acumulada anterior;
- cantidad proyectada esta semana;
- cantidad real ejecutada esta semana;
- cantidad real acumulada;
- cantidad pendiente;
- porcentaje de avance.

Ejemplo:

| Concepto | Proyectado | Real |
|---|---:|---:|
| Block #6 | 20 m² | 14 m² |
| Castillos | 15 ml | 11 ml |

La diferencia debe quedar visible.

El avance físico real debe conservar histórico semanal.

---

# 15. Pago autorizado y pago real

La pre-estimación representa cuánto solicita cobrar el contratista.

El sistema debe permitir que posteriormente:

`Monto solicitado ≠ Monto autorizado ≠ Monto pagado`

Ejemplo:

Solicitado: $40,000  
Autorizado: $40,000  
Pagado: $30,000  
Pendiente: $10,000

También puede existir:

Solicitado: $40,000  
Pagado: $50,000

En este caso existe un adelanto/sobrepago de $10,000.

El sistema debe conservar estas diferencias y hacerlas visibles.

No debe eliminar o sobrescribir información histórica para esconder diferencias.

> **Nota de arquitectura técnica (ver sección 49):** `MovimientoSemanal` (Reporte
> General) representa el movimiento/programación del pago, **no** se declara como
> la fuente definitiva de cuánto se pagó realmente. Pagos múltiples/parciales se
> resolverán con una futura entidad `PagoReal` (1:N desde `MovimientoSemanal`).

---

# 16. Comparación pago vs. avance

Una de las funcionalidades futuras más importantes será comparar:

- porcentaje físico ejecutado;
- porcentaje contractual pagado.

Ejemplo:

Avance físico: 55%  
Contrato pagado: 70%

El sistema debe poder mostrar claramente que existe un adelanto financiero respecto
al avance físico.

Esta información debe poder consultarse por:

- contratista;
- contrato;
- proyecto.

---

# 17. Aditivas de contratistas

Cuando un trabajo no está contemplado dentro del contrato original de un contratista,
Andrés puede proponer una aditiva.

La aditiva pertenece a:

Proyecto
→ Contratista/Participación contractual
→ Aditiva

Debe poder contener:

- descripción;
- conceptos;
- unidad;
- cantidad;
- precio propuesto cuando aplique;
- importe;
- evidencia/observaciones;
- fecha;
- usuario solicitante;
- estatus;
- usuario autorizador;
- fecha de autorización.

Flujo:

1. Andrés crea la aditiva.
2. Queda pendiente.
3. Sergio la revisa.
4. Sergio puede autorizarla o rechazarla.
5. Solo una aditiva autorizada aumenta el contrato.
6. Una aditiva rechazada se conserva en histórico.

Las aditivas no deben eliminarse para ocultar rechazos.

> **Nota de arquitectura técnica (ver sección 49):** una aditiva puede tener
> **varias líneas** (cabecera + detalle), no un único concepto. La cabecera
> conserva proyecto/contrato, descripción, solicitante/autorizador, estatus y
> fechas; el detalle contiene concepto, unidad, cantidad y precios por línea.
> Cuando exista `ContratoContratista`, la aditiva se relacionará con ese
> contrato específico, no con la participación completa.

---

# 18. Trabajos extraordinarios sin contratista existente

Puede ocurrir que aparezca un trabajo fuera de contrato y que quien lo realiza no
tenga previamente un contrato dentro de la obra.

Actualmente estos trabajos pueden terminar agrupados como "Extras".

En el nuevo sistema NO se debe crear necesariamente un contratista ficticio llamado
"Extras".

Debe existir la posibilidad de registrar un:

**Trabajo extraordinario / no asignado**

y posteriormente relacionarlo con:

- una persona;
- un proveedor;
- un nuevo contratista;
- u otra participación correspondiente.

Esto evita mezclar dentro de una sola identidad ficticia trabajos realizados por
personas diferentes.

La definición detallada de este flujo se terminará al diseñar esta funcionalidad.

---

# 19. Estimación Cliente

Cada proyecto maneja una **Estimación Cliente**.

Actualmente Charles construye esta estimación manualmente utilizando los PDF de las
estimaciones de cada contratista.

El objetivo del sistema es automatizar esta consolidación.

Conceptualmente:

Estimaciones de contratistas
→ cantidades/conceptos de la semana
→ consolidación
→ Estimación Cliente

Charles debe revisar la estimación antes de considerarla definitiva.

---

# 20. Estructura de Estimación Cliente

El formato actual contiene información como:

## Encabezado

- Hoja
- Proyecto
- Estimación N°
- Número de contrato
- Ubicación
- Tipo de estimación:
  - Normal
  - Excedente
  - Extraordinaria
- Fecha
- Contratista
- Periodo
- Cargo a

## Detalle

Por partida/concepto:

- Código
- Descripción
- Unidad
- Cantidad contractual
- Precio unitario
- Importe contractual
- Cantidad de esta estimación
- Importe de esta estimación
- Cantidad acumulada anterior
- Cantidad acumulada nueva
- Importe acumulado
- Importe por ejercer
- Porcentaje por ejercer
- Porcentaje de avance acumulado

## Totales

- Subtotal por partida
- Total contratado
- Total aditivas
- Monto del contrato
- Esta estimación
- Administración
- IVA
- Total

La aplicación debe calcular automáticamente los campos derivados.

---

# 21. Estimación Cliente: cantidades y precios

La cantidad física debe tener una sola fuente de verdad.

Un mismo avance puede tener diferentes valoraciones financieras.

Conceptualmente:

Cantidad ejecutada
→ P.U. contratista
→ valoración contratista

Cantidad ejecutada
→ P.U. capa normal
→ valoración normal

Cantidad ejecutada
→ P.U. privado
→ valoración privada

No se debe duplicar la cantidad física para obtener estas valoraciones.

> **Nota de arquitectura técnica (ver sección 49):** el modelo soporta los tres
> precios (contratista/normal/privado) pero **no asume que siempre son distintos
> entre sí** — es una capacidad flexible, no una regla funcional confirmada hasta
> revisar más archivos reales. Además, cualquier estimación histórica debe
> conservar el precio que aplicó **en ese momento** (snapshot), nunca
> recalcularse con un precio vigente actualizado después.

---

# 22. Versión normal / supervisor

Cada proyecto tiene una versión normal/supervisor.

Esta versión contiene la información que puede utilizarse en la operación diaria sin
exponer precios privados.

Debe compartir con la versión privada:

- estructura física;
- partidas;
- conceptos;
- cantidades;
- avances;
- acumulados;
- información operativa permitida.

Los permisos exactos sobre precios deben respetar la política de confidencialidad
establecida en los documentos generales.

---

# 23. Versión privada

Cada proyecto tiene una versión privada accesible únicamente para usuarios autorizados,
principalmente Administrador y Director.

La versión privada utiliza la misma información física del proyecto pero puede tener:

- precios unitarios privados;
- importes privados;
- administración privada;
- información financiera del cliente;
- anticipos reales;
- conceptos exclusivamente privados;
- materiales exclusivamente privados;
- otros costos exclusivamente privados.

La versión privada NO debe ser una copia independiente que requiera volver a capturar
el avance.

---

# 24. Diferencias reales entre normal y privado

Los formatos actuales demuestran que una misma cantidad física puede tener precios
diferentes.

Ejemplo real de referencia:

Obra Civil:

Cantidad contractual: 1,198 m²

Versión normal:
P.U.: $4,080.00

Versión privada:
P.U.: $5,300.00

Por lo tanto:

`Cantidad física = compartida`

`Precio = depende de la capa`

Esta regla debe respetarse en el diseño de datos.

---

# 25. Aditivas y versión privada

Cuando Andrés crea una aditiva desde la versión normal:

1. Se registra la información física/operativa.
2. La aditiva queda pendiente de autorización.
3. Sergio debe poder verla desde la versión privada.
4. Sergio puede revisar/modificar el precio unitario privado.
5. Sergio confirma la información financiera privada.
6. Al autorizarse, aumenta el contrato correspondiente según las reglas de cada capa.

La cantidad/concepto no debe duplicarse innecesariamente entre normal y privado.

---

# 26. Conceptos exclusivamente privados

Sergio debe poder agregar información que únicamente exista en la capa privada.

Ejemplos:

- aditivas privadas;
- materiales privados;
- otros costos privados;
- ajustes financieros privados.

Estos registros:

- pertenecen al mismo proyecto;
- pueden afectar la estimación/contractual privado;
- NO deben aparecer al supervisor;
- NO deben filtrarse accidentalmente a PDFs normales.

El sistema de permisos debe proteger esta información también a nivel de API, no
solamente ocultándola visualmente.

---

# 27. Otros / Materiales

La Estimación Cliente contiene una partida denominada:

`Otros / Materiales`

Uno de sus principales orígenes son los gastos realizados por Andrés para la obra.

Flujo esperado:

1. Andrés registra gasto.
2. Selecciona proyecto.
3. Captura monto.
4. Captura descripción.
5. Indica método de pago cuando corresponda.
6. Adjunta foto de ticket/factura/evidencia.
7. Queda pendiente de validación.
8. Charles revisa.
9. Charles aprueba o rechaza.
10. Si se aprueba, puede alimentar la partida Otros / Materiales correspondiente.

La versión privada incluye estos gastos aprobados y adicionalmente puede incluir
gastos/materiales privados registrados por Sergio u otro usuario autorizado.

---

# 28. Relación de gastos con Reporte General

Un gasto aprobado puede tener dos efectos distintos:

### Control de Obra

Puede convertirse en costo/material cobrable dentro de la Estimación Cliente.

Reglas vigentes (decisión de Charles, noviembre 2026):

- **Semana abierta (preliminar):** Cliente y Cliente Priv. muestran los gastos cobrables
  aprobados que entrarían al cerrar la semana, con su subtotal y la administración/utilidad
  de cada vista, sumados al total preliminar. Es solo consulta: no crea estimaciones ni liga
  gastos. Usa exactamente los mismos criterios que el cierre.
- **Semana cerrada sin estimación:** al aprobar un gasto cobrable de esa semana se crean sus
  estimaciones (General y Privada, en borrador) y se liga el gasto. Si la semana ya tiene
  estimación, no se crea otra; una estimación emitida nunca se modifica y el gasto pasa a la
  siguiente en borrador.
- El pago de la reposición a quien pagó el gasto es independiente del cobro al cliente.

### Reporte General

Puede representar dinero que debe pagarse o reponerse.

La misma información no debe capturarse nuevamente.

Debe existir trazabilidad entre el registro origen y los movimientos derivados.

---

# 29. Relación con Reporte General — estimaciones

Actualmente Charles consulta los PDF enviados por Andrés y vuelve a capturar en Reporte
General cuánto está solicitando cada contratista.

El sistema debe eliminar esa recaptura.

Conceptualmente:

Pre-estimación contratista aprobada/revisada
→ genera o propone movimiento en Reporte General

Ejemplo:

Villas La Herradura  
Juan Pérez  
Estimación #18  
Solicitado: $72,500

→

Reporte General  
Villas La Herradura  
Juan Pérez  
Estimación #18  
$72,500  
Pendiente de pago

Debe conservarse referencia entre ambos registros.

---

# 30. Administración

Los pagos administrativos no necesariamente nacen de una estimación de contratista.

Actualmente Sergio captura/define información relacionada con administración.

El módulo Reporte General continuará manejando esta información según su propia
especificación.

Control de Obra solamente debe integrarse cuando exista una relación real con costos
del proyecto.

---

# 31. Control Contractual Cliente

Cada proyecto maneja también un **Control Contractual Cliente**.

Su función es mostrar el comportamiento financiero acumulado del contrato semana tras
semana.

Actualmente el reporte contiene al menos:

## Encabezado

- Hoja
- Fecha
- Estimación N°
- Tipo:
  - Normal
  - Excedente
  - Extraordinaria
- Proveedor
- Número de contrato
- Descripción de los trabajos
- Fecha de contrato
- Importe original del contrato
- Fecha de inicio
- Contrato revisado
- Fecha de terminación
- IVA
- Total contrato

---

# 32. Anticipos

El Control Contractual puede manejar anticipos.

Por registro se contemplan campos como:

- número/referencia;
- monto de anticipo;
- amortización;
- retención;
- otros/multas;
- importe;
- IVA;
- importe neto;
- fecha de recepción;
- fecha de pago cuando aplique;
- concepto/comentario.

La versión privada puede contener anticipos reales del cliente que no deben ser
visibles en la versión normal.

---

# 33. Histórico de estimaciones en Control Contractual

Cada estimación cerrada/alimentada debe reflejarse en el Control Contractual.

Actualmente se manejan campos como:

- referencia;
- monto de estimación;
- amortización;
- retención;
- otros/multas;
- importe;
- IVA;
- importe neto;
- fecha de recepción;
- fecha de pago;
- concepto.

El sistema debe generar esta información desde las estimaciones existentes siempre que
sea posible, en lugar de requerir una captura duplicada.

---

# 34. Órdenes de cambio

El Control Contractual contiene una sección de:

`ÓRDENES DE CAMBIO`

relacionada con aditivas/cambios contractuales.

Debe conservar:

- referencia;
- monto;
- amortización;
- retención;
- otros/multas;
- importe;
- IVA;
- importe neto;
- fechas;
- concepto.

La integración exacta con las aditivas deberá mantener trazabilidad entre el cambio
contractual origen y su representación financiera.

---

# 35. Resumen contractual

El Control Contractual debe poder calcular un resumen financiero.

Actualmente contempla conceptos como:

### A la fecha

- Requisitado
- Amortizado
- Retenido
- Otros
- Pagado

### Por ejercer

- Por requisitar
- Por amortizar
- Por pagar

Los cálculos exactos deben documentarse y validarse contra los archivos históricos
antes de automatizar definitivamente cada fórmula.

No se deben inferir fórmulas financieras cuando los archivos existentes no permitan
confirmarlas.

---

# 36. Cierre de estimación

Una estimación debe conservar histórico.

Una vez que una estimación haya sido considerada definitiva y utilizada para generar
reportes, no debe modificarse silenciosamente.

Las correcciones posteriores deben conservar:

- valor anterior;
- valor nuevo;
- usuario;
- fecha;
- motivo.

La estrategia exacta de estados de estimación y reapertura se definirá antes de
implementar el flujo final.

---

# 37. Bitácora

Toda acción relevante de Control de Obra debe generar bitácora.

Como mínimo:

- creación de proyecto;
- modificación de proyecto;
- creación/modificación de contrato;
- creación de estimación;
- modificación de cantidades;
- registro de avance real;
- creación de aditiva;
- autorización/rechazo de aditiva;
- modificación de precio privado;
- creación de concepto privado;
- aprobación/rechazo de gasto;
- cierre/reapertura de estimación.

Registrar:

- usuario;
- fecha/hora;
- acción;
- entidad afectada;
- valor anterior cuando aplique;
- valor nuevo cuando aplique;
- motivo cuando corresponda.

---

# 38. Histórico

Principio no negociable:

**No eliminar información histórica de negocio.**

Los registros pueden:

- cancelarse;
- rechazarse;
- desactivarse;
- corregirse mediante flujo controlado;

pero no deben desaparecer físicamente cuando ya participaron en un proceso financiero
u operativo.

---

# 39. Reportes PDF

La aplicación debe generar directamente los reportes formales utilizados en la
operación.

Como referencia existen actualmente reportes como:

- Control Contractual;
- Estimación de Obra;
- versión normal;
- versión privada.

Los nuevos PDF deben mantener un estilo:

- profesional;
- consistente;
- corporativo;
- legible;
- con identidad de Grupo Conkuali/empresa correspondiente;
- apto para envío a cliente;
- apto para archivo histórico.

No es obligatorio copiar pixel por pixel el diseño actual.

Sí es obligatorio conservar toda la información funcional necesaria.

---

# 40. PDF normal vs. PDF privado

La generación de PDF debe respetar estrictamente la capa de información.

### PDF normal

Solo información permitida para esa capa.

### PDF privado

Información financiera privada autorizada.

Nunca debe existir la posibilidad de que un PDF normal incluya accidentalmente:

- P.U. privado;
- importes privados;
- anticipos privados;
- conceptos privados;
- gastos privados.

La separación debe aplicarse desde el origen de los datos, no únicamente ocultando
columnas en la plantilla del PDF.

---

# 41. Histórico de PDFs

Idealmente cada PDF definitivo generado debe poder quedar asociado a:

- proyecto;
- tipo de reporte;
- estimación;
- versión/capa;
- fecha de generación;
- usuario que lo generó.

La estrategia exacta de almacenamiento de archivos se definirá al implementar el
módulo documental/reportes.

---

# 42. Flujo conceptual completo

El flujo objetivo es:

```text
CREAR PROYECTO
      ↓
DEFINIR ESTRUCTURA CONTRACTUAL
      ↓
PARTIDAS / CONCEPTOS
      ↓
ASIGNAR CONTRATISTAS
      ↓
GENERAR CONTRATOS
      ↓
────────────────────────────────
        CICLO SEMANAL
────────────────────────────────
      ↓
ANDRÉS + CONTRATISTA
definen avance proyectado
      ↓
PRE-ESTIMACIÓN CONTRATISTA
      ↓
se determina monto solicitado
      ↓
CHARLES REVISA / CONSOLIDA
      ↓
ESTIMACIÓN CLIENTE
      ↓
NORMAL ───────── PRIVADA
          misma
        información
          física
      ↓
CONTROL CONTRACTUAL
      ↓
REPORTE GENERAL
      ↓
AUTORIZACIÓN / PAGO
```

Paralelamente:

```text
ANDRÉS
  ↓
GASTO + EVIDENCIA
  ↓
CHARLES VALIDA
  ↓
┌──────────────────────────┐
│                          │
ESTIMACIÓN CLIENTE    REPORTE GENERAL
Otros / Materiales     Pago / reposición
```

Y:

```text
ANDRÉS
  ↓
PROPONE ADITIVA
  ↓
SERGIO REVISA
  ↓
DEFINE/CONFIRMA PRECIO PRIVADO
  ↓
AUTORIZA
  ↓
AUMENTA CONTRATO
```

---

# 43. Separación entre avance, solicitud y pago

El sistema debe tratar como conceptos independientes:

## A. Proyección / pre-estimación

¿Qué esperamos ejecutar esta semana?

## B. Avance físico real

¿Qué se ejecutó realmente?

## C. Monto solicitado

¿Cuánto solicita cobrar el contratista?

## D. Monto autorizado

¿Cuánto se autorizó pagar?

## E. Monto pagado

¿Cuánto dinero recibió realmente?

Estos valores pueden ser diferentes.

El sistema debe mostrar las diferencias en lugar de intentar hacerlas coincidir
automáticamente.

---

# 44. Integración entre módulos

Control de Obra será fuente de información para otros módulos.

Debe diseñarse pensando en relaciones explícitas entre entidades, no copiando valores
sin trazabilidad.

Ejemplos:

`EstimaciónContratista → MovimientoReporteGeneral`

`GastoObra → MovimientoReporteGeneral`

`GastoObra → ConceptoOtrosMateriales`

`Aditiva → Contrato`

`EstimaciónCliente → ControlContractual`

Cada registro derivado debe poder rastrearse hasta su origen.

---

# 45. No implementar toda la lógica de una sola vez

Control de Obra es un módulo complejo.

Debe construirse por etapas.

Propuesta inicial:

### Etapa 1 — Proyectos

- listado;
- alta;
- edición;
- estatus;
- permisos.

### Etapa 2 — Estructura contractual

- partidas;
- conceptos;
- contratistas;
- contratos;
- cantidades;
- precios correspondientes.

### Etapa 3 — Estimaciones de contratistas

- pre-estimaciones;
- cantidades proyectadas;
- monto solicitado;
- histórico.

### Etapa 4 — Avance físico

- avance real;
- acumulados;
- diferencias contra proyección.

### Etapa 5 — Aditivas

- captura;
- autorización;
- precios privados;
- integración contractual.

### Etapa 6 — Estimación Cliente

- consolidación automática;
- normal;
- privado;
- revisión/cierre.

### Etapa 7 — Control Contractual

- anticipos;
- histórico de estimaciones;
- órdenes de cambio;
- resumen financiero.

### Etapa 8 — Gastos / Otros / Materiales

- evidencia;
- validación;
- integración con estimación;
- integración con Reporte General.

### Etapa 9 — Reportes PDF

- Estimación Cliente;
- Control Contractual;
- normal;
- privado;
- histórico.

El orden puede ajustarse si existen dependencias técnicas, pero no se debe intentar
construir todo el módulo simultáneamente.

---

# 46. Migración de archivos históricos

Grupo Conkuali cuenta con información histórica importante en Excel.

La migración NO debe realizarse hasta que el modelo de datos correspondiente esté
aprobado.

Orden recomendado:

1. Proyectos
2. Partidas
3. Conceptos
4. Beneficiarios/contratistas
5. Contratos
6. Aditivas
7. Estimaciones históricas
8. Gastos/materiales
9. Información contractual del cliente
10. Relaciones con Reporte General

Debe desarrollarse una estrategia controlada de importación.

No modificar los archivos históricos originales.

---

# 47. Información todavía pendiente de cerrar

Las siguientes reglas todavía requieren análisis antes de considerarse definitivas:

- estados exactos de una pre-estimación;
- flujo exacto de revisión/aprobación de estimaciones;
- momento exacto en que una estimación alimenta Reporte General;
- reglas para pagar menos o más de lo solicitado;
- tratamiento posterior de adelantos/sobrepagos;
- fórmula exacta de ciertos campos del Control Contractual;
- reapertura/corrección de estimaciones cerradas;
- estructura definitiva de trabajos extraordinarios sin contratista;
- relación exacta entre múltiples contratos del mismo contratista;
- reglas de administración por proyecto;
- IVA según proyecto/contrato;
- retenciones;
- amortizaciones;
- excedentes;
- estimaciones extraordinarias;
- almacenamiento definitivo de PDFs;
- reglas exactas para determinar qué conceptos de contratistas consolidan en cada
  concepto de Estimación Cliente.

Estas reglas NO deben inventarse durante el desarrollo.

Cuando una implementación llegue a uno de estos puntos, debe detenerse y solicitar
definición funcional antes de asumir comportamiento.

---

# 48. Objetivo final

Control de Obra debe reemplazar progresivamente el trabajo manual realizado
actualmente entre:

- Excel;
- PDFs;
- WhatsApp;
- Reporte General;
- controles privados.

La meta no es digitalizar exactamente el Excel.

La meta es construir una única fuente de información donde:

- Andrés capture información de campo una sola vez;
- Charles revise y administre;
- Sergio autorice y controle información privada;
- las estimaciones se generen automáticamente;
- el Reporte General reciba información sin recaptura;
- los reportes cliente se generen desde el sistema;
- se conserve todo el histórico;
- y los precios privados permanezcan protegidos.

---

# 49. Decisiones de arquitectura técnica (sesión de diseño, agosto 2026)

Esta sección documenta cómo el análisis técnico de este módulo (hecho junto con
Claude, comparando este documento contra `prisma/schema.prisma` y los módulos ya
construidos) ajustó algunos de los conceptos descritos arriba. **Donde haya
diferencia, esta sección manda** sobre las secciones anteriores para efectos de
implementación — el resto del documento sigue siendo válido como descripción del
negocio.

## 49.1 `BeneficiarioProyecto` no es el contrato

`BeneficiarioProyecto` (entidad ya implementada, ver `03-modulo-reporte-general.md`)
conserva su significado actual: la relación única entre un Beneficiario y un
Proyecto (`@@unique([beneficiarioId, proyectoId])`, sin cambio). Reporte General
sigue trabajando a ese nivel sin modificaciones.

La estructura contractual detallada que pide este documento (partidas, conceptos,
múltiples contratos por obra) se resuelve con entidades nuevas **debajo** de
`BeneficiarioProyecto`, todavía no implementadas:

```text
Beneficiario
   ↓
BeneficiarioProyecto        (ya existe — sin cambio)
   ↓ 1:N
ContratoContratista          (futuro — Etapa 2)
   ↓ 1:N
ContratoConcepto              (futuro — Etapa 2)
```

Ejemplo: Juan Pérez tiene un `BeneficiarioProyecto` en Villas La Herradura, y
dentro de ese `BeneficiarioProyecto` puede tener dos filas de `ContratoContratista`
("Contrato 01 — Obra Civil" y "Contrato 02 — Firmes y Exteriores"). Nunca dos
`BeneficiarioProyecto` para representar dos contratos.

Consecuencia futura ya anticipada: cuando exista `ContratoContratista`, `Aditiva`
se relacionará con el contrato específico (`ContratoContratista`), no con el
`BeneficiarioProyecto` completo — eso implicará mover su FK en esa etapa.

## 49.2 Aditiva: cabecera + detalle

`Aditiva` (ya implementada, con flujo Supervisor-solicita → Director-autoriza) va
a evolucionar a cabecera + detalle, no a extenderse con campos planos:

```text
Aditiva                 (cabecera: proyecto/contrato, descripción, solicitante,
   └── AditivaDetalle     autorizador, estatus, fechas, monto = suma del detalle)
                         (detalle: concepto opcional, descripción, unidad,
                          cantidad, P.U. contratista, valoración normal,
                          P.U. privado, importe)
```

Motivo: una aditiva puede representar varias líneas de trabajo (ej. "Aditiva 03 —
Modificación terraza": demolición adicional + block + zarpeo + instalación
pluvial), no necesariamente un solo concepto.

## 49.3 Tres precios posibles, no una regla de "siempre tres distintos"

El modelo debe soportar tres valoraciones por concepto — precio contratista
(lo que Conkuali paga), precio normal (capa supervisor) y precio privado (capa
Administrador/Director) — pero **no se asume todavía** que en todos los proyectos
los tres sean siempre diferentes o independientes entre sí. Es una capacidad del
modelo, no una regla de negocio confirmada. Se revisará contra más archivos reales
antes de convertirla en regla definitiva.

## 49.4 Snapshots de precios históricos

Los precios "vigentes" de un concepto sirven como default para nuevas capturas,
pero cualquier registro histórico (estimación, y después Estimación Cliente) debe
conservar el precio que aplicó **en el momento en que se generó**, nunca
recalcularse si el precio vigente cambia después. Ejemplo: una estimación de
febrero con P.U. privado $5,300 debe seguir mostrando $5,300 aunque en junio el
precio vigente suba a $5,600.

## 49.5 `MovimientoSemanal` no es la fuente definitiva del pago real

`MovimientoSemanal` (Reporte General) sigue representando el movimiento/
programación del pago dentro del ciclo semanal — no se declara como el registro
definitivo de cuánto dinero se entregó realmente. Se deja abierta la posibilidad
de una futura entidad `PagoReal` (1:N desde `MovimientoSemanal`) para soportar
pagos parciales/múltiples, fechas, métodos, comprobantes y folio:

```text
EstimacionContratista → MovimientoSemanal → PagoReal (futuro, no implementado)
```

No implementado todavía — el diseño actual de `MovimientoSemanal` no bloquea
agregarlo después (sería una tabla nueva con FK hacia `MovimientoSemanal`).

## 49.6 Seguridad Normal/Privado

Confirmado: la protección de información privada se aplica desde el
servicio/query/API (el `select`/`where` de la consulta misma nunca incluye campos
privados para un solicitante sin permiso), nunca únicamente ocultando componentes
en el frontend. Ver sección 26.

## 49.7 Alcance de la Etapa 1

La Etapa 1 (administración de proyectos) **solo** agrega campos generales a
`Proyecto` (`cliente`, `ubicacion`, `numeroContrato`, `descripcion`, `notas`,
`fechaEstimadaTermino` — todos opcionales) y la pantalla/servicios para
administrarlo. `cliente` es texto libre por ahora (no hay todavía un catálogo
`Cliente` con razón social/RFC/contactos). `numeroContrato` representa el
contrato principal del proyecto con el cliente — **no** los contratos de
contratistas, que se resuelven después con `ContratoContratista`. Ninguna de las
entidades de las secciones 49.1–49.5 se crea en esta etapa.

## 49.8 Avance físico (`AvanceConcepto`) — decisión de sesión, agosto 2026

`AvanceConcepto` se agrega como entidad nueva, aditiva, sin tocar el modelo
contractual existente:

```text
Concepto (ya existe)
   ↓ 1:N
AvanceConcepto (nuevo) — único por (conceptoId, semanaId)
```

Decisiones tomadas:

- **El avance vive a nivel de `Concepto`, no de `ContratoConcepto`.** Es la
  única fuente de verdad de la cantidad física ejecutada (sección 14). Cuando
  un concepto está asignado a un solo contratista, su avance se muestra en la
  tarjeta de ese contratista (pestaña Contratistas) sin ambigüedad. Cuando un
  concepto está repartido entre varios `ContratoContratista`, el sistema **no
  prorratea ni atribuye** el avance a ninguno — se muestra `—` con la nota
  "Concepto compartido · avance no atribuible por contratista". Atribuir avance
  por contratista de forma fina, si se necesita en el futuro, requeriría
  capturar por `ContratoConcepto` en lugar de por `Concepto` — cambio que no se
  hizo aquí a propósito.
- **Nada calculado se guarda.** `AvanceConcepto.cantidadEjecutada` es lo
  capturado esa semana únicamente. Acumulado, pendiente y % de avance se
  derivan siempre en lectura sumando las filas de todas las semanas hasta la
  consultada (ordenadas por `Semana.fechaInicio`, no por `numero`/`anio`, para
  no romperse en cambios de año).
- **`empresaId` explícito** en `AvanceConcepto` (por decisión de arquitectura,
  aunque sea alcanzable transitivamente vía `concepto → partida → proyecto →
  empresa` — a diferencia de `ContratoConcepto`, que no lo tiene).
- **Excedente sobre lo contratado**: bloquea el guardado con un mensaje claro
  (no hay todavía regla de aditivas/excedentes extraordinarios — sección 5 del
  documento original). Se revisará cuando se diseñe el manejo de cantidades
  extraordinarias.
- **"Avance físico general" del proyecto** queda sin calcular — no existe
  todavía una metodología válida para promediar % entre conceptos con
  unidades distintas (m², piezas, ml) sin una base de ponderación económica, y
  esta pantalla no maneja precios. El indicador queda preparado visualmente
  ("— · Pendiente de definir metodología") hasta que se defina esa base.
- **Permisos explícitos**: `puedeReportarAvance()` lista los 4 roles actuales
  (Supervisor, Administrador, Director, Master) uno por uno, no "cualquier
  usuario activo" — un rol nuevo en el futuro no hereda este permiso
  automáticamente.
- La lógica de `Semana` (antes en `lib/server/reporte-general/semanas.ts`) se
  reubicó a `lib/server/semanas.ts` — es una entidad de la Empresa, compartida
  por Reporte General y Control de Obra, no propia de ningún módulo.

## 49.9 Contrato General / Contrato General Privado — decisión de sesión, agosto 2026 (Etapa A: schema base)

Esta sección **sustituye** el modelo de "tres precios normal/privado" descrito
en las secciones 19-27 y 49.3. Ya no se trata de tres precios equivalentes con
distinta visibilidad — son **componentes de costo distintos**
(contratista/materiales/indirectos/herramienta) más un % de utilidad o
administración, y la línea Normal/Privado corta por campo específico, no por
"todo o nada". También sustituye la frase de la sección 4 *"[Supervisor] NO
debe tener acceso a precios financieros privados"* — el Supervisor sí ve el
presupuesto operativo del Contrato General (ver más abajo qué campos exactos).

### Dos esquemas contractuales por proyecto

`Proyecto.esquemaContractual` (`PRECIO_ALZADO | ADMINISTRACION`, nullable —
**no se infiere** para proyectos existentes, Administrador/Director lo asigna
a propósito):

- **Precio Alzado**: costo base = Contratista + Materiales + Indirectos +
  Herramienta; precio cliente = costo base × (1 + % utilidad).
- **Administración**: no usa Indirectos ni Herramienta; precio cliente = costo
  real (Contratista + Materiales + otros gastos) × (1 + % administración). El
  cliente sí puede ver el % de administración en este esquema (no así la
  utilidad de Precio Alzado).

Los campos de Indirectos/Herramienta existen en el schema para ambos esquemas
(no se ocultan a nivel de columna) — qué aplica según el esquema se valida en
el servicio, no en la base de datos.

### Contrato General vs. Contrato General Privado

No son dos contratos ni dos fuentes de verdad — es la misma estructura
(`Partida` → `Concepto`) con visibilidad distinta por campo:

- **Contrato General** (Supervisor, Administrador, Director, Master):
  descripción, unidad, cantidad, presupuesto de Contratista, presupuesto de
  Materiales, subtotal por partida, avance físico.
- **Contrato General Privado** (solo Administrador/Director/Master — mismo
  rol-set que `puedeAdministrarProyectos()`, sin permiso nuevo): Indirectos,
  Herramienta, % utilidad/administración, precio unitario final al cliente,
  márgenes comerciales.

### Precio recomendado vs. precio comercial

`Concepto.precioUnitarioClienteOverride` (nullable) es la única cifra
comercial que se **guarda** — es una decisión de Administrador/Director que no
se puede derivar de nada. El precio recomendado (costo base × 1+%) nunca se
guarda, se calcula siempre en lectura. Regla:

```
precioUnitarioCliente = concepto.precioUnitarioClienteOverride ?? precioCalculado
```

Cuando existe override, ambos valores (recomendado y comercial) deben poder
verse simultáneamente — nunca solo el resultado final, para poder analizar
margen después.

### Porcentajes — siempre campos separados, nunca uno genérico

`Proyecto.porcentajeUtilidadDefault` / `Proyecto.porcentajeAdministracionDefault`,
y a nivel `Concepto`: `porcentajeUtilidad` / `porcentajeAdministracion`
(override; `null` = usa el default del proyecto). Se mantienen separados a
propósito — un campo único cuyo significado dependiera de
`esquemaContractual` fue descartado explícitamente para que el dato nunca sea
ambiguo por sí mismo.

### Pagos por contrato específico (preparación, no implementado)

`MovimientoSemanal.contratoContratistaId` (nullable) permite, cuando
corresponda, ligar un pago a un `ContratoContratista` específico — sin asumir
"un contratista = un contrato por proyecto". Mientras sea `null`, el
movimiento sigue funcionando exactamente igual que hoy (asociado solo a
`BeneficiarioProyecto`). Esto prepara —sin implementar todavía— Pagado
acumulado/Saldo/comparación avance-vs-pagado/Estado de cuenta por contrato.

### Qué NO se hizo en esta etapa (a propósito)

- No se movió la relación de `Aditiva` hacia `ContratoContratista` (sigue
  ligada a `BeneficiarioProyecto`, ver 49.1) — toca cálculos que ya usa
  Reporte General, se hará en una etapa separada.
- No existe todavía `EstimacionContratista` (cabecera+detalle, sección 12 del
  rediseño) ni Estado de Cuenta por contratista.
- No hay todavía captura de gasto real de materiales (sección 13) — el módulo
  de requisiciones/compras/gastos no existe aún; `precioUnitarioMateriales`
  por ahora es solo presupuesto.
- Ninguna UI se modificó en esta etapa — solo schema (migración
  `20260814041200_contrato_general_base`, totalmente aditiva, sin defaults
  que alteren proyectos/conceptos existentes).
  por Reporte General y Control de Obra, no propia de ningún módulo.
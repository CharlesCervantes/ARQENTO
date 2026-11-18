# ARQENTO — Módulo de Comercialización

Versión: 0.9 · 17 de noviembre de 2026
Estado: implementación incremental. B1 (módulo, permisos y catálogo), B2 (clientes, obras y cotizaciones en borrador) B3 (emisión, PDF, aceptación y orden de venta), B4 (compras a proveedores), B5 (cuentas por cobrar y por pagar, condiciones, cobros y pagos), B6A (entregas parciales al cliente con evidencias) y B6B (recordatorios internos de cobros y pagos) implementados en la rama `feature/comercializacion`, sin desplegar; ver §20.
Ubicación propuesta en el repositorio: `docs/negocio/comercializacion.md`.

## 1. Propósito y autoridad del documento

Controlar la comercialización de materiales a obras: cotizar, registrar la aceptación del cliente, comprar al proveedor, controlar créditos y abonos, documentar entregas y consultar resultados internos. La experiencia debe permitir actualizaciones cotidianas en pocos minutos.

Este documento incorpora los comentarios del usuario después de la reunión. Los prototipos anteriores son referencias visuales; este texto reemplaza sus etiquetas o comportamientos cuando exista diferencia. No constituye evidencia de funcionalidad implementada ni de revisión del código actual.

Convenciones:
- **Confirmado:** solicitado expresamente por el usuario.
- **Propuesta:** regla recomendada para concretar el alcance; no presentarla como acuerdo de los dueños.
- **Pendiente:** decisión que debe resolverse antes de implementar la parte afectada. Continuar con las partes independientes.

## 2. Acuerdos confirmados

1. Un módulo habilitable por empresa, con logo y usuarios propios, dentro de Arqento.
2. Interfaz sencilla: listado, formulario de cotización y detalle. Evitar siete pantallas de navegación y múltiples pestañas.
3. El botón principal es **Nueva cotización**. Una cotización aceptada se convierte en una **OC** y continúa el seguimiento.
4. Incorporar **Vendedor** para identificar quién vende.
5. Seleccionar materiales de un catálogo precargado, editable, con precios modificables.
6. Solo el Administrador puede modificar el precio al armar una cotización. El vendedor utiliza el precio autorizado, sin edición ni descuentos.
7. Dos perfiles funcionales iniciales: acceso completo y vendedor, que cotiza y sigue entregas. Se busca reutilizar Administrador y Supervisor si el código lo permite.
8. Pago directo o crédito tanto para cliente como para proveedor, con opción de pagos en varias fechas desde la primera versión. Cada lado tiene su propio calendario y saldo.
9. El vendedor solo consulta sus cotizaciones y el seguimiento asociado; no las de otros vendedores.
10. Las notificaciones iniciales se muestran exclusivamente dentro de Arqento. WhatsApp se evaluará en una fase posterior, posiblemente la semana siguiente, sin fecha comprometida.
11. Mantener pagos parciales, evidencias y entregas parciales, sin volver a capturar los mismos datos.
12. Contemplar resultado interno y reparto entre socios. El caso de referencia usa 50/50; abonos a deuda y reservas no deben confundirse.

## 3. Integración con Arqento y límites

- Antes de desarrollar, leer el `AGENTS.md` real, el índice de negocio, decisiones fundamentales y la implementación actual de usuarios, permisos, empresas, proyectos, compras y archivos.
- Reutilizar infraestructura existente después de inspeccionarla. No asumir nombres de modelos, rutas o enums a partir de este documento.
- Todo registro pertenece a una empresa. Validar empresa y permisos en servidor, incluyendo relaciones, búsquedas, archivos, descargas y PDFs.
- Habilitar Comercialización mediante el mecanismo actual de módulos/planes; ocultar y bloquear el acceso si está deshabilitado.
- No modificar globalmente las facultades del Supervisor de construcción. La capacidad de ver precios de venta y cotizar es específica de Comercialización.
- No obligar a una obra comercial a crear contratos de construcción, semanas, estimaciones o avances físicos. Verificar si el modelo Proyecto sirve como referencia ligera o requiere una adaptación localizada.
- No generar duplicados financieros en Compras, Gastos o Contabilidad. Definir un único propietario de cada obligación y movimiento antes de conectar módulos.
- Reutilizar bitácora, marca, almacenamiento y componentes. Conservar historial y evitar borrados destructivos de registros utilizados.
- No ejecutar migraciones ni cambiar PRD como consecuencia de leer este archivo. Preparar cambios y pruebas conforme al flujo autorizado del repositorio.

## 4. Significado de OC y flujo comercial

**Propuesta terminológica:** llamar **OC de cliente** a la venta aceptada y **Compra a proveedor** a la adquisición para atenderla. No confundirlas con una sola entidad o un solo saldo.

**Pendiente P1:** confirmar si el folio OC lo genera Arqento, lo proporciona el cliente o se requieren ambos. La cotización aceptada no debe generar automáticamente compras al proveedor sin conocer proveedor, costos y condiciones.

Flujo propuesto:
1. Crear cotización en borrador con vendedor, cliente, obra y partidas del catálogo.
2. Completar condiciones y generar PDF para compartir fuera del sistema.
3. Registrar aceptación y su evidencia/referencia.
4. Convertir una sola vez a OC de cliente, conservando cotización y versión aceptada.
5. Registrar compras vinculadas, obligaciones de cobro/pago y entregas.
6. Registrar abonos y evidencias; consultar saldos y vencimientos.
7. Cerrar cuando se cumplan condiciones de entrega y liquidación; mantener el historial.

Estados propuestos de cotización: Borrador, Emitida, Aceptada, Rechazada y Cancelada. Vigencia vencida se identifica por fecha; no convertir ni cobrar automáticamente una cotización vencida.

La aceptación debe ser transaccional e idempotente: doble clic o reintento no crea dos OCs. Conservar folios de cotización y OC, fecha, usuario que registra aceptación, vendedor y evidencia. Una cotización no aceptada no aumenta el saldo por cobrar ni compromete una compra.

Después de aceptar, no editar silenciosamente cantidades o precios pactados. Una corrección requiere historial y una revisión controlada que trate efectos sobre pagos, compras y entregas. Para el primer alcance, bloquear esos cambios cuando existan movimientos y resolver ajustes explícitos con administración.

Entrega, cobro y pago son estados independientes. No utilizar un único estado para representar los tres. No inferir que el cliente pagó porque se entregó material, ni que el proveedor recibió pago porque su compra es de contado.

## 5. Experiencia de usuario

### 5.1 Listado único: Comercialización

- Título propuesto: **Cotizaciones y órdenes**.
- Acción principal: **Nueva cotización**.
- Filtros sencillos: búsqueda, obra, estado; vendedor para administración.
- Tabla: folio y tipo (COT/OC), descripción, cliente/obra, vendedor, total, estado comercial y entrega. Saldo y vencimiento según permiso.
- En borradores, cobro/entrega muestran “No aplica”, no “Cobrado” ni “Completa”.
- Administrador: indicadores Por cobrar, Por pagar y Entregas pendientes; bloque compacto **Vencimientos** con accesos a los expedientes.
- Vendedor: indicadores y filas de su alcance; sin costos, saldos de proveedores ni utilidades.
- Acceso secundario **Productos** dentro del módulo: panel o vista simple de catálogo, no nuevo conjunto de menús.

### 5.2 Nueva cotización

Datos: cliente, obra, descripción, vendedor, fecha, vigencia y condiciones. Crear cliente/obra desde el formulario si tiene permiso. Vendedor se precarga con usuario actual cuando corresponde; administración puede asignarlo. Registrar creador y vendedor por separado.

Partidas: buscador por código/nombre, unidad precargada, cantidad, precio de venta editable solo para Administrador (de solo lectura para vendedor) e importe calculado. Costos internos solo para administración. Subtotal, impuestos y total automáticos. Opciones: Guardar borrador y Guardar/ver cotización.

No exigir pagos, fotos de entrega o proveedor definitivo para guardar un borrador. Validar campos completos al emitir/aceptar. No exigir que el usuario cambie de pantalla para seleccionar productos.

### 5.3 Detalle único

Encabezado con folios, cliente/obra, vendedor, estado y acción Ver cotización. Antes de aceptación: acciones comerciales según permiso. Después: bloques simples de Materiales, Compras vinculadas, Cobros/pagos, Entregas/documentos y Resultado interno. Los bloques sensibles no se envían al vendedor desde servidor.

Las compras pueden mostrarse como filas o sección expandible dentro del detalle. Cada una identifica proveedor, importe, modalidad y próximo vencimiento, con calendario de cuotas expandible. Registrar un pago sobre la compra correcta.

Acciones frecuentes con formularios breves: Registrar cobro, Registrar pago, Registrar entrega y Adjuntar documento. Mostrar inicialmente movimientos recientes y permitir consultar el historial sin salir del expediente.

## 6. Catálogo y precios

**Propuesta de campos mínimos:** código único por empresa, descripción, unidad, precio de venta base, costo de referencia opcional privado, tratamiento de impuesto y activo/inactivo. Proveedor sugerido opcional; no sustituye a la compra real.

Catálogo administrable; productos utilizados se desactivan, no se eliminan con su historial. Definir responsable y archivo de carga inicial; no asumir que la explosión de insumos DUALIA es automáticamente el catálogo de la nueva empresa. Si se importa, validar códigos, unidades, precios y duplicados, con resumen previo de errores.

Reglas propuestas esenciales:
- Seleccionar producto copia sus datos y precio a la partida como fotografía histórica.
- Modificar el precio **en la cotización afecta solo esa cotización** por defecto.
- Actualizar el catálogo es una acción explícita y separada, restringida a administración; no marcarla por defecto al cotizar.
- Cambiar catálogo no recalcula documentos anteriores ni borradores existentes silenciosamente. Si se ofrece actualizar un borrador, mostrar cambios y requerir una acción explícita.
- Conservar precio base aplicado y precio final, autor y fecha del cambio. Un descuento no cambia el costo del proveedor.
- No confundir costo de referencia con costo confirmado de compra. Si falta costo, mostrar resultado incompleto, no asumir costo cero.
- Servidor valida y calcula totales con decimales adecuados; definir redondeo consistente por partida y documento. No confiar en importes enviados por navegador.

**Confirmado P2:** el vendedor no puede modificar precios, descuentos ni importes calculados, ni mantener el catálogo. Solo Administrador puede ajustar el precio al cotizar. Validar en servidor: rechazar alteraciones de precio por API, importación o duplicación; no basta deshabilitar un campo. Conservar precios previamente autorizados por administración al editar otras partes de una cotización; no volver al precio de catálogo silenciosamente.

## 7. Perfiles y permisos

Reutilización de Administrador/Supervisor: propuesta sujeta a inspección del código. Mostrar “Vendedor” como función dentro del módulo, sin renombrar el rol global Supervisor. El campo vendedor identifica responsabilidad comercial, no concede privilegios.

Matriz propuesta para primera versión:

| Capacidad | Administrador | Supervisor con función vendedor |
|---|---|---|
| Consultar expedientes | Toda su empresa | Solo sus cotizaciones y OCs derivadas |
| Crear/editar cotización no aceptada | Sí | Sí, en su alcance |
| Seleccionar producto/ver precio de venta | Sí | Sí |
| Modificar precio en cotización | Sí | No (confirmado) |
| Mantener catálogo global | Sí | No |
| Ver costos, margen y reparto | Sí | No |
| Asignar/reasignar vendedor | Sí | No |
| Registrar aceptación y convertir a OC | Sí | Pendiente P3 |
| Consultar/registrar entregas | Sí | Sí, en su alcance |
| Registrar compras, créditos y pagos | Sí | No por defecto |
| Ver cobros del cliente o registrarlos | Sí | Pendiente P3; restringido hasta definir |
| Cancelar, revertir movimientos o cerrar | Sí, con motivo | No por defecto |

Mapear Director/Master conforme a la política existente, sin degradar permisos actuales ni conceder accesos globales nuevos por accidente. Aplicar restricciones en API, exportaciones, PDFs y archivos, no solo ocultando botones. El vendedor no debe poder descargar una factura de proveedor que revele costos mediante una URL conocida.

## 8. Compras y créditos: prioridad funcional

Una venta puede requerir una o varias compras. **Propuesta:** admitir varias compras simples vinculadas desde el detalle; confirmar volumen habitual sin construir comparativas avanzadas ni inventario.

Compra mínima: proveedor, folio/referencia, partidas/cantidades y costos confirmados, subtotal/impuestos/total, fecha de compra, modalidad **Pago directo / Crédito**, documento y condición de pago.

- Pago directo: registrar obligación y pago efectivo por separado; fecha exigible capturada o confirmada. Guardar la compra no significa pagarla.
- Crédito: calendario de una o varias cuotas, cada una con monto y fecha de vencimiento obligatorios. Capturar fechas explícitas; un generador de plazos sería opcional y no necesario para iniciar.
- No asumir si el plazo corre desde compra, factura o recepción. En primera versión capturar fechas por cuota. La base de plazo solo queda pendiente si se agrega cálculo automático.
- Cambiar vencimiento requiere permiso, motivo e historial. Conservar vencimiento original y vigente.
- Cada compra tiene saldo propio. Mostrar suma en la OC sin perder vencimientos individuales.
- Abonos reducen saldo; un abono parcial no liquida la obligación ni reinicia su vencimiento.
- Método (transferencia/efectivo/etc.) es distinto de modalidad (directo/crédito).

**Confirmado:** el cliente también puede tener crédito y pagos en varias fechas. Su calendario de cobro es independiente del calendario de pago al proveedor. Nunca copiar fechas ni compensar saldos automáticamente entre ambos lados.

**Confirmado: múltiples vencimientos incluidos en la primera versión.** Modelar cuotas y aplicaciones de abonos; no simular cuotas como compras ficticias.

Reglas propuestas para hacerlo sencillo:
- En el mismo detalle, botón “Programar pagos” con filas Fecha / Importe y “Agregar fecha”. Un único pago es un calendario de una cuota.
- La suma de cuotas debe cuadrar con el total exigible. Si hay anticipo, mostrarlo como parte del total y descontarlo una sola vez; nunca sumar total completo más anticipo.
- Cada cuota conserva monto original, fecha, importe aplicado, saldo y estado. El saldo de la obligación es la suma de saldos de sus cuotas.
- Al registrar un abono, proponer aplicación a la cuota pendiente más antigua, mostrar distribución y permitir a administración ajustarla antes de guardar. Esta regla de imputación es una propuesta técnica explícita.
- Un abono puede cubrir parte de una cuota o varias cuotas de la misma obligación; la suma de aplicaciones debe coincidir con el abono, sin duplicar el movimiento.
- No sobreaplicar ni mover pagos ya aplicados silenciosamente al reprogramar. Cambios posteriores preservan historial y requieren motivo.
- Ejemplo: total $12,000, tres cuotas de $4,000. Un abono de $5,000 aplica $4,000 a la primera y $1,000 a la segunda; saldos $0, $3,000 y $4,000, total $7,000. La tercera mantiene su fecha futura aunque la segunda esté vencida.

## 9. Saldos y movimientos

- Saldo cliente = total vigente de OC menos cobros válidos aplicados y ajustes autorizados correspondientes.
- Saldo proveedor = total vigente de compra menos pagos válidos aplicados y ajustes autorizados correspondientes.
- Registrar monto, fecha efectiva, método, referencia, comprobante, autor y obligación vinculada.
- Primera versión (B5, provisional): cada movimiento se aplica a una sola obligación (una OV o una compra) y se distribuye entre sus cuotas. Una transferencia que cubra varias obligaciones se captura como varios movimientos; confirmar P5 antes de ampliar.
- Evitar doble registro por reintento y validar abonos concurrentes. No permitir sobrepago accidental; anticipos excedentes requieren una regla explícita, no saldo negativo silencioso.
- Anular con motivo y conservar registro; recalcular saldo y alertas. No borrar pagos históricos.
- Pagos a socios y abonos a deuda son conceptos distintos de pagar material al proveedor.
- Las transferencias entre empresas del ejemplo DUALIA no son ventas adicionales. No contabilizar todos sus pasos como ingresos del mismo negocio.

## 10. Vencimientos y recordatorios

**Confirmado P6:** notificaciones solo dentro de Arqento en esta primera entrega; no correo, WhatsApp ni push externo. Pendiente únicamente la anticipación y presentación concreta de avisos. No considerar satisfecho este requisito con fechas guardadas sin avisos visibles.

Propuesta de alcance inicial:
- Alertas dentro de Arqento en el listado y detalle, calculadas por cuota de obligaciones activas con saldo pendiente.
- Categorías: Por vencer, Vence hoy y Vencido. Umbral inicial propuesto: 3 días naturales; requiere confirmación.
- Mostrar proveedor/cliente, OC/compra, cuota, vencimiento y saldo de esa cuota, con acción para abrir el expediente. El total vencido suma solo cuotas vencidas pendientes, no las cuotas futuras.
- Fecha anterior a hoy y saldo positivo = vencido. Fecha igual a hoy = vence hoy. Saldo cero = liquidado y sin alerta activa.
- Aplicar zona horaria configurada para la empresa; no desplazar fechas de vencimiento por conversiones UTC. Propuesta inicial de negocio: America/Monterrey.
- Administrador recibe información de pagos a proveedores. El vendedor solo avisos autorizados de su ámbito.
- Avisos calculados al consultar la pantalla funcionan sin scheduler, pero no llegan fuera de Arqento.

B6B implementa estos avisos dentro del listado (bloque «Por atender», solo administración). El vendedor no recibe avisos financieros en esta versión. Ver §20 B6B.

WhatsApp queda fuera de esta entrega y como posible fase siguiente, sin promesa de implementación la próxima semana. No construir ahora infraestructura de envíos externos ni bloquear el módulo por esa integración. Una futura fase requerirá destinatarios autorizados, proveedor de mensajería, costos, programación y deduplicación por cuota. Los avisos internos se actualizan al abonar, liquidar, revertir o reprogramar una cuota. No crear automatizaciones personales de ChatGPT para sustituirlos.

## 11. Entregas y documentos

- Una entrega registra fecha, cantidades por partida, receptor, observaciones, fotos y remisión.
- Calcular pendientes por producto/unidad; evitar sobreentregas accidentales. No sumar piezas, toneladas y metros en un porcentaje engañoso.
- Estados: Pendiente, Parcial y Completa. Completa solo cuando todas las partidas aplicables estén cubiertas.
- Recepción del proveedor y entrega al cliente son hechos distintos, aunque el envío sea directo a obra. Confirmar si necesitan capturar ambos por separado; no duplicar cantidades. B6A implementa solo la entrega al cliente contra la OV (ver §20 B6A); la recepción por compra sigue pendiente.
- Preservar correcciones de entregas en historial. Devoluciones y cambios con movimientos necesitan regla acordada; no editar una entrega antigua para ocultarlos.
- Documentos clasificados por función: cotización, autorización/OC cliente, compra/factura proveedor, comprobante de cobro/pago, remisión y fotos. Controlar visibilidad por rol.
- PDF cliente: marca de la empresa, folio, versión, fecha, vendedor según decisión comercial, cliente/obra, materiales, precios de venta, impuestos, total y condiciones. Nunca costos, margen o reparto.

## 12. Resultado, reparto y deuda opcional

Mostrar resultado estimado de venta menos costos y gastos registrados, con bases de impuestos consistentes. Separar margen estimado de flujo disponible. Un crédito pendiente no desaparece porque haya dinero en banco.

Reparto inicial de referencia 50/50; configurar socios y porcentajes por proyecto si se confirma. Distinguir importe previsto, autorizado y pagado. No distribuir automáticamente por aceptar cotización o recibir un anticipo.

Caso DUALIA: la evidencia revisada identifica abono a deuda de otro proyecto. No denominarlo fondo de ahorro ni tratar el principal como gasto operativo por defecto. Deuda, reserva y reparto tienen movimientos y saldos separados. Confirmar base del descuento, alcance por empresa/proyecto y momento del reparto. Si el primer cliente no lo necesita, posponer la gestión avanzada manteniendo la separación conceptual.

## 13. Modelo conceptual, no esquema obligatorio

| Elemento | Relación/regla |
|---|---|
| Producto | Empresa, código, unidad y precios de referencia |
| Cotización y partidas | Empresa, cliente, obra, vendedor y versión de precios |
| OC de cliente | Referencia única a aceptación de cotización |
| Compra y partidas | OC, proveedor, costos y condiciones propias |
| Obligación | Cobro cliente o pago proveedor; total y saldo independientes |
| Cuota | Obligación, monto, fecha y saldo; una o varias por calendario |
| Movimiento/aplicación | Abono o reversión con evidencia; distribución entre cuotas sin duplicar dinero |
| Entrega y partidas | Cantidades por partida de venta |
| Documento | Expediente/entidad y clasificación de acceso |
| Aviso interno | Derivado de cuota/vencimiento/saldo; envío externo fuera de esta versión |

Claude debe comparar este modelo con Prisma y la lógica existente antes de proponer tablas. No reutilizar entidades solo porque se llaman Cotización u OrdenCompra si representan otra función. No introducir contabilidad completa, inventario o motor genérico de workflows para resolver este módulo.

## 14. Criterios de aceptación y pruebas mínimas

1. Empresa sin módulo no accede por menú, URL ni API; empresa A no puede leer registros/archivos de B.
2. Supervisor de construcción conserva su comportamiento; vendedor comercial puede cotizar sin recibir costos, márgenes o documentos privados.
3. Cambiar precio local no modifica catálogo. Cambiar catálogo no modifica una cotización guardada/aceptada ni su PDF histórico.
4. Vendedor identifica responsable distinto del creador cuando administración registra a su nombre; no se permite reasignación indebida.
5. Borrador no crea cuentas por cobrar/pagar. Dos solicitudes simultáneas de aceptación crean una sola OC.
6. Compra de $11,600 con abono $4,000 deja $7,600 pendientes; compra a crédito exige vencimiento y pago directo no se marca pagado sin movimiento.
7. Cobros del cliente y pagos al proveedor no se compensan ni liquidan entre sí.
8. Probar por vencer, hoy, vencido, liquidado, abono parcial, cambio de fecha y reversión, incluyendo zona horaria.
9. Avisos internos por cuota: liquidar una cuota retira su aviso, mantiene pendientes las otras y no considera vencidas las futuras. No depender de correo ni WhatsApp.
10. Entrega de 40 de 100 deja 60 pendientes; no altera saldo monetario. Varias unidades no producen agregados inválidos.
11. Costos desconocidos muestran resultado incompleto; crédito pendiente no se ofrece como dinero repartible.
12. Anulaciones y cambios registran usuario, fecha y motivo. No hay doble pago por reintento ni sobreaplicación concurrente.
13. Vendedor no accede a cotizaciones de otro vendedor por URL, búsqueda, PDF, archivos ni totales agregados; no altera precios mediante peticiones manipuladas.
14. Probar calendario de $12,000 en tres cuotas y abono de $5,000: saldo $7,000; repetir para cobro cliente y pago proveedor, incluyendo reversión y reprogramación.
15. Probar flujo real completo con administrador y vendedor, PDF cliente, adjuntos desde móvil y regresión de Compras/Construcción.

## 15. Decisiones pendientes antes de cerrar implementación

| ID | Decisión | Propuesta inicial / impacto |
|---|---|---|
| P1 — resuelto (B3) | Qué significa OC y quién genera folio | Orden de venta con folio interno `OV-000001`, consecutivo propio por Empresa; número de OC del cliente opcional y aparte. Ver §20 B3 |
| P2 — resuelto | Edición de precios | Solo Administrador; vendedor no modifica precios |
| P3 — resuelto (B3) | Alcance del vendedor, aceptación y cobros | Vendedor solo ve sus cotizaciones. Registran aceptación: Administrador, Director y el vendedor asignado (solo las suyas), con evidencia obligatoria. Solo Administrador y Director ven y registran cobros (a implementar en el bloque financiero). El vendedor ve precios y totales de venta, nunca cobranza, costos ni utilidad |
| P4 — resuelto en alcance | Crédito cliente/proveedor y varios vencimientos | Incluidos desde primera versión; fechas explícitas por cuota. Base de plazo solo si se agrega cálculo automático |
| P5 — provisional (B5), confirmar | Una transferencia para varias órdenes, anticipos y ajustes | Implementado: un movimiento = una obligación, distribuido entre sus cuotas. Sí se admite el anticipo dentro de una OV o compra (primera cuota de anticipo, dinero antes del vencimiento, aplicación a cuotas futuras de la misma cuenta). Excluidos: anticipos sin documento, saldo a favor, sobrepago, movimientos repartidos entre varios documentos y ajustes. Ver §20 B5 |
| P6 — parcial | Canal interno: confirmado; WhatsApp posterior | Implementado con umbral **provisional** de 3 días naturales (B6B, valor centralizado `DIAS_AVISO_PROXIMO`); falta confirmar el umbral. Ver §20 B6B |
| P7 — parcial | Origen y carga inicial de catálogo | Alta manual implementada (B1). Importación masiva pendiente del archivo que entregará el negocio (columnas, responsable, volumen) |
| P9 — resuelto (B1) | Facultades administrativas y función Vendedor | Administrador y Director administran; Vendedor = Supervisor + marca `vendedorComercial` (falsa por defecto), asignada por Administrador/Director de su Empresa. Ver §20 |
| P12 — provisional (B3), confirmar | Cotizaciones vencidas | No se registra la aceptación de una cotización emitida vencida; se duplica y se emite una nueva. Ver §20 B3 |
| P13 — propuesta implementada (B3), confirmar | Reglas de duplicado y de emisión | Ver «Decisiones provisionales de B3» en §20 |
| P14 — provisional (B4), confirmar | Límites de compras | Sin excedentes sobre lo vendido, sin conversión de unidades, costo > 0, sin PDF de compra; corrección por anulación. Ver §20 B4 |
| P11 — propuesta implementada (B2), confirmar | Vendedores elegibles y mínimos del borrador | Elegibles: Supervisor activo con función Vendedor o Administrador/Director activo. Borrador: folio, vendedor y fecha automáticos + cliente, descripción o un material. Ver §20 |
| P10 — resuelto (B1) | Impuestos del catálogo | Precios sin IVA; tratamiento por producto: Gravado (tasa editable, 16 % como valor inicial), Tasa 0 % y Exento, que se distinguen |
| P8 | Reparto y deuda en primera entrega | Resultado estimado; automatización avanzada después si no es necesaria |

Estas decisiones no detienen la revisión del repositorio ni la preparación de partes independientes. No publicar reglas financieras o permisos ambiguos como definitivos.

## 16. Secuencia de implementación y plazo

1. Inspeccionar repo y entregar mapa de reutilización, diferencias, migraciones y riesgos. Resolver P1–P6 para las partes afectadas.
2. Módulo/empresa/permisos y catálogo con datos iniciales.
3. Cotización, vendedor, precios históricos, PDF y conversión a OC.
4. Compras, obligaciones, calendarios de cuotas y aplicación de abonos para cliente y proveedor.
5. Recordatorios acordados, entregas/evidencias y resultado básico.
6. Pruebas integrales, revisión con dueños y liberación conforme al proceso del repo.

La semana planteada originalmente era una estimación para un alcance menor. Catálogo, restricciones por rol, crédito y avisos requieren reevaluar el plazo después de inspeccionar código y dimensionar los calendarios de cuotas. El canal inicial ya está confirmado: interno. No prometer una semana sin esa revisión ni recortar controles de dinero/permisos para cumplirla.

Fuera del primer alcance propuesto: portal cliente, pasarela de pago, timbrado fiscal, conciliación bancaria automática, inventario multi-almacén, WhatsApp, intereses/moras automáticos, amortización financiera avanzada e intermediación multiempresa automatizada. Los calendarios simples de cuotas SÍ están incluidos. Si alguno es indispensable, incorporarlo explícitamente y reestimar.

## 17. Cómo mantener este documento visible para Claude

Colocar este archivo en `docs/negocio/comercializacion.md`, agregarlo al índice de negocio y añadir al `AGENTS.md` y/o `CLAUDE.md` que ya use el repositorio, sin reemplazar instrucciones existentes:

> Para tareas de Comercialización, leer `docs/negocio/comercializacion.md` antes de proponer o modificar modelos, permisos, cotizaciones, compras, créditos, pagos, recordatorios o entregas. Distinguir acuerdos confirmados de propuestas y pendientes. Actualizar este documento con las decisiones aprobadas y el estado real de implementación. No alterar permisos globales ni flujos de construcción para resolver reglas exclusivas de Comercialización.

Prompt de arranque sugerido:

> Lee las instrucciones del repositorio y `docs/negocio/comercializacion.md`. Primero inspecciona la implementación actual y entrega un plan concreto de reutilización, cambios, migraciones y pruebas; identifica los pendientes que afectan cada parte. Mantén la interfaz sencilla y la separación de cotización, OC cliente y compra proveedor. No implementes supuestos pendientes como decisiones aprobadas. En esta primera revisión no modifiques PRD ni ejecutes migraciones.

## 18. Fuentes y estado

- Requerimientos del usuario y comentarios de reunión, conversación de noviembre de 2026.
- `00-decisiones-fundamentales.md` y `00-indice.md` proporcionados como contexto: multitenancy, marca, permisos, bitácora y preservación histórica.
- Tres propuestas visuales de listado, alta y detalle aceptadas como referencia de estilo; actualizar Nueva operación → Nueva cotización, agregar vendedor y catálogo, y adaptar crédito/permisos.
- Caso documental DUALIA revisado previamente: https://drive.google.com/drive/folders/1lw_5ec1m33FvQ1sOK0KKxuo_Dj5KdLgV . Es ejemplo, no configuración obligatoria para cada empresa.

Estado de implementación al emitir la versión 0.2: no verificado. A partir de la versión 0.3 el estado real se lleva en §20.

## 19. Cambios de versión 0.2

Decisiones confirmadas por el usuario: precios editables solo por Administrador, vendedor limitado a sus cotizaciones, crédito para cliente y proveedor con varias fechas y notificaciones exclusivamente dentro de Arqento. WhatsApp se evaluará después. Se actualizaron formulario, permisos, modelo de cuotas, avisos, pruebas y pendientes para evitar contradicciones con la versión 0.1.

## 20. Estado real de implementación

### B1 — Módulo, permisos y catálogo de productos (implementado, sin desplegar)

Rama `feature/comercializacion`. Migración `20261116120000_comercializacion_b1_catalogo` (aditiva). Aplicada en la base de desarrollo compartida (Neon, antes de B2), en la base local de pruebas y, desde B2, en las bases locales independientes del worktree; **no aplicada en PRD**.

Corrección hecha en B2: la verificación previa de «código ya existe» usaba la comparación sin mayúsculas de Prisma, que se traduce a `ILIKE` y trataba «_» y «%» como comodines (crear `CEM_50` fallaba si existía `CEMX50`). Ahora compara con `lower(codigo)`, la misma expresión del índice único.

Decisiones confirmadas para B1 (noviembre 2026):
- **Administración:** Administrador y Director tienen las facultades administrativas de Comercialización, siguiendo la jerarquía existente. Master solo habilita el módulo por Empresa desde Portal Master; no opera dentro del módulo.
- **Vendedor:** rol Supervisor existente + marca `Usuario.vendedorComercial`, falsa por defecto. Sin rol global nuevo y sin cambios en los permisos de construcción del Supervisor. Un Supervisor sin la marca no entra al módulo; la marca no tiene efecto en otros roles.
- **Asignación de la marca:** Administrador/Director la activan o retiran solo a Supervisores de su propia Empresa (otorgarla exige cuenta activa; retirarla siempre se permite). La acción no cambia rol, Empresa, estado de la cuenta ni otros permisos. Queda en bitácora.
- **Catálogo:** precios sin IVA. Tratamiento de impuesto por producto: Gravado (tasa editable; 16 % es solo el valor inicial del formulario), Tasa 0 % y Exento, distintos entre sí. Código único por Empresa sin distinguir mayúsculas. Costo de referencia opcional y privado. Alta, edición, desactivación y reactivación; los productos no se borran.
- **Vendedor en catálogo:** consulta solo productos activos con su precio de venta; no recibe costos, historial ni datos privados (el servidor no los selecciona).
- **Importes:** aritmética exacta en centavos (sin punto flotante), redondeo half-up al centavo; el servidor normaliza y valida todo importe y la base lo refuerza con restricciones CHECK.
- **Historial:** alta, cambios de precio/costo/impuesto/datos, desactivación (con motivo opcional) y reactivación se registran en la bitácora general con valor anterior y nuevo; visible solo a administración.
- **Proveedor sugerido:** no se incluyó en B1 (no aporta valor sin compras y expondría datos de proveedor). Se evaluará en B4.

Qué puede hacer cada usuario al terminar B1:
- Master: habilitar Comercialización a una Empresa (Portal Master → Empresas → Módulos). No se habilita automáticamente para ninguna Empresa.
- Administrador/Director: ver el módulo, administrar Productos y asignar la función Vendedor.
- Vendedor: ver el módulo y consultar Productos activos con precios de venta.
- «Nueva cotización» aparecía deshabilitado hasta B2 (ya habilitado, ver B2).

### B2 — Clientes, obras comerciales y cotizaciones en borrador (implementado, sin desplegar)

Rama `feature/comercializacion`. Migración `20261117090000_comercializacion_b2_cotizaciones` (aditiva). Aplicada solo en la base de desarrollo **independiente** del worktree (PostgreSQL local en Docker) y en su base de pruebas dedicada; **no** en la base de desarrollo compartida con `develop` ni en PRD.

Entidades (propias del módulo, aisladas por Empresa; no crean Proyecto, contratos ni semanas):
- `ClienteComercial` (nombre único por Empresa sin distinguir mayúsculas ni espacios; contacto y teléfono opcionales).
- `ObraComercial` (de un cliente; nombre único por cliente; ubicación opcional).
- `CotizacionVenta` (estatus BORRADOR; creador y vendedor separados; fecha y vigencia como fechas de calendario; condiciones y observaciones; totales derivados; versión; clave de creación).
- `PartidaCotizacionVenta` (copia histórica del producto y precios).
- La base garantiza con llaves foráneas compuestas que cliente, obra, partidas y productos sean de la misma Empresa y que la obra sea del cliente de la cotización; una obra sin cliente se rechaza.

Reglas implementadas:
- **Alcance:** Administrador/Director ven y editan las cotizaciones de su Empresa; el vendedor solo las asignadas a él (por listado, búsqueda, filtro o ID directo; fuera de alcance = «no existe»).
- **Clientes y obras:** administración y vendedores consultan la lista y dan de alta los mínimos desde el formulario. Un nombre repetido devuelve el registro existente (también evita duplicados por doble clic). Los selectores solo exponen id y nombre, nunca cotizaciones ni importes.
- **Vendedor:** el vendedor siempre queda asignado a sí mismo; enviar otro vendedor se rechaza. Administración asigna un vendedor elegible de su Empresa: Supervisor activo con la función Vendedor, o Administrador/Director activo (administración puede vender directamente). La elegibilidad se valida al asignar; conservar a un vendedor que después perdió la función no falla.
- **Mínimos de un borrador:** el sistema asigna folio, vendedor y fecha (hoy en America/Monterrey, editable); además se exige al menos uno de cliente, descripción o un material. Cliente, obra, vigencia, condiciones y materiales pueden completarse después. Si hay obra, debe haber cliente y ser suyo. La vigencia no puede ser anterior a la fecha.
- **Productos:** buscador de productos activos por código o descripción; al agregar se precargan unidad, precio y tratamiento de impuesto. Un producto inactivo no puede agregarse como partida nueva; sus partidas existentes se conservan.
- **Copia histórica:** cada partida guarda código, descripción, unidad, tratamiento, tasa, precio base (catálogo al agregarla) y precio aplicado. Cambiar o desactivar el producto no altera partidas guardadas; cambiar el precio de una partida no altera el catálogo.
- **Precios:** solo Administrador/Director fijan un precio distinto al de catálogo; queda registrado quién y cuándo. El vendedor cambia cantidades y quita o agrega partidas, pero no precios, impuestos, descuentos ni importes: el servidor rechaza esos campos. Un precio ajustado por administración se conserva cuando el vendedor edita cantidades.
- **Sin costos para el vendedor:** las partidas no guardan costo; el formulario y las respuestas solo usan campos de venta.
- **Folios:** consecutivo propio por Empresa `COT-000001` (`Empresa.ultimoFolioCotizacionVenta`), asignado en la misma transacción; no consume el contador de OC de Compras.
- **Reintentos:** el formulario envía una clave de creación por intento; un doble clic o reintento con la misma clave devuelve la misma cotización y no consume folio. La clave de otra persona no permite recuperar una cotización ajena.
- **Conflictos:** cada guardado envía la versión leída; si otra persona guardó antes, se rechaza sin sobrescribir y se pide recargar.
- **Bitácora:** creación (folio, vendedor, cliente/obra, partidas, total) y cada edición (campos cambiados, vendedor, partidas agregadas/eliminadas/modificadas con cantidad y precio anterior/nuevo, total y versión). Guardar sin cambios no genera registro.
- **Sin efectos financieros:** un borrador no crea OC, compra, cobro, ingreso, egreso, gasto ni deuda.
- **Listado:** «Cotizaciones y órdenes» con cotizaciones reales; filtros por búsqueda (folio, descripción, cliente u obra), cliente, obra y —solo administración— vendedor. Cobro y entrega muestran «No aplica». No se muestran indicadores de saldos, utilidades ni entregas mientras no existan datos reales.

Cálculos (servidor; el navegador solo muestra una vista previa con las mismas funciones):
- **Cantidad:** mayor que 0, hasta 3 decimales (metros, toneladas…), hasta 11 dígitos enteros. Nunca se redondea a entero.
- **Precio unitario:** mayor que 0, 2 decimales, sin IVA.
- **Importe de partida:** cantidad × precio calculado exacto (enteros, sin punto flotante) y redondeado una sola vez, half-up, al centavo.
- **Subtotal:** suma de importes de partida.
- **IVA:** la base gravada se agrupa por tasa; IVA de cada tasa = base × tasa, redondeado half-up al centavo; IVA total = suma por tasa. Tasa 0 % y Exento se muestran como bases separadas con IVA $0.00 y nunca se mezclan entre sí.
- **Total:** subtotal + IVA. La base exige `total = subtotal + iva`.
- Nota: el IVA se redondea por tasa sobre el documento, no por partida. Si en el futuro se facturan cotizaciones con CFDI (que calcula impuesto por concepto) puede haber diferencias de centavos; decidir al llegar a facturación.

Fuera de B2: emitir/PDF, aceptación, conversión a OC, compras, créditos, entregas, resultado, importación de catálogo y navegación móvil.

### Verificación en navegador de B1 y B2 (17 de noviembre de 2026)

Recorrido real en Chrome (automatizado con Playwright, sin cambios en las dependencias del repositorio) contra el servidor de desarrollo del worktree y su base local dedicada, con los usuarios del seed local. Datos de prueba identificados con el prefijo `PRB-` / `[PRUEBA]`; no son datos reales. Capturas sin credenciales; los correos se ocultan antes de capturar.

Verificado:
1. Master habilita Comercialización por Empresa; antes figura como «No incluido en el Plan».
2. Administrador da de alta productos (Gravado 16 %, Tasa 0 %, Exento), con historial; valida precio 0 y código duplicado sin distinguir mayúsculas; marca al Supervisor como vendedor (persiste al recargar y queda en bitácora).
3. Administrador crea cliente y obra desde el formulario, cotización con cantidades 2.375 / 10 / 0.125 / 1.5, precio ajustado ($260.00 contra $245.50 de catálogo) y vendedor asignado. Folio COT-000001.
4. Al salir y reabrir coinciden datos y totales: subtotal $3,428.19; IVA 16 % sobre $2,893.19 = $462.91; base tasa 0 % $355.00; base exenta $180.00; total $3,891.10.
5. El vendedor ve solo su cotización, cambia cantidades (3.5 y 12.5) y guarda; el precio autorizado de $260.00 se conserva. Nuevo total $4,806.21.
6. El vendedor no ve la cotización de administración (404 por URL directa) ni la pantalla de Vendedores. No hay campos de precio ni selector de vendedor. Ningún costo aparece en el HTML ni en la carga enviada al navegador, en Productos ni en la cotización.
7. Dos pestañas sobre el mismo borrador: la segunda recibe el aviso de conflicto, no sobrescribe, y «Recargar» muestra la versión vigente.
8. Buscador con y sin resultados; validaciones de mínimos, vigencia, precio con 3 decimales y cantidad inválida; un cliente repetido reutiliza el existente; doble clic en «Guardar borrador» crea una sola cotización. Sin contenido cortado ni desplazamiento horizontal a 1440, 1280 y 1024 px.

Errores encontrados y corregidos durante la verificación:
- **Formulario de producto (B1):** tras un error de validación se vaciaban Código, Descripción, Unidad y Costo (React 19 reinicia los campos no controlados de un `<form action>`). Ahora son campos controlados y se conservan.
- **Mensajes del formulario de cotización (B2):** el error o conflicto aparecía debajo del botón, fuera de la vista. Ahora aparece arriba del botón, como alerta, y la página se desplaza hasta él.
- **Pestaña activa (B2):** en el detalle de una cotización ninguna pestaña aparecía activa; ahora se marca «Cotizaciones y órdenes».
- **Portal Master, Módulos (previo a Comercialización):** un módulo fuera del Plan sin override se mostraba como «Incluido en Plan», y el selector mostraba «Heredar del Plan» aunque hubiera un override activo. Ahora dice «No incluido en el Plan» y el selector refleja el override real.

No verificado en navegador: vista móvil (fuera de alcance hasta B6).

### B3 — Emisión, PDF, aceptación y orden de venta (implementado, sin desplegar)

Rama `feature/comercializacion`. Migración `20261118090000_comercializacion_b3_emision_ov` (aditiva). Aplicada solo en la base de desarrollo independiente del worktree y en su base de pruebas dedicada; **no** en la base compartida con `develop` ni en PRD.

Decisiones confirmadas (noviembre 2026):
1. **Orden de venta (OV):** folio interno `OV-000001` con consecutivo propio por Empresa (`Empresa.ultimoFolioOrdenVenta`). Guarda aparte, opcionalmente, el número de OC que da el cliente. No reutiliza el consecutivo ni las entidades de Compras de construcción (`OrdenCompra`/`Cotizacion`).
2. **Aceptación:** la registran Administrador, Director y el vendedor asignado (solo sobre sus cotizaciones), con evidencia adjunta obligatoria.
3. **Cobros:** solo Administrador y Director los ven y registran. Es una regla para el bloque financiero; B3 no implementa cobros. El vendedor ve precios y totales de venta de sus cotizaciones, pero no cobranza, costos ni utilidad. En el listado, la columna «Cobro» solo aparece para administración.

Reglas implementadas:
- **Estados:** Borrador → Emitida → Aceptada. Rechazada/Cancelada no están definidas todavía.
- **Emitir** exige cliente, obra del cliente, vendedor elegible en ese momento, descripción, fecha, vigencia (no anterior a hoy) y al menos una partida, sin productos desactivados. Los datos fiscales del cliente no son obligatorios. Usa las reglas exactas de cálculo de B2 y comprueba que los totales guardados coincidan con el recálculo. Emitir guarda antes los cambios del formulario y pide confirmación. No envía correo ni WhatsApp ni significa aceptación. Lo pueden hacer administración y el vendedor asignado.
- **Copia histórica** (`CotizacionVenta.documentoEmitido`): empresa (nombre, razón social y referencia del logo), cliente (nombre, contacto, teléfono), obra (nombre, ubicación), vendedor (nombre), descripción, fechas, condiciones, observaciones, partidas (código, descripción, unidad, cantidad, precio, importe, impuesto) y totales por tasa. No incluye costos, precio de catálogo ni marcas internas de ajuste. La vista y el PDF de una cotización emitida usan solo esta copia.
- **Inmutabilidad:** una cotización emitida o aceptada no se edita. La base lo garantiza con dos triggers: las partidas no cambian, y los datos comerciales, la copia y los totales no cambian. Además, solo puede pasar de Emitida a Aceptada, nunca volver a Borrador.
- **Duplicar** (cotizaciones emitidas o aceptadas): crea un borrador con folio COT nuevo y vínculo al origen (`origenId`); el original queda intacto. Pasa por la misma creación de B2 (permisos de precio y validación de productos) e incluye una clave contra reintentos.
- **PDF** (`/api/comercializacion/cotizaciones/[id]/pdf`): mismo motor e identidad que los PDFs existentes. Incluye logo o nombre de la empresa, folio COT, fecha, vigencia, cliente, obra, vendedor, descripción, materiales con unidad, cantidad, precio, impuesto e importe, Tasa 0 % y Exento por separado, total, condiciones y observaciones. Pie con folio y «Página X de Y»; las partidas no se parten entre páginas. Un borrador genera una vista previa marcada BORRADOR. Protegido por Empresa y vendedor también por URL directa (404).
- **Aceptación:** solo sobre una cotización Emitida y vigente. Pide fecha de aceptación (entre la fecha de la cotización y hoy), evidencia y referencia opcional de la OC del cliente. Se guarda quién la registró y cuándo; es un registro interno de evidencia, no una firma electrónica del cliente.
- **Evidencia:** PDF, JPG o PNG de hasta 10 MB. El tipo se valida por el contenido real del archivo, no por el nombre. Se guarda con la infraestructura de archivos existente bajo `comercializacion/<empresa>/aceptaciones/<cotización>/`. Se descarga solo a través de la aplicación (`/api/comercializacion/ordenes/[id]/evidencia`), con el mismo alcance por Empresa y vendedor.
- **Atomicidad:** primero se sube la evidencia; después una sola transacción bloquea la cotización, asigna el folio OV, crea la OV con los totales emitidos, marca la cotización como Aceptada y registra la bitácora (cotización y OV). Si algo falla, no queda nada aceptado, no se consume folio y la evidencia recién subida se elimina.
- **Una sola OV:** doble clic, reintentos y solicitudes simultáneas devuelven la misma OV. La base lo garantiza con índice único por cotización y bloqueo de fila; las evidencias sobrantes de solicitudes repetidas se eliminan.
- **Sin efectos financieros:** la OV no crea compras, cuotas, cobros, pagos, ingresos, egresos ni entregas, y no toca construcción.
- **Interfaz:**
  - Listado único con distintivos Borrador / Emitida (+ Vencida) / Aceptada y filtro por estado.
  - Una cotización aceptada aparece en una sola fila con el folio OV y su COT debajo.
  - La búsqueda incluye OV y la OC del cliente.
  - Detalle: un borrador se edita; una emitida o aceptada se muestra de solo lectura con «Ver PDF», «Registrar aceptación» (si aplica) y «Duplicar». Si está aceptada, se ven la OV, la fecha, la OC del cliente, la evidencia y quién la registró.
  - Sin secciones nuevas en el menú ni cifras de cobranza o entregas.

Decisiones provisionales de B3 (no confirmadas por el negocio; P12 y P13):
- **Cotización vencida:** como este documento no define cómo aceptar una cotización emitida vencida, esa aceptación se bloquea; se duplica y se emite una nueva.
- **Emisión:** se exige vigencia de hoy en adelante y que ningún material esté desactivado.
- **Duplicado:**
  - Los productos desactivados se omiten y se avisa cuáles.
  - El resto toma los datos actuales del catálogo.
  - Administración conserva el precio aplicado del original (queda como ajuste suyo si difiere del catálogo).
  - El vendedor recibe el precio vigente de catálogo; no hereda precios ajustados.
  - El vendedor queda él mismo. Administración conserva al vendedor original si sigue siendo elegible; si no, queda ella misma.
  - Fecha = hoy; la vigencia se conserva solo si sigue vigente.

Verificado en navegador (Chrome con Playwright, base local dedicada; datos `[PRUEBA]`):
- **Administrador:**
  - Al emitir sin obra se muestra el faltante.
  - Emite y obtiene un PDF de 1 página con el mismo total que en pantalla, Tasa 0 % y Exento por separado, sin costos ni marca BORRADOR.
  - Registra la aceptación con evidencia PDF y obtiene OV-000001.
  - Reabre la OV desde el listado (una sola fila OV / COT) y descarga la evidencia.
  - Al duplicar, el borrador conserva el precio ajustado y su vista previa sale marcada BORRADOR.
- **Vendedor:**
  - Ve solo su OV y no ve la columna Cobro.
  - Descarga su PDF y su evidencia.
  - La cotización, el PDF y la evidencia de administración responden 404 por URL directa.
  - Su duplicado toma el precio de catálogo ($245.50 en lugar de $260.00 ajustado).
  - Emite y acepta su propia cotización; la evidencia inválida se rechaza con mensaje y la PNG se acepta.
- **Almacenamiento:** las evidencias se guardaron en un almacenamiento S3 local de pruebas; el bucket compartido no se usó.
- **Errores encontrados y corregidos:**
  - Actualizaciones de estado durante el render (aceptación de B3 y formulario de producto de B1) que React marcaba como error; ahora ocurren en un efecto.
  - Filtros del listado que se cortaban; ahora se acomodan en varias líneas sin cortarse a 1440, 1280 y 1024 px.

Limitaciones conocidas:
- El PDF se arma al descargarlo a partir de la copia histórica (no se guarda el archivo).
- El logo se toma de la referencia congelada; si ese archivo se borrara del almacenamiento, el PDF usa el nombre de la Empresa de la copia.
- Las pruebas automáticas renderizan el PDF en un proceso aparte, porque `@react-pdf/renderer` no funciona con la condición `react-server` que usan las pruebas; en la aplicación se genera en un route handler, como los demás PDFs.

### B4 — Compras a proveedores de una orden de venta (implementado, sin desplegar)

Rama `feature/comercializacion`. Migración `20261119090000_comercializacion_b4_compras` (aditiva). Aplicada solo en la base de desarrollo independiente del worktree y en su base de pruebas dedicada; **no** en la base compartida con `develop` ni en PRD.

Qué hace:
- Desde una OV aceptada, Administrador o Director registran una o varias compras, cada una a un proveedor.
- Cada compra incluye una o varias partidas de esa OV y cada partida queda vinculada al material vendido. Ejemplo verificado: OV de 100 postes → compra A de 60 + compra B de 40 = 100 comprados y 0 pendientes. Esto no significa pagado, recibido ni entregado.

Modelo:
- `CompraComercial`:
  - Folio `COC-000001`, consecutivo propio por Empresa (`Empresa.ultimoFolioCompraComercial`), separado de las OC de construcción.
  - Estados Borrador / Confirmada / Anulada.
  - Pertenece a una OV y a un proveedor.
  - Guarda fecha, referencia y documento del proveedor, notas, totales, versión y clave de creación.
  - Al confirmar copia el proveedor (nombre, razón social, RFC).
- `PartidaCompraComercial`:
  - Vínculo con la partida de venta.
  - Copia de código, descripción y unidad.
  - Cantidad, costo unitario e impuesto **de compra** (tratamiento y tasa), e importe.
- **Proveedores:** se reutiliza el catálogo existente (`Beneficiario` de tipo PROVEEDOR de la misma Empresa). El alta rápida desde la compra usa el mismo servicio de Catálogos. Solo se agregó un índice único `(id, empresaId)` que no cambia construcción.
- **Integridad garantizada también por la base:**
  - Las llaves compuestas exigen que OV, proveedor y partidas sean de la misma Empresa.
  - Un trigger exige que cada partida comprada sea de la OV de su compra.
  - Las partidas solo cambian mientras la compra está en borrador.
  - Una compra confirmada es inmutable: solo se anula. La referencia y el documento del proveedor pueden agregarse.
  - Una compra anulada es definitiva.
  - Al confirmar, la base bloquea la OV y comprueba que lo confirmado no supere lo vendido.

Reglas implementadas:
- **Permisos:** todo lo de compras exige Administrador o Director (servicio, acciones, página y ruta del documento). El vendedor conserva su OV, pero no recibe compras, proveedores, costos ni documentos de compra, tampoco por API, HTML o URL directa.
- **Cálculo:**
  - Cantidades de hasta 3 decimales e importes exactos con las reglas de B2: importe por partida redondeado half-up, IVA agrupado por tasa, Tasa 0 % y Exento por separado.
  - El impuesto de compra se captura por partida y es independiente del de venta. No hay valor predeterminado; al elegir «Gravado» se sugiere 16 %, editable.
- **Pendiente por comprar** = cantidad vendida − cantidades de compras **confirmadas** no anuladas. Los borradores y las anuladas no consumen. No se permite comprar más de lo vendido. La validación bloquea la OV, así que dos confirmaciones simultáneas no pueden superarlo juntas.
- **Borrador:** se crea vacío desde la OV (con folio). Se capturan proveedor, fecha, cantidades, costos e impuestos; puede quedar incompleto. No cuenta como comprado ni crea compromisos.
- **Confirmar** exige proveedor activo de la Empresa, al menos una partida y costo e impuesto en todas. Un costo faltante nunca se toma como cero. Recalcula importes exactos, congela la copia del proveedor y registra en bitácora.
- **Costo de referencia del catálogo:** solo orientativo. Se muestra a administración como «Ref. catálogo» y nunca se copia como costo confirmado.
- **Anular** (borrador o confirmada) exige motivo, conserva el registro y sus partidas, libera las cantidades y queda en bitácora. La función `motivosQueImpidenAnular` es el punto donde B5 (pagos) y B6 (recepciones) bloquearán una anulación simple. En B4 no hay bloqueos porque esas operaciones no existen.
- **Idempotencia y conflictos:**
  - Crear con la misma clave devuelve el mismo borrador (sin folio duplicado).
  - Confirmar o anular dos veces devuelve el mismo resultado (una sola entrada de bitácora).
  - Guardar con una versión vieja es un conflicto que no sobrescribe.
- **Documento del proveedor:** referencia opcional y archivo PDF/JPG/PNG de hasta 10 MB, validado por contenido. Usa la infraestructura de archivos existente (`comercializacion/<empresa>/compras/<compra>/`) y se descarga solo por la aplicación, solo administración. Reemplazar el archivo conserva el anterior en el almacenamiento y queda en bitácora.
- **Sin efectos:** no se modifican cantidades ni precios de la OV. No se crean OC de construcción, semanas, movimientos semanales, gastos, egresos ni ingresos.
- **Interfaz:**
  - Bloque «Compras a proveedores» en el detalle de la OV, solo para administración: vendido, comprado, pendiente y en borradores por material; lista de compras con proveedor, folio, fecha, importe y estado; botón «Nueva compra».
  - Página de la compra (`/comercializacion/compras/[id]`, sin entrada en el menú) con formulario de borrador, confirmación con aviso, anulación con motivo y documento del proveedor.
  - No se muestran pagos ni saldos por pagar.

Limitaciones de B4 (decisiones provisionales, P14):
- No se permiten compras por encima de lo vendido (sin excedentes ni mermas).
- Se compra en la unidad de la partida de venta (sin conversiones de unidades).
- Una partida de venta aparece a lo más una vez por compra.
- El costo unitario debe ser mayor que 0 (no hay partidas sin costo o bonificadas).
- No hay PDF de compra; el documento del proveedor se adjunta.
- Una compra confirmada no se corrige: se anula y se captura de nuevo.

### B5 — Cuentas por cobrar y por pagar, condiciones, cobros y pagos (implementado, sin desplegar)

Rama `feature/comercializacion`. Migraciones:
- `20261120090000_comercializacion_b5_cuentas` (aditiva, con carga inicial).
- `20261120090100_comercializacion_b5_corrige_suma_cuotas`: corrige una referencia ambigua en la función que valida que las cuotas sumen el total. Se detectó en pruebas antes de cualquier uso real.

Ambas se aplicaron solo en la base de desarrollo independiente del worktree y en su base de pruebas dedicada; **no** en la base compartida con `develop` ni en PRD.

Qué hace:
- **Cuentas:**
  - Cada OV aceptada tiene una cuenta por cobrar y cada compra confirmada una cuenta por pagar.
  - Se crean en la misma transacción que la aceptación o la confirmación; si una falla, no ocurre ninguna.
  - La base garantiza una sola cuenta por documento (índices únicos) y que toda OV y toda compra confirmada tengan la suya (trigger diferido).
- **Carga inicial:** la migración creó, de forma determinista e idempotente, la cuenta de cada OV existente y de cada compra confirmada no anulada, por su total, en «Condiciones por definir». No se inventaron fechas, cuotas ni pagos. En la base de desarrollo: 8 OV → 8 cuentas por cobrar; 1 compra confirmada → 1 cuenta por pagar; la compra anulada no recibió cuenta.
- **Condiciones:**
  - Contado: una sola fecha por el total.
  - Crédito: una o varias cuotas con fecha explícita.
  - Las cuotas deben sumar exactamente el total (centavos exactos, validado en servicio y base). Se permiten fechas pasadas para capturar historia.
  - Mientras la cuenta no tenga movimientos, las condiciones pueden reemplazarse: las cuotas anteriores se marcan sustituidas (no se borran) y se muestran como calendario anterior.
  - En cuanto existe un movimiento, aunque después se anule, el calendario queda fijo (servicio y base).
- **Cobros y pagos (solo Administrador y Director):**
  - Datos: importe, fecha real (no futura), método (transferencia, depósito, efectivo, cheque, tarjeta u otro), referencia, observaciones y comprobante opcional (PDF/JPG/PNG ≤ 10 MB, validado por contenido, en `comercializacion/<empresa>/movimientos/<cuenta>/`, descargable solo por administración).
  - Requiere condiciones definidas.
  - Propone aplicar a la cuota más antigua primero; el usuario puede ajustar la distribución. Un movimiento con varias aplicaciones; la suma de aplicaciones = importe (verificado por la base).
  - No se permite sobrepago ni saldo a favor: el importe no puede superar el saldo, ni una aplicación el saldo de su cuota.
  - Idempotente por clave de registro (un reintento devuelve el mismo movimiento) y seguro ante registros simultáneos: la cuenta se bloquea y la base rechaza excedentes.
- **Anulación de movimientos:** «Anular por error» exige motivo, conserva el movimiento y sus aplicaciones con quién y cuándo, y deja de contarlo en saldos. Es idempotente. Un movimiento no se edita ni se borra.
- **Estados por cuenta y por cuota:**
  - Liquidación: Pendiente / Parcial / Liquidada.
  - Vencimiento: Condiciones por definir / Al corriente / Vence hoy / Vencida.
  - Vencido = saldo de las cuotas cuya fecha ya pasó (no incluye las que vencen hoy). Una cuota liquidada nunca está vencida.
  - «Hoy» se calcula en la zona horaria de la Empresa (`Empresa.zonaHoraria`, opcional, sin pantalla de edición todavía); si no existe o es inválida se usa America/Monterrey.
- **Relación con B4:**
  - Una compra con cualquier historial de pagos, incluso anulados, ya no se anula de forma simple (`motivosQueImpidenAnular`). La pantalla lo explica en lugar de mostrar el botón.
  - Una compra sin movimientos se anula junto con su cuenta por pagar, que queda anulada con el mismo motivo y deja de sumar.
  - Anulación y pago simultáneos son seguros: ambos bloquean la cuenta en el mismo orden y la base solo acepta anular la compra si su cuenta ya está anulada y nunca tuvo movimientos.
- **Interfaz:**
  - Detalle de la OV (solo administración): «Resumen de la orden» (por cobrar, vencido por cobrar, por pagar y vencido por pagar de sus compras confirmadas) y bloque «Cobros del cliente» con condiciones, cuotas, registro e historial.
  - Página de la compra: bloque «Pagos al proveedor» equivalente.
  - Listado de Comercialización (solo administración): indicadores Por cobrar, Vencido por cobrar, Por pagar y Vencido por pagar, y la columna «Cobro» con el estado real.
  - El vendedor no ve cuentas, cuotas, cobros, pagos ni indicadores, tampoco por URL directa.
- **Sin efectos fuera del módulo:** no se crean ingresos, egresos, gastos ni movimientos de construcción. Cobrado no es utilidad; pagado no es recibido.
- **Bitácora:** definir o cambiar condiciones, registrar y anular movimientos y anular la cuenta de una compra quedan registrados.

Verificación:
- Pruebas unitarias (12) e integración (19) de B5, incluido el caso de $12,000.
- Recorrido en navegador local (17 de noviembre de 2026) con datos [PRUEBA]:
  - OV de $12,000 a crédito: $4,000 vencida y $8,000 futura.
  - Abono de $5,000 distribuido 4,000 + 1,000: saldo $7,000, vencido $0, «Parcial · Al corriente».
  - Anulación por error: saldo $12,000, vencido $4,000, calendario fijo.
  - Compra a contado con pago parcial y anulación del pago: la compra sigue sin poder anularse.
  - El vendedor no ve nada de cobranza.

Decisiones provisionales de B5 (confirmar):
- P5: un movimiento se aplica a una sola OV o compra.
  - **Sí incluido — anticipo dentro del documento:** el calendario puede empezar con una cuota de anticipo; el dinero puede registrarse antes de su vencimiento y aplicarse a cuotas futuras de la misma cuenta (propuesta automática o distribución explícita). Verificado con pruebas de integración para cobro y pago (anticipo $3,000 + $9,000).
  - **Excluido:** anticipos sin documento asociado, saldo a favor, sobrepago, movimientos repartidos entre varios documentos, notas de crédito y ajustes.
- La reprogramación del calendario de una cuenta con movimientos no está disponible (queda pendiente definir cómo reasignar aplicaciones con historial).
- Cobros y pagos sin IVA desglosado ni conciliación bancaria; el comprobante es opcional.

### B6A — Entregas parciales al cliente y evidencias (implementado, sin desplegar)

Rama `feature/comercializacion`. Migración `20261121090000_comercializacion_b6a_entregas` (aditiva). Se aplicó solo en la base de desarrollo independiente del worktree y en su base de pruebas dedicada; **no** en la base compartida con `develop` ni en PRD.

Qué hace:
- **Entregas por OV:** una OV aceptada admite varias entregas parciales, numeradas dentro de la OV (Entrega 1, 2, …). Funciona con entrega directa del proveedor a la obra: no exige una recepción en almacén ni elegir una compra.
- **Datos de una entrega:**
  - Fecha real de entrega (no futura; se admiten fechas pasadas).
  - Una o varias partidas de la OV con su cantidad entregada (positiva, hasta 3 decimales, en la unidad de venta).
  - Quién recibe y observaciones, opcionales.
  - Evidencias: fotografías JPG/PNG y/o remisión PDF.
  - Autor y fecha de registro, independientes de la fecha real de entrega.
- **Evidencias:**
  - Obligatorias: al menos una por entrega (servicio y base).
  - Tipo real validado por contenido (misma validación que los demás documentos).
  - Límites explícitos: hasta 10 archivos y 9 MB en total por entrega.
  - Si un archivo es inválido, no se registra nada.
  - Se guardan en `comercializacion/<empresa>/entregas/<OV>/` con tabla, ruta de descarga y permisos propios, separadas de los documentos de compra y de los comprobantes de cobro/pago. La PDF se clasifica como remisión y la imagen como fotografía.
- **Cantidades y estado:**
  - Pendiente por entregar = vendido − entregas vigentes (no anuladas), por partida.
  - No se entrega por encima de lo pendiente, ni partidas de otra OV o Empresa, y cada partida aparece una sola vez por entrega.
  - El registro bloquea la OV, así que dos registros simultáneos no superan juntos lo vendido; la base lo vuelve a comprobar.
  - Estado de la OV: Pendiente (nada entregado), Parcial (algo entregado y quedan pendientes) o Completa (todas las partidas). No se suman unidades distintas: se muestra el avance por partida y «N de M partidas completas».
- **Correcciones:**
  - Una entrega no se edita ni se borra (servicio y base).
  - Administración la anula con motivo: se conservan el registro y sus evidencias, sus cantidades dejan de contar y se recalculan pendientes y estado; después se registra la entrega correcta.
  - La anulación es atómica e idempotente.
  - No es una devolución física.
- **Idempotencia y archivos:**
  - Registrar con la misma clave (doble clic, reintento o solicitudes simultáneas) devuelve la misma entrega.
  - Si la operación falla, no queda ninguna cantidad aplicada y se eliminan los archivos recién subidos. Nunca se borran evidencias de una entrega válida.
  - La base solo admite partidas y evidencias en la misma transacción que crea la entrega.
- **Permisos (revalidados en cada petición):**
  - Administrador y Director consultan, registran y anulan entregas de su Empresa.
  - El vendedor consulta y registra entregas solo de sus OV asignadas, y descarga sus evidencias. No anula, ni recibe costos, compras, proveedores, cobros o pagos.
  - Fuera del alcance (otra Empresa u OV ajena) la respuesta es «no encontrado», también por URL directa de la página o de la evidencia.
- **Sin efectos:** registrar o anular una entrega no modifica precios, compras, cuentas, cobros, pagos, vencimientos ni construcción. Una venta puede estar entregada y pendiente de cobro.
- **Interfaz:**
  - Bloque «Entregas y documentos» en el detalle de la OV (administración y vendedor asignado), con tabla por material (vendido, entregado y pendiente), historial con fecha, cantidades y evidencias, «Registrar entrega» y «Anular por error» solo para administración.
  - La columna «Entrega» del listado muestra el estado real y las partidas completas; las cotizaciones sin aceptar muestran «No aplica».
  - Sin sección nueva en el menú.

**Relación con compras (B4) — expresamente:**
- B6A acredita **entrega al cliente**; **no** acredita la recepción de una compra (COC) específica.
- No se vinculan entregas con compras, ni se marcan compras como recibidas o entregadas.
- Una entrega real no se bloquea porque la captura administrativa de la compra esté pendiente.
- La recepción por COC y su bloqueo de la anulación simple de una compra (`motivosQueImpidenAnular`) **siguen pendientes**. El control de recepciones de B4 **no** está terminado.
- La estructura (partidas de entrega ligadas a la partida vendida) permite agregar después el vínculo con compras o recepciones sin rehacer las entregas.

Verificación:
- 7 pruebas unitarias y 11 de integración. Incluyen el caso de 100 postes y 2.375 m, excedente rechazado, completa, anulación y recuperación; registros simultáneos; reintentos; fracciones exactas; archivos válidos e inválidos; aislamiento entre empresas y vendedores; vendedor sin anulación; saldo por cobrar intacto con la OV entregada; y ninguna modificación a compras ni construcción.
- Recorrido en navegador local (17 de noviembre de 2026) con datos [PRUEBA]:
  - OV de 100 postes y 2.375 m. Entrega 1 de 60 y 1.250 con foto y remisión: Parcial, pendientes 40 y 1.125. Descarga de evidencias.
  - Excedente de 41 rechazado (aviso en pantalla y mensaje del servidor).
  - Entrega 2 del vendedor por lo pendiente: Completa.
  - El vendedor recibe 404 en una OV ajena y en su evidencia, y no ve la acción de anular.
  - Anulación de la Entrega 1 por administración: Parcial, pendientes 60 y 1.250, y la evidencia sigue disponible.

Limitaciones y decisiones provisionales de B6A (confirmar):
- **Límite de tamaño:** 9 MB en total por entrega. El `proxy.ts` de la aplicación solo conserva 10 MB del cuerpo de cada solicitud: por encima de eso, la solicitud falla antes de llegar al servicio. Se comprobó en local con un comprobante de B5 de 10.5 MB, que devolvió 500. Afecta también a los comprobantes de B5 (hasta 10 MB) y a cargas existentes de otros módulos. Ampliar el límite (`experimental.proxyClientMaxBodySize`) es un cambio global de configuración y queda pendiente de aprobación.
- Las evidencias solo se adjuntan al registrar la entrega; no se agregan después (para completar, se anula y se registra de nuevo).
- No se valida que la fecha de entrega sea posterior a la aceptación de la OV (no hay regla acordada).
- Sin devoluciones físicas ni cambios de material.
- Indicador «Entregas pendientes» en la cabecera del listado: agregado en B6B.

### B6B — Recordatorios internos de cobros y pagos (implementado, sin desplegar)

Rama `feature/comercializacion`. **Sin migración:** los avisos se calculan al consultar y no tienen tabla, cron ni envíos.

Qué hace:
- **Fuente única:** los avisos salen de las cuentas, cuotas y aplicaciones reales de B5 (el mismo cálculo de saldos que la pantalla de cobros y los indicadores). No hay otra fuente de saldos ni avisos guardados, así que recargar o entrar con varios usuarios no genera duplicados.
- **Categorías** (por cuota con saldo positivo de una cuenta vigente, una sola categoría por cuota):
  - Vencidos: vencimiento anterior a hoy.
  - Vencen hoy: vencimiento igual a hoy.
  - Próximos: de mañana a hoy + 3 días naturales, inclusive.
  - Condiciones por definir: cuenta vigente con saldo y sin calendario. Una entrada por cuenta, sin fecha; no se clasifica como vencida.
  - Las cuotas que vencen después del día 3 no generan aviso.
- **Exclusiones:** cuentas anuladas (incluida la de una compra anulada) y cuotas liquidadas. Las cuotas sustituidas por un cambio de calendario no cuentan.
- **Importe:** el saldo pendiente de la cuota (no su importe original ni el saldo de la cuenta). En «Condiciones por definir», el saldo de la cuenta.
- **Fechas:** «hoy» en la zona horaria de la Empresa, con las mismas reglas de B5 (America/Monterrey si no está definida), comparando fechas de calendario sin conversiones UTC.
- **Actualización:**
  - Un abono baja el importe; liquidar la cuota quita su aviso; anular el movimiento lo vuelve a mostrar.
  - Anular una compra sin pagos quita los avisos de su cuenta.
  - Cambiar un calendario (permitido por B5 solo sin movimientos) reemplaza los avisos anteriores.
  - Se recalcula al abrir la página, al regresar a ella (también con el botón Atrás o al volver a la pestaña) y después de cobros, pagos, cambios de condiciones, compras y entregas.
  - Si la página sigue abierta al cambiar el día en la zona de la Empresa, vuelve a pedir la consulta al servidor, que es quien clasifica.
- **Sin acciones de «resolver»:** el aviso no tiene «Marcar como pagado» ni «Descartar»; se resuelve registrando el cobro o pago real en el documento.
- **Permisos:** solo Administrador y Director de la Empresa, con el módulo habilitado. El servidor no calcula nada para el vendedor, ni conteos, ni importes, ni clientes o proveedores, aunque abra la URL con parámetros. Los permisos y avisos de construcción no cambian.
- **Interfaz** (listado de Comercialización, solo administración, sin sección nueva en el menú ni campana global):
  - Bloque «Por atender» con cuatro pestañas: Vencidos, Vencen hoy, Próximos 3 días y Condiciones por definir.
  - Cada pestaña muestra «Por cobrar» y «Por pagar» por separado, con número de cuotas (o de cuentas, en Condiciones por definir) e importe. Nunca se compensan.
  - Cada fila: tipo (cobro o pago), cliente o proveedor, folio OV o COC, número de cuota, vencimiento, saldo pendiente y enlace «Ir a cobros» o «Ir a pagos» al bloque financiero del documento.
  - Orden por fecha ascendente: vencidos desde el más antiguo, hoy y próximos desde el más cercano.
  - 10 filas y «Ver más» (de 10 en 10, hasta 500). Conteos y totales corresponden a la categoría completa, no a las filas visibles.
- **Indicador «Entregas pendientes»** (cabecera del listado, solo administración): número de OV aceptadas con al menos una partida pendiente de entregar, contadas una vez por OV, con las reglas de B6A. Excluye cotizaciones sin aceptar y OV completas; anular una entrega lo actualiza. No suma unidades distintas y está separado de los importes.
- **Sin efectos:** consultar los avisos no escribe nada (ni saldos, ni bitácora, ni construcción).

Verificación:
- 7 pruebas unitarias y 10 de integración con fecha controlada (parámetro de la consulta; sin cambiar el reloj ni los datos). Cubren:
  - Cuota vencida, de hoy, de mañana, a 3 días y a 4 días.
  - Medianoche en la zona de la Empresa y zona configurada distinta.
  - Abono parcial, liquidación y anulación del movimiento.
  - Cuenta sin calendario, compra anulada y reprogramación.
  - Varias cuotas de una cuenta, paginación con totales completos y parámetros inválidos.
  - Separación entre por cobrar y por pagar.
  - Aislamiento entre empresas, bloqueo del vendedor y del usuario sin módulo.
  - Entregas pendientes: parcial, completa y anulación.
  - Consultas repetidas y simultáneas sin cambios en saldos, bitácora ni construcción.
- Recorrido en navegador local (17 de noviembre de 2026) con datos [PRUEBA] (OV-000012 a crédito: $4,000 vencida el 13 nov, $3,000 el 19 nov y $5,000 a 30 días):
  - Con calendario, la cuota 1 aparece en Vencidos ($4,000), la cuota 2 en Próximos ($3,000) y la cuota 3 en ninguna categoría.
  - «Ir a cobros» abre la OV en su bloque de cobros.
  - Un abono de $1,500 y regreso con Atrás: el aviso muestra $2,500.
  - Liquidar con $2,500 quita el aviso. Anular ese cobro lo devuelve con $2,500.
  - «Ver más» con 11 cuentas sin condiciones (incluida la nueva OV-000013 a $12,000): 10 visibles, después 11, con los totales sin cambio.
  - El vendedor no recibe el bloque, ni conteos, ni importes, tampoco forzando los parámetros en la URL.
  - Sin errores en consola.

Decisiones provisionales de B6B (confirmar):
- Umbral de «Próximos»: 3 días naturales (P6; propuesta, no confirmada por el negocio). Se cambia en un solo lugar.
- El vendedor no recibe avisos financieros. §10 menciona «avisos autorizados de su ámbito», pero no hay ninguno definido.
- Los avisos solo se ven en el listado de Comercialización. No hay campana global, avisos en el Inicio, correo ni WhatsApp.
- Orden dentro de «Condiciones por definir»: por folio (no tienen fecha).

### Defecto funcional pendiente antes de publicar (fuera de Comercialización)

**Ciclo de redirecciones con una cookie de sesión inválida.**
- **Qué pasa:** si el navegador conserva la cookie `conkuali_session`, pero la sesión ya no existe en la base (sesión borrada, usuario o empresa desactivados, o cookie de otro entorno en el mismo host), `/dashboard` redirige a `/login` y `proxy.ts` (que solo revisa que exista la cookie) devuelve a `/dashboard`, en un ciclo sin fin.
- **Dónde se vio:** en la prueba local, por compartir el host `localhost` con el entorno de `develop`.
- **Alcance:** es código anterior a Comercialización y también puede ocurrir en producción.
- **Clasificación:** defecto funcional, no ajuste visual. No se corrigió en B4; requiere una corrección acotada de autenticación (por ejemplo, borrar la cookie al detectar una sesión inválida) antes de publicar.

### Pendientes para B6 y posteriores

- Confirmar las decisiones provisionales P11, P12, P13 y P14.
- Confirmar P5 y las decisiones provisionales de B5 (reprogramación con pagos, saldo a favor, pagos agrupados, ajustes).
- Pantalla para editar la zona horaria de la Empresa (hoy se usa America/Monterrey si no está definida).
- Confirmar el umbral de avisos «Próximos» (P6, 3 días provisional) y si el vendedor debe recibir algún aviso.
- Agregar evidencia a una entrega existente sin anularla.
- Validaciones y mensajes de error de cargas cercanas al límite de tamaño.
- Recepciones por compra (COC) y su bloqueo de la anulación simple de una compra; el control de recepciones de B4 no está terminado.
- Decidir si se amplía el límite de 10 MB por solicitud del proxy (afecta evidencias de entrega, comprobantes de B5 y cargas de otros módulos).
- P7 (importación del catálogo) y P8 (reparto y deuda) siguen pendientes.
- Estados Rechazada/Cancelada de una cotización: no definidos.
- Corrección del ciclo de redirecciones por cookie inválida (ver arriba).
- Ajustes visuales y navegación móvil.

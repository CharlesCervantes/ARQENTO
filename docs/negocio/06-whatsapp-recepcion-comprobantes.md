# Recepción de comprobantes por WhatsApp — Fase 2A

**Grupo Conkuali — Sistema de Gestión de Obra (Arqento)**
Noviembre 2026. Reglas de negocio aprobadas para recibir fotografías y PDF de
comprobantes en el número oficial de WhatsApp de ARQENTO. Complementa
`05-modulo-contabilidad.md`.

---

## 1. Alcance

Un usuario con su WhatsApp vinculado puede enviar al número oficial la fotografía o
el PDF de un comprobante. ARQENTO lo **recibe y lo guarda** como documento pendiente
de revisión humana en Contabilidad → Egresos, bandeja «Recibidos por WhatsApp».

En esta fase **no** se analiza el documento, no se crea ningún gasto ni egreso y no
se llama a ninguna IA. Registrar el gasto a partir del comprobante corresponde a la
Fase 2B.

## 2. Quién puede enviar y quién puede ver

- Puede enviar cualquier usuario con vínculo de WhatsApp verificado, autorizado para
  WhatsApp, activo, de una Empresa activa con WhatsApp habilitado. Incluye al
  Supervisor.
- Enviar comprobantes **no** da acceso a Contabilidad ni a documentos privados.
- La bandeja solo la ven Administrador y Director (`puedeVerContabilidad`), y siempre
  limitada a su propia Empresa.
- La bandeja depende de que WhatsApp esté habilitado para la Empresa, **no** de
  ARQENTO IA. Con ARQENTO IA apagada, recibir un comprobante nunca crea análisis.
- La autorización se revalida al momento de guardar: si se retiró mientras se recibía
  el archivo, no se guarda.

## 3. Empresa del comprobante

- Un número vinculado a una sola Empresa: el comprobante es de esa Empresa.
- Un número vinculado a varias Empresas: se usa la Empresa elegida en los últimos
  30 minutos. Sin selección vigente, ARQENTO pide elegir la Empresa y reenviar el
  comprobante. **Nunca se asigna una Empresa por omisión.**

## 4. Archivos aceptados

- Fotografía JPG o PNG, o PDF, de hasta 10 MB y 20 páginas.
- El tipo se decide por el contenido real del archivo, nunca por lo que declare quien
  lo envía. Un archivo disfrazado se rechaza.
- HEIC, WebP, audio, video y stickers no se reciben; el remitente recibe un aviso con
  los formatos aceptados.

## 5. Pie de foto

El texto que acompaña al archivo se guarda como **nota de quien lo envió**: una sola
línea, máximo 200 caracteres, sin caracteres de control. Es contexto, nunca
información financiera confirmada.

## 6. Archivo repetido

- El mismo archivo (misma huella SHA-256) en la misma Empresa **no** crea otro
  documento ni otra copia del archivo. Esto incluye un documento que ya se había
  subido desde la web.
- El remitente recibe la misma confirmación que con un archivo nuevo; no se le revela
  que ya existía.
- La recepción repetida queda identificada internamente (registro del mensaje y
  bitácora del documento: quién lo volvió a enviar y por qué canal). Un pie de foto
  distinto se agrega como anotación, sin sustituir la nota original.
- Un documento ya **descartado** no se reutiliza: si el archivo vuelve a llegar, es
  un documento nuevo y visible en la bandeja.
- Dos Empresas nunca comparten documentos ni archivos, aunque sean idénticos.

## 7. Confirmación al remitente

La confirmación «Recibimos tu comprobante» se envía **solo después** de que el
archivo está almacenado y el documento existe. Todas las respuestas son genéricas:
nunca incluyen importes, proveedores, obras ni datos de otros usuarios.

## 8. Recepción interrumpida

Ningún comprobante válido se descarta en silencio.

- Cada recepción avanza por etapas que quedan registradas: asignada a su Empresa,
  archivo resguardado, documento guardado o rechazada con aviso.
- Una recepción interrumpida se reanuda donde quedó: con la reentrega de WhatsApp,
  con el siguiente mensaje que llegue, con «Reintentar recepción» en la bandeja o
  desde el Portal Master.
- Tras 3 intentos automáticos fallidos la recepción queda **detenida**: no se pierde
  ni se borra, el remitente recibe un aviso una sola vez y la bandeja la muestra como
  pendiente hasta que alguien la reintente.
- Abrir la bandeja solo muestra lo pendiente; reintentar es siempre una acción
  explícita.
- Limitación conocida: sin mensajes nuevos y sin que alguien abra la bandeja, una
  recepción interrumpida espera. WhatsApp conserva el archivo original 7 días; pasado
  ese plazo, si el archivo no alcanzó a resguardarse, se pide reenviarlo.

## 9. Límites contra abuso

- Por número, en una ventana de 10 minutos: hasta 50 archivos y, aparte, hasta 20
  mensajes de otro tipo. Los archivos no consumen el límite de los mensajes ni al
  revés.
- El archivo que excede el límite no se descarga ni se guarda, pero **nunca en
  silencio**: queda registrado como no guardado por límite, ligado a su Empresa, el
  remitente recibe un aviso para reenviarlo y la bandeja lo informa.
- El límite se cuenta por orden de llegada: un álbum enviado de golpe guarda siempre
  los primeros.
- Archivos de un número sin vínculo nunca se descargan.
- Los valores (50 archivos, aviso hasta el doble del límite) son iniciales y pueden
  ajustarse según el uso real.

## 10. Descartar un comprobante recibido por error

- Administrador o Director puede descartar un comprobante de la bandeja que todavía
  no se haya registrado.
- Al descartarlo se **elimina el archivo** del almacenamiento privado y se borran su
  nombre y la nota; queda solo la bitácora mínima (quién, cuándo, que se descartó y
  que se eliminó el archivo).
- Nunca se elimina un archivo que use otro registro.
- Si la eliminación del archivo falla, el documento queda descartado con
  «eliminación pendiente» y se puede reintentar; nunca se informa que se eliminó
  antes de que ocurra.
- No se puede descartar un documento ya registrado como gasto ni uno subido desde la
  web.

## 11. Datos personales y retención

- Del remitente solo se conserva un identificador cifrado (HMAC). Su número, el texto
  y los datos del archivo se guardan solo mientras la recepción está en curso o
  detenida, y se borran al terminar.
- El registro del mensaje que dio origen a un documento se conserva como
  trazabilidad; los demás registros operativos se depuran a los 90 días.

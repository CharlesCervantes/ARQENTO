# Despliegue y migraciones de base de datos

## Regla

**Las migraciones se aplican a la base de producción ANTES de desplegar el código que las usa.**
El build de Vercel no aplica migraciones; solo verifica que no falte ninguna.

Motivo (incidente 13-nov-2026): producción recibió código que usaba
`empresas.inteligenciaHabilitada` mientras su base tenía 6 migraciones sin aplicar
(desde `20261003194511_carga_inteligente_documentos_v1`). Aprobar un gasto pagado por
un beneficiario fallaba al generar el folio de reposición. La transacción se revirtió
completa; no hubo cambios parciales.

## Candado en el build

`npm run build` ejecuta primero `scripts/despliegue/verificar-migraciones.mjs`:

- Fuera de `VERCEL_ENV=production` no hace nada (local, Preview).
- En producción exige `DATABASE_URL` (pooler) y `DIRECT_URL` (directa) apuntando al
  **mismo** endpoint/base de Neon, y que `prisma migrate status` reporte la base al día.
  Si no, el build se detiene y el despliegue anterior sigue sirviendo.
- No escribe nada en la base ni imprime cadenas de conexión.

Requisitos en Vercel → Settings → Environment Variables → **Production**:
`DATABASE_URL` y `DIRECT_URL` de la base de producción. Build Command: el
predeterminado (`npm run build`), no `next build` directo.

## Procedimiento para aplicar migraciones en producción

1. Respaldo: en la consola de Neon (proyecto de producción) crear una rama desde
   `main` llamada `respaldo-AAAA-MM-DD-antes-migraciones`.
2. En una terminal (nunca en archivos), definir solo para esa sesión:
   `$env:DIRECT_URL = "<conexión DIRECTA de producción, sin -pooler>"`
3. `npx prisma migrate status` — confirmar que el datasource es el endpoint de
   producción y revisar la lista de pendientes.
4. `npx prisma migrate deploy`
5. `npx prisma migrate status` — debe decir *Database schema is up to date!*
6. `Remove-Item Env:DIRECT_URL`
7. Desplegar (merge a `main`).

Nunca usar `prisma migrate reset`, `prisma migrate dev` ni `prisma db push` contra
producción. Las migraciones deben ser aditivas/compatibles con el código anterior,
porque entre los pasos 4 y 7 el código viejo sigue atendiendo usuarios.

## Objetos manuales que Prisma no representa

Algunas migraciones agregan a mano objetos que `schema.prisma` no puede expresar:
CHECK, triggers, índices parciales y por expresión. Prisma ignora los CHECK y los
triggers, pero **sí** detecta un índice único escrito a mano y, al comparar con el
esquema, propone eliminarlo:

- `ordenes_venta_cotizacion_unica` — una sola orden de venta por cotización
  (Comercialización B3). `prisma migrate diff` lo reporta como
  *Removed unique index on columns (cotizacionId)*. **Es intencional: no se elimina
  para que coincida el esquema.**

Reglas:

1. Al generar una migración con `prisma migrate dev` (solo en bases locales), revisar
   el SQL antes de confirmarla y quitar cualquier `DROP INDEX` / `DROP TRIGGER` /
   `DROP CONSTRAINT` sobre estos objetos que no sea parte deliberada del cambio.
2. Las pruebas lo vigilan: `tests/comercializacion/objetos-manuales-migraciones.test.ts`
   (ninguna migración puede borrar los índices protegidos) y
   `tests/integracion/comercializacion-objetos-manuales.test.ts` (existen después
   de migrar).
3. Para agregar un objeto manual nuevo, sumarlo a esas pruebas y a esta lista.

## Estado conocido de producción (19-nov-2026)

PRD tiene aplicadas dos migraciones de WhatsApp (`20261020120000_whatsapp_v1_vinculacion`
y `20261110120000_whatsapp_fase2a_recepcion_documentos`) cuyo código todavía no está
en `main`. Son aditivas (tablas nuevas y columnas con valor por defecto), el código
de `main` funciona con ellas y `prisma migrate status` las tolera. Por eso
`prisma migrate diff` contra PRD lista tablas y columnas de WhatsApp como
«eliminadas»: **nunca** aplicar ese diff. Se integran al llegar WhatsApp a `main`.

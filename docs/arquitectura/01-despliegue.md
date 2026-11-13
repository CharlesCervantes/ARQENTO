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

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { hashPassword, verifyPassword } from "@/lib/crypto/password";
import { MASTER_PREVIEW, restablecerPasswordMasterTx, type Consultar } from "@/scripts/preview/base-preview";
import { admin, baseLimpiaConDatos } from "./apoyo/base";

// Restablecimiento de la contraseña del Master ficticio de Preview: las
// sentencias SQL reales contra PostgreSQL LOCAL (base de pruebas protegida;
// nunca Neon), con el mismo hash del sistema. Las validaciones de conexión y
// del marcador se prueban sin conexión en tests/seguridad/preparacion-preview.

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.usuario.create({
    data: { id: MASTER_PREVIEW.id, nombre: MASTER_PREVIEW.nombre, email: MASTER_PREVIEW.email, passwordHash: await hashPassword("anterior-ficticia"), rol: "MASTER", empresaId: null, debeCambiarPassword: false },
  });
  const expiraEn = new Date(Date.now() + 3_600_000);
  await db.sesion.createMany({
    data: [
      { usuarioId: MASTER_PREVIEW.id, tokenHash: "hash-ficticio-1", expiraEn },
      { usuarioId: MASTER_PREVIEW.id, tokenHash: "hash-ficticio-2", expiraEn },
      { usuarioId: admin.id, tokenHash: "hash-ficticio-3", expiraEn },
    ],
  });
});

const restablecer = () =>
  db.$transaction((tx) => {
    const consultar: Consultar = (sql, parametros = []) => tx.$queryRawUnsafe(sql, ...parametros);
    return restablecerPasswordMasterTx(consultar, hashPassword);
  });

describe("Preview en PostgreSQL — restablecer la contraseña del Master ficticio", () => {
  test("Nueva contraseña válida con el hash del sistema, cambio obligatorio, sesiones del Master cerradas y nadie más afectado", async () => {
    const otrosAntes = await db.usuario.findMany({ where: { id: { not: MASTER_PREVIEW.id } }, orderBy: { id: "asc" } });
    const { password, sesionesCerradas } = await restablecer();

    const master = await db.usuario.findUniqueOrThrow({ where: { id: MASTER_PREVIEW.id } });
    assert.equal(await verifyPassword(password, master.passwordHash), true, "la contraseña mostrada inicia sesión");
    assert.equal(await verifyPassword("anterior-ficticia", master.passwordHash), false, "la anterior deja de valer");
    assert.equal(master.debeCambiarPassword, true);
    assert.equal(sesionesCerradas, 2);
    assert.deepEqual((await db.sesion.findMany()).map((s) => s.usuarioId), [admin.id]);
    assert.deepEqual(await db.usuario.findMany({ where: { id: { not: MASTER_PREVIEW.id } }, orderBy: { id: "asc" } }), otrosAntes);

    const auditoria = await db.registroAuditoria.findMany({ where: { entidad: "Usuario", entidadId: MASTER_PREVIEW.id } });
    assert.equal(auditoria.length, 1);
    assert.deepEqual(auditoria[0].valorNuevo, { accion: "password_temporal_regenerada", origen: "script-preview", sesionesCerradas: 2 });
    const [fila] = await db.$queryRawUnsafe<{ t: string }[]>(
      `SELECT (SELECT string_agg(row_to_json(u)::text, '') FROM usuarios u) || (SELECT string_agg(row_to_json(a)::text, '') FROM registros_auditoria a) AS t`
    );
    assert.ok(!fila.t.includes(password), "la contraseña nunca queda en claro");
  });

  test("Si el usuario no es el Master de la semilla (tiene Empresa o está desactivado), no cambia nada", async () => {
    const hashAntes = (await db.usuario.findUniqueOrThrow({ where: { id: MASTER_PREVIEW.id } })).passwordHash;
    await db.usuario.update({ where: { id: MASTER_PREVIEW.id }, data: { activo: false } });
    await assert.rejects(restablecer(), /desactivado/);
    await db.usuario.update({ where: { id: MASTER_PREVIEW.id }, data: { activo: true, rol: "DIRECTOR", empresaId: admin.empresaId } });
    await assert.rejects(restablecer(), /no coincide/);
    const despues = await db.usuario.findUniqueOrThrow({ where: { id: MASTER_PREVIEW.id } });
    assert.equal(despues.passwordHash, hashAntes);
    assert.equal(await db.sesion.count(), 3);
    assert.equal(await db.registroAuditoria.count(), 0);
  });

  test("Una falla dentro de la transacción la revierte completa", async () => {
    const hashAntes = (await db.usuario.findUniqueOrThrow({ where: { id: MASTER_PREVIEW.id } })).passwordHash;
    await assert.rejects(
      db.$transaction(async (tx) => {
        await restablecerPasswordMasterTx((sql, parametros = []) => tx.$queryRawUnsafe(sql, ...parametros), hashPassword);
        throw new Error("Falla simulada antes de confirmar");
      }),
      /Falla simulada/
    );
    assert.equal((await db.usuario.findUniqueOrThrow({ where: { id: MASTER_PREVIEW.id } })).passwordHash, hashAntes);
    assert.equal(await db.sesion.count(), 3);
  });
});

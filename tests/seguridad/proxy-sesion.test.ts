import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";

// Ciclo de redirecciones con cookie de sesión inválida (corrección de
// noviembre de 2026). El proxy solo ve la PRESENCIA de la cookie, que no
// demuestra una sesión válida: nunca debe enviar /login → /dashboard por sí
// mismo (eso, con /dashboard → /login de la verificación real, era el ciclo).
// La verificación autoritativa sigue en la DAL (requireSession / layout de
// /login).

const pedir = (ruta: string, cookie?: string) => {
  const req = new NextRequest(new URL(ruta, "http://localhost:3100"));
  if (cookie !== undefined) req.cookies.set(SESSION_COOKIE_NAME, cookie);
  return proxy(req);
};
const destino = (r: Response) => r.headers.get("location");

describe("proxy y cookie de sesión", () => {
  test("sin cookie: rutas privadas van a /login; /login se muestra", () => {
    for (const ruta of ["/dashboard", "/comercializacion", "/master"]) {
      const r = pedir(ruta);
      assert.equal(r.status, 307);
      assert.equal(new URL(destino(r)!).pathname, "/login");
      assert.equal(new URL(destino(r)!).origin, "http://localhost:3100", "destino interno, nunca externo");
    }
    assert.equal(destino(pedir("/login")), null);
  });

  test("con cookie (válida o no): /login ya no redirige desde el proxy", () => {
    const r = pedir("/login", "cookie-inventada-de-prueba");
    assert.equal(destino(r), null);
    assert.equal(r.headers.get("x-middleware-next"), "1");
  });

  test("con cookie: las rutas privadas pasan a la verificación real (no se omite ningún control)", () => {
    const r = pedir("/dashboard", "cookie-inventada-de-prueba");
    assert.equal(destino(r), null);
    assert.equal(r.headers.get("x-middleware-next"), "1");
  });
});

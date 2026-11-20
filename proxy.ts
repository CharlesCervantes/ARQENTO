import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";

// Solo lee la presencia de la cookie (chequeo optimista) — nunca consulta la
// base de datos aquí. La verificación real y autoritativa vive en la DAL
// (lib/server/auth/dal.ts), que corre cerca de los datos.
const PUBLIC_ROUTES = ["/login"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const tieneSesion = request.cookies.has(SESSION_COOKIE_NAME);
  const esRutaPublica = PUBLIC_ROUTES.includes(pathname);

  if (!tieneSesion && !esRutaPublica) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Con cookie en /login NO se redirige aquí: la presencia de la cookie no
  // demuestra que la sesión sea válida (sesión borrada o vencida, usuario o
  // Empresa desactivados, cookie de otro entorno). Redirigir a /dashboard por
  // la sola cookie provocaba un ciclo infinito /dashboard ⇄ /login con una
  // cookie inválida. /login verifica la sesión real (app/login/layout.tsx) y
  // solo entonces envía a /dashboard.

  return NextResponse.next();
}

export const config = {
  // /images agregado (Rediseño de login, septiembre 2026): es la primera
  // pantalla pública que necesita servir un archivo estático de public/ a
  // alguien sin sesión (foto + logotipos de /login) — antes nunca hacía
  // falta, todo lo demás bajo public/ pasa por endpoints de R2 con URL
  // firmada. icon.png/apple-icon.png agregados (Favicon Arqento, septiembre
  // 2026): son rutas que Next.js genera solo a partir de app/icon.png y
  // app/apple-icon.png (mismo mecanismo que favicon.ico, ya excluido) — un
  // navegador las pide sin sesión para pintar la pestaña/ícono de inicio,
  // igual que favicon.ico. Nunca toca ninguna regla de sesión/redirección/
  // permisos, solo amplía qué se considera ruta estática pública.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|images/).*)"],
};

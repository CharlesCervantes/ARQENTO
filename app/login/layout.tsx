import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/server/auth/dal";

// Metadata propia de /login (nunca "Conkuali", el layout raíz) — esta
// pantalla es pública y usa la marca de plataforma Arqento, distinta del
// nombre del tenant (Rediseño de login, septiembre 2026).
export const metadata: Metadata = {
  title: "Arqento",
  description: "Plataforma de gestión de proyectos",
};

// Quien ya tiene una sesión VÁLIDA (misma verificación autoritativa que el
// resto de la app: sesión vigente, usuario activo, Empresa activa) no ve el
// login. Con una cookie inválida se muestra el login normalmente; iniciar
// sesión la reemplaza y cerrar sesión la borra. Destino fijo e interno: no
// se acepta ningún parámetro de redirección.
export default async function LoginLayout({ children }: LayoutProps<"/login">) {
  if (await verifySession()) redirect("/dashboard");
  return children;
}

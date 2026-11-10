// Preparación de las pruebas UNITARIAS (npm test) — se carga con --import
// antes de cualquier módulo del proyecto.
//
// 1) Ninguna prueba unitaria puede tocar una base de datos real: se fuerza
//    DATABASE_URL a una dirección inalcanzable ANTES de que lib/server/db.ts
//    construya el cliente, sin importar lo que traiga el entorno.
// 2) Con la condición react-server (necesaria para `server-only`), la build
//    de servidor de React no trae createContext y lucide-react truena al
//    importarse. Los módulos de servidor solo lo arrastran de forma
//    transitiva (íconos de catálogo), así que en pruebas se sustituye por un
//    stub — nunca en la aplicación.
import { registerHooks } from "node:module";

process.env.DATABASE_URL = "postgresql://pruebas-unitarias-sin-bd@127.0.0.1:1/sin_base_de_datos";

// WhatsApp: nunca credenciales reales en pruebas — se retiran y se ponen
// secretos ficticios; sin token de acceso no sale ningún mensaje a Meta.
for (const clave of Object.keys(process.env)) if (clave.startsWith("WHATSAPP_")) delete process.env[clave];
process.env.WHATSAPP_APP_SECRET = "secreto-webhook-de-prueba";
process.env.WHATSAPP_VERIFY_TOKEN = "token-verificacion-de-prueba";
process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-number-id-simulado";
process.env.WHATSAPP_CODIGO_PEPPER = "pimienta-de-prueba-0123456789";

const stubLucide = new URL("./lucide-stub.cjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lucide-react") return { url: stubLucide, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

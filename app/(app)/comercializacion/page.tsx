import Link from "next/link";
import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";

// Listado único "Cotizaciones y órdenes" (§5.1). B1 solo entrega la entrada
// del módulo: las cotizaciones llegan en B2, así que "Nueva cotización" se
// muestra deshabilitado con una indicación explícita, nunca como un botón
// que no hace nada.
export default async function ComercializacionPage() {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  const esAdmin = esAdministradorComercial(usuario);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Cotizaciones y órdenes</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {esAdmin
              ? "Cotizaciones de venta de tu empresa y las órdenes de compra de cliente que resulten de ellas."
              : "Tus cotizaciones de venta y el seguimiento de las órdenes que resulten de ellas."}
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button type="button" disabled aria-describedby="nueva-cotizacion-aviso">
            + Nueva cotización
          </Button>
          <p id="nueva-cotizacion-aviso" className="text-xs text-[var(--muted)]">
            Aún no disponible: se habilitará en la siguiente entrega.
          </p>
        </div>
      </div>

      <Card className="p-6 text-sm text-[var(--muted)]">
        Todavía no hay cotizaciones. Mientras tanto puedes consultar el catálogo en{" "}
        <Link href="/comercializacion/productos" className="font-medium text-[var(--brand)] hover:underline">
          Productos
        </Link>
        .
      </Card>
    </div>
  );
}

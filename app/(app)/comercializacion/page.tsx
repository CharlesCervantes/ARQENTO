import Link from "next/link";
import { requireSession } from "@/lib/server/auth/dal";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import { esAdministradorComercial } from "@/lib/server/permisos";
import { listarClientesYObras } from "@/lib/server/comercializacion/clientes";
import { listarCotizacionesVenta, listarVendedoresConCotizaciones } from "@/lib/server/comercializacion/cotizaciones";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Thead, Th, Tr, Td } from "@/components/ui/table";
import { SinAccesoComercial } from "@/components/comercializacion/sin-acceso";
import { formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";

// Listado único "Cotizaciones y órdenes" (§5.1). B2 muestra cotizaciones
// reales en borrador. Cobro y entrega dicen "No aplica" mientras sea
// cotización; no se muestran saldos, utilidades ni entregas (no existen
// todavía y no se inventan cifras). Filtros por GET, aplicados en servidor
// dentro del alcance del usuario.

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";

const texto = (v: string | string[] | undefined) => (typeof v === "string" && v.length <= 100 ? v : undefined);

export default async function ComercializacionPage(props: PageProps<"/comercializacion">) {
  const usuario = await requireSession();
  const acceso = evaluarAccesoComercial(usuario);
  if (!acceso.permitido) return <SinAccesoComercial motivo={acceso.motivo} />;

  const esAdmin = esAdministradorComercial(usuario);
  const sp = await props.searchParams;
  const filtros = {
    busqueda: texto(sp.q),
    clienteId: texto(sp.cliente),
    obraId: texto(sp.obra),
    vendedorId: esAdmin ? texto(sp.vendedor) : undefined,
  };

  const [cotizaciones, { clientes, obras }, vendedores] = await Promise.all([
    listarCotizacionesVenta(usuario, filtros),
    listarClientesYObras(usuario),
    listarVendedoresConCotizaciones(usuario),
  ]);
  const obrasFiltro = filtros.clienteId ? obras.filter((o) => o.clienteId === filtros.clienteId) : obras;
  const hayFiltros = Boolean(filtros.busqueda || filtros.clienteId || filtros.obraId || filtros.vendedorId);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Cotizaciones y órdenes</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {esAdmin
              ? "Cotizaciones de venta de tu empresa. Las órdenes de compra de cliente se habilitarán en la siguiente entrega."
              : "Tus cotizaciones de venta. Las órdenes de compra de cliente se habilitarán en la siguiente entrega."}
          </p>
        </div>
        <Link
          href="/comercializacion/cotizaciones/nueva"
          className="inline-flex items-center justify-center rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-medium text-[var(--brand-foreground)] shadow-sm transition-[filter] duration-150 ease-out hover:brightness-110"
        >
          + Nueva cotización
        </Link>
      </div>

      <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <Input name="q" type="search" placeholder="Buscar folio, descripción, cliente u obra" defaultValue={filtros.busqueda} aria-label="Buscar" />
        <select name="cliente" defaultValue={filtros.clienteId ?? ""} className={claseSelect} aria-label="Cliente">
          <option value="">Todos los clientes</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
        <select name="obra" defaultValue={filtros.obraId ?? ""} className={claseSelect} aria-label="Obra">
          <option value="">Todas las obras</option>
          {obrasFiltro.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nombre}
            </option>
          ))}
        </select>
        {esAdmin ? (
          <select name="vendedor" defaultValue={filtros.vendedorId ?? ""} className={claseSelect} aria-label="Vendedor">
            <option value="">Todos los vendedores</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nombre}
              </option>
            ))}
          </select>
        ) : (
          <span className="hidden lg:block" />
        )}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] hover:bg-black/[0.03]"
          >
            Filtrar
          </button>
          {hayFiltros && (
            <Link href="/comercializacion" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
              Limpiar
            </Link>
          )}
        </div>
      </form>

      {cotizaciones.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          {hayFiltros ? "Ninguna cotización coincide con los filtros." : "Todavía no hay cotizaciones. Crea la primera con «Nueva cotización»."}
        </Card>
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Folio</Th>
              <Th>Descripción</Th>
              <Th>Cliente / obra</Th>
              <Th>Vendedor</Th>
              <Th className="text-right">Total</Th>
              <Th>Estado</Th>
              <Th>Cobro</Th>
              <Th>Entrega</Th>
            </tr>
          </Thead>
          <tbody>
            {cotizaciones.map((c) => (
              <Tr key={c.id}>
                <Td className="whitespace-nowrap">
                  <Link href={`/comercializacion/cotizaciones/${c.id}`} className="font-medium text-[var(--brand)] hover:underline">
                    {c.folio}
                  </Link>
                  <div className="text-xs text-[var(--muted)]">{formatearFechaCalendario(c.fecha)}</div>
                </Td>
                <Td>{c.descripcion ?? <span className="text-[var(--muted)]">Sin descripción</span>}</Td>
                <Td>
                  {c.clienteNombre ?? <span className="text-[var(--muted)]">Sin cliente</span>}
                  {c.obraNombre && <div className="text-xs text-[var(--muted)]">{c.obraNombre}</div>}
                </Td>
                <Td className="whitespace-nowrap">{c.vendedorNombre}</Td>
                <Td className="text-right tabular-nums whitespace-nowrap">
                  {c.partidas > 0 ? formatearImporte(c.total) : <span className="text-[var(--muted)]">—</span>}
                </Td>
                <Td>
                  <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">Borrador</span>
                </Td>
                <Td className="whitespace-nowrap text-[var(--muted)]">No aplica</Td>
                <Td className="whitespace-nowrap text-[var(--muted)]">No aplica</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

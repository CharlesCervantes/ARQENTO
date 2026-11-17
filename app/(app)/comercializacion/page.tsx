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
import { EstatusCotizacionBadge } from "@/components/comercializacion/cotizacion-emitida";
import { formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";

// Listado único "Cotizaciones y órdenes" (§5.1). B2 muestra cotizaciones
// reales en borrador. Cobro y entrega dicen "No aplica" mientras sea
// cotización; no se muestran saldos, utilidades ni entregas (no existen
// todavía y no se inventan cifras). Filtros por GET, aplicados en servidor
// dentro del alcance del usuario.

const claseSelect =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/15";

const claseFiltro = "w-auto min-w-[12rem] max-w-[18rem] flex-[1_1_12rem]";

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
    estatus: texto(sp.estado),
  };

  const [cotizaciones, { clientes, obras }, vendedores] = await Promise.all([
    listarCotizacionesVenta(usuario, filtros),
    listarClientesYObras(usuario),
    listarVendedoresConCotizaciones(usuario),
  ]);
  const obrasFiltro = filtros.clienteId ? obras.filter((o) => o.clienteId === filtros.clienteId) : obras;
  const hayFiltros = Boolean(filtros.busqueda || filtros.clienteId || filtros.obraId || filtros.vendedorId || filtros.estatus);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Cotizaciones y órdenes</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {esAdmin
              ? "Cotizaciones de venta de tu empresa y las órdenes de venta (OV) que resultan de su aceptación."
              : "Tus cotizaciones de venta y las órdenes de venta (OV) que resultan de su aceptación."}
          </p>
        </div>
        <Link
          href="/comercializacion/cotizaciones/nueva"
          className="inline-flex items-center justify-center rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-medium text-[var(--brand-foreground)] shadow-sm transition-[filter] duration-150 ease-out hover:brightness-110"
        >
          + Nueva cotización
        </Link>
      </div>

      {/* Filtros que se acomodan en varias líneas: con anchos mínimos, nunca se
          cortan los textos de los selectores (verificación en navegador, B3). */}
      <form method="get" className="flex flex-wrap items-center gap-3">
        <Input
          name="q"
          type="search"
          placeholder="Buscar COT, OV, OC del cliente, cliente u obra"
          defaultValue={filtros.busqueda}
          aria-label="Buscar"
          className="min-w-[18rem] flex-[2_1_20rem]"
        />
        <select name="cliente" defaultValue={filtros.clienteId ?? ""} className={`${claseSelect} ${claseFiltro}`} aria-label="Cliente">
          <option value="">Todos los clientes</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
        <select name="obra" defaultValue={filtros.obraId ?? ""} className={`${claseSelect} ${claseFiltro}`} aria-label="Obra">
          <option value="">Todas las obras</option>
          {obrasFiltro.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nombre}
            </option>
          ))}
        </select>
        <select name="estado" defaultValue={filtros.estatus ?? ""} className={`${claseSelect} ${claseFiltro}`} aria-label="Estado">
          <option value="">Todos los estados</option>
          <option value="BORRADOR">Borrador</option>
          <option value="EMITIDA">Emitida</option>
          <option value="ACEPTADA">Aceptada (OV)</option>
        </select>
        {esAdmin ? (
          <select name="vendedor" defaultValue={filtros.vendedorId ?? ""} className={`${claseSelect} ${claseFiltro}`} aria-label="Vendedor">
            <option value="">Todos los vendedores</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nombre}
              </option>
            ))}
          </select>
        ) : null}
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
              {/* Cobranza: solo Administrador/Director (decisión confirmada, B3). */}
              {esAdmin && <Th>Cobro</Th>}
              <Th>Entrega</Th>
            </tr>
          </Thead>
          <tbody>
            {cotizaciones.map((c) => (
              <Tr key={c.id}>
                <Td className="whitespace-nowrap">
                  {/* Una operación = una fila: la OV aceptada conserva visible su COT. */}
                  <Link href={`/comercializacion/cotizaciones/${c.id}`} className="font-medium text-[var(--brand)] hover:underline">
                    {c.ordenFolio ?? c.folio}
                  </Link>
                  <div className="text-xs text-[var(--muted)]">
                    {c.ordenFolio ? `${c.folio} · ` : ""}
                    {formatearFechaCalendario(c.fecha)}
                  </div>
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
                <Td className="whitespace-nowrap">
                  <EstatusCotizacionBadge estatus={c.estatus} vencida={c.vencida} />
                </Td>
                {/* Mientras sea cotización, cobro y entrega no aplican. En una OV
                    todavía no existen (B4+): se muestra "—", nunca una cifra. */}
                {esAdmin && (
                  <Td className="whitespace-nowrap text-[var(--muted)]" title={c.ordenFolio ? "Se registrará en un bloque posterior" : undefined}>
                    {c.ordenFolio ? "—" : "No aplica"}
                  </Td>
                )}
                <Td className="whitespace-nowrap text-[var(--muted)]" title={c.ordenFolio ? "Se registrará en un bloque posterior" : undefined}>
                  {c.ordenFolio ? "—" : "No aplica"}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

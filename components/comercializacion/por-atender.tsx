import Link from "next/link";
import { Table, Thead, Th, Tr, Td } from "@/components/ui/table";
import { formatearImporte } from "@/lib/comercializacion/importes";
import { enlaceDefinir } from "@/lib/comercializacion/condiciones";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";
import { CATEGORIAS_AVISO, ETIQUETA_CATEGORIA_AVISO, type CategoriaAviso, type TotalesAviso } from "@/lib/comercializacion/recordatorios";
import type { RecordatoriosComerciales } from "@/lib/server/comercializacion/recordatorios";

// Bloque «Por atender» (B6B) del listado de Comercialización. SOLO se
// renderiza para administración (la página no calcula nada para el
// vendedor). Componente de servidor: categoría y "Ver más" por GET. Desde el
// rediseño se muestra dentro del panel «Ver pendientes» del listado.
// Por cobrar y por pagar siempre por separado; nunca se compensan.

const unidad = (categoria: CategoriaAviso, t: TotalesAviso) =>
  categoria === "SIN_CONDICIONES" ? `${t.cuentas} ${t.cuentas === 1 ? "cuenta" : "cuentas"}` : `${t.cuotas} ${t.cuotas === 1 ? "cuota" : "cuotas"}`;

export function PorAtender({ datos, parametros }: { datos: RecordatoriosComerciales; parametros: Record<string, string> }) {
  const enlace = (cambios: Record<string, string | null>) => {
    const p = new URLSearchParams(parametros);
    for (const [k, v] of Object.entries(cambios)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const q = p.toString();
    return `/comercializacion${q ? `?${q}` : ""}#por-atender`;
  };
  const r = datos.resumen;
  const actual = datos.categoria;
  const descripcion =
    actual === "VENCIDO"
      ? `Cuotas con saldo y vencimiento anterior a hoy (${formatearFechaCalendario(datos.hoy)}), desde la más antigua.`
      : actual === "HOY"
        ? `Cuotas con saldo que vencen hoy (${formatearFechaCalendario(datos.hoy)}).`
        : actual === "PROXIMO"
          ? `Cuotas con saldo que vencen de mañana al ${formatearFechaCalendario(datos.hastaProximo)}, desde la más cercana.`
          : "Cuentas con saldo que todavía no tienen fechas de pago. No se clasifican como vencidas.";

  return (
    <div id="por-atender" className="scroll-mt-6 space-y-4">
      <p className="text-sm text-[var(--muted)]">Se resuelven registrando el cobro o pago en su documento. Importe = saldo pendiente de cada cuota.</p>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" role="tablist" aria-label="Categorías de avisos">
        {CATEGORIAS_AVISO.map((k) => {
          const activa = k === actual;
          const hay = r[k].cobro.cuotas + r[k].cobro.cuentas + r[k].pago.cuotas + r[k].pago.cuentas > 0;
          return (
            <Link
              key={k}
              href={enlace({ avisos: k, ver: null })}
              scroll={false}
              role="tab"
              aria-selected={activa}
              data-categoria={k}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                activa ? "border-[var(--brand)] bg-[var(--brand)]/[0.06] ring-1 ring-[var(--brand)]" : "border-[var(--border)] hover:bg-black/[0.03]"
              }`}
            >
              <span className={`block text-sm font-medium ${k === "VENCIDO" && hay ? "text-red-700" : "text-[var(--foreground)]"}`}>{ETIQUETA_CATEGORIA_AVISO[k]}</span>
              <span className="mt-1 block text-xs text-[var(--muted)]" data-total="cobro">
                Por cobrar: {unidad(k, r[k].cobro)} · <span className="tabular-nums">{formatearImporte(r[k].cobro.importe)}</span>
              </span>
              <span className="block text-xs text-[var(--muted)]" data-total="pago">
                Por pagar: {unidad(k, r[k].pago)} · <span className="tabular-nums">{formatearImporte(r[k].pago.importe)}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <p className="text-xs text-[var(--muted)]">{descripcion}</p>

      {datos.totalCategoria === 0 ? (
        <p className="text-sm text-[var(--muted)]">Nada por atender en esta categoría.</p>
      ) : (
        <>
          <Table>
            <Thead>
              <tr>
                <Th>Tipo</Th>
                <Th>Cliente / proveedor</Th>
                <Th>Documento</Th>
                <Th>Cuota</Th>
                <Th>Vencimiento</Th>
                <Th className="text-right">Saldo pendiente</Th>
                <Th>
                  <span className="sr-only">Abrir</span>
                </Th>
              </tr>
            </Thead>
            <tbody>
              {datos.avisos.map((a) => (
                <Tr key={a.clave} data-aviso={`${a.folio}:${a.cuotaNumero ?? "-"}`}>
                  <Td className="whitespace-nowrap">{a.tipo === "COBRO" ? "Cobro" : "Pago"}</Td>
                  <Td>{a.contraparte}</Td>
                  <Td className="whitespace-nowrap font-medium">{a.folio}</Td>
                  <Td className="whitespace-nowrap">{a.cuotaNumero ? `Cuota ${a.cuotaNumero}` : "—"}</Td>
                  <Td className={`whitespace-nowrap ${a.categoria === "VENCIDO" ? "text-red-700" : ""}`}>
                    {a.fechaVencimiento ? formatearFechaCalendario(a.fechaVencimiento) : "Por definir"}
                  </Td>
                  <Td className="text-right tabular-nums whitespace-nowrap">{formatearImporte(a.saldo)}</Td>
                  <Td className="whitespace-nowrap">
                    <Link href={a.categoria === "SIN_CONDICIONES" ? enlaceDefinir(a.enlace, a.clave) : a.enlace} className="text-sm font-medium text-[var(--foreground)] underline decoration-[var(--border)] underline-offset-4 hover:decoration-[var(--foreground)]">
                      {a.categoria === "SIN_CONDICIONES" ? "Definir condiciones" : a.tipo === "COBRO" ? "Ir a cobros" : "Ir a pagos"}
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="flex items-center justify-between text-xs text-[var(--muted)]">
            <span>
              Mostrando {datos.avisos.length} de {datos.totalCategoria}
            </span>
            {datos.avisos.length < datos.totalCategoria && (
              <Link href={enlace({ avisos: actual, ver: String(datos.visibles + 10) })} scroll={false} className="font-medium text-[var(--brand)] hover:underline">
                Ver más
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}

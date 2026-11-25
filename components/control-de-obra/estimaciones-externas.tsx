import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Table, Thead, Th, Tr, Td } from "@/components/ui/table";
import { formatMoney } from "@/lib/dinero";
import type { DetalleEstimacionExterna, FilaEstimacionExterna } from "@/lib/server/control-de-obra/estimaciones-externas";

const num = "text-right tabular-nums whitespace-nowrap";

export function EstimacionesExternas({ filas, verPago }: { filas: FilaEstimacionExterna[]; verPago: boolean }) {
  if (filas.length === 0) return null;
  const suma = (k: "importe" | "iva" | "importeNeto") => filas.reduce((t, f) => t + f[k], 0);
  return (
    <Card className="enter p-5">
      <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
        Estimaciones {filas[0].numero} a {filas[filas.length - 1].numero} · emitidas fuera de ARQENTO
      </p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Importes de la hoja contractual original. Cuentan en estimado y saldo; no en cobrado ni por cobrar
        {verPago ? ". La fecha de pago es la de la hoja; no es un cobro registrado aquí." : "."}
      </p>
      <div className="mt-3">
        <Table>
          <Thead>
            <tr>
              <Th>Estimación</Th>
              <Th>Semana</Th>
              <Th>Concepto</Th>
              <Th className="text-right">Importe</Th>
              <Th className="text-right">IVA</Th>
              <Th className="text-right">Importe neto</Th>
              <Th>Recepción</Th>
              {verPago && <Th>Fecha de pago</Th>}
            </tr>
          </Thead>
          <tbody>
            {filas.map((f) => (
              <Tr key={f.id}>
                <Td className="font-medium">{f.numero}</Td>
                <Td className="whitespace-nowrap">
                  {f.semanaNumero}/{f.semanaAnio}
                </Td>
                <Td className="text-xs text-[var(--muted)]">{f.concepto}</Td>
                <Td className={num}>{formatMoney(f.importe)}</Td>
                <Td className={num}>{formatMoney(f.iva)}</Td>
                <Td className={num}>{formatMoney(f.importeNeto)}</Td>
                <Td className="whitespace-nowrap text-xs">{f.fechaRecepcion ?? "—"}</Td>
                {verPago && <Td className="whitespace-nowrap text-xs">{f.fechaPago ?? "—"}</Td>}
              </Tr>
            ))}
            <Tr>
              <Td className="font-semibold">Total</Td>
              <Td />
              <Td />
              <Td className={num + " font-semibold"}>{formatMoney(suma("importe"))}</Td>
              <Td className={num + " font-semibold"}>{formatMoney(suma("iva"))}</Td>
              <Td className={num + " font-semibold"}>{formatMoney(suma("importeNeto"))}</Td>
              <Td />
              {verPago && <Td />}
            </Tr>
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

export function DetalleExterna({ detalle: d, porcentajeAdministracion, hrefControl }: { detalle: DetalleEstimacionExterna; porcentajeAdministracion: number; hrefControl: string }) {
  const administracion = d.subtotalConceptos * (porcentajeAdministracion / 100);
  const diferencia = Math.round((d.importe - d.subtotalConceptos - administracion) * 100) / 100;
  const renglon = (e: string, v: number, fuerte = false) => (
    <div className={"flex justify-between gap-4 " + (fuerte ? "font-semibold text-[var(--foreground)]" : "")}>
      <span>{e}</span>
      <span className="tabular-nums">{formatMoney(v)}</span>
    </div>
  );
  return (
    <div className="space-y-3">
      <Card className="p-4 text-sm">
        <p className="font-semibold text-[var(--foreground)]">Estimación {d.numero} · emitida fuera de ARQENTO</p>
        {d.concepto && <p className="mt-0.5 text-xs text-[var(--muted)]">{d.concepto}</p>}
        <Link href={hrefControl} className="mt-1 inline-block text-xs text-[var(--brand)] hover:underline">
          Ver las estimaciones anteriores en Control contractual
        </Link>
      </Card>
      {d.partidas.map((p, i) => (
        <Card key={i} className="p-4">
          <p className="text-sm font-semibold text-[var(--foreground)]">{p.nombre}</p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--muted)]">
                <th className="py-1 font-medium">Concepto</th>
                <th className="py-1 text-right font-medium">Cantidad estimada</th>
                <th className="py-1 text-right font-medium">Importe sin administración</th>
              </tr>
            </thead>
            <tbody>
              {p.conceptos.map((c) => (
                <tr key={c.id} className="border-t border-[var(--border)] align-top">
                  <td className="py-2 pr-4">{c.descripcion}</td>
                  <td className="py-2 text-right tabular-nums whitespace-nowrap">
                    {c.cantidad.toLocaleString("es-MX", { maximumFractionDigits: 6 })} {c.unidad}
                  </td>
                  <td className="py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(c.importeBase)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      <Card className="ml-auto w-full max-w-md space-y-1 p-4 text-sm">
        {renglon("Conceptos", d.subtotalConceptos)}
        {renglon(`Administración (${porcentajeAdministracion}%)`, administracion)}
        {Math.abs(diferencia) >= 0.01 && renglon("Ajuste a la hoja original", diferencia)}
        {renglon("Importe de la estimación", d.importe, true)}
        {renglon("IVA", d.iva)}
        {renglon("Importe neto", d.importeNeto, true)}
        {Math.abs(diferencia) >= 1 && (
          <p className="pt-1 text-xs text-[var(--muted)]">
            El ajuste son conceptos que no se cargaron en ARQENTO o renglones que la hoja original no sumó. Manda el importe de la hoja.
          </p>
        )}
      </Card>
    </div>
  );
}

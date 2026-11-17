"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Thead, Th, Tr, Td } from "@/components/ui/table";
import { calcularImpuesto, ETIQUETA_TRATAMIENTO, formatearImporte } from "@/lib/comercializacion/importes";
import type { ProductoParaVenta } from "@/lib/server/comercializacion/productos";
import { coincideBusqueda, etiquetaImpuesto } from "./productos-comun";

// Vista del vendedor: solo productos activos con su precio de venta. El tipo
// ProductoParaVenta no tiene campos privados — el servidor no los envía.
export function ProductosVentaView({ productos }: { productos: ProductoParaVenta[] }) {
  const [busqueda, setBusqueda] = useState("");
  const visibles = useMemo(() => productos.filter((p) => coincideBusqueda(p, busqueda)), [productos, busqueda]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Productos</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Catálogo de venta autorizado por administración. Precios sin IVA.
        </p>
      </div>

      <Input
        type="search"
        placeholder="Buscar por código o descripción"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        className="sm:max-w-sm"
        aria-label="Buscar productos"
      />

      {productos.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">Todavía no hay productos activos en el catálogo.</Card>
      ) : visibles.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">Ningún producto coincide con la búsqueda.</Card>
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Código</Th>
              <Th>Descripción</Th>
              <Th>Unidad</Th>
              <Th className="text-right">Precio sin IVA</Th>
              <Th>Impuesto</Th>
              <Th className="text-right">Precio con IVA</Th>
            </tr>
          </Thead>
          <tbody>
            {visibles.map((p) => (
              <Tr key={p.id}>
                <Td className="font-medium whitespace-nowrap">{p.codigo}</Td>
                <Td>{p.descripcion}</Td>
                <Td className="whitespace-nowrap">{p.unidad}</Td>
                <Td className="text-right tabular-nums whitespace-nowrap">{formatearImporte(p.precioVenta)}</Td>
                <Td className="whitespace-nowrap" title={ETIQUETA_TRATAMIENTO[p.tratamientoImpuesto]}>
                  {etiquetaImpuesto(p)}
                </Td>
                <Td className="text-right tabular-nums whitespace-nowrap">
                  {formatearImporte(calcularImpuesto(p.precioVenta, p.tratamientoImpuesto, p.tasaIva).total)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

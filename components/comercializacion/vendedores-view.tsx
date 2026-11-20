"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Table, Thead, Th, Tr, Td } from "@/components/ui/table";
import type { UsuarioElegibleVendedor } from "@/lib/server/comercializacion/vendedores";
import { cambiarVendedorAction } from "@/app/(app)/comercializacion/actions";

// Asignación de la función Vendedor a Supervisores de la propia Empresa. Solo
// cambia esa marca: el rol, la Empresa y los permisos de obra del Supervisor
// no se tocan.
export function VendedoresView({ usuarios }: { usuarios: UsuarioElegibleVendedor[] }) {
  const [error, setError] = useState<string | null>(null);
  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function cambiar(u: UsuarioElegibleVendedor) {
    setError(null);
    setEnCurso(u.id);
    startTransition(async () => {
      const r = await cambiarVendedorAction(u.id, !u.vendedorComercial);
      if (r.error) setError(r.error);
      setEnCurso(null);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Vendedores</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Un Supervisor con la función Vendedor puede cotizar con los precios autorizados y solo verá sus propias
          cotizaciones. No ve costos y no cambia sus permisos de obra.
        </p>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      {usuarios.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Tu empresa no tiene usuarios con rol Supervisor. Las cuentas se dan de alta desde el portal de administración de
          la plataforma.
        </Card>
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Nombre</Th>
              <Th>Correo</Th>
              <Th>Cuenta</Th>
              <Th className="text-right">Función Vendedor</Th>
            </tr>
          </Thead>
          <tbody>
            {usuarios.map((u) => {
              const deshabilitado = enCurso === u.id || (!u.activo && !u.vendedorComercial);
              return (
                <Tr key={u.id}>
                  <Td className="font-medium">{u.nombre}</Td>
                  <Td className="text-[var(--muted)]">{u.email}</Td>
                  <Td>{u.activo ? "Activa" : "Desactivada"}</Td>
                  <Td className="text-right">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={u.vendedorComercial}
                        disabled={deshabilitado}
                        onChange={() => cambiar(u)}
                        aria-label={`Función Vendedor para ${u.nombre}`}
                      />
                      {u.vendedorComercial ? "Vendedor" : "No"}
                    </label>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}

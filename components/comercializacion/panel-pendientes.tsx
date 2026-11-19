"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PanelLateral } from "./panel-lateral";

// «Ver pendientes» del listado: el detalle existente de «Por atender» (B6B)
// dentro de un panel. Su estado vive en la URL (?avisos=…&ver=…), así que
// categorías, «Ver más», Recargar y Atrás siguen funcionando igual; cerrar
// quita esos parámetros sin tocar los filtros. La página lo monta con
// key={abierto} para que cada cambio de URL lo abra o cierre.
export function PanelPendientes({ abierto, hrefCerrar, children }: { abierto: boolean; hrefCerrar: string; children: ReactNode }) {
  const router = useRouter();
  const [visible, setVisible] = useState(abierto);
  return (
    <PanelLateral
      abierto={visible}
      ancho="amplio"
      titulo="Por atender"
      contexto="Cobros y pagos pendientes según las cuotas reales."
      onCerrar={() => {
        setVisible(false);
        router.replace(hrefCerrar, { scroll: false });
      }}
    >
      {children}
    </PanelLateral>
  );
}

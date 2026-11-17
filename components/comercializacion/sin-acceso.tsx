import { Card } from "@/components/ui/card";
import type { MotivoSinAcceso } from "@/lib/server/comercializacion/acceso";

const MENSAJE: Record<MotivoSinAcceso, string> = {
  SIN_EMPRESA: "Tu cuenta no tiene una empresa asignada.",
  SIN_MODULO: "Tu empresa no tiene habilitado el módulo de Comercialización.",
  SIN_PERMISO: "No tienes acceso a Comercialización. Pide a administración que te asigne la función Vendedor.",
};

export function SinAccesoComercial({ motivo }: { motivo: MotivoSinAcceso }) {
  return <Card className="p-6 text-sm text-[var(--muted)]">{MENSAJE[motivo]}</Card>;
}

import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/dinero";
import { etiquetaCargo, sufijoTasa, type TasaTrabajos } from "@/lib/control-de-obra/presentacion-estimacion-privada";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";

// Desglose obligatorio de 6 líneas (sección 8 del rediseño de Estimación
// semanal, agosto 2026): Subtotal trabajos / Gastos cobrables / Subtotal /
// Administración-o-Utilidad / IVA (solo si aplica) / TOTAL. Se muestra como
// monto, nunca como "% único" — un solo porcentaje sobre trabajos+gastos
// combinados sería engañoso en cuanto algún concepto tiene un override
// propio (la administración real es la suma exacta por concepto más la de
// gastos, no un porcentaje plano visible aquí).
type ResumenCompleto = {
  subtotalTrabajos: number;
  gastosCobrables: number;
  administracion: number;
  aplicaIVA: boolean;
  montoIVA: number;
  total: number;
};

function esCompleto(props: { total: number } | ResumenCompleto): props is ResumenCompleto {
  return "subtotalTrabajos" in props;
}

export function ResumenEstimacionOperativa(props: { total: number } | ResumenCompleto) {
  if (!esCompleto(props)) {
    return (
      <Card className="enter p-5 ring-2 ring-emerald-200">
        <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
          Resumen de la semana
        </p>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--muted)]">Total de esta semana</span>
          <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">
            {formatMoney(props.total)}
          </span>
        </div>
      </Card>
    );
  }

  return (
    <ResumenLineas
      titulo="Resumen de la semana"
      etiquetaMonto="Administración"
      {...props}
    />
  );
}

// Cliente Priv.: la tabla va sin administración, así que el cargo se ve aquí
// separado (trabajos / gastos) con su tasa. Si los trabajos combinan tasas se
// desglosan y no se muestra una tasa única.
export function ResumenEstimacionPrivada({
  esquemaContractual,
  subtotalTrabajos,
  gastosCobrables,
  administracionTrabajos,
  tasasTrabajos,
  administracionGastos,
  porcentajeAdministracionGastos,
  aplicaIVA,
  porcentajeIVA,
  montoIVA,
  total,
}: {
  esquemaContractual: EsquemaContractual | null;
  subtotalTrabajos: number;
  gastosCobrables: number;
  administracionTrabajos: number;
  tasasTrabajos: TasaTrabajos[];
  administracionGastos: number;
  porcentajeAdministracionGastos: number | null;
  aplicaIVA: boolean;
  porcentajeIVA: number | null;
  montoIVA: number;
  total: number;
}) {
  const cargo = etiquetaCargo(esquemaContractual);
  const tasaUnica = tasasTrabajos.length === 1 ? tasasTrabajos[0].porcentaje : null;
  return (
    <Card className="enter p-5 ring-2 ring-emerald-200">
      <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
        Resumen comercial de esta estimación
      </p>
      <div className="mt-3 space-y-1.5">
        <Linea label={`Trabajos sin ${cargo.toLowerCase()}`} valor={subtotalTrabajos} />
        <Linea label="Gastos cobrables" valor={gastosCobrables} />
        <Linea
          label={`Subtotal antes de ${cargo.toLowerCase()}`}
          valor={subtotalTrabajos + gastosCobrables}
          destacado
        />
        <Linea label={`${cargo} sobre trabajos${sufijoTasa(tasaUnica)}`} valor={administracionTrabajos} />
        {tasasTrabajos.length > 1 &&
          tasasTrabajos.map((t) => (
            <p key={t.porcentaje} className="flex justify-between pl-4 text-xs tabular-nums text-[var(--muted)]">
              <span>
                {t.porcentaje.toLocaleString("es-MX")}% sobre {formatMoney(t.base)}
              </span>
              <span>{formatMoney(t.monto)}</span>
            </p>
          ))}
        <Linea
          label={`${cargo} sobre gastos${sufijoTasa(porcentajeAdministracionGastos)}`}
          valor={administracionGastos}
        />
        {aplicaIVA && <Linea label={`IVA${sufijoTasa(porcentajeIVA)}`} valor={montoIVA} />}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-3">
        <span className="text-sm font-medium text-[var(--muted)]">Total de la estimación</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{formatMoney(total)}</span>
      </div>
    </Card>
  );
}

function ResumenLineas({
  titulo,
  etiquetaMonto,
  subtotalTrabajos,
  gastosCobrables,
  administracion,
  aplicaIVA,
  montoIVA,
  total,
}: ResumenCompleto & { titulo: string; etiquetaMonto: string }) {
  const subtotal = subtotalTrabajos + gastosCobrables;
  return (
    <Card className="enter p-5 ring-2 ring-emerald-200">
      <p className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">{titulo}</p>
      <div className="mt-3 space-y-1.5">
        <Linea label="Subtotal trabajos" valor={subtotalTrabajos} />
        <Linea label="Gastos cobrables" valor={gastosCobrables} />
        <Linea label="Subtotal" valor={subtotal} destacado />
        <Linea label={etiquetaMonto} valor={administracion} />
        {aplicaIVA && <Linea label="IVA" valor={montoIVA} />}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-3">
        <span className="text-sm font-medium text-[var(--muted)]">TOTAL</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">
          {formatMoney(total)}
        </span>
      </div>
    </Card>
  );
}

function Linea({ label, valor, destacado }: { label: string; valor: number; destacado?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-sm ${destacado ? "font-medium text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
        {label}
      </span>
      <span
        className={`tabular-nums ${destacado ? "text-sm font-semibold text-[var(--foreground)]" : "text-sm text-[var(--foreground)]"}`}
      >
        {formatMoney(valor)}
      </span>
    </div>
  );
}

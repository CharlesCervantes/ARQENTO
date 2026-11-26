import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/dinero";

export function ResumenSemana({
  totalEntreSemana,
  totalFinSemana,
  pendienteDePago,
}: {
  totalEntreSemana: number;
  totalFinSemana: number;
  pendienteDePago: number;
}) {
  // «Entre semana» ya no se muestra (noviembre 2026), pero el total lo
  // sigue sumando para no esconder ningún monto.
  const total = totalEntreSemana + totalFinSemana;

  const tarjetas = [
    { etiqueta: "Total semana", valor: formatMoney(total), destacado: true },
    { etiqueta: "Fin de semana", valor: formatMoney(totalFinSemana) },
    {
      etiqueta: "Pendiente de pago",
      valor: formatMoney(pendienteDePago),
      alerta: pendienteDePago > 0,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {tarjetas.map((t, i) => (
        <Card
          key={t.etiqueta}
          className="enter p-4"
          style={{ transitionDelay: `${i * 40}ms` }}
        >
          <p className="text-xs font-medium text-[var(--muted)]">
            {t.etiqueta}
          </p>
          <p
            className={
              t.destacado
                ? "mt-1 text-3xl font-semibold tabular-nums text-[var(--brand)]"
                : t.alerta
                  ? "mt-1 text-2xl font-semibold tabular-nums text-red-700"
                  : "mt-1 text-2xl font-semibold tabular-nums text-[var(--foreground)]"
            }
          >
            {t.valor}
          </p>
        </Card>
      ))}
    </div>
  );
}

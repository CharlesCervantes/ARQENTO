import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import { proyectarResumenEjecutivo, resolverAccesoDashboard, type DatosDashboard } from "@/lib/server/dashboard";
import { usuarioDePrueba } from "../helpers/usuarios";
import { datosDePrueba, HOY, IDS, rangoDePrueba } from "../helpers/datos-dashboard";

const general = () => resolverAccesoDashboard(usuarioDePrueba({ rol: "DIRECTOR" }), "general");
const privado = () => resolverAccesoDashboard(usuarioDePrueba({ rol: "DIRECTOR" }), "privado");
const proyectar = (datos: DatosDashboard, acceso = general()) =>
  proyectarResumenEjecutivo(datos, acceso, "semana", rangoDePrueba(), HOY);

const saludPorObra = (r: ReturnType<typeof proyectar>) => Object.fromEntries(r.proyectos.map((p) => [p.id, p.salud]));

// Datos privados alterados: precios privados y gasto directo distintos — la
// vista General no debe notar la diferencia.
function conPrivadoAlterado(): DatosDashboard {
  const datos = datosDePrueba();
  datos.conceptosRaw = datos.conceptosRaw.map((c) => ({
    ...c,
    precioUnitarioContratistaPrivado: new Prisma.Decimal(1),
  }));
  datos.costoDirectoEmpresaPorProyecto = new Map([[IDS.TORRE, 9_999_999]]);
  return datos;
}

describe("Salud y orden de obras en vista General", () => {
  test("La salud en General no usa la desviación privada", () => {
    const r = proyectar(datosDePrueba());
    // Torre: pago pendiente de ~2 días → Atención (la desviación privada >30 pp no cuenta).
    assert.equal(saludPorObra(r)[IDS.TORRE], "ATENCION");
    // Bodega: sin señales operativas → Saludable (la desviación privada >15 pp no cuenta).
    assert.equal(saludPorObra(r)[IDS.BODEGA], "SALUDABLE");
    assert.equal(saludPorObra(r)[IDS.PAUSADA], "EN_SEGUIMIENTO");
  });

  test("Cambiar datos privados no altera salud ni orden en General", () => {
    const a = proyectar(datosDePrueba());
    const b = proyectar(conPrivadoAlterado());
    assert.deepEqual(saludPorObra(b), saludPorObra(a));
    assert.deepEqual(b.proyectos.map((p) => p.id), a.proyectos.map((p) => p.id));
    assert.deepEqual(b.alertas, a.alertas);
  });

  test("En Privado la desviación sí influye en la salud", () => {
    const r = proyectar(datosDePrueba(), privado());
    assert.equal(saludPorObra(r)[IDS.TORRE], "REQUIERE_ACCION"); // desviación > 30 pp
    assert.equal(saludPorObra(r)[IDS.BODEGA], "ATENCION"); // desviación > 15 pp
  });
});

describe("Semanas sin cerrar", () => {
  const fin = (mes: number, dia: number) => new Date(Date.UTC(2026, mes - 1, dia));
  // Torre empieza en la semana 38; la 37 existe en la empresa desde antes.
  function datosConSemanas(): DatosDashboard {
    const datos = datosDePrueba();
    datos.semanasCerradasVencidas = [
      { id: "semana-37", fechaFin: fin(9, 12) },
      { id: "semana-38", fechaFin: fin(9, 19) },
      { id: "semana-39", fechaFin: fin(9, 26) },
    ];
    datos.ultimaSemanaConAvance = [
      { conceptoId: "concepto-torre", semana: { fechaFin: fin(9, 19) } },
      { conceptoId: "concepto-torre", semana: { fechaFin: fin(9, 26) } },
    ];
    const cierre = (semanaId: string, fechaFin: Date) => ({ proyectoId: IDS.TORRE, semanaId, estatus: "CERRADA" as const, semana: { fechaFin } });
    datos.cierresSemana = [cierre("semana-38", fin(9, 19)), cierre("semana-39", fin(9, 26))];
    return datos;
  }
  const torre = (d: DatosDashboard) => proyectar(d).proyectos.find((p) => p.id === IDS.TORRE)!;

  test("no cuenta semanas anteriores al primer avance de la obra", () => {
    const datos = datosConSemanas();
    assert.equal(torre(datos).semanasSinCerrarDias, 0);
    assert.ok(!proyectar(datos).alertas.some((a) => a.tipo === "semanas_sin_cerrar"));
  });

  test("sí cuenta una semana de la obra que quedó sin cerrar, sea con avance o intermedia", () => {
    const datos = datosConSemanas();
    datos.cierresSemana = datos.cierresSemana.filter((c) => c.semanaId !== "semana-38");
    const esperado = (HOY.getTime() - fin(9, 19).getTime()) / 86400000;
    assert.equal(torre(datos).semanasSinCerrarDias, esperado);
    assert.ok(proyectar(datos).alertas.some((a) => a.tipo === "semanas_sin_cerrar"));
  });
});

describe("Alertas según la vista", () => {
  test("General nunca incluye la alerta de desviación", () => {
    assert.ok(!proyectar(datosDePrueba()).alertas.some((a) => a.tipo === "desviacion"));
  });

  test("Privado conserva la alerta de desviación", () => {
    const alerta = proyectar(datosDePrueba(), privado()).alertas.find((a) => a.tipo === "desviacion");
    assert.ok(alerta, "debe existir la alerta de desviación en Privado");
    assert.equal(alerta.severidad, "REQUIERE_ACCION");
  });

  test("Estimaciones listas para emitir: General no cuenta borradores de capa PRIVADO", () => {
    // Solo se compara el conteo: el texto de la alerta es el existente, sin cambios.
    const g = proyectar(datosDePrueba()).alertas.find((a) => a.tipo === "estimaciones_listas");
    assert.match(g?.titulo ?? "", /^1 /);
    const p = proyectar(datosDePrueba(), privado()).alertas.find((a) => a.tipo === "estimaciones_listas");
    assert.match(p?.titulo ?? "", /^2 /);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { proyectarResumenEjecutivo, resolverAccesoDashboard, type PeriodoDashboard } from "@/lib/server/dashboard";
import { usuarioDePrueba } from "../helpers/usuarios";
import { datosDePrueba, HOY, IDS, rangoDePrueba } from "../helpers/datos-dashboard";

// Montos legítimos de vista General: deben ser idénticos antes y después de
// la corrección D2/D4 (valores calculados a mano sobre el escenario de
// prueba y verificados contra el código previo a la corrección), y no deben
// depender de si el usuario tiene o no permiso privado.

const usuariosGeneral = [
  usuarioDePrueba({ rol: "DIRECTOR" }),
  usuarioDePrueba({ rol: "ADMINISTRADOR" }),
  usuarioDePrueba({ rol: "ADMINISTRADOR", vistaPrivadaActiva: false }),
  usuarioDePrueba({ rol: "DIRECTOR", privadoHabilitado: false }),
];


function montosGenerales(periodo: PeriodoDashboard, usuario = usuariosGeneral[0]) {
  const acceso = resolverAccesoDashboard(usuario, "general");
  const r = proyectarResumenEjecutivo(datosDePrueba(), acceso, periodo, rangoDePrueba(periodo), HOY);
  return {
    porPagarObras: r.porPagarObras,
    porPagarEmpresa: r.porPagarEmpresa,
    porPagarTotal: r.porPagarTotal,
    porCobrar: r.porCobrar,
    flujoDinero: r.flujoDinero,
    porPagarObrasDiasMax: r.porPagarObrasDiasMax,
    estimacionesPorCobrar: r.estimacionesPorCobrar,
    gastosProyectoPeriodo: r.gastosProyectoPeriodo,
    gastosEmpresaPeriodo: r.gastosEmpresaPeriodo,
    obrasActivas: r.obrasActivas,
    avanceFisico: r.avanceFisicoConsolidado,
    obras: r.proyectos.map((p) => ({
      id: p.id,
      ejecutado: p.ejecutado,
      montoContrato: p.montoContrato,
      avanceFinancieroPorcentaje: p.avanceFinancieroPorcentaje,
      porPagar: p.porPagar,
      avanceFisico: p.avanceFisico.porcentaje,
    })),
    alertasNoPrivadas: r.alertas
      .filter((a) => a.tipo !== "desviacion" && a.tipo !== "estimaciones_listas")
      .map((a) => ({ tipo: a.tipo, titulo: a.titulo, monto: a.monto })),
  };
}

describe("Regresión de montos de vista General", () => {
  test("Semana: valores esperados", () => {
    const m = montosGenerales("semana");
    assert.equal(m.porPagarObras, 120000);
    assert.equal(m.porPagarEmpresa, 86200);
    assert.equal(m.porPagarTotal, 206200);
    // Torre: OPERATIVO 980,000 − min(500,000 cobrado en PRIVADO, 980,000) = 480,000; Bodega: 300,000 − 100,000.
    assert.equal(m.porCobrar, 680000);
    // Entradas: 500,000 + 100,000 + aportación 75,000. Pagos de obra liquidados: 400,000 + 50,000.
    // Flujo General: sin tope alcanzado ni caso 3 en este escenario → mismas cifras que el flujo anterior.
    assert.deepEqual(m.flujoDinero, { base: "general", entradas: 675000, pagosDeObra: 450000, gastosReposicionesDentro: 50000, neto: 225000 });
    // Inicio V2 retira el resumen fiscal (Contabilidad lo conserva).
    assert.equal("resumenFiscal" in m, false);
    // Antigüedad solo de Obras: el único pago pendiente (Torre) lleva 2 días.
    assert.equal(m.porPagarObrasDiasMax, 2);
    // Torre y Bodega tienen saldo pendiente.
    assert.equal(m.estimacionesPorCobrar, 2);
    assert.equal(m.gastosProyectoPeriodo, 90000);
    assert.equal(m.gastosEmpresaPeriodo, 15000);
    assert.deepEqual(m.obrasActivas, { total: 2, enEjecucion: 2, porIniciar: 0, pausadas: 1 });
    // (60×1000 + 10×2000) / (100×1000 + 50×2000) = 40 %; anterior (55×1000 + 8×2000)/200,000 = 35.5 %.
    assert.equal(m.avanceFisico.porcentaje, 40);
    assert.ok(Math.abs((m.avanceFisico.deltaVsAnterior ?? 0) - 4.5) < 1e-9);

    const torre = m.obras.find((o) => o.id === IDS.TORRE)!;
    assert.deepEqual(torre, { id: IDS.TORRE, ejecutado: 850000, montoContrato: 1000000, avanceFinancieroPorcentaje: 85, porPagar: 120000, avanceFisico: 60 });
    const bodega = m.obras.find((o) => o.id === IDS.BODEGA)!;
    assert.deepEqual(bodega, { id: IDS.BODEGA, ejecutado: 250000, montoContrato: 1000000, avanceFinancieroPorcentaje: 25, porPagar: 0, avanceFisico: 20 });

    assert.deepEqual(m.alertasNoPrivadas, [
      { tipo: "pagos_pendientes", titulo: "$120,000 pendientes de pago", monto: 120000 },
      { tipo: "pendiente_cobro", titulo: "$680,000 pendiente de cobro", monto: 680000 },
    ]);
  });

  for (const periodo of ["semana", "mes", "mes_anterior", "acumulado"] as PeriodoDashboard[]) {
    test(`${periodo}: los montos General no dependen del permiso privado del usuario`, () => {
      const referencia = montosGenerales(periodo, usuariosGeneral[0]);
      for (const usuario of usuariosGeneral.slice(1)) {
        assert.deepEqual(montosGenerales(periodo, usuario), referencia);
      }
    });
  }

  test("Vista Privado: los montos que no son privados no cambian", () => {
    const acceso = resolverAccesoDashboard(usuarioDePrueba({ rol: "DIRECTOR" }), "privado");
    const r = proyectarResumenEjecutivo(datosDePrueba(), acceso, "semana", rangoDePrueba(), HOY);
    assert.equal(r.porPagarObras, 120000);
    assert.equal(r.porPagarEmpresa, 86200);
    // P2 (cambio aprobado): total real de cada estimación. Torre 1,150,000 − 500,000 + Bodega (solo OP) 300,000 − 100,000.
    // Antes: 650,000 (solo capas PRIVADO).
    assert.equal(r.porCobrar, 850000);
    assert.deepEqual(r.flujoDinero, { base: "real", entradas: 675000, pagosDeObra: 450000, gastosReposicionesDentro: 50000, neto: 225000 });
  });
});

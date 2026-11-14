import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  obtenerResumenEjecutivo,
  proyectarResumenEjecutivo,
  resolverAccesoDashboard,
  type VistaDashboard,
} from "@/lib/server/dashboard";
import { SinPermisoError } from "@/lib/server/control-de-obra/proyectos";
import { combinacionesDeAcceso, usuarioDePrueba } from "../helpers/usuarios";
import { datosDePrueba, HOY, rangoDePrueba } from "../helpers/datos-dashboard";

// Matriz completa: rol × switch personal × Empresa habilitada × vista pedida
// (24 casos) + MASTER. Para cada caso se verifica la vista efectiva y qué
// campos deben llegar en null.

const VISTAS: VistaDashboard[] = ["general", "privado"];

describe("Matriz de acceso a Inicio", () => {
  for (const caso of combinacionesDeAcceso()) {
    for (const vistaPedida of VISTAS) {
      const nombre = `${caso.rol} · switch ${caso.vistaPrivadaActiva ? "on" : "off"} · Empresa ${caso.privadoHabilitado ? "habilitada" : "sin Privado"} · pide ${vistaPedida}`;

      test(nombre, () => {
        const usuario = usuarioDePrueba(caso);
        const acceso = resolverAccesoDashboard(usuario, vistaPedida);

        const esDirectivo = caso.rol === "DIRECTOR" || caso.rol === "ADMINISTRADOR";
        const debePoderVerPrivado = esDirectivo && caso.vistaPrivadaActiva && caso.privadoHabilitado;
        const vistaEsperada: VistaDashboard = vistaPedida === "privado" && debePoderVerPrivado ? "privado" : "general";

        assert.equal(acceso.nivelAcceso, esDirectivo ? "completo" : "operativo");
        assert.equal(acceso.puedeVerPrivado, debePoderVerPrivado);
        assert.equal(acceso.vistaEfectiva, vistaEsperada);
        assert.equal(acceso.incluirPrivado, vistaEsperada === "privado");

        const r = proyectarResumenEjecutivo(datosDePrueba(), acceso, "semana", rangoDePrueba(), HOY);
        assert.equal(r.vista, vistaEsperada);

        if (vistaEsperada === "general") {
          assert.equal(r.utilidadConsolidada, null, "utilidadConsolidada debe ser null en General");
          assert.equal(r.privado, null, "los indicadores privados deben ser null en General");
          for (const p of r.proyectos) {
            assert.equal(p.utilidad, null, `utilidad de ${p.nombre} debe ser null en General`);
            assert.equal(p.desviacionPrivadaPP, null, `desviacionPrivadaPP de ${p.nombre} debe ser null en General`);
          }
          assert.ok(!r.alertas.some((a) => a.tipo === "desviacion"), "no debe haber alerta de desviación en General");
        } else {
          assert.notEqual(r.utilidadConsolidada, null, "Privado conserva la utilidad consolidada");
          assert.notEqual(r.privado, null, "Privado recibe sus indicadores");
          assert.ok(r.proyectos.some((p) => p.desviacionPrivadaPP !== null), "Privado conserva la desviación por obra");
        }

        if (!esDirectivo) {
          assert.equal(r.porPagarObras, null);
          assert.equal(r.porPagarEmpresa, null);
          assert.equal(r.porPagarTotal, null);
          assert.equal(r.porCobrar, null);
          assert.equal(r.flujoDinero, null);
          assert.equal(r.porPagarObrasDiasMax, null);
          assert.equal(r.estimacionesPorCobrar, null);
          assert.equal(r.gastosProyectoPeriodo, null);
          assert.equal(r.gastosEmpresaPeriodo, null);
          assert.deepEqual(r.compromisos, []);
          for (const p of r.proyectos) {
            assert.equal(p.ejecutado, null);
            assert.equal(p.montoContrato, null);
            assert.equal(p.avanceFinancieroPorcentaje, null);
            assert.equal(p.porPagar, null);
          }
          assert.ok(r.alertas.every((a) => a.tipo === "sin_avance_reciente"), "Supervisor solo recibe alertas operativas");
        }
      });
    }
  }

  test("MASTER no tiene Empresa: Inicio lanza SinPermisoError antes de leer datos", async () => {
    const master = usuarioDePrueba({ rol: "MASTER" });
    await assert.rejects(obtenerResumenEjecutivo(master, "general", "semana"), SinPermisoError);
    await assert.rejects(obtenerResumenEjecutivo(master, "privado", "semana"), SinPermisoError);
  });

  test("URL manipulada: pedir ?vista=privado sin permiso devuelve General", () => {
    for (const caso of [
      { rol: "SUPERVISOR" as const },
      { rol: "ADMINISTRADOR" as const, vistaPrivadaActiva: false },
      { rol: "DIRECTOR" as const, privadoHabilitado: false },
    ]) {
      const acceso = resolverAccesoDashboard(usuarioDePrueba(caso), "privado");
      assert.equal(acceso.vistaEfectiva, "general");
      assert.equal(acceso.incluirPrivado, false);
    }
  });
});

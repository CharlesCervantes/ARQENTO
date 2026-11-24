import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rutaInicial } from "@/lib/modulos";
import { puedeVerInicio } from "@/lib/server/permisos";
import { obtenerResumenEjecutivo } from "@/lib/server/dashboard";
import { SinPermisoError } from "@/lib/server/control-de-obra/proyectos";
import { usuarioDePrueba } from "../helpers/usuarios";

// «Inicio» como módulo habilitable por Empresa (noviembre 2026).

describe("Inicio — módulo por Empresa", () => {
  test("rutaInicial: Inicio primero si está; sin Inicio, el primer módulo con pantalla", () => {
    assert.equal(rutaInicial(["inicio", "reporte_general", "comercializacion"]), "/dashboard");
    assert.equal(rutaInicial(["comercializacion"]), "/comercializacion");
    assert.equal(rutaInicial(["control_prestamos", "gastos"]), "/gastos", "un módulo sin pantalla se salta");
    assert.equal(rutaInicial([]), null);
    assert.equal(rutaInicial(["clave_desconocida"]), null);
  });

  test("rutaInicial nunca devuelve /dashboard si Inicio no está visible (sin ciclos)", () => {
    for (const claves of [["comercializacion"], ["reporte_general"], ["control_de_obra", "gastos"], []]) {
      assert.notEqual(rutaInicial(claves), "/dashboard");
    }
  });

  test("puedeVerInicio depende del módulo de la Empresa", () => {
    assert.equal(puedeVerInicio(usuarioDePrueba({ rol: "ADMINISTRADOR", modulos: ["inicio", "comercializacion"] })), true);
    assert.equal(puedeVerInicio(usuarioDePrueba({ rol: "DIRECTOR", modulos: ["comercializacion"] })), false);
    assert.equal(puedeVerInicio(usuarioDePrueba({ rol: "SUPERVISOR", modulos: [] })), false);
    assert.equal(puedeVerInicio(usuarioDePrueba({ rol: "MASTER" })), false, "Master no tiene Empresa");
  });

  test("Sin Inicio, el resumen ejecutivo se rechaza antes de consultar datos de obras", async () => {
    const soloComercial = usuarioDePrueba({ rol: "ADMINISTRADOR", modulos: ["comercializacion"] });
    await assert.rejects(obtenerResumenEjecutivo(soloComercial, "general", "semana"), SinPermisoError);
  });

  test("Sidebar: Inicio llega como módulo (sin enlace fijo) y el logo se centra sin deformarse", () => {
    const fuente = readFileSync(join(process.cwd(), "app", "(app)", "_components", "sidebar.tsx"), "utf8");
    assert.doesNotMatch(fuente, /<NavLink href="\/dashboard"/);
    assert.match(fuente, /inicio: House/);
    assert.match(fuente, /object-contain object-center/);
    assert.doesNotMatch(fuente, /object-left/);
  });
});

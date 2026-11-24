import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/server/db";
import { obtenerModulosVisibles } from "@/lib/server/permisos";
import { obtenerResumenEjecutivo } from "@/lib/server/dashboard";
import { SinPermisoError } from "@/lib/server/control-de-obra/proyectos";
import { rutaInicial } from "@/lib/modulos";
import { usuarioDePrueba } from "../helpers/usuarios";
import { EMPRESA, baseLimpiaConDatos } from "./apoyo/base";

// «Inicio» como módulo del catálogo (migración 20261130090000). La limpieza
// de integración vacía también `modulos`: se siembran las filas del catálogo
// que usa la prueba, con los mismos ids/claves que las migraciones.

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.modulo.createMany({
    data: [
      { id: "modulo_inicio", clave: "inicio", nombre: "Inicio" },
      { id: "mod-reporte", clave: "reporte_general", nombre: "Reporte General" },
      { id: "mod-obra", clave: "control_de_obra", nombre: "Control de Obra" },
      { id: "modulo_comercializacion", clave: "comercializacion", nombre: "Comercialización" },
    ],
  });
});

const conModulos = (rol: "ADMINISTRADOR" | "DIRECTOR" | "SUPERVISOR", modulos: string[], vendedorComercial = false) =>
  usuarioDePrueba({ rol, empresaId: EMPRESA, modulos, vendedorComercial });

describe("Integración — Inicio como módulo", () => {
  test("Solo Comercialización: el menú no trae Inicio y la entrada es Operaciones", async () => {
    const dueno = conModulos("ADMINISTRADOR", ["comercializacion"]);
    const claves = (await obtenerModulosVisibles(dueno)).map((m) => m.clave);
    assert.deepEqual(claves, ["comercializacion"]);
    assert.equal(rutaInicial(claves), "/comercializacion");
  });

  test("Con Inicio: es la primera opción del menú y la entrada es /dashboard", async () => {
    const u = conModulos("DIRECTOR", ["comercializacion", "control_de_obra", "inicio", "reporte_general"]);
    const claves = (await obtenerModulosVisibles(u)).map((m) => m.clave);
    assert.equal(claves[0], "inicio");
    assert.deepEqual(claves.slice(1, 3), ["reporte_general", "control_de_obra"]);
    assert.equal(rutaInicial(claves), "/dashboard");
  });

  test("Supervisor sin la función Vendedor en una Empresa solo comercial: sin módulos (aviso, sin redirección)", async () => {
    const claves = (await obtenerModulosVisibles(conModulos("SUPERVISOR", ["comercializacion"]))).map((m) => m.clave);
    assert.deepEqual(claves, []);
    assert.equal(rutaInicial(claves), null);
  });

  test("Sin Inicio no se crean ni consultan datos de obras (semana actual, recurrentes)", async () => {
    const semanasAntes = await db.semana.count();
    await assert.rejects(obtenerResumenEjecutivo(conModulos("ADMINISTRADOR", ["comercializacion"]), "general", "semana"), SinPermisoError);
    assert.equal(await db.semana.count(), semanasAntes);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as permisos from "@/lib/server/permisos";
import {
  esAdministradorComercial,
  esVendedorComercial,
  puedeAdministrarCatalogoComercial,
  puedeAsignarVendedoresComerciales,
  puedeModificarPrecioComercial,
  puedeUsarComercializacion,
  puedeVerCostosComerciales,
} from "@/lib/server/permisos";
import { evaluarAccesoComercial } from "@/lib/server/comercializacion/acceso";
import type { UsuarioSesion } from "@/lib/server/session";
import { usuarioDePrueba } from "../helpers/usuarios";

// Matriz de permisos de Comercialización (B1) y regresión de construcción:
// la marca de vendedor y el módulo nuevo no alteran NINGUNA función de
// permisos existente.

const M = "comercializacion";
type Rol = UsuarioSesion["rol"];
const ROLES: Rol[] = ["MASTER", "DIRECTOR", "ADMINISTRADOR", "SUPERVISOR"];

describe("Matriz de acceso a Comercialización", () => {
  for (const rol of ROLES) {
    for (const conModulo of [true, false]) {
      for (const vendedorComercial of [true, false]) {
        const nombre = `${rol} · módulo ${conModulo ? "sí" : "no"} · marca vendedor ${vendedorComercial ? "sí" : "no"}`;
        test(nombre, () => {
          const u = usuarioDePrueba({ rol, vendedorComercial, modulos: conModulo ? [M] : [] });
          const admin = conModulo && (rol === "ADMINISTRADOR" || rol === "DIRECTOR");
          const vendedor = conModulo && rol === "SUPERVISOR" && vendedorComercial;

          assert.equal(esAdministradorComercial(u), admin, "administración");
          assert.equal(esVendedorComercial(u), vendedor, "vendedor");
          assert.equal(puedeUsarComercializacion(u), admin || vendedor, "uso");
          // Facultades administrativas: nunca el vendedor, nunca Master.
          for (const f of [
            puedeAdministrarCatalogoComercial,
            puedeVerCostosComerciales,
            puedeModificarPrecioComercial,
            puedeAsignarVendedoresComerciales,
          ]) {
            assert.equal(f(u), admin, f.name);
          }
          assert.equal(evaluarAccesoComercial(u).permitido, admin || vendedor);
        });
      }
    }
  }

  test("Motivos de bloqueo en pantalla: sin módulo y Supervisor sin marca", () => {
    const sinModulo = evaluarAccesoComercial(usuarioDePrueba({ rol: "ADMINISTRADOR" }));
    assert.deepEqual(sinModulo, { permitido: false, motivo: "SIN_MODULO" });
    const sinMarca = evaluarAccesoComercial(usuarioDePrueba({ rol: "SUPERVISOR", modulos: [M] }));
    assert.deepEqual(sinMarca, { permitido: false, motivo: "SIN_PERMISO" });
    const master = evaluarAccesoComercial(usuarioDePrueba({ rol: "MASTER" }));
    assert.equal(master.permitido, false);
  });

  test("Un override que APAGA el módulo manda sobre la marca de vendedor", () => {
    const u = usuarioDePrueba({ rol: "SUPERVISOR", vendedorComercial: true });
    u.empresa!.modulosOverride = [{ habilitado: false, modulo: { clave: M, nombre: M } }];
    assert.equal(puedeUsarComercializacion(u), false);
  });
});

describe("Regresión: permisos existentes no cambian por Comercialización", () => {
  // Todas las funciones de permisos que existían antes de B1 (las nuevas de
  // Comercialización se excluyen). Se evalúan con y sin marca de vendedor y
  // con y sin el módulo: el resultado debe ser idéntico.
  const NUEVAS = new Set([
    "esAdministradorComercial",
    "esVendedorComercial",
    "puedeUsarComercializacion",
    "puedeAdministrarCatalogoComercial",
    "puedeVerCostosComerciales",
    "puedeModificarPrecioComercial",
    "puedeAsignarVendedoresComerciales",
    "empresaTieneModulo",
    "obtenerModulosVisibles",
  ]);
  const existentes = Object.entries(permisos).filter(
    ([nombre, f]) => typeof f === "function" && !NUEVAS.has(nombre)
  ) as [string, (u: UsuarioSesion, ...args: unknown[]) => unknown][];

  test("Hay funciones existentes que verificar", () => {
    assert.ok(existentes.length >= 30, `solo ${existentes.length} funciones`);
  });

  for (const rol of ROLES) {
    test(`${rol}: mismas respuestas con marca/módulo de Comercialización`, () => {
      const base = usuarioDePrueba({ rol });
      const variantes = [
        usuarioDePrueba({ rol, vendedorComercial: true }),
        usuarioDePrueba({ rol, modulos: [M] }),
        usuarioDePrueba({ rol, vendedorComercial: true, modulos: [M] }),
      ];
      for (const [nombre, f] of existentes) {
        // Las funciones con un segundo argumento (p. ej. categoría sensible)
        // se prueban con ambos valores.
        for (const extra of [false, true]) {
          const esperado = f(base, extra);
          for (const v of variantes) assert.equal(f(v, extra), esperado, `${nombre}(${rol}, ${extra})`);
        }
      }
    });
  }

  test("Supervisor de construcción conserva exactamente sus permisos de obra", () => {
    const s = usuarioDePrueba({ rol: "SUPERVISOR", vendedorComercial: true, modulos: [M] });
    assert.equal(permisos.puedeReportarAvance(s), true);
    assert.equal(permisos.puedeCapturarGastos(s), true);
    assert.equal(permisos.puedeAprobarGastos(s), false);
    assert.equal(permisos.puedeAdministrarProyectos(s), false);
    assert.equal(permisos.puedeAdministrarCatalogos(s), false);
    assert.equal(permisos.puedeVerContabilidad(s), false);
    assert.equal(permisos.puedeVerInformacionPrivada(s), false);
    assert.equal(permisos.puedeAutorizarOrdenesCompra(s), false);
  });
});

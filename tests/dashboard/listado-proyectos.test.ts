import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  aBusqueda,
  aFiltroProyectos,
  aVistaProyectos,
  coincideBusqueda,
  contarPorFiltro,
  cumpleFiltro,
  hrefListado,
  ordenarProyectos,
  resumenEstatus,
  type EstatusListado,
} from "@/lib/control-de-obra/listado-proyectos";

const p = (nombre: string, estatus: EstatusListado, rangoSalud: number | null = null, cliente: string | null = null) => ({ nombre, estatus, rangoSalud, cliente });

const PROYECTOS = [
  p("CIENEGA", "ACTIVO", 1),
  p("MISSISSIPPI", "ACTIVO", 1),
  p("Ladera del aura", "ACTIVO", 2, "Sr Arturo"),
  p("ASADOR GUADALUPE", "ACTIVO", 2, "GERARDO ISLAS"),
  p("MISSISSIPPI (Corte)", "PAUSADO"),
  p("Bodega", "CERRADO"),
  p("Casa vieja", "CANCELADO"),
];

describe("Proyectos: filtros por estatus", () => {
  test("Activos es el filtro por omisión y cualquier valor desconocido vuelve a él", () => {
    assert.equal(aFiltroProyectos(undefined), "activos");
    assert.equal(aFiltroProyectos("atencion"), "activos");
    assert.equal(aFiltroProyectos(["pausados"]), "activos");
    assert.equal(aFiltroProyectos("cancelados"), "cancelados");
  });

  test("cada filtro muestra solo su estatus; Todos incluye cerrados", () => {
    const nombres = (filtro: Parameters<typeof cumpleFiltro>[1]) => PROYECTOS.filter((x) => cumpleFiltro(x.estatus, filtro)).map((x) => x.nombre);
    assert.deepEqual(nombres("activos"), ["CIENEGA", "MISSISSIPPI", "Ladera del aura", "ASADOR GUADALUPE"]);
    assert.deepEqual(nombres("pausados"), ["MISSISSIPPI (Corte)"]);
    assert.deepEqual(nombres("cancelados"), ["Casa vieja"]);
    assert.equal(nombres("todos").length, 7);
  });

  test("los conteos de los filtros y el resumen del encabezado", () => {
    const conteos = contarPorFiltro(PROYECTOS);
    assert.deepEqual(conteos, { activos: 4, todos: 7, pausados: 1, cancelados: 1 });
    assert.equal(resumenEstatus(conteos), "4 activos y 1 pausado");
    assert.equal(resumenEstatus({ activos: 1, todos: 1, pausados: 0, cancelados: 0 }), "1 activo");
  });
});

describe("Proyectos: búsqueda, orden y enlaces", () => {
  test("busca por nombre o cliente sin importar acentos ni mayúsculas", () => {
    assert.equal(coincideBusqueda({ nombre: "CIÉNEGA", cliente: null }, "cienega"), true);
    assert.equal(coincideBusqueda({ nombre: "Ladera", cliente: "Sr Arturo" }, "arturo"), true);
    assert.equal(coincideBusqueda({ nombre: "Ladera", cliente: null }, "asador"), false);
    assert.equal(coincideBusqueda({ nombre: "Ladera", cliente: null }, ""), true);
    assert.equal(aBusqueda("  bodega  "), "bodega");
    assert.equal(aBusqueda("x".repeat(300)).length, 100);
  });

  test("activos primero, lo que requiere atención antes y luego por nombre", () => {
    const orden = ordenarProyectos([...PROYECTOS].reverse()).map((x) => x.nombre);
    assert.deepEqual(orden, ["CIENEGA", "MISSISSIPPI", "ASADOR GUADALUPE", "Ladera del aura", "MISSISSIPPI (Corte)", "Bodega", "Casa vieja"]);
  });

  test("la URL omite los valores por omisión y conserva los demás", () => {
    assert.equal(hrefListado({ filtro: "activos", vista: "tarjetas", busqueda: "" }), "/control-de-obra");
    assert.equal(hrefListado({ filtro: "pausados", vista: "lista", busqueda: "río" }), "/control-de-obra?estatus=pausados&vista=lista&q=r%C3%ADo");
    assert.equal(aVistaProyectos("lista"), "lista");
    assert.equal(aVistaProyectos("otra"), "tarjetas");
  });
});

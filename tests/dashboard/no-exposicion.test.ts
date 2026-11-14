import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { proyectarResumenEjecutivo, resolverAccesoDashboard } from "@/lib/server/dashboard";
import { usuarioDePrueba } from "../helpers/usuarios";
import { datosDePrueba, HOY, rangoDePrueba, TRAMPAS_PRIVADAS } from "../helpers/datos-dashboard";

// Lo que se serializa hacia el navegador (payload RSC) en vista General no
// debe contener ningún campo privado con valor ni ningún monto que solo
// exista del lado privado.

const LLAVES_PRIVADAS = [
  "utilidad",
  "desviacionPrivadaPP",
  "utilidadConsolidada",
  "costoRealPagado",
  "utilidadReal",
  "utilidadPresupuestada",
  // Indicadores de la fila principal Privado (Inicio V2).
  "privado",
  "costoCubierto",
  "presupuestoCosto",
  "porcentajeCubierto",
  "obrasAdelantadas",
];

function llavesPrivadasConValor(valor: unknown, ruta = "$"): string[] {
  if (valor === null || typeof valor !== "object") return [];
  const hallazgos: string[] = [];
  for (const [llave, v] of Object.entries(valor)) {
    if (LLAVES_PRIVADAS.includes(llave) && v !== null && v !== undefined) hallazgos.push(`${ruta}.${llave}`);
    hallazgos.push(...llavesPrivadasConValor(v, `${ruta}.${llave}`));
  }
  return hallazgos;
}

const usuariosEnGeneral = [
  { nombre: "Director con permiso privado, en vista General", usuario: usuarioDePrueba({ rol: "DIRECTOR" }) },
  { nombre: "Administrador con permiso privado, en vista General", usuario: usuarioDePrueba({ rol: "ADMINISTRADOR" }) },
  { nombre: "Administrador con switch apagado", usuario: usuarioDePrueba({ rol: "ADMINISTRADOR", vistaPrivadaActiva: false }) },
  { nombre: "Director de Empresa sin Privado", usuario: usuarioDePrueba({ rol: "DIRECTOR", privadoHabilitado: false }) },
  { nombre: "Supervisor", usuario: usuarioDePrueba({ rol: "SUPERVISOR" }) },
];

describe("No exposición de datos privados en vista General", () => {
  for (const { nombre, usuario } of usuariosEnGeneral) {
    test(nombre, () => {
      const acceso = resolverAccesoDashboard(usuario, "general");
      const resultado = proyectarResumenEjecutivo(datosDePrueba(), acceso, "semana", rangoDePrueba(), HOY);
      const json = JSON.stringify(resultado);

      assert.deepEqual(llavesPrivadasConValor(JSON.parse(json)), [], "ningún campo privado debe llegar con valor");

      for (const [nombreTrampa, monto] of Object.entries(TRAMPAS_PRIVADAS)) {
        assert.ok(!json.includes(String(monto)), `el monto privado ${nombreTrampa} (${monto}) no debe aparecer`);
      }
      assert.ok(!json.includes('"desviacion"'), "no debe aparecer la alerta de desviación");
    });
  }

  test("El usuario con permiso que pide Privado sí recibe los datos privados (control)", () => {
    const acceso = resolverAccesoDashboard(usuarioDePrueba({ rol: "DIRECTOR" }), "privado");
    const resultado = proyectarResumenEjecutivo(datosDePrueba(), acceso, "semana", rangoDePrueba(), HOY);
    assert.ok(llavesPrivadasConValor(resultado).length > 0);
  });

  // Punto 1 del diagnóstico (D2): resuelto con E1 — ver e1-flujo-general.test.ts.
});

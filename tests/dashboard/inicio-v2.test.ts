import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  priorizarPendientes,
  proyectarResumenEjecutivo,
  resolverAccesoDashboard,
  type AlertaDashboard,
  type CompromisoDashboard,
  type DatosDashboard,
} from "@/lib/server/dashboard";
import { usuarioDePrueba } from "../helpers/usuarios";
import { datosDePrueba, HOY, IDS, rangoDePrueba, TRAMPAS_PRIVADAS } from "../helpers/datos-dashboard";

// Inicio V2 (noviembre 2026): agregados nuevos de la fila principal Privado,
// antigüedad de Por pagar Obras, conteo de estimaciones por cobrar y la
// fusión de alertas + compromisos. Ninguno introduce una fórmula financiera
// nueva — solo suman lo que ya calculaba la proyección por obra.

function proyectar(vista: "general" | "privado", datos: DatosDashboard = datosDePrueba(), rol: "DIRECTOR" | "SUPERVISOR" = "DIRECTOR") {
  const acceso = resolverAccesoDashboard(usuarioDePrueba({ rol }), vista);
  return proyectarResumenEjecutivo(datos, acceso, "semana", rangoDePrueba(), HOY);
}

const PRESUPUESTO_TORRE = TRAMPAS_PRIVADAS.presupuestoCostoTorre; // 100 × 4,321.09
const PRESUPUESTO_BODEGA = 130000; // 50 × 2,600

describe("Inicio V2 · indicadores privados", () => {
  test("Costo cubierto = liquidado + puente, sin gasto directo solo aprobado", () => {
    const r = proyectar("privado");
    assert.ok(r.privado);
    // Torre 400,000 liquidado + Bodega 50,000 liquidado. El gasto directo de
    // Torre (12,345.67) sí entra a costoRealPagado (utilidad), NO aquí.
    assert.equal(r.privado.costoCubierto, 450000);
    assert.ok(Math.abs(r.privado.presupuestoCosto - (PRESUPUESTO_TORRE + PRESUPUESTO_BODEGA)) < 1e-6);
    assert.ok(Math.abs((r.privado.porcentajeCubierto ?? 0) - (450000 / (PRESUPUESTO_TORRE + PRESUPUESTO_BODEGA)) * 100) < 1e-9);

    const torre = r.proyectos.find((p) => p.id === IDS.TORRE)!;
    assert.equal(torre.utilidad?.costoRealPagado, 400000 + TRAMPAS_PRIVADAS.costoDirectoEmpresaTorre);
  });

  test("PAGADO_PUENTE entra al costo cubierto pero no cambia el flujo neto", () => {
    const base = proyectar("privado");
    const datos = datosDePrueba();
    datos.movimientosSemanales.push(
      {
        montoFinSemana: new Prisma.Decimal(30000),
        estatusAprobacion: "APROBADO",
        estatusPago: "PAGADO_PUENTE",
        fechaPago: new Date(2026, 9, 7, 12),
        createdAt: new Date(2026, 9, 5, 12),
        origen: "CORTE_CONTRATISTA",
        beneficiarioProyecto: { proyectoId: IDS.BODEGA },
      },
      // Aprobado y sin pagar: nunca es costo cubierto.
      {
        montoFinSemana: new Prisma.Decimal(9999),
        estatusAprobacion: "APROBADO",
        estatusPago: "PENDIENTE_PAGO",
        fechaPago: null,
        createdAt: new Date(2026, 9, 7, 12),
        origen: "CORTE_CONTRATISTA",
        beneficiarioProyecto: { proyectoId: IDS.BODEGA },
      }
    );
    const r = proyectar("privado", datos);
    assert.equal(r.privado?.costoCubierto, 480000);
    assert.deepEqual(r.flujoDinero, base.flujoDinero, "el flujo sigue contando solo LIQUIDADO");
  });

  test("Obras con costo adelantado: misma regla y umbral que la alerta de desviación", () => {
    const r = proyectar("privado");
    assert.ok(r.privado);
    assert.equal(r.privado.umbralPP, 15);
    // Pausada no tiene conceptos: su desviación no es calculable.
    assert.equal(r.privado.obrasConDesviacionCalculable, 2);
    // Torre: 400,000/432,109 = 92.6 % ejercido vs 60 % físico; Bodega: 38.5 % vs 20 %.
    assert.deepEqual(r.privado.obrasAdelantadas.map((o) => o.id), [IDS.TORRE, IDS.BODEGA]);
    assert.ok(Math.abs(r.privado.obrasAdelantadas[0].desviacionPP - ((400000 / PRESUPUESTO_TORRE) * 100 - 60)) < 1e-9);
  });

  test("General y Supervisor nunca reciben los indicadores privados", () => {
    assert.equal(proyectar("general").privado, null);
    assert.equal(proyectar("privado", datosDePrueba(), "SUPERVISOR").privado, null);
    assert.equal(proyectar("general", datosDePrueba(), "SUPERVISOR").privado, null);
  });
});

describe("Inicio V2 · Por pagar y Por cobrar", () => {
  test("La antigüedad es solo de Obras y es null cuando Obras no debe nada", () => {
    assert.equal(proyectar("general").porPagarObrasDiasMax, 2);

    const sinPendienteObras = datosDePrueba();
    sinPendienteObras.movimientosSemanales = sinPendienteObras.movimientosSemanales.filter((m) => m.estatusPago !== "PENDIENTE_PAGO");
    const r = proyectar("general", sinPendienteObras);
    assert.equal(r.porPagarObras, 0);
    // Empresa sigue debiendo, pero nunca se le atribuye una antigüedad.
    assert.equal(r.porPagarEmpresa, 86200);
    assert.equal(r.porPagarObrasDiasMax, null);
  });

  test("Estimaciones por cobrar sale del mismo cálculo que el saldo", () => {
    assert.equal(proyectar("general").estimacionesPorCobrar, 2);
    assert.equal(proyectar("general", datosDePrueba(), "SUPERVISOR").estimacionesPorCobrar, null);
  });
});

describe("Inicio V2 · pendientes", () => {
  test("General: omite lo que ya muestran Por pagar y Por cobrar, sin repetir el pago como compromiso", () => {
    const r = proyectar("general");
    const tipos = r.pendientes.map((p) => p.tipo);
    assert.ok(!tipos.includes("pagos_pendientes"));
    assert.ok(!tipos.includes("pendiente_cobro"));
    assert.ok(!tipos.includes("pago_pendiente"));
    assert.ok(!tipos.includes("desviacion"));
  });

  test("Privado: muestra pagos y cobros (no hay indicador arriba), omite la desviación", () => {
    const r = proyectar("privado");
    const tipos = r.pendientes.map((p) => p.tipo);
    assert.ok(tipos.includes("pagos_pendientes"));
    assert.ok(tipos.includes("pendiente_cobro"));
    assert.ok(!tipos.includes("desviacion"));
    assert.ok(!tipos.includes("pago_pendiente"), "el compromiso del mismo pago no se repite");
  });

  test("Un compromiso sin alerta de su asunto sí aparece; con alerta, no", () => {
    const alerta: AlertaDashboard = {
      tipo: "reposicion_pendiente_antigua",
      severidad: "ATENCION",
      titulo: "$5,000 en reposiciones abiertas",
      detalle: "1 reposición",
      monto: 5000,
      href: "/contabilidad/egresos",
    };
    const compromisos: CompromisoDashboard[] = [
      { tipo: "reposicion_pendiente", titulo: "Reposición REP-1", detalle: "Torre", monto: 5000, href: "/contabilidad/egresos" },
      { tipo: "gasto_recurrente_variable", titulo: "Renta", detalle: "Torre", monto: null, href: "/gastos/recurrentes" },
    ];
    const conAlerta = priorizarPendientes([alerta], compromisos, "general").map((p) => p.tipo);
    assert.deepEqual(conAlerta, ["reposicion_pendiente_antigua", "gasto_recurrente_variable"]);
    const sinAlerta = priorizarPendientes([], compromisos, "general").map((p) => p.tipo);
    assert.deepEqual(sinAlerta, ["reposicion_pendiente", "gasto_recurrente_variable"]);
  });

  test("Requiere acción va primero, luego la prioridad D13", () => {
    const a = (tipo: AlertaDashboard["tipo"], severidad: AlertaDashboard["severidad"]): AlertaDashboard => ({
      tipo,
      severidad,
      titulo: tipo,
      detalle: "",
      href: "/x",
    });
    const orden = priorizarPendientes(
      [a("facturas_pendientes", "ATENCION"), a("gastos_pendientes", "ATENCION"), a("semanas_sin_cerrar", "REQUIERE_ACCION"), a("estimaciones_listas", "ATENCION")],
      [],
      "general"
    ).map((p) => p.tipo);
    assert.deepEqual(orden, ["semanas_sin_cerrar", "estimaciones_listas", "gastos_pendientes", "facturas_pendientes"]);
  });

  test("Supervisor: solo pendientes operativos y conteo de obras sin avance", () => {
    const datos = datosDePrueba();
    // Último avance hace >2 semanas para ambas obras.
    datos.ultimaSemanaConAvance = datos.ultimaSemanaConAvance.map((f) => ({ ...f, semana: { fechaFin: new Date(2026, 8, 15, 12) } }));
    const r = proyectar("general", datos, "SUPERVISOR");
    assert.equal(r.obrasSinAvanceReciente, 2);
    assert.ok(r.pendientes.length > 0);
    assert.ok(r.pendientes.every((p) => p.tipo === "sin_avance_reciente"));
    assert.ok(r.pendientes.every((p) => p.monto === null));
  });
});

import { db } from "@/lib/server/db";

// Base de datos SIMULADA en memoria para probar las rutas de cobro
// (registrar / editar / aplicar fondo / cancelar) sin una base real:
// - implementa solo las consultas que esas rutas usan;
// - simula los bloqueos `SELECT … FOR UPDATE` como candados por fila que se
//   liberan al terminar la transacción, y cede el turno entre consultas para
//   que dos transacciones concurrentes realmente se intercalen.
// Nunca toca una base real: sustituye los métodos del cliente `db` y los
// restaura con `restaurar()`.

export type CapaSimulada = {
  id: string;
  estimacionClienteId: string;
  capa: "OPERATIVO" | "PRIVADO";
  estatus: "BORRADOR" | "EMITIDA";
  total: number;
};

export type MovimientoSimulado = {
  id: string;
  tipo: "APORTACION_FONDO" | "PAGO_ESTIMACION" | "APLICACION_ESTIMACION";
  monto: number;
  fecha: Date;
  createdAt: Date;
  estimacionClienteCapaId: string | null;
  estatus: "VIGENTE" | "CANCELADO";
};

const EMPRESA = "empresa-prueba";
const PROYECTO = "proyecto-cobros";

type Fila = Record<string, unknown>;

function coincide(fila: Fila, where: Fila | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([llave, esperado]) => {
    if (llave === "estimacionCliente") {
      const e = esperado as Fila;
      return (e.empresaId === undefined || e.empresaId === EMPRESA) && (e.proyectoId === undefined || e.proyectoId === PROYECTO);
    }
    if (llave === "empresaId") return esperado === EMPRESA;
    if (llave === "proyectoId") return esperado === PROYECTO;
    const valor = fila[llave];
    if (esperado !== null && typeof esperado === "object" && !(esperado instanceof Date)) {
      const op = esperado as { in?: unknown[]; not?: unknown };
      if (op.in) return op.in.includes(valor);
      if ("not" in op) return valor !== op.not;
    }
    return valor === esperado;
  });
}

const ceder = () => new Promise<void>((r) => setImmediate(r));
// Antes de escribir se cede varias veces: da tiempo a que otra transacción
// concurrente lea el estado anterior. Sin un candado real, ambas validarían
// contra el mismo saldo — exactamente la carrera que deben impedir las rutas.
const cederAntesDeEscribir = async () => {
  for (let i = 0; i < 20; i++) await ceder();
};

export function crearBdEnMemoria(inicial: { capas: CapaSimulada[]; movimientos: MovimientoSimulado[] }) {
  const capas = inicial.capas.map((c) => ({ ...c }));
  const movimientos = inicial.movimientos.map((m) => ({ ...m }));
  let siguiente = 1;
  let reloj = Date.UTC(2026, 9, 8, 12);

  // Candados por fila: cola de promesas por llave.
  const candados = new Map<string, Promise<void>>();
  async function tomarCandado(llave: string): Promise<() => void> {
    const anterior = candados.get(llave) ?? Promise.resolve();
    let liberar!: () => void;
    const actual = new Promise<void>((r) => (liberar = r));
    const encadenado = anterior.then(() => actual);
    candados.set(llave, encadenado);
    await anterior;
    return liberar;
  }

  const conRelaciones = (c: CapaSimulada) => ({ ...c, estimacionCliente: { proyectoId: PROYECTO, empresaId: EMPRESA } });
  const movConRelaciones = (m: MovimientoSimulado) => {
    const capa = capas.find((c) => c.id === m.estimacionClienteCapaId);
    return {
      ...m,
      empresaId: EMPRESA,
      proyectoId: PROYECTO,
      referencia: null,
      notas: null,
      motivoCancelacion: null,
      registradoPor: { nombre: "Usuario Prueba" },
      estimacionClienteCapa: capa ? { capa: capa.capa } : null,
    };
  };

  // El alcance del Supervisor (obras-visibles.ts) se da por asignado aquí: estas
  // pruebas comprueban los permisos que siguen. Se prueba en obras-supervisor.
  const sinAlcance = (where?: Fila) => {
    const resto = { ...where };
    delete resto.accesosObra;
    delete resto.tipo;
    return resto;
  };
  const delegados = {
    // Un solo proyecto, de la Empresa simulada (ver obtenerProyecto).
    proyecto: {
      findFirst: async ({ where }: { where?: Fila }) => (await ceder(), coincide({ id: PROYECTO }, sinAlcance(where)) ? { id: PROYECTO, empresaId: EMPRESA, nombre: "Obra Prueba" } : null),
    },
    estimacionClienteCapa: {
      findFirst: async ({ where }: { where?: Fila }) => (await ceder(), capas.map(conRelaciones).find((c) => coincide(c, where)) ?? null),
      findFirstOrThrow: async ({ where }: { where?: Fila }) => {
        await ceder();
        const c = capas.map(conRelaciones).find((x) => coincide(x, where));
        if (!c) throw new Error("No encontrada");
        return c;
      },
      findMany: async ({ where }: { where?: Fila } = {}) => (await ceder(), capas.map(conRelaciones).filter((c) => coincide(c, where))),
    },
    movimientoFinancieroCliente: {
      findFirst: async ({ where }: { where?: Fila }) => (await ceder(), movimientos.map(movConRelaciones).find((m) => coincide(m, where)) ?? null),
      findMany: async ({ where }: { where?: Fila } = {}) => (await ceder(), movimientos.map(movConRelaciones).filter((m) => coincide(m, where))),
      create: async ({ data }: { data: Fila }) => {
        await cederAntesDeEscribir();
        reloj += 1000;
        const nuevo: MovimientoSimulado = {
          id: `nuevo-${siguiente++}`,
          tipo: data.tipo as MovimientoSimulado["tipo"],
          monto: Number(data.monto),
          fecha: (data.fecha as Date) ?? new Date(reloj),
          createdAt: new Date(reloj),
          estimacionClienteCapaId: (data.estimacionClienteCapaId as string) ?? null,
          estatus: "VIGENTE",
        };
        movimientos.push(nuevo);
        return nuevo;
      },
      update: async ({ where, data }: { where: { id: string }; data: Fila }) => {
        await cederAntesDeEscribir();
        const m = movimientos.find((x) => x.id === where.id)!;
        if (data.monto !== undefined) m.monto = Number(data.monto);
        if (data.estatus !== undefined) m.estatus = data.estatus as MovimientoSimulado["estatus"];
        if (data.fecha !== undefined) m.fecha = data.fecha as Date;
        return m;
      },
    },
    ingreso: { create: async () => ({}), upsert: async () => ({}) },
    registroAuditoria: { create: async () => ({}) },
  };

  async function transaccion<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const liberaciones: (() => void)[] = [];
    const tx = {
      ...delegados,
      $queryRaw: async (partes: TemplateStringsArray, ...valores: unknown[]) => {
        const sql = partes.join("?");
        if (/FOR UPDATE/i.test(sql)) {
          const tabla = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? "?";
          liberaciones.push(await tomarCandado(`${tabla}:${String(valores[0])}`));
        }
        await ceder();
        return [];
      },
    };
    try {
      return await fn(tx);
    } finally {
      liberaciones.reverse().forEach((l) => l());
    }
  }

  // Instalar sobre el cliente real (solo en memoria del proceso de prueba).
  const cliente = db as unknown as Record<string, Record<string, unknown>> & { $transaction: unknown };
  const originales: [Record<string, unknown>, string, unknown][] = [];
  for (const [nombre, metodos] of Object.entries(delegados)) {
    const destino = cliente[nombre];
    for (const [metodo, impl] of Object.entries(metodos)) {
      originales.push([destino, metodo, destino[metodo]]);
      destino[metodo] = impl;
    }
  }
  const transaccionOriginal = cliente.$transaction;
  (cliente as { $transaction: unknown }).$transaction = transaccion;

  return {
    proyectoId: PROYECTO,
    empresaId: EMPRESA,
    capas,
    movimientos,
    transaccion,
    cobroVigente: (estimacionClienteId: string) => {
      const ids = new Set(capas.filter((c) => c.estimacionClienteId === estimacionClienteId).map((c) => c.id));
      return movimientos
        .filter((m) => m.estatus === "VIGENTE" && m.tipo !== "APORTACION_FONDO" && m.estimacionClienteCapaId && ids.has(m.estimacionClienteCapaId))
        .reduce((t, m) => t + m.monto, 0);
    },
    restaurar: () => {
      for (const [destino, metodo, original] of originales) destino[metodo] = original;
      (cliente as { $transaction: unknown }).$transaction = transaccionOriginal;
    },
  };
}

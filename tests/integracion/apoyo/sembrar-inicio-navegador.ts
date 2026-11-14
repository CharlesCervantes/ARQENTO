import { createHash } from "node:crypto";
import { db } from "@/lib/server/db";
import { obtenerOCrearSemana } from "@/lib/server/semanas";
import { validarBaseDePruebas } from "../../helpers/base-de-pruebas";
import { BENEFICIARIO, EMPRESA, admin, baseLimpiaConDatos, supervisor, verificarConexionDePruebas } from "./base";

// Datos FICTICIOS para revisar Inicio V2 en un navegador local (no es una
// prueba automática). Solo corre con la preparación de las pruebas de
// integración (base local protegida, identidad verificada, servicios
// externos simulados):
//   node --conditions=react-server --import tsx --import ./tests/setup/integracion.mjs tests/integracion/apoyo/sembrar-inicio-navegador.ts
// Variables (valores aleatorios, solo para la base local):
//   TOKEN_SESION_LOCAL             sesión del Administrador
//   TOKEN_SESION_LOCAL_SUPERVISOR  sesión del Supervisor (opcional)
//   TOKEN_SESION_LOCAL_MASTER      sesión de un Master ficticio (opcional)
//   IMAGENES_LOCALES_URL           servidor local de imágenes de portada (opcional)
//   INICIO_VACIO=1                 Empresa sin obras (estado vacío)

const TOKEN_ADMIN = process.env.TOKEN_SESION_LOCAL;
const TOKEN_SUPERVISOR = process.env.TOKEN_SESION_LOCAL_SUPERVISOR;
const TOKEN_MASTER = process.env.TOKEN_SESION_LOCAL_MASTER;
const IMAGENES = process.env.IMAGENES_LOCALES_URL;
const VACIO = process.env.INICIO_VACIO === "1";
if (!TOKEN_ADMIN) throw new Error("Falta TOKEN_SESION_LOCAL (un valor aleatorio, solo para la base local).");

// Protección explícita del destino — corre ANTES de cualquier consulta.
// 1) Sin conexión: TEST_DATABASE_URL debe existir y cumplir las reglas de la
//    base de pruebas (PostgreSQL local, nombre *_test, nunca Neon), y el
//    cliente `db` debe estar apuntando exactamente a ella (lo hace
//    tests/setup/integracion.mjs). Si el script se lanza sin esa
//    preparación, DATABASE_URL vendría del .env (desarrollo compartido o
//    producción) y aquí se detiene.
// 2) Conectado, solo lectura: la base debe tener el marcador exclusivo de
//    pruebas de ARQENTO, leído con el MISMO cliente que va a escribir.
async function protegerDestino() {
  if (process.env.VERCEL_ENV || process.env.NODE_ENV === "production") {
    throw new Error("Siembra cancelada: entorno de despliegue.");
  }
  const testUrl = validarBaseDePruebas(process.env.TEST_DATABASE_URL, []);
  if (process.env.DATABASE_URL !== testUrl) {
    throw new Error("Siembra cancelada: DATABASE_URL no es la base local de pruebas. Ejecútalo con --import ./tests/setup/integracion.mjs.");
  }
  await verificarConexionDePruebas();
}

const DIA = 86_400_000;
const haceDias = (n: number) => new Date(Date.now() - n * DIA);

type Obra = {
  id: string;
  nombre: string;
  imagen?: string;
  estatus?: "ACTIVO" | "PAUSADO";
  // [cantidad, precio contratista General (null = sin precio), precio contratista Privado]
  conceptos: [number, number | null, number][];
  // Fracción ejecutada por semana atrás (0 = esta semana): { semanasAtras: fracción }
  avance: Record<number, number>;
  pagos?: { monto: number; estatus: "LIQUIDADO" | "PENDIENTE_PAGO" | "PAGADO_PUENTE"; diasAtras: number }[];
  estimacion?: { totalGeneral: number; totalPrivado?: number; cobrado: number };
  gastosPorRevisar?: number;
};

const OBRAS: Obra[] = [
  {
    id: "obra-torre",
    nombre: "Torre Valle Oriente",
    imagen: "torre.svg",
    conceptos: [[100, 9000, 9800], [40, 12000, 13100]],
    avance: { 1: 0.4, 2: 0.24 },
    pagos: [
      { monto: 640000, estatus: "LIQUIDADO", diasAtras: 5 },
      { monto: 185000, estatus: "PENDIENTE_PAGO", diasAtras: 16 },
    ],
    estimacion: { totalGeneral: 980000, totalPrivado: 1150000, cobrado: 500000 },
  },
  {
    id: "obra-bodega",
    nombre: "Bodega Industrial Apodaca",
    imagen: "bodega.svg",
    conceptos: [[300, 2500, 2900]],
    avance: { 0: 0.08, 1: 0.3 },
    pagos: [{ monto: 410000, estatus: "LIQUIDADO", diasAtras: 2 }, { monto: 60000, estatus: "PAGADO_PUENTE", diasAtras: 3 }],
    estimacion: { totalGeneral: 300000, cobrado: 300000 },
    gastosPorRevisar: 2,
  },
  {
    // Casos especiales: nombre largo, un concepto sin precio (avance físico
    // "Sin datos") y facturado mayor a 100 % (450,000 sobre 400,000).
    id: "obra-casa",
    nombre: "Casa Chipinque Residencial con Alberca, Terraza y Estudio Independiente",
    conceptos: [[50, 8000, 8400], [10, null, 900]],
    avance: { 0: 0.11, 1: 0.8 },
    pagos: [{ monto: 300000, estatus: "LIQUIDADO", diasAtras: 4 }],
    estimacion: { totalGeneral: 450000, cobrado: 450000 },
  },
  {
    id: "obra-plaza",
    nombre: "Plaza Comercial Cumbres",
    imagen: "plaza.svg",
    conceptos: [[500, 6000, 6300]],
    avance: { 3: 0.22 },
    pagos: [{ monto: 420000, estatus: "LIQUIDADO", diasAtras: 20 }],
  },
  {
    id: "obra-nave",
    nombre: "Nave Escobedo",
    conceptos: [[120, 7000, 7700]],
    avance: { 0: 0.12, 1: 0.35 },
    pagos: [{ monto: 92000, estatus: "PENDIENTE_PAGO", diasAtras: 3 }],
    estimacion: { totalGeneral: 260000, cobrado: 0 },
  },
  {
    id: "obra-escuela",
    nombre: "Escuela Primaria Fase 2",
    imagen: "escuela.svg",
    conceptos: [[80, 5000, 5300]],
    avance: {},
  },
  {
    id: "obra-oficinas",
    nombre: "Oficinas Centro",
    estatus: "PAUSADO",
    conceptos: [[60, 4000, 4200]],
    avance: { 6: 0.15 },
  },
];

async function sembrar() {
  await protegerDestino();
  await baseLimpiaConDatos();
  await db.empresa.update({ where: { id: EMPRESA }, data: { privadoHabilitado: true, colorPrimario: "#1f6f5c" } });

  // Módulos a los que Inicio enlaza (la base de pruebas no tiene plan).
  for (const [clave, nombre] of [
    ["control_de_obra", "Control de Obra"],
    ["reporte_general", "Reporte General"],
    ["contabilidad", "Contabilidad"],
    ["gastos", "Gastos"],
  ]) {
    const modulo = await db.modulo.upsert({ where: { clave }, update: {}, create: { clave, nombre } });
    await db.empresaModulo.create({ data: { empresaId: EMPRESA, moduloId: modulo.id, habilitado: true } });
  }

  for (const [usuarioId, token] of [
    [admin.id, TOKEN_ADMIN],
    [supervisor.id, TOKEN_SUPERVISOR],
  ] as const) {
    if (!token) continue;
    await db.sesion.create({
      data: { usuarioId, tokenHash: createHash("sha256").update(token).digest("hex"), expiraEn: new Date(Date.now() + 3_600_000) },
    });
  }
  if (TOKEN_MASTER) {
    const master = await db.usuario.create({
      data: { nombre: "Master Ficticio", email: "master@prueba.invalid", passwordHash: "sin-acceso", rol: "MASTER", empresaId: null },
    });
    await db.sesion.create({
      data: { usuarioId: master.id, tokenHash: createHash("sha256").update(TOKEN_MASTER).digest("hex"), expiraEn: new Date(Date.now() + 3_600_000) },
    });
  }
  await db.usuario.update({ where: { id: admin.id }, data: { vistaPrivadaActiva: true, nombre: "Lucía Ficticia" } });
  await db.usuario.update({ where: { id: supervisor.id }, data: { nombre: "Mateo Ficticio" } });

  // La obra base de las pruebas no forma parte de esta revisión.
  await db.proyecto.update({ where: { id: "proyecto-int" }, data: { estatus: "CERRADO" } });
  if (VACIO) return console.log("Empresa sin obras lista.");

  const semanas = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((n) => obtenerOCrearSemana(EMPRESA, haceDias(n * 7))));

  for (const obra of OBRAS) {
    await db.proyecto.create({
      data: {
        id: obra.id,
        empresaId: EMPRESA,
        nombre: obra.nombre,
        estatus: obra.estatus ?? "ACTIVO",
        esquemaContractual: "ADMINISTRACION",
        imagenRef: obra.imagen && IMAGENES ? `${IMAGENES}/${obra.imagen}` : null,
      },
    });
    const partida = await db.partida.create({ data: { proyectoId: obra.id, nombre: "Obra civil" } });
    const bp = await db.beneficiarioProyecto.create({ data: { beneficiarioId: BENEFICIARIO, proyectoId: obra.id } });

    for (const [i, [cantidad, precio, privado]] of obra.conceptos.entries()) {
      const concepto = await db.concepto.create({
        data: {
          partidaId: partida.id,
          descripcion: `Concepto ${i + 1}`,
          unidad: "m2",
          cantidadContratada: cantidad,
          precioUnitarioContratista: precio,
          precioUnitarioContratistaPrivado: privado,
        },
      });
      for (const [atras, fraccion] of Object.entries(obra.avance)) {
        await db.avanceConcepto.create({
          data: {
            empresaId: EMPRESA,
            conceptoId: concepto.id,
            semanaId: semanas[Number(atras)].id,
            cantidadEjecutada: Math.round(cantidad * fraccion * 1000) / 1000,
            registradoPorId: supervisor.id,
            estatusAprobacion: "APROBADO",
          },
        });
      }
    }

    // Semanas pasadas cerradas (salvo la anterior de Torre, para tener una
    // semana pendiente de cierre).
    for (const n of [1, 2, 3, 4, 5, 6]) {
      if (obra.id === "obra-torre" && n === 1) continue;
      await db.cierreSemanaProyecto.create({
        data: { empresaId: EMPRESA, proyectoId: obra.id, semanaId: semanas[n].id, cerradoPorId: admin.id },
      });
    }

    // Un movimiento por obra y semana (restricción de la tabla).
    for (const [i, pago] of (obra.pagos ?? []).entries()) {
      await db.movimientoSemanal.create({
        data: {
          beneficiarioProyectoId: bp.id,
          semanaId: semanas[Math.min(6, Math.floor(pago.diasAtras / 7) + i)].id,
          origen: "CORTE_CONTRATISTA",
          enviadoPorId: admin.id,
          montoFinSemana: pago.monto,
          estatusAprobacion: "APROBADO",
          estatusPago: pago.estatus,
          fechaPago: pago.estatus === "PENDIENTE_PAGO" ? null : haceDias(pago.diasAtras),
          createdAt: haceDias(pago.diasAtras),
        },
      });
    }

    if (obra.estimacion) {
      const est = await db.estimacionCliente.create({
        data: { empresaId: EMPRESA, proyectoId: obra.id, semanaId: semanas[2].id, generadoPorId: admin.id },
      });
      const capaGeneral = await db.estimacionClienteCapa.create({
        data: {
          estimacionClienteId: est.id,
          capa: "OPERATIVO",
          estatus: "EMITIDA",
          subtotal: obra.estimacion.totalGeneral * 0.9,
          montoAdministracionTrabajos: obra.estimacion.totalGeneral * 0.1,
          total: obra.estimacion.totalGeneral,
          emitidoEn: haceDias(10),
          generadoPorId: admin.id,
        },
      });
      const capaPrivada = obra.estimacion.totalPrivado
        ? await db.estimacionClienteCapa.create({
            data: {
              estimacionClienteId: est.id,
              capa: "PRIVADO",
              estatus: "EMITIDA",
              subtotal: obra.estimacion.totalPrivado,
              montoAdministracionTrabajos: 0,
              total: obra.estimacion.totalPrivado,
              emitidoEn: haceDias(10),
              generadoPorId: admin.id,
            },
          })
        : null;
      if (obra.estimacion.cobrado > 0) {
        await db.movimientoFinancieroCliente.create({
          data: {
            empresaId: EMPRESA,
            proyectoId: obra.id,
            tipo: "PAGO_ESTIMACION",
            monto: obra.estimacion.cobrado,
            fecha: haceDias(1),
            registradoPorId: admin.id,
            estimacionClienteCapaId: (capaPrivada ?? capaGeneral).id,
          },
        });
      }
    }

    for (let g = 0; g < (obra.gastosPorRevisar ?? 0); g++) {
      await db.gastoObra.create({
        data: {
          empresaId: EMPRESA,
          proyectoId: obra.id,
          semanaId: semanas[0].id,
          fecha: haceDias(1),
          descripcion: `Material ficticio ${g + 1}`,
          categoria: "MATERIALES",
          monto: 4500 + g * 1200,
          metodoPago: "EFECTIVO",
          pagadorBeneficiarioId: null,
          capturadoPorId: supervisor.id,
          estatus: "PENDIENTE_REVISION",
        },
      });
    }
  }

  // Por pagar de Empresa (Proyecto-Oficina) — sin antigüedad calculada.
  await db.proyecto.create({ data: { id: "oficina", empresaId: EMPRESA, nombre: "Oficina", tipo: "OFICINA" } });
  const bpOficina = await db.beneficiarioProyecto.create({ data: { beneficiarioId: BENEFICIARIO, proyectoId: "oficina" } });
  await db.movimientoSemanal.create({
    data: {
      beneficiarioProyectoId: bpOficina.id,
      semanaId: semanas[0].id,
      origen: "REPOSICION_GASTOS",
      enviadoPorId: admin.id,
      montoFinSemana: 18450,
      estatusAprobacion: "APROBADO",
      estatusPago: "PENDIENTE_PAGO",
    },
  });

  console.log("Datos ficticios de Inicio listos.");
}

sembrar()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Error");
    process.exitCode = 1;
  });

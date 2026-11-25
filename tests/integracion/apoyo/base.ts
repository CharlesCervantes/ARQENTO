import { db } from "@/lib/server/db";
import { baseDeUrl, limpiarDatosDePrueba, verificarIdentidadOAbortar, type Consultar } from "../../helpers/identidad-base-pruebas";
import { usuarioDePrueba } from "../../helpers/usuarios";
import type { UsuarioSesion } from "@/lib/server/session";

// Apoyo de las pruebas de integración contra PostgreSQL real. Solo corre
// después de tests/setup/integracion.mjs (URL validada, identidad verificada,
// servicios externos simulados). Todos los datos son FICTICIOS y cada prueba
// empieza con la base vacía (limpieza verificada de nuevo antes de borrar).

export const EMPRESA = "empresa-prueba";
export const EMPRESA_AJENA = "empresa-ajena";
export const PROYECTO = "proyecto-int";
export const PROYECTO_AJENO = "proyecto-int-ajeno";
export const SEMANA = "semana-int";
export const SEMANA_AJENA = "semana-int-ajena";
export const BENEFICIARIO = "benef-andres";
export const BENEFICIARIO_AJENO = "benef-ajeno";
export const MEDIO_BANCO = "medio-banco";
export const MEDIO_AJENO = "medio-ajeno";

export const admin: UsuarioSesion = usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA });
export const supervisor: UsuarioSesion = usuarioDePrueba({ rol: "SUPERVISOR", empresaId: EMPRESA });
export const adminAjeno: UsuarioSesion = { ...usuarioDePrueba({ rol: "ADMINISTRADOR", empresaId: EMPRESA_AJENA }), id: "usuario-admin-ajeno" };

const consultar: Consultar = (sql, parametros = []) => db.$queryRawUnsafe(sql, ...parametros);

function baseEsperada(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Falta TEST_DATABASE_URL.");
  return baseDeUrl(url);
}

// Comprobación de identidad desde el MISMO cliente que usan las pruebas.
export async function verificarConexionDePruebas() {
  return verificarIdentidadOAbortar(consultar, baseEsperada());
}

export async function baseLimpiaConDatos() {
  await limpiarDatosDePrueba(consultar, (sql) => db.$executeRawUnsafe(sql), baseEsperada());
  await sembrar();
}

async function sembrar() {
  await db.empresa.createMany({
    data: [
      { id: EMPRESA, nombre: "Constructora Prueba (ficticia)" },
      { id: EMPRESA_AJENA, nombre: "Constructora Ajena (ficticia)" },
    ],
  });
  await db.usuario.createMany({
    data: [
      { id: admin.id, nombre: "Admin Prueba", email: "admin@prueba.invalid", passwordHash: "sin-acceso", rol: "ADMINISTRADOR", empresaId: EMPRESA },
      { id: supervisor.id, nombre: "Supervisor Prueba", email: "supervisor@prueba.invalid", passwordHash: "sin-acceso", rol: "SUPERVISOR", empresaId: EMPRESA },
      { id: adminAjeno.id, nombre: "Admin Ajeno", email: "admin@ajena.invalid", passwordHash: "sin-acceso", rol: "ADMINISTRADOR", empresaId: EMPRESA_AJENA },
    ],
  });
  await db.proyecto.createMany({
    data: [
      { id: PROYECTO, empresaId: EMPRESA, nombre: "Obra Prueba" },
      { id: PROYECTO_AJENO, empresaId: EMPRESA_AJENA, nombre: "Obra Ajena" },
    ],
  });
  await db.accesoObra.create({ data: { usuarioId: supervisor.id, proyectoId: PROYECTO } });
  const semana = { numero: 41, anio: 2026, fechaInicio: new Date(Date.UTC(2026, 9, 5)), fechaFin: new Date(Date.UTC(2026, 9, 11)) };
  await db.semana.createMany({
    data: [
      { id: SEMANA, empresaId: EMPRESA, ...semana },
      { id: SEMANA_AJENA, empresaId: EMPRESA_AJENA, ...semana },
    ],
  });
  await db.beneficiario.createMany({
    data: [
      { id: BENEFICIARIO, empresaId: EMPRESA, tipo: "ADMINISTRACION", nombre: "Andrés (ficticio)" },
      { id: BENEFICIARIO_AJENO, empresaId: EMPRESA_AJENA, tipo: "ADMINISTRACION", nombre: "Beneficiario ajeno" },
    ],
  });
  await db.medioFinanciero.createMany({
    data: [
      { id: MEDIO_BANCO, empresaId: EMPRESA, nombre: "Banco ficticio", tipo: "BANCO" },
      { id: MEDIO_AJENO, empresaId: EMPRESA_AJENA, nombre: "Banco ajeno", tipo: "BANCO" },
    ],
  });
}

// Gasto ficticio de la semana de prueba. Por omisión: pendiente de revisión
// y pagado por Andrés (genera reposición al aprobarse).
export async function crearGasto(
  id: string,
  monto: string,
  extra: { estatus?: "PENDIENTE_REVISION" | "APROBADO"; pagador?: string | null; reposicionGastosId?: string | null; empresaId?: string } = {}
) {
  const empresaId = extra.empresaId ?? EMPRESA;
  return db.gastoObra.create({
    data: {
      id,
      empresaId,
      proyectoId: empresaId === EMPRESA ? PROYECTO : PROYECTO_AJENO,
      semanaId: empresaId === EMPRESA ? SEMANA : SEMANA_AJENA,
      fecha: new Date(Date.UTC(2026, 9, 6)),
      descripcion: `Gasto ficticio ${id}`,
      categoria: "MATERIALES",
      monto,
      metodoPago: "EFECTIVO",
      pagadorBeneficiarioId: extra.pagador === undefined ? (empresaId === EMPRESA ? BENEFICIARIO : BENEFICIARIO_AJENO) : extra.pagador,
      reposicionGastosId: extra.reposicionGastosId ?? null,
      capturadoPorId: empresaId === EMPRESA ? admin.id : adminAjeno.id,
      estatus: extra.estatus ?? "PENDIENTE_REVISION",
    },
  });
}

// Suma EXACTA (numeric de PostgreSQL, como texto) de los abonos de una reposición.
export async function sumaAbonos(reposicionId: string): Promise<string> {
  const [fila] = await db.$queryRawUnsafe<{ s: string }[]>(
    `SELECT COALESCE(SUM(monto), 0)::numeric(14,2)::text AS s FROM abonos_reposicion WHERE "reposicionGastosId" = $1`,
    reposicionId
  );
  return fila.s;
}

export async function abonosDe(reposicionId: string): Promise<string[]> {
  const filas = await db.$queryRawUnsafe<{ m: string }[]>(
    `SELECT monto::text AS m FROM abonos_reposicion WHERE "reposicionGastosId" = $1 ORDER BY "createdAt", id`,
    reposicionId
  );
  return filas.map((f) => f.m);
}

// Ningún rechazo de un lote concurrente puede ser un interbloqueo (40P01) ni
// un error inesperado de base de datos.
export function sinInterbloqueos(resultados: PromiseSettledResult<unknown>[]) {
  for (const r of resultados) {
    if (r.status === "rejected") {
      const texto = `${(r.reason as Error)?.message ?? r.reason} ${(r.reason as { code?: string })?.code ?? ""}`;
      if (/deadlock|40P01/i.test(texto)) throw new Error(`Interbloqueo detectado: ${texto}`);
    }
  }
}

export function rechazosInesperados(resultados: PromiseSettledResult<unknown>[], esperados: RegExp) {
  return resultados.filter((r) => r.status === "rejected" && !esperados.test(String((r.reason as Error)?.message ?? r.reason)));
}

// Trigger temporal de la base de PRUEBAS que hace fallar una escritura
// concreta, para comprobar el rollback real de PostgreSQL. Siempre se
// elimina en `finally`.
export async function conFallaSimulada<T>(tabla: string, condicion: string, operacion: () => Promise<T>): Promise<T> {
  if (!/^[a-z_]+$/.test(tabla)) throw new Error("Tabla no válida para falla simulada.");
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION arqento_pruebas.falla_simulada() RETURNS trigger AS $$
    BEGIN
      IF ${condicion} THEN RAISE EXCEPTION 'Falla simulada en ${tabla}'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER falla_simulada BEFORE INSERT OR UPDATE ON "${tabla}" FOR EACH ROW EXECUTE FUNCTION arqento_pruebas.falla_simulada()`
  );
  try {
    return await operacion();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS falla_simulada ON "${tabla}"`);
  }
}

export const repetir = async (veces: number, fn: (vuelta: number) => Promise<void>) => {
  for (let i = 0; i < veces; i++) await fn(i);
};

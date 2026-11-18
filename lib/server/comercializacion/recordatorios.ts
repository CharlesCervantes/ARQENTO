import "server-only";
import { randomBytes } from "crypto";
import { db } from "@/lib/server/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { UsuarioSesion } from "@/lib/server/session";
import { requerirAdministracionComercial } from "@/lib/server/comercializacion/acceso";
import { INCLUIR_CUENTA, estadoDe, folioGasto } from "@/lib/server/comercializacion/cuentas";
import { hoyEnZona } from "@/lib/comercializacion/cuentas";
import {
  CATEGORIAS_AVISO,
  DIAS_AVISO_PROXIMO,
  construirAvisos,
  resumirAvisos,
  sumarDias,
  type Aviso,
  type CategoriaAviso,
  type CuentaParaAvisos,
  type ResumenCategoria,
} from "@/lib/comercializacion/recordatorios";

// Recordatorios internos de cobros y pagos (B6B). docs/negocio/
// comercializacion.md §10 y §20 (B6B). SOLO Administrador/Director.
// Se calculan al consultar con los saldos reales de B5 (estadoDe); no hay
// tabla de avisos ni cron, por lo que recargar o entrar con varios usuarios
// no genera duplicados y cualquier abono, liquidación, anulación o cambio de
// calendario se refleja en la siguiente consulta. Consultar no escribe nada.

export const AVISOS_POR_PAGINA = 10;
const MAX_AVISOS_VISIBLES = 500;

const INCLUIR_AVISOS = {
  ...INCLUIR_CUENTA,
  ordenVenta: { select: { id: true, folio: true, cotizacionId: true, cotizacion: { select: { cliente: { select: { nombre: true } } } } } },
  compra: { select: { id: true, folio: true, estatus: true, proveedorConfirmado: true, proveedor: { select: { nombre: true } } } },
  gasto: {
    select: { id: true, numero: true, concepto: true, estatus: true, beneficiarioNombre: true, ordenVenta: { select: { folio: true, cotizacionId: true } } },
  },
} as const satisfies Prisma.CuentaComercialInclude;

export type RecordatoriosComerciales = {
  hoy: string;
  zona: string | null;
  generadoEn: string; // marca de la respuesta (para refrescar al volver)
  diasProximo: number;
  hastaProximo: string;
  categoria: CategoriaAviso;
  resumen: Record<CategoriaAviso, ResumenCategoria>;
  avisos: Aviso[]; // filas visibles de la categoría elegida
  totalCategoria: number; // filas de la categoría completa
  visibles: number;
};

export async function recordatoriosComerciales(
  usuario: UsuarioSesion,
  opciones: { categoria?: unknown; visibles?: unknown; ahora?: Date } = {}
): Promise<RecordatoriosComerciales> {
  const empresaId = requerirAdministracionComercial(usuario);
  const empresa = await db.empresa.findUnique({ where: { id: empresaId }, select: { zonaHoraria: true } });
  const hoy = hoyEnZona(empresa?.zonaHoraria ?? null, opciones.ahora ?? new Date());

  // Solo cuentas vigentes; una compra anulada tiene su cuenta anulada (B5),
  // y además se exige compra confirmada por defensa.
  const cuentas = await db.cuentaComercial.findMany({
    where: {
      empresaId,
      estatus: "VIGENTE",
      OR: [{ tipo: "POR_COBRAR" }, { tipo: "POR_PAGAR", compra: { estatus: "CONFIRMADA" } }, { tipo: "POR_PAGAR", gasto: { estatus: "VIGENTE" } }],
    },
    include: INCLUIR_AVISOS,
  });

  const entrada: CuentaParaAvisos[] = cuentas.map((c) => {
    const e = estadoDe(c, hoy);
    const esCobro = c.tipo === "POR_COBRAR";
    // B7: el gasto adicional se identifica con su OV y su concepto, y enlaza
    // a su bloque de pagos dentro del detalle de la OV.
    const g = c.gasto;
    return {
      cuentaId: c.id,
      tipo: esCobro ? "COBRO" : "PAGO",
      contraparte: esCobro
        ? (c.ordenVenta?.cotizacion.cliente?.nombre ?? "Sin cliente")
        : g
          ? g.beneficiarioNombre
          : ((c.compra?.proveedorConfirmado as { nombre?: string } | null)?.nombre ?? c.compra?.proveedor?.nombre ?? "Sin proveedor"),
      folio: esCobro ? (c.ordenVenta?.folio ?? "—") : g ? folioGasto(g) : (c.compra?.folio ?? "—"),
      enlace: esCobro
        ? `/comercializacion/cotizaciones/${c.ordenVenta?.cotizacionId}#cobros`
        : g
          ? `/comercializacion/cotizaciones/${g.ordenVenta.cotizacionId}#gasto-${g.id}`
          : `/comercializacion/compras/${c.compra?.id}#pagos`,
      saldo: e.saldo,
      cuotas: e.cuotas.map((q) => ({ numero: q.numero, fechaVencimiento: q.fechaVencimiento, saldo: q.saldo })),
    };
  });

  const avisos = construirAvisos(entrada, hoy);
  const categoria = (CATEGORIAS_AVISO as readonly unknown[]).includes(opciones.categoria) ? (opciones.categoria as CategoriaAviso) : "VENCIDO";
  const deCategoria = avisos.filter((a) => a.categoria === categoria);
  const pedidas = Number(opciones.visibles);
  const visibles = Number.isInteger(pedidas) && pedidas > AVISOS_POR_PAGINA ? Math.min(pedidas, MAX_AVISOS_VISIBLES) : AVISOS_POR_PAGINA;

  return {
    hoy,
    zona: empresa?.zonaHoraria ?? null,
    generadoEn: `${Date.now()}-${randomBytes(4).toString("hex")}`,
    diasProximo: DIAS_AVISO_PROXIMO,
    hastaProximo: sumarDias(hoy, DIAS_AVISO_PROXIMO),
    categoria,
    resumen: resumirAvisos(avisos),
    avisos: deCategoria.slice(0, visibles),
    totalCategoria: deCategoria.length,
    visibles,
  };
}

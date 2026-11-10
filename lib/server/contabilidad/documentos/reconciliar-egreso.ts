import "server-only";
import { db } from "@/lib/server/db";
import type { TrabajoProcesamientoDocumento, EstatusDocumentoEgreso, CapacidadInteligencia } from "@/lib/generated/prisma/client";
import { extraerTextoPdfNativo } from "@/lib/server/inteligencia/extractor-pdf-nativo";
import { interpretarCamposFinancierosMX } from "@/lib/server/inteligencia/interprete-financiero-mx";
import { crearInterpretadorOpenAI } from "@/lib/server/inteligencia/interpretador-openai";
import { renderizarPaginasPdf, prepararImagenParaVision } from "@/lib/server/inteligencia/render-documento-visual";
import { calcularCosto } from "@/lib/server/inteligencia/tarifas";
import { autorizarConsumo, type MotivoDenegacionInteligencia } from "@/lib/server/inteligencia/capacidades";
import { ErrorInterpretacion } from "@/lib/server/inteligencia/tipos";
import { reconciliarCampo, degradarSiInconsistente, type CampoReconciliado } from "@/lib/server/inteligencia/reconciliador";
import {
  formatoRfcValido,
  formatoCuentaValido,
  formatoFolioValido,
  formatoMontoValido,
  formatoReferenciaValido,
  normalizarRfc,
  normalizarCuenta,
  normalizarFolio,
  normalizarMonto,
  normalizarReferencia,
  normalizarFechaAIso,
  validarConsistenciaMontos,
} from "@/lib/server/inteligencia/validadores-mx";
import { registrarOperacion, type ManejadorOperacion } from "@/lib/server/inteligencia/registro-operaciones";
import { HechosDocumentoEgresoSchema, INSTRUCCIONES_HECHOS_EGRESO, type HechosDocumentoEgreso } from "./schema-hechos-egreso";

// Wiring ESPECÍFICO de Contabilidad sobre el motor genérico — esta es la
// única pieza de todo este flujo que sabe qué campos tiene un Egreso y que
// escribe en DocumentoEgreso. El motor de reconciliación y los validadores
// MX siguen siendo 100% genéricos, reutilizables por Compras/Facturas
// después sin tocarlos (Carga inteligente de documentos, V1 — octubre 2026).

async function documentoDelJob(job: TrabajoProcesamientoDocumento) {
  const documento = await db.documentoEgreso.findFirst({
    where: { id: job.referenciaModulo, empresaId: job.empresaId },
  });
  if (!documento) throw new Error(`DocumentoEgreso no encontrado para el trabajo ${job.id}`);
  return documento;
}

// Tope de páginas de un PDF escaneado que realmente se mandan a visión —
// deliberadamente más chico que MAX_PAGINAS_POR_DOCUMENTO (el límite de
// subida para texto nativo): los documentos financieros reales son casi
// siempre 1-3 páginas, y cada página extra es una imagen más en la misma
// llamada (más tokens/costo). Si el documento excede este tope, solo se
// analizan las primeras — V1.2, octubre 2026.
const MAX_PAGINAS_VISION = 5;

// Traduce el motivo GENÉRICO de autorizarConsumo() (que no sabe qué es un
// DocumentoEgreso) al estatus de dominio correspondiente — única pieza que
// conecta ambos vocabularios (Master → Empresa → ARQENTO IA, V1.3).
const ESTATUS_POR_MOTIVO: Record<MotivoDenegacionInteligencia, EstatusDocumentoEgreso> = {
  IA_DESHABILITADA: "CAPACIDAD_NO_HABILITADA",
  CAPACIDAD_DESHABILITADA: "CAPACIDAD_NO_HABILITADA",
  LIMITE_ALCANZADO: "LIMITE_ALCANZADO",
};

const ESTATUS_TERMINAL_SIN_PROPUESTA: EstatusDocumentoEgreso[] = ["SIN_TEXTO", "CAPACIDAD_NO_HABILITADA", "LIMITE_ALCANZADO"];

// Ya resuelto por una persona (confirmado, vinculado o descartado) mientras
// el trabajo esperaba o se procesaba (Fase 0 WhatsApp + ARQENTO IA, octubre
// 2026): el worker nunca vuelve a llamar a la IA para él ni le cambia el
// estatus — antes podía devolver a PROCESADO un documento ya confirmado.
const ESTATUS_YA_RESUELTO: EstatusDocumentoEgreso[] = ["VINCULADO", "CONVERTIDO", "DESCARTADO"];

// Toda transición de estatus del worker solo aplica a un documento que
// sigue PENDIENTE — nunca pisa una decisión humana tomada en paralelo.
const SOLO_SI_PENDIENTE = { estatus: "PENDIENTE" as const };

// Forma "vacía" de CamposFinancierosDetectados — para documentos VISION no
// existe ningún parser determinístico (no hay texto del que partir), así
// que la reconciliación sigue exactamente el mismo camino que ya existe
// para texto nativo, solo que el lado determinístico siempre es null (nunca
// CONFIRMADO con una sola fuente — ver reconciliador.ts, sin cambios).
const CAMPO_VACIO = { valor: null, confianza: 0 };
const DET_VACIO: ReturnType<typeof interpretarCamposFinancierosMX> = {
  proveedorNombre: CAMPO_VACIO,
  rfc: CAMPO_VACIO,
  folio: CAMPO_VACIO,
  fechaDocumento: CAMPO_VACIO,
  subtotal: CAMPO_VACIO,
  iva: CAMPO_VACIO,
  total: CAMPO_VACIO,
  moneda: CAMPO_VACIO,
  referenciaBancaria: CAMPO_VACIO,
  cuentaOrigen: CAMPO_VACIO,
  cuentaDestino: CAMPO_VACIO,
  conceptoBancario: CAMPO_VACIO,
};

// Normaliza para comparar nombres de proyecto tolerando mayúsculas/acentos —
// nunca para nada más (ver emparejarProyecto).
function normalizarTexto(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

// Resuelve un nombre de proyecto LIBRE (sugerido por la IA a partir del
// contexto del usuario) contra los proyectos REALES activos de la Empresa —
// la IA nunca puede inventar/preseleccionar un proyectoId; esta función es
// la única autorizada a convertir un nombre en un id real, y solo cuando la
// coincidencia es exacta o inequívoca (decisión de sesión, octubre 2026).
function emparejarProyecto(
  nombreSugerido: string,
  proyectos: { id: string; nombre: string }[]
): { id: string; nombre: string } | null {
  const sugeridoNorm = normalizarTexto(nombreSugerido);
  if (!sugeridoNorm) return null;

  const exacto = proyectos.find((p) => normalizarTexto(p.nombre) === sugeridoNorm);
  if (exacto) return exacto;

  const candidatos = proyectos.filter((p) => {
    const nombreNorm = normalizarTexto(p.nombre);
    return nombreNorm.includes(sugeridoNorm) || sugeridoNorm.includes(nombreNorm);
  });
  return candidatos.length === 1 ? candidatos[0] : null;
}

const manejador: ManejadorOperacion = {
  async ejecutarExtraccionDeterministica(job, bytes) {
    const documento = await documentoDelJob(job);
    if (ESTATUS_YA_RESUELTO.includes(documento.estatus)) return { continuarProcesamiento: false };

    // Chequeo RÁPIDO (no autoritativo) — evita gastar el parser determinístico
    // y decidir una estrategia para una capacidad que ya sabemos deshabilitada.
    // La verificación que realmente autoriza gastar IA ocurre de nuevo,
    // inmediatamente antes de la llamada real, en ejecutarExtraccionIA.
    async function denegarSiNoAutorizado(capacidad: CapacidadInteligencia): Promise<boolean> {
      const autorizacion = await autorizarConsumo(job.empresaId, capacidad);
      if (autorizacion.autorizado) return false;
      await db.documentoEgreso.updateMany({
        where: { id: documento.id, ...SOLO_SI_PENDIENTE },
        data: { estatus: ESTATUS_POR_MOTIVO[autorizacion.motivo] },
      });
      return true;
    }

    // Una imagen suelta (JPG/PNG) nunca tiene texto que extraer — siempre
    // necesita visión, sin pasar por el parser de texto en absoluto.
    if (documento.tipoMime === "image/jpeg" || documento.tipoMime === "image/png") {
      if (await denegarSiNoAutorizado("ANALISIS_VISUAL")) return { continuarProcesamiento: false };
      await db.documentoEgreso.update({ where: { id: documento.id }, data: { estrategiaExtraccion: "VISION" } });
      return { continuarProcesamiento: true };
    }

    const { texto, tieneTextoNativo } = await extraerTextoPdfNativo(bytes);

    if (tieneTextoNativo) {
      if (await denegarSiNoAutorizado("ANALISIS_DOCUMENTAL_TEXTO")) return { continuarProcesamiento: false };
      const campos = interpretarCamposFinancierosMX(texto);
      await db.documentoEgreso.update({
        where: { id: documento.id },
        data: { resultadoDeterministico: campos as unknown as object, estrategiaExtraccion: "TEXTO_NATIVO" },
      });
      return { continuarProcesamiento: true };
    }

    // Sin capa de texto suficiente (probable escaneo/foto dentro del PDF) —
    // necesita VISION.
    if (await denegarSiNoAutorizado("ANALISIS_VISUAL")) return { continuarProcesamiento: false };
    await db.documentoEgreso.update({ where: { id: documento.id }, data: { estrategiaExtraccion: "VISION" } });
    return { continuarProcesamiento: true };
  },

  async ejecutarExtraccionIA(job, bytes) {
    const documento = await documentoDelJob(job);
    if (ESTATUS_YA_RESUELTO.includes(documento.estatus)) return;
    const esVision = documento.estrategiaExtraccion === "VISION";
    const capacidad: CapacidadInteligencia = esVision ? "ANALISIS_VISUAL" : "ANALISIS_DOCUMENTAL_TEXTO";

    // Revisión AUTORITATIVA — inmediatamente antes de la llamada real al
    // proveedor, nunca solo al decidir la estrategia (la configuración de
    // la Empresa pudo cambiar entre que el trabajo se encoló/decidió y que
    // realmente se procesa). Si no autoriza, nunca se llama al proveedor —
    // nunca se crea un RegistroConsumoInteligencia (no hubo consumo real).
    const autorizacion = await autorizarConsumo(job.empresaId, capacidad);
    if (!autorizacion.autorizado) {
      await db.documentoEgreso.updateMany({
        where: { id: documento.id, ...SOLO_SI_PENDIENTE },
        data: { estatus: ESTATUS_POR_MOTIVO[autorizacion.motivo] },
      });
      return;
    }

    const interprete = crearInterpretadorOpenAI("gpt-5-mini");

    // unidades (número de imágenes) se conoce ANTES de llamar al proveedor
    // — se registra igual si la llamada falla después (es un hecho sobre
    // nuestra propia solicitud, no algo que el proveedor deba confirmarnos).
    let imagenes: Awaited<ReturnType<typeof renderizarPaginasPdf>> | undefined;
    let unidades: number | null = null;
    if (esVision) {
      imagenes =
        documento.tipoMime === "application/pdf"
          ? await renderizarPaginasPdf(bytes, MAX_PAGINAS_VISION)
          : [await prepararImagenParaVision(bytes, documento.tipoMime)];
      unidades = imagenes.length;
    }

    let resultado: Awaited<ReturnType<typeof interprete.interpretar<HechosDocumentoEgreso>>>;
    try {
      resultado = esVision
        ? await interprete.interpretar({
            imagenes: imagenes!,
            schema: HechosDocumentoEgresoSchema,
            nombreSchema: "hechos_documento_egreso",
            instrucciones: INSTRUCCIONES_HECHOS_EGRESO,
            contextoUsuario: documento.contextoUsuario ?? undefined,
          })
        : await interprete.interpretar({
            texto: (await extraerTextoPdfNativo(bytes)).texto,
            schema: HechosDocumentoEgresoSchema,
            nombreSchema: "hechos_documento_egreso",
            instrucciones: INSTRUCCIONES_HECHOS_EGRESO,
            contextoUsuario: documento.contextoUsuario ?? undefined,
          });
    } catch (error) {
      // La llamada SÍ se hizo (a diferencia del caso "no autorizado" de
      // arriba) — siempre se registra, con el consumo REAL conocido. Si
      // ErrorInterpretacion trae usoParcial (el proveedor alcanzó a
      // responder), se usa para calcular un costo real; si no (nunca hubo
      // respuesta), tokens/costo quedan en null/0 — nunca se estima.
      const usoParcial = error instanceof ErrorInterpretacion ? error.usoParcial : null;
      const costoParcial = usoParcial ? calcularCosto("gpt-5-mini", usoParcial.tokensEntrada, usoParcial.tokensSalida) : null;
      await db.registroConsumoInteligencia.create({
        data: {
          empresaId: job.empresaId,
          modulo: job.modulo,
          operacion: job.operacion,
          trabajoId: job.id,
          tipoConsumo: esVision ? "EXTRACCION_LLM_VISUAL" : "EXTRACCION_LLM",
          proveedor: "openai",
          modelo: "gpt-5-mini",
          tokensEntrada: usoParcial?.tokensEntrada ?? null,
          tokensSalida: usoParcial?.tokensSalida ?? null,
          unidades,
          tarifaEntradaPorMillion: costoParcial?.tarifaEntradaPorMillion ?? null,
          tarifaSalidaPorMillion: costoParcial?.tarifaSalidaPorMillion ?? null,
          costoTotal: costoParcial?.costoTotal ?? 0,
          duracionMs: usoParcial?.duracionMs ?? null,
          estatus: "ERROR",
        },
      });
      throw error; // el worker genérico sigue su manejo normal de reintentos/backoff
    }

    const costo = calcularCosto("gpt-5-mini", resultado.tokensEntrada, resultado.tokensSalida);

    // Consumo y resultado se escriben juntos — minimiza (no elimina del
    // todo: ningún sistema sin transacciones distribuidas con el proveedor
    // externo puede eliminarlo por completo) la ventana entre "ya pagamos
    // la llamada" y "ya quedó persistida", tal como se pidió revisar.
    await db.$transaction([
      db.documentoEgreso.update({
        where: { id: documento.id },
        data: { resultadoIA: resultado.datos as unknown as object },
      }),
      db.registroConsumoInteligencia.create({
        data: {
          empresaId: job.empresaId,
          modulo: job.modulo,
          operacion: job.operacion,
          trabajoId: job.id,
          // Distingue claramente la capacidad usada — permite comparar
          // TEXTO_NATIVO vs VISION directamente desde esta tabla, sin
          // campos adicionales (requisito explícito del benchmark, V1.2).
          tipoConsumo: esVision ? "EXTRACCION_LLM_VISUAL" : "EXTRACCION_LLM",
          proveedor: "openai",
          modelo: "gpt-5-mini",
          tokensEntrada: resultado.tokensEntrada,
          tokensSalida: resultado.tokensSalida,
          unidades, // número de imágenes enviadas (páginas renderizadas o 1 para una imagen suelta); null en TEXTO_NATIVO
          tarifaEntradaPorMillion: costo.tarifaEntradaPorMillion,
          tarifaSalidaPorMillion: costo.tarifaSalidaPorMillion,
          costoTotal: costo.costoTotal,
          duracionMs: resultado.duracionMs,
          estatus: "EXITO",
        },
      }),
    ]);
  },

  async reconciliarYFinalizar(job) {
    const documento = await documentoDelJob(job);
    // Un paso anterior ya dejó esto terminal (sin autorización, límite
    // alcanzado, o — legado — sin texto extraíble) — nunca hubo IA, nada
    // que reconciliar.
    if (ESTATUS_TERMINAL_SIN_PROPUESTA.includes(documento.estatus) || ESTATUS_YA_RESUELTO.includes(documento.estatus)) return;

    // En VISION no existe parser determinístico (no hay texto del que
    // partir) — det queda "vacío" a propósito, nunca inventado; el
    // reconciliador ya sabe tratar un lado null como SOLO_IA/PROPUESTO,
    // nunca CONFIRMADO con una sola fuente (sin cambios en reconciliador.ts).
    const det =
      (documento.resultadoDeterministico as ReturnType<typeof interpretarCamposFinancierosMX> | null) ?? DET_VACIO;
    const ia = documento.resultadoIA as HechosDocumentoEgreso | null;
    if (!ia) throw new Error("Falta resultado de IA para reconciliar.");

    const iaRfc = ia.partes.emisor?.rfc ?? ia.partes.receptor?.rfc ?? ia.partes.ordenante?.rfc ?? ia.partes.beneficiario?.rfc ?? null;
    const iaFolio = ia.identificadores.numeroCotizacion ?? ia.identificadores.folioDocumento ?? null;

    const campos: CampoReconciliado<unknown>[] = [
      reconciliarCampo({ campo: "rfc", detValor: det.rfc.valor, iaValor: iaRfc, formatoValido: formatoRfcValido, normalizar: normalizarRfc }),
      reconciliarCampo({ campo: "folio", detValor: det.folio.valor, iaValor: iaFolio, formatoValido: formatoFolioValido, normalizar: normalizarFolio }),
      reconciliarCampo({ campo: "subtotal", detValor: det.subtotal.valor, iaValor: ia.montos.subtotal, formatoValido: formatoMontoValido, normalizar: (n: number) => String(normalizarMonto(n)) }),
      reconciliarCampo({ campo: "iva", detValor: det.iva.valor, iaValor: ia.montos.iva, formatoValido: formatoMontoValido, normalizar: (n: number) => String(normalizarMonto(n)) }),
      reconciliarCampo({ campo: "total", detValor: det.total.valor, iaValor: ia.montos.total, formatoValido: formatoMontoValido, normalizar: (n: number) => String(normalizarMonto(n)) }),
      reconciliarCampo({ campo: "referenciaBancaria", detValor: det.referenciaBancaria.valor, iaValor: ia.identificadores.referenciaBancaria, formatoValido: formatoReferenciaValido, normalizar: normalizarReferencia }),
      reconciliarCampo({ campo: "cuentaOrigen", detValor: det.cuentaOrigen.valor, iaValor: ia.pago.cuentaOrigen, formatoValido: formatoCuentaValido, normalizar: normalizarCuenta }),
      reconciliarCampo({ campo: "cuentaDestino", detValor: det.cuentaDestino.valor, iaValor: ia.pago.cuentaDestino, formatoValido: formatoCuentaValido, normalizar: normalizarCuenta }),
    ];

    const subtotalC = campos.find((c) => c.campo === "subtotal")!;
    const ivaC = campos.find((c) => c.campo === "iva")!;
    const totalC = campos.find((c) => c.campo === "total")!;
    const consistente = validarConsistenciaMontos({
      subtotal: subtotalC.valor as number | null,
      iva: ivaC.valor as number | null,
      total: totalC.valor as number | null,
    });
    degradarSiInconsistente(
      [subtotalC, ivaC, totalC],
      consistente,
      "coincidencia entre fuentes, pero subtotal + IVA no cuadra con total — degradado de CONFIRMADO"
    );

    // Partes — sin contraparte determinística comparable, siempre
    // informativas/PROPUESTAS (nunca CONFIRMADO por definición).
    const partes = Object.entries(ia.partes)
      .filter(([, p]) => p?.nombre)
      .map(([rol, p]) => ({ rol, nombre: p!.nombre, rfc: p!.rfc }));

    // proyectoSugerido viene del CONTEXTO del usuario (nunca del documento)
    // — la IA solo propone un nombre libre; el proyectoId real solo puede
    // salir de resolverlo aquí contra los proyectos ACTIVO de esta Empresa
    // (nunca se confía en un id que la IA pudiera inventar).
    let proyectoSugerido: { nombreSugerido: string; proyectoId: string | null; nombreCoincidente: string | null } | null = null;
    if (ia.inferenciasContexto.proyectoSugerido) {
      const proyectosActivos = await db.proyecto.findMany({
        where: { empresaId: job.empresaId, estatus: "ACTIVO", tipo: { not: "OFICINA" } },
        select: { id: true, nombre: true },
      });
      const match = emparejarProyecto(ia.inferenciasContexto.proyectoSugerido, proyectosActivos);
      proyectoSugerido = {
        nombreSugerido: ia.inferenciasContexto.proyectoSugerido,
        proyectoId: match?.id ?? null,
        nombreCoincidente: match?.nombre ?? null,
      };
    }

    const propuesta = {
      tipoDocumento: ia.tipoDocumento,
      campos,
      partes,
      conceptos: ia.conceptos,
      moneda: ia.montos.moneda ?? det.moneda.valor ?? "MXN",
      // ia.pago.fecha viene en el formato en que aparece en el documento
      // (nunca se le pide a la IA inventar un ISO) — pero un <input
      // type="date"> solo acepta YYYY-MM-DD como valor prellenado;
      // cualquier otro formato simplemente no se mostraba, sin avisar
      // (hallazgo real de uso, octubre 2026). det.fechaDocumento.valor ya
      // es ISO siempre (interprete-financiero-mx.ts lo normaliza al
      // detectarla), así que solo hace falta normalizar el lado de la IA.
      fecha: normalizarFechaAIso(ia.pago.fecha) ?? det.fechaDocumento.valor ?? null,
      conceptoBancario: ia.pago.concepto ?? det.conceptoBancario.valor ?? null,
      proyectoSugerido,
      finalidadGasto: ia.inferenciasContexto.finalidadGasto,
      contradiccionConContexto: ia.contradiccionConContexto,
      // Transparencia sobre cómo se leyó el documento — útil para que quien
      // revisa la propuesta sepa si vino de texto nativo o de visión (menos
      // confiable sobre letra pequeña/manuscrita), y para el benchmark.
      estrategiaExtraccion: documento.estrategiaExtraccion,
    };

    await db.documentoEgreso.updateMany({
      where: { id: documento.id, ...SOLO_SI_PENDIENTE },
      data: {
        propuestaReconciliada: propuesta as unknown as object,
        tipoDocumento: ia.tipoDocumento,
        estatus: "PROCESADO",
      },
    });
  },
};

registrarOperacion("contabilidad", "extraccion_documento_egreso", manejador);

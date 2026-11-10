"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { formatMoney } from "@/lib/dinero";
import {
  subirDocumentosEgresoAction,
  obtenerDocumentosDelLoteAction,
  descartarDocumentoEgresoAction,
} from "@/app/(app)/contabilidad/actions";

// Flujo: Subir → Analizando → Revisar propuesta → (el usuario continúa a
// captura, ya prellenada) — nunca crea nada por sí solo (Carga inteligente
// de documentos, V1 — octubre 2026). "Datos detectados" y "decisiones que
// debes tomar" se muestran visualmente separados a propósito.

type CampoReconciliado = {
  campo: string;
  valor: unknown;
  fuente: "DETERMINISTICO" | "IA" | "AMBOS" | "NINGUNA";
  estado: "CONFIRMADO" | "PROPUESTO" | "CONFLICTO" | "NO_DETECTADO";
  requiereRevision: boolean;
  nota?: string;
};

type PropuestaReconciliada = {
  tipoDocumento: string;
  campos: CampoReconciliado[];
  partes: { rol: string; nombre: string | null; rfc: string | null }[];
  moneda: string;
  fecha: string | null;
  conceptoBancario: string | null;
  proyectoSugerido: { nombreSugerido: string; proyectoId: string | null; nombreCoincidente: string | null } | null;
  finalidadGasto: string | null;
  contradiccionConContexto: string | null;
  estrategiaExtraccion: "TEXTO_NATIVO" | "VISION" | null;
};

type DocumentoLote = {
  id: string;
  archivoNombre: string;
  estatus:
    | "PENDIENTE"
    | "PROCESADO"
    | "SIN_TEXTO"
    | "CAPACIDAD_NO_HABILITADA"
    | "LIMITE_ALCANZADO"
    | "VINCULADO"
    | "CONVERTIDO"
    | "DESCARTADO";
  propuestaReconciliada: PropuestaReconciliada | null;
  trabajoProcesamiento: { estatus: string; error: string | null; intentos: number; maxIntentos: number } | null;
  // Remitente (origen) del documento — necesario para ofrecer "pagó quien
  // lo envió" al registrarlo como gasto.
  subidoPor: { id: string; nombre: string; beneficiario: { activo: boolean } | null };
};

export type RemitenteDeDocumento = { nombre: string; tieneBeneficiario: boolean };
const remitenteDe = (doc: DocumentoLote): RemitenteDeDocumento => ({
  nombre: doc.subidoPor.nombre,
  tieneBeneficiario: doc.subidoPor.beneficiario?.activo === true,
});

const ETIQUETA_CAMPO: Record<string, string> = {
  rfc: "RFC",
  folio: "Folio / cotización",
  subtotal: "Subtotal",
  iva: "IVA",
  total: "Total",
  referenciaBancaria: "Referencia bancaria",
  cuentaOrigen: "Cuenta origen",
  cuentaDestino: "Cuenta destino",
};

const COLOR_ESTADO: Record<CampoReconciliado["estado"], string> = {
  CONFIRMADO: "bg-emerald-50 text-emerald-700",
  PROPUESTO: "bg-amber-50 text-amber-700",
  CONFLICTO: "bg-red-50 text-red-700",
  NO_DETECTADO: "bg-black/[0.04] text-[var(--muted)]",
};

function valorMostrado(campo: CampoReconciliado): string {
  if (campo.valor === null) return "—";
  if (campo.campo === "subtotal" || campo.campo === "iva" || campo.campo === "total") {
    return formatMoney(Number(campo.valor));
  }
  return String(campo.valor);
}

// Un documento deja de hacer polling una vez que llega a cualquier estatus
// terminal, o a un error de trabajo — nunca sigue "Analizando…" para
// siempre (Carga inteligente de documentos, V1.1 — octubre 2026).
const ESTATUS_TERMINALES: DocumentoLote["estatus"][] = [
  "SIN_TEXTO",
  "CAPACIDAD_NO_HABILITADA",
  "LIMITE_ALCANZADO",
  "PROCESADO",
  "VINCULADO",
  "CONVERTIDO",
  "DESCARTADO",
];

function sigueEnProceso(doc: DocumentoLote): boolean {
  return !ESTATUS_TERMINALES.includes(doc.estatus) && doc.trabajoProcesamiento?.estatus !== "ERROR";
}

export function NuevoEgresoDocumentos({
  onUsarPropuesta,
  onRegistrarManual,
  onCancelar,
}: {
  onUsarPropuesta: (args: { documentoEgresoId: string; propuesta: PropuestaReconciliada; remitente: RemitenteDeDocumento }) => void;
  onRegistrarManual: (documentoEgresoId: string, remitente: RemitenteDeDocumento) => void;
  onCancelar: () => void;
}) {
  const [loteId, setLoteId] = useState<string | null>(null);
  const [documentos, setDocumentos] = useState<DocumentoLote[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Consultas ENCADENADAS (Fase 0 WhatsApp + ARQENTO IA, octubre 2026): la
  // siguiente solo se programa cuando la anterior respondió — cada consulta
  // puede avanzar el procesamiento de un documento en el servidor, así que
  // nunca se empalman. Se detiene cuando todos los documentos terminaron.
  useEffect(() => {
    if (!loteId) return;
    let activo = true;
    let temporizador: ReturnType<typeof setTimeout> | null = null;
    const consultar = async () => {
      try {
        const docs = (await obtenerDocumentosDelLoteAction(loteId)) as unknown as DocumentoLote[];
        if (!activo) return;
        setDocumentos(docs);
        if (docs.every((d) => !sigueEnProceso(d))) return;
      } catch {
        if (!activo) return;
      }
      temporizador = setTimeout(consultar, 3000);
    };
    // setTimeout(…, 0) en vez de llamar consultar directo — evita "setState
    // síncrono dentro de un efecto".
    temporizador = setTimeout(consultar, 0);
    return () => {
      activo = false;
      if (temporizador) clearTimeout(temporizador);
    };
  }, [loteId]);

  async function alSubir(formData: FormData) {
    setSubiendo(true);
    setError(null);
    const resultado = await subirDocumentosEgresoAction(formData);
    setSubiendo(false);
    if (resultado?.error) {
      setError(resultado.error);
      return;
    }
    if (resultado?.loteId) setLoteId(resultado.loteId);
  }

  if (!loteId) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Subir documentos</h2>
        <p className="text-sm text-[var(--muted)]">
          Sube una cotización, un comprobante de pago, o ambos a la vez (hasta 5 archivos, PDF/JPG/PNG, 10MB c/u).
          Arqento analiza el documento — con texto o, si es un escaneo/foto, con lectura visual — y te muestra una
          propuesta editable. Nunca crea nada automáticamente.
        </p>
        <form action={alSubir} className="space-y-3">
          <FileInput name="documentos" accept="application/pdf,image/jpeg,image/png" multiple required />
          <div>
            <label className="text-xs text-[var(--muted)]">Contexto para ARQENTO IA (opcional)</label>
            <textarea
              name="contexto"
              rows={2}
              placeholder='Ej. "Jardines. Es sin factura de Conkuali. Solo para meterlo como gasto."'
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)]"
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              Ayuda a la IA a inferir cosas que el documento no dice (ej. proyecto, para qué es el gasto) — nunca
              sobrescribe lo que el documento sí muestra (montos, RFC, folios, cuentas, fechas).
            </p>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={subiendo}>
              {subiendo ? "Subiendo…" : "Subir y analizar"}
            </Button>
            <button type="button" onClick={onCancelar} className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
              Cancelar
            </button>
          </div>
        </form>
      </div>
    );
  }

  const analizando = documentos.some(sigueEnProceso);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-[var(--foreground)]">Propuesta</h2>

      {analizando && (
        <p className="text-sm text-[var(--muted)]">Analizando documentos… esto puede tardar unos segundos.</p>
      )}

      {documentos.map((doc) => (
        <Card key={doc.id} className="p-5">
          <p className="mb-3 text-sm font-medium text-[var(--foreground)]">{doc.archivoNombre}</p>

          {doc.estatus === "SIN_TEXTO" && (
            <div className="space-y-3">
              <p className="text-sm text-amber-700">
                No pudimos leer este documento automáticamente. Parece ser un documento escaneado o una imagen
                dentro de un PDF. La lectura de imágenes todavía no está disponible. Puedes registrar el gasto
                manualmente.
              </p>
              <Button onClick={() => onRegistrarManual(doc.id, remitenteDe(doc))}>Registrar manualmente</Button>
            </div>
          )}

          {doc.estatus === "CAPACIDAD_NO_HABILITADA" && (
            <div className="space-y-3">
              <p className="text-sm text-amber-700">
                El análisis automático de este tipo de documento no está habilitado para esta empresa. Puedes
                registrarlo manualmente.
              </p>
              <Button onClick={() => onRegistrarManual(doc.id, remitenteDe(doc))}>Registrar manualmente</Button>
            </div>
          )}

          {doc.estatus === "LIMITE_ALCANZADO" && (
            <div className="space-y-3">
              <p className="text-sm text-amber-700">
                Se alcanzó el límite mensual de análisis automático de documentos para esta empresa. Puedes
                registrarlo manualmente.
              </p>
              <Button onClick={() => onRegistrarManual(doc.id, remitenteDe(doc))}>Registrar manualmente</Button>
            </div>
          )}

          {doc.estatus === "PENDIENTE" && doc.trabajoProcesamiento?.estatus === "ERROR" && (
            <div className="space-y-3">
              <p className="text-sm text-amber-700">
                No se pudo analizar automáticamente este documento. Puedes completar los datos a mano.
              </p>
              <Button onClick={() => onRegistrarManual(doc.id, remitenteDe(doc))}>Registrar manualmente</Button>
            </div>
          )}

          {doc.estatus === "PENDIENTE" && doc.trabajoProcesamiento?.estatus !== "ERROR" && (
            <p className="text-sm text-[var(--muted)]">Analizando…</p>
          )}

          {(doc.estatus === "VINCULADO" || doc.estatus === "CONVERTIDO") && (
            <p className="text-sm text-[var(--muted)]">
              Este documento ya fue registrado anteriormente — no requiere ninguna acción.
            </p>
          )}

          {doc.estatus === "DESCARTADO" && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--muted)]">Este documento fue descartado anteriormente.</p>
              <button
                type="button"
                onClick={() => onRegistrarManual(doc.id, remitenteDe(doc))}
                className="text-sm font-medium text-[var(--brand)] hover:underline"
              >
                Registrar manualmente de todas formas
              </button>
            </div>
          )}

          {doc.estatus === "PROCESADO" && doc.propuestaReconciliada && (
            <div className="space-y-4">
              {doc.propuestaReconciliada.estrategiaExtraccion === "VISION" && (
                <p className="text-xs text-[var(--muted)]">
                  Leído por análisis visual (documento escaneado/foto) — revisa con más cuidado los montos y
                  números antes de confirmar.
                </p>
              )}

              {doc.propuestaReconciliada.contradiccionConContexto && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  ⚠ {doc.propuestaReconciliada.contradiccionConContexto}
                </p>
              )}

              <div>
                <p className="mb-1.5 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
                  Datos detectados del documento
                </p>
                <div className="space-y-1.5">
                  {doc.propuestaReconciliada.campos
                    .filter((c) => c.estado !== "NO_DETECTADO")
                    .map((c) => (
                      <div key={c.campo} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-[var(--foreground)]">{ETIQUETA_CAMPO[c.campo] ?? c.campo}</span>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{valorMostrado(c)}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${COLOR_ESTADO[c.estado]}`}>
                            {c.estado}
                          </span>
                        </div>
                      </div>
                    ))}
                  {doc.propuestaReconciliada.partes.map((p) => (
                    <div key={p.rol} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-[var(--foreground)] capitalize">{p.rol}</span>
                      <div className="flex items-center gap-2">
                        <span>{p.nombre}</span>
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          PROPUESTO
                        </span>
                      </div>
                    </div>
                  ))}
                  {doc.propuestaReconciliada.proyectoSugerido && (
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-[var(--foreground)]">Proyecto sugerido</span>
                      <div className="flex items-center gap-2">
                        <span>
                          {doc.propuestaReconciliada.proyectoSugerido.nombreCoincidente ??
                            doc.propuestaReconciliada.proyectoSugerido.nombreSugerido}
                        </span>
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          {doc.propuestaReconciliada.proyectoSugerido.proyectoId ? "PROPUESTO" : "SIN COINCIDENCIA"}
                        </span>
                      </div>
                    </div>
                  )}
                  {doc.propuestaReconciliada.finalidadGasto && (
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-[var(--foreground)]">Finalidad del gasto</span>
                      <span className="text-right text-[var(--muted)]">{doc.propuestaReconciliada.finalidadGasto}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 border-t border-[var(--border)] pt-3">
                <Button
                  onClick={() => onUsarPropuesta({ documentoEgresoId: doc.id, propuesta: doc.propuestaReconciliada!, remitente: remitenteDe(doc) })}
                >
                  Continuar con esta propuesta
                </Button>
                <button
                  type="button"
                  onClick={() => descartarDocumentoEgresoAction(doc.id)}
                  className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Descartar documento
                </button>
              </div>
            </div>
          )}
        </Card>
      ))}

      <button type="button" onClick={onCancelar} className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        Cerrar
      </button>
    </div>
  );
}

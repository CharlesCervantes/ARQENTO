import { Card } from "@/components/ui/card";
import { FormNuevaPartida } from "./form-nueva-partida";
import { FormNuevoConcepto } from "./form-nuevo-concepto";
import { IconoPartida } from "./icono-partida";
import { BotonEliminarPartida } from "./boton-eliminar-partida";
import { AccionesPropuesta, ConceptosPropuestos, EtiquetaPorAprobar } from "./propuestas-contrato";
import { TablaOperativaEditable, type ConceptoOperativoPlano } from "./tabla-operativa-editable";
import { formatMoney } from "@/lib/dinero";
import { calcularPrecioOperativoConcepto } from "@/lib/control-de-obra/contrato-general";
import type { obtenerPartidasProyecto } from "@/lib/server/control-de-obra/estructura-contractual";
import type { FilaPropuesta } from "@/lib/server/control-de-obra/propuestas-contrato";
import type { EsquemaContractual } from "@/lib/generated/prisma/enums";

type Partidas = Awaited<ReturnType<typeof obtenerPartidasProyecto>>;
type Concepto = Partidas[number]["conceptos"][number];

// Nada de Decimal cruza hacia TablaOperativaEditable ("use client") — se
// convierte a number aquí, en el server component (mismo motivo que Avance
// de obra y Contrato General Privado).
function aConceptoPlano(concepto: Concepto): ConceptoOperativoPlano {
  return {
    id: concepto.id,
    descripcion: concepto.descripcion,
    unidad: concepto.unidad,
    cantidadContratada: Number(concepto.cantidadContratada),
    precioUnitarioContratista:
      concepto.precioUnitarioContratista !== null ? Number(concepto.precioUnitarioContratista) : null,
    precioUnitarioMateriales:
      concepto.precioUnitarioMateriales !== null ? Number(concepto.precioUnitarioMateriales) : null,
    porcentajeAdministracion:
      concepto.porcentajeAdministracion !== null ? Number(concepto.porcentajeAdministracion) : null,
  };
}

// Wrapper: convierte los Decimal del Concepto de Prisma y llama al motor
// operativo compartido (lib/control-de-obra/contrato-general.ts) — Cliente
// (operativo) reutiliza esa misma función, así que esta fórmula nunca se
// duplica entre las dos pantallas.
function precioOperativo(
  concepto: Concepto,
  esquema: EsquemaContractual | null,
  porcentajeAdministracionDefault: number | null
) {
  return calcularPrecioOperativoConcepto(
    {
      precioUnitarioContratista:
        concepto.precioUnitarioContratista !== null ? Number(concepto.precioUnitarioContratista) : null,
      precioUnitarioMateriales:
        concepto.precioUnitarioMateriales !== null ? Number(concepto.precioUnitarioMateriales) : null,
      porcentajeAdministracion:
        concepto.porcentajeAdministracion !== null ? Number(concepto.porcentajeAdministracion) : null,
    },
    esquema,
    porcentajeAdministracionDefault
  );
}

// Subtotal operativo = cantidad × (P.U. + Materiales si Precio Alzado). Nunca
// incluye Indirectos/Herramienta/precio comercial — eso es Contrato General
// Privado (pestaña aparte).
function subtotalOperativo(
  concepto: Concepto,
  esquema: EsquemaContractual | null
): number {
  return Number(concepto.cantidadContratada) * precioOperativo(concepto, esquema, null).subtotalPorUnidad;
}

function montoAdministracion(
  concepto: Concepto,
  esquema: EsquemaContractual | null,
  porcentajeAdministracionDefault: number | null
): number {
  return (
    Number(concepto.cantidadContratada) *
    precioOperativo(concepto, esquema, porcentajeAdministracionDefault).montoAdministracionPorUnidad
  );
}

export function ContratoGeneralView({
  proyectoId,
  partidas,
  esquemaContractual,
  porcentajeAdministracionDefault,
  puedeAdministrar,
  puedeEliminar,
  propuestas,
  puedeProponer,
  puedeResolver,
}: {
  proyectoId: string;
  partidas: Partidas;
  esquemaContractual: EsquemaContractual | null;
  porcentajeAdministracionDefault: number | null;
  puedeAdministrar: boolean;
  puedeEliminar: boolean;
  propuestas: FilaPropuesta[];
  puedeProponer: boolean;
  puedeResolver: boolean;
}) {
  const pendientes = propuestas.filter((p) => p.estatus === "PENDIENTE");
  const rechazadas = propuestas.filter((p) => p.estatus === "RECHAZADA");
  const partidasPropuestas = pendientes.filter((p) => p.tipo === "PARTIDA");
  const idsPartida = new Set(partidas.map((p) => p.id));
  const idsPropuestas = new Set(partidasPropuestas.map((p) => p.id));
  const conceptosDe = (id: string) => pendientes.filter((p) => p.tipo === "CONCEPTO" && p.partidaId === id);
  // Su partida se eliminó después de proponerlos: solo queda rechazarlos.
  const sinPartida = pendientes.filter(
    (p) => p.tipo === "CONCEPTO" && !idsPartida.has(p.partidaId ?? "") && !idsPropuestas.has(p.padreId ?? "")
  );

  const esPrecioAlzado = esquemaContractual === "PRECIO_ALZADO";
  const esAdministracion = esquemaContractual === "ADMINISTRACION";

  const todosLosConceptos = partidas.flatMap((p) => p.conceptos);
  const totalContratistas = todosLosConceptos.reduce(
    (t, c) => t + Number(c.cantidadContratada) * (c.precioUnitarioContratista ? Number(c.precioUnitarioContratista) : 0),
    0
  );
  const totalMateriales = esPrecioAlzado
    ? todosLosConceptos.reduce(
        (t, c) => t + Number(c.cantidadContratada) * (c.precioUnitarioMateriales ? Number(c.precioUnitarioMateriales) : 0),
        0
      )
    : 0;
  const subtotalGeneral = totalContratistas + totalMateriales;
  const montoAdmGeneral = esAdministracion
    ? todosLosConceptos.reduce(
        (t, c) => t + montoAdministracion(c, esquemaContractual, porcentajeAdministracionDefault),
        0
      )
    : 0;

  return (
    <div className="space-y-3">
      {partidas.length === 0 && (
        <Card className="p-6 text-sm text-[var(--muted)]">
          Todavía no hay partidas en este proyecto.
        </Card>
      )}

      {partidas.length > 0 && (
        <ResumenContrato
          esPrecioAlzado={esPrecioAlzado}
          esAdministracion={esAdministracion}
          totalContratistas={totalContratistas}
          totalMateriales={totalMateriales}
          subtotalGeneral={subtotalGeneral}
          montoAdmGeneral={montoAdmGeneral}
          porcentajeAdministracionDefault={porcentajeAdministracionDefault}
        />
      )}

      {partidas.map((partida, i) => {
        const subtotal = partida.conceptos.reduce(
          (t, c) => t + subtotalOperativo(c, esquemaContractual),
          0
        );
        const montoAdm = esAdministracion
          ? partida.conceptos.reduce(
              (t, c) => t + montoAdministracion(c, esquemaContractual, porcentajeAdministracionDefault),
              0
            )
          : 0;

        return (
          <Card
            key={partida.id}
            className="enter overflow-hidden"
            style={{ transitionDelay: `${Math.min(i, 6) * 40}ms` }}
          >
            <details>
              <summary className="group flex cursor-pointer list-none items-center justify-between px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-3">
                  <IconoPartida icono={partida.icono} color={partida.color} />
                  <span className="text-sm font-semibold text-[var(--foreground)]">
                    {partida.nombre}
                  </span>
                  {conceptosDe(partida.id).length > 0 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      {conceptosDe(partida.id).length} por aprobar
                    </span>
                  )}
                  {puedeEliminar && (
                    <BotonEliminarPartida
                      proyectoId={proyectoId}
                      partidaId={partida.id}
                      nombre={partida.nombre}
                      conceptosActivos={partida.conceptos.length}
                    />
                  )}
                </span>
                {esAdministracion && partida.conceptos.length > 0 ? (
                  <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
                    <span>
                      Subtotal{" "}
                      <span className="tabular-nums text-[var(--foreground)]">
                        {formatMoney(subtotal)}
                      </span>
                    </span>
                    <span>
                      ADM{" "}
                      <span className="tabular-nums text-[var(--foreground)]">
                        {formatMoney(montoAdm)}
                      </span>
                    </span>
                    <span className="font-semibold text-[var(--foreground)]">
                      Total <span className="tabular-nums">{formatMoney(subtotal + montoAdm)}</span>
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-[var(--muted)]">
                    {partida.conceptos.length} concepto
                    {partida.conceptos.length === 1 ? "" : "s"}
                  </span>
                )}
              </summary>

              <div className="border-t border-[var(--border)] px-5 py-4 space-y-5">
                {partida.conceptos.length > 0 && (
                  <TablaOperativaEditable
                    proyectoId={proyectoId}
                    conceptos={partida.conceptos.map(aConceptoPlano)}
                    esPrecioAlzado={esPrecioAlzado}
                    esAdministracion={esAdministracion}
                    porcentajeAdministracionDefault={porcentajeAdministracionDefault}
                    subtotal={subtotal}
                    montoAdm={montoAdm}
                    puedeAdministrar={puedeAdministrar}
                    puedeEliminar={puedeEliminar}
                  />
                )}

                <ConceptosPropuestos proyectoId={proyectoId} propuestas={conceptosDe(partida.id)} puedeResolver={puedeResolver} />

                {(puedeAdministrar || puedeProponer) && (
                  <details>
                    <summary className="inline-flex w-fit cursor-pointer list-none items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] transition-colors duration-150 ease-out select-none hover:bg-black/[0.03] [&::-webkit-details-marker]:hidden">
                      + Agregar concepto
                    </summary>
                    <div className="mt-3">
                      <FormNuevoConcepto
                        partidaId={partida.id}
                        proyectoId={proyectoId}
                        esquemaContractual={esquemaContractual}
                        proponer={puedeProponer}
                      />
                    </div>
                  </details>
                )}
              </div>
            </details>
          </Card>
        );
      })}

      {partidasPropuestas.map((propuesta) => (
        <Card key={propuesta.id} className="space-y-4 border-amber-200 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                {propuesta.descripcion} {puedeResolver && <EtiquetaPorAprobar />}
              </p>
              <p className="mt-0.5 text-xs text-[var(--muted)]">Partida propuesta por {propuesta.solicitadoPorNombre}</p>
            </div>
            <AccionesPropuesta proyectoId={proyectoId} propuesta={propuesta} puedeResolver={puedeResolver} />
          </div>
          <ConceptosPropuestos proyectoId={proyectoId} propuestas={pendientes.filter((p) => p.padreId === propuesta.id)} puedeResolver={puedeResolver} />
          {puedeProponer && (
            <details>
              <summary className="inline-flex w-fit cursor-pointer list-none items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] select-none hover:bg-black/[0.03] [&::-webkit-details-marker]:hidden">
                + Agregar concepto
              </summary>
              <div className="mt-3">
                <FormNuevoConcepto partidaId={propuesta.id} proyectoId={proyectoId} esquemaContractual={esquemaContractual} proponer enPropuesta />
              </div>
            </details>
          )}
        </Card>
      ))}

      {sinPartida.length > 0 && (
        <Card className="space-y-3 p-5">
          <p className="text-sm font-semibold text-[var(--foreground)]">Su partida ya no existe</p>
          <ConceptosPropuestos proyectoId={proyectoId} propuestas={sinPartida} puedeResolver={puedeResolver} />
        </Card>
      )}

      {rechazadas.length > 0 && (
        <Card className="p-5">
          <p className="text-sm font-semibold text-[var(--foreground)]">Propuestas tuyas rechazadas (últimos 30 días)</p>
          <ul className="mt-2 space-y-2">
            {rechazadas.map((p) => (
              <li key={p.id} className="text-sm">
                <span className="text-[var(--foreground)]">{p.descripcion}</span>
                <span className="block text-xs text-red-700">Motivo: {p.motivo}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(puedeAdministrar || puedeProponer) && (
        <Card className="p-4">
          <FormNuevaPartida proyectoId={proyectoId} proponer={puedeProponer} />
        </Card>
      )}
    </div>
  );
}

// Solo componentes operativos (Contratistas/Materiales) — nunca % Utilidad,
// P.U. Cliente ni Indirectos/Herramienta (eso es Contrato General Privado).
// % Administración es la única excepción porque no es privado (ver arriba).
function ResumenContrato({
  esPrecioAlzado,
  esAdministracion,
  totalContratistas,
  totalMateriales,
  subtotalGeneral,
  montoAdmGeneral,
  porcentajeAdministracionDefault,
}: {
  esPrecioAlzado: boolean;
  esAdministracion: boolean;
  totalContratistas: number;
  totalMateriales: number;
  subtotalGeneral: number;
  montoAdmGeneral: number;
  porcentajeAdministracionDefault: number | null;
}) {
  return (
    <Card className="enter p-5 ring-2 ring-emerald-200">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        Resumen del contrato
      </p>
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        <Metrica label="Contratistas" valor={totalContratistas} />
        {esPrecioAlzado && <Metrica label="Materiales" valor={totalMateriales} />}
        {esAdministracion && (
          <Metrica
            label={
              porcentajeAdministracionDefault !== null
                ? `% Administración (${porcentajeAdministracionDefault.toLocaleString("es-MX")}%)`
                : "% Administración"
            }
            valor={montoAdmGeneral}
          />
        )}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3">
        <span className="text-sm font-medium text-[var(--muted)]">
          {esAdministracion ? "Total (mano de obra + administración)" : "Subtotal directo (Contratistas + Materiales)"}
        </span>
        <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">
          {formatMoney(esAdministracion ? subtotalGeneral + montoAdmGeneral : subtotalGeneral)}
        </span>
      </div>
    </Card>
  );
}

function Metrica({ label, valor }: { label: string; valor: number }) {
  return (
    <div>
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="text-base font-semibold tabular-nums text-[var(--foreground)]">
        {formatMoney(valor)}
      </p>
    </div>
  );
}


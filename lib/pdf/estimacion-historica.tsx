import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import type { DatosDocumentoEstimacion } from "@/lib/server/control-de-obra/documentos-estimacion";
import { resumenPdfPrivado } from "@/lib/control-de-obra/presentacion-estimacion-privada";
import { aplanarGastosCobrables } from "@/lib/control-de-obra/lineas-gasto-estimacion";

// Documento @react-pdf/renderer del historial documental — se renderiza en
// el servidor (route handler), nunca en el navegador. Vista tonta: recibe
// datos ya numéricos/congelados (obtenerDatosDocumentoEstimacion ya resolvió
// el corte histórico) y solo formatea. Página 1 = Control Contractual al
// corte; página(s) 2+ = Estimación semanal — el bloque financiero y las
// columnas de pago del historial ya vienen podados desde el servidor si el
// usuario no tiene permiso, este componente nunca decide ocultar nada por
// su cuenta (historial documental, agosto 2026).

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#111827" },
  encabezado: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
    paddingBottom: 12,
    borderBottom: "1pt solid #111827",
  },
  identidadEmpresa: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 130, height: 56, objectFit: "contain" },
  razonSocial: { fontSize: 13, fontWeight: 700 },
  titulo: { fontSize: 11, marginTop: 2, color: "#374151" },
  folio: { fontSize: 12, fontWeight: 700, textAlign: "right" },
  fecha: { fontSize: 9, color: "#6b7280", textAlign: "right", marginTop: 2 },
  filaDatos: { flexDirection: "row", marginBottom: 3 },
  etiquetaDato: { width: 140, color: "#6b7280" },
  etiquetaResumen: { width: 200, color: "#6b7280" },
  valorDato: { fontWeight: 700 },
  seccion: { marginTop: 16 },
  seccionTitulo: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#374151",
    marginBottom: 6,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  gridItem: { width: "33%", marginBottom: 8, paddingRight: 8 },
  gridEtiqueta: { fontSize: 8, color: "#6b7280" },
  gridValor: { fontSize: 10, fontWeight: 700, marginTop: 1 },
  tablaEncabezado: {
    flexDirection: "row",
    backgroundColor: "#f3f4f6",
    paddingVertical: 5,
    paddingHorizontal: 4,
    fontWeight: 700,
    fontSize: 9,
  },
  tablaFila: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottom: "0.5pt solid #e5e7eb",
    fontSize: 9,
  },
  colEstimacion: { flex: 1.4 },
  colSemana: { flex: 1.4 },
  colMonto: { flex: 1.3, textAlign: "right" },
  colEstado: { flex: 1, textAlign: "right" },
  colDescripcion: { flex: 3 },
  colUnidad: { flex: 1, textAlign: "center" },
  colCantidad: { flex: 1, textAlign: "right" },
  colPU: { flex: 1, textAlign: "right" },
  colImporte: { flex: 1, textAlign: "right" },
  filaTotal: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1pt solid #111827",
  },
  totalEtiqueta: { fontSize: 11, fontWeight: 700, marginRight: 12 },
  totalValor: { fontSize: 13, fontWeight: 700 },
  piePagina: { marginTop: 16, fontSize: 8, color: "#9ca3af" },
});

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCantidad(n: number): string {
  return n.toLocaleString("es-MX", { maximumFractionDigits: 3 });
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}

const ESTADO_LABEL: Record<string, string> = {
  PENDIENTE: "Pendiente",
  PARCIAL: "Parcial",
  CUBIERTA: "Cubierta",
};

function IdentidadEmpresa({ datos }: { datos: DatosDocumentoEstimacion }) {
  const { branding } = datos;
  return (
    <View style={styles.identidadEmpresa}>
      {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image, no es <img> HTML */}
      {datos.logoBuffer && <Image src={datos.logoBuffer} style={styles.logo} />}
      {/* Con logo, el logo ES la identidad — se omite el nombre en texto para
          que el logo pueda verse más grande (mismo criterio que el sidebar de
          la app). Sin logo, el nombre sigue siendo necesario. */}
      {!datos.logoBuffer && <Text style={styles.razonSocial}>{branding.razonSocial ?? branding.nombre}</Text>}
    </View>
  );
}

function ItemGrid({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <View style={styles.gridItem}>
      <Text style={styles.gridEtiqueta}>{etiqueta}</Text>
      <Text style={styles.gridValor}>{valor}</Text>
    </View>
  );
}

function PaginaControlContractual({ datos }: { datos: DatosDocumentoEstimacion }) {
  const { controlContractual: cc } = datos;
  return (
    <Page size="LETTER" style={styles.page}>
      <View style={styles.encabezado}>
        <View>
          <IdentidadEmpresa datos={datos} />
          <Text style={styles.titulo}>Control contractual al corte de Estimación {datos.numero}</Text>
        </View>
        <View>
          <Text style={styles.folio}>Estimación {String(datos.numero).padStart(3, "0")}</Text>
        </View>
      </View>

      <View>
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Proyecto</Text>
          <Text style={styles.valorDato}>{datos.proyectoNombre}</Text>
        </View>
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Semana</Text>
          <Text style={styles.valorDato}>{datos.semanaLabel}</Text>
        </View>
        {datos.emitidoEn && (
          <View style={styles.filaDatos}>
            <Text style={styles.etiquetaDato}>Fecha de emisión</Text>
            <Text style={styles.valorDato}>{formatFecha(datos.emitidoEn)}</Text>
          </View>
        )}
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Documento generado</Text>
          <Text style={styles.valorDato}>{formatFecha(datos.fechaCorteDocumento)}</Text>
        </View>
      </View>

      <View style={styles.seccion}>
        <Text style={styles.seccionTitulo}>Información contractual</Text>
        <View style={styles.grid}>
          <ItemGrid etiqueta="Esquema contractual" valor={cc.proyecto.esquemaContractual ?? "Sin definir"} />
          <ItemGrid
            etiqueta="Fecha de inicio"
            valor={cc.proyecto.fechaInicio ? formatFecha(cc.proyecto.fechaInicio) : "—"}
          />
        </View>
      </View>

      <View style={styles.seccion}>
        <Text style={styles.seccionTitulo}>Avance contractual</Text>
        <View style={styles.grid}>
          <ItemGrid etiqueta="Monto del contrato" valor={formatMoney(cc.avanceContractual.montoContrato)} />
          <ItemGrid
            etiqueta="Trabajos contractuales estimados"
            valor={formatMoney(cc.avanceContractual.trabajosEstimados)}
          />
          <ItemGrid
            etiqueta="Saldo contractual por ejercer"
            valor={formatMoney(cc.avanceContractual.saldoPorEjercer)}
          />
          <ItemGrid
            etiqueta="% avance"
            valor={`${cc.avanceContractual.porcentajeEjercido.toLocaleString("es-MX", { maximumFractionDigits: 1 })}%`}
          />
        </View>
      </View>

      {cc.financiero && (
        <View style={styles.seccion}>
          <Text style={styles.seccionTitulo}>Situación financiera real</Text>
          <View style={styles.grid}>
            <ItemGrid etiqueta="Total cubierto" valor={formatMoney(cc.financiero.totalCubierto)} />
            <ItemGrid etiqueta="Pendiente por cobrar" valor={formatMoney(cc.financiero.pendienteFinancieroReal)} />
            {cc.financiero.fondo && (
              <>
                <ItemGrid etiqueta="Fondo aportado" valor={formatMoney(cc.financiero.fondo.aportado)} />
                <ItemGrid etiqueta="Fondo aplicado" valor={formatMoney(cc.financiero.fondo.aplicado)} />
                <ItemGrid etiqueta="Fondo disponible" valor={formatMoney(cc.financiero.fondo.disponible)} />
              </>
            )}
          </View>
        </View>
      )}

      <View style={styles.seccion}>
        <Text style={styles.seccionTitulo}>Historial de estimaciones (1 – {datos.numero})</Text>
        <View style={styles.tablaEncabezado}>
          <Text style={styles.colEstimacion}>Estimación</Text>
          <Text style={styles.colSemana}>Semana</Text>
          <Text style={styles.colMonto}>Importe</Text>
          {datos.historial[0]?.financiero && <Text style={styles.colEstado}>Estado</Text>}
        </View>
        {datos.historial.map((fila) => (
          <View style={styles.tablaFila} key={fila.id}>
            <Text style={styles.colEstimacion}>Estimación {fila.numero}</Text>
            <Text style={styles.colSemana}>
              Semana {fila.semanaNumero}/{fila.semanaAnio}
            </Text>
            <Text style={styles.colMonto}>{formatMoney(fila.importe)}</Text>
            {fila.financiero && (
              <Text style={styles.colEstado}>{ESTADO_LABEL[fila.financiero.estado]}</Text>
            )}
          </View>
        ))}
      </View>

      <Text style={styles.piePagina}>
        Documento histórico — refleja el corte financiero del{" "}
        {formatFecha(datos.fechaCorteDocumento)}, fijado en la primera generación de este documento.
      </Text>
    </Page>
  );
}

function PaginaEstimacionSemanal({ datos }: { datos: DatosDocumentoEstimacion }) {
  const { estimacionSemanal: es } = datos;
  const esPrivado = datos.capa === "privado";
  // Solo Cliente Priv.: P.U. va en base y el importe incluye el cargo.
  const abreviatura = es.esquemaContractual === "ADMINISTRACION" ? "Adm." : "Util.";
  const incluyeCargo = esPrivado && es.administracionTrabajos !== 0;
  return (
    <Page size="LETTER" style={styles.page}>
      <View style={styles.encabezado}>
        <View>
          <IdentidadEmpresa datos={datos} />
          <Text style={styles.titulo}>Estimación de obra No. {datos.numero}</Text>
        </View>
        <View>
          <Text style={styles.folio}>{datos.semanaLabel}</Text>
        </View>
      </View>

      <View style={styles.filaDatos}>
        <Text style={styles.etiquetaDato}>Proyecto</Text>
        <Text style={styles.valorDato}>{datos.proyectoNombre}</Text>
      </View>

      <View style={styles.seccion}>
        <View style={styles.tablaEncabezado}>
          <Text style={styles.colDescripcion}>Concepto</Text>
          <Text style={styles.colUnidad}>Unidad</Text>
          <Text style={styles.colCantidad}>Cant. semana</Text>
          <Text style={styles.colPU}>{incluyeCargo ? `P.U. sin ${abreviatura}` : "P.U."}</Text>
          <Text style={styles.colImporte}>{incluyeCargo ? `Importe + ${abreviatura}` : "Importe"}</Text>
        </View>
        {es.filas.map((f, i) => (
          <View style={styles.tablaFila} key={i}>
            <Text style={styles.colDescripcion}>{f.descripcionConcepto}</Text>
            <Text style={styles.colUnidad}>{f.unidad}</Text>
            <Text style={styles.colCantidad}>{formatCantidad(f.cantidadEstaSemana)}</Text>
            <Text style={styles.colPU}>{formatMoney(f.precioUnitario)}</Text>
            <Text style={styles.colImporte}>{formatMoney(f.importeEstaSemana)}</Text>
          </View>
        ))}
      </View>

      {es.gastos.length > 0 && (
        <View style={styles.seccion}>
          <Text style={styles.seccionTitulo}>Gastos de obra / Materiales</Text>
          <View style={styles.tablaEncabezado}>
            <Text style={styles.colDescripcion}>Descripción</Text>
            <Text style={styles.colUnidad}>Unidad</Text>
            <Text style={styles.colCantidad}>Cantidad</Text>
            <Text style={styles.colPU}>P.U.</Text>
            <Text style={styles.colImporte}>Importe</Text>
          </View>
          {aplanarGastosCobrables(es.gastos).map((l, i) => (
            <View style={styles.tablaFila} key={i}>
              <Text style={styles.colDescripcion}>{l.descripcion}</Text>
              <Text style={styles.colUnidad}>{l.unidad}</Text>
              <Text style={styles.colCantidad}>{formatCantidad(l.cantidad)}</Text>
              <Text style={styles.colPU}>{formatMoney(l.precioUnitario)}</Text>
              <Text style={styles.colImporte}>{formatMoney(l.importe)}</Text>
            </View>
          ))}
        </View>
      )}

      {esPrivado ? <ResumenPrivado es={es} /> : <ResumenGeneral es={es} />}

      <View style={styles.filaTotal}>
        <Text style={styles.totalEtiqueta}>Total de la estimación</Text>
        <Text style={styles.totalValor}>{formatMoney(es.total)}</Text>
      </View>
    </Page>
  );
}

function ResumenPrivado({ es }: { es: DatosDocumentoEstimacion["estimacionSemanal"] }) {
  return (
    <View style={styles.seccion} wrap={false}>
      {resumenPdfPrivado(es).map((l) => (
        <View style={styles.filaDatos} key={l.etiqueta}>
          <Text style={styles.etiquetaResumen}>{l.etiqueta}</Text>
          <Text style={styles.valorDato}>{formatMoney(l.monto)}</Text>
        </View>
      ))}
    </View>
  );
}

function ResumenGeneral({ es }: { es: DatosDocumentoEstimacion["estimacionSemanal"] }) {
  return (
      <View style={styles.seccion}>
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Subtotal trabajos</Text>
          <Text style={styles.valorDato}>{formatMoney(es.subtotalTrabajos)}</Text>
        </View>
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Gastos cobrables</Text>
          <Text style={styles.valorDato}>{formatMoney(es.gastosCobrables)}</Text>
        </View>
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Subtotal</Text>
          <Text style={styles.valorDato}>{formatMoney(es.subtotalTrabajos + es.gastosCobrables)}</Text>
        </View>
        <View style={styles.filaDatos}>
          <Text style={styles.etiquetaDato}>Administración</Text>
          <Text style={styles.valorDato}>{formatMoney(es.administracion)}</Text>
        </View>
        {es.aplicaIVA && (
          <View style={styles.filaDatos}>
            <Text style={styles.etiquetaDato}>
              IVA{es.porcentajeIVA !== null ? ` (${es.porcentajeIVA}%)` : ""}
            </Text>
            <Text style={styles.valorDato}>{formatMoney(es.montoIVA)}</Text>
          </View>
        )}
      </View>
  );
}

export function EstimacionHistoricaDocumento({ datos }: { datos: DatosDocumentoEstimacion }) {
  return (
    <Document>
      <PaginaControlContractual datos={datos} />
      <PaginaEstimacionSemanal datos={datos} />
    </Document>
  );
}

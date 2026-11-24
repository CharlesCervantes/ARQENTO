import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import type { DocumentoCotizacion } from "@/lib/comercializacion/documento";
import { formatearCantidad, formatearImporte } from "@/lib/comercializacion/importes";
import { formatearFechaCalendario } from "@/lib/comercializacion/fechas";

// Cotización de venta (Comercialización B3) — @react-pdf/renderer en el
// servidor, mismo motor e identidad que Orden de Compra/Recibo
// (lib/pdf/orden-compra.tsx). Se arma EXCLUSIVAMENTE con DocumentoCotizacion:
// la copia histórica emitida (o la vista previa de un borrador, marcada
// BORRADOR). Nunca incluye costos, utilidad ni datos internos.
// Importes y cantidades se formatean desde texto exacto (sin float).

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 54, paddingHorizontal: 36, fontSize: 9.5, fontFamily: "Helvetica", color: "#111827" },
  encabezado: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: "1pt solid #111827",
  },
  identidadEmpresa: { flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 330 },
  logo: { width: 130, height: 56, objectFit: "contain" },
  razonSocial: { fontSize: 13, fontWeight: 700 },
  titulo: { fontSize: 11, marginTop: 2, color: "#374151" },
  folio: { fontSize: 13, fontWeight: 700, textAlign: "right" },
  fecha: { fontSize: 9, color: "#6b7280", textAlign: "right", marginTop: 2 },
  marcaBorrador: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: 700,
    color: "#b91c1c",
    textAlign: "right",
  },
  avisoBorrador: {
    marginBottom: 10,
    padding: 6,
    border: "1pt solid #b91c1c",
    color: "#b91c1c",
    fontSize: 9,
    textAlign: "center",
  },
  datos: { flexDirection: "row", gap: 16, marginBottom: 6 },
  columnaDatos: { flex: 1 },
  filaDatos: { flexDirection: "row", marginBottom: 3 },
  etiquetaDato: { width: 70, color: "#6b7280" },
  valorDato: { flex: 1, fontWeight: 700 },
  seccion: { marginTop: 12 },
  seccionTitulo: { fontSize: 8.5, fontWeight: 700, color: "#6b7280", marginBottom: 5, textTransform: "uppercase" },
  tablaEncabezado: { flexDirection: "row", backgroundColor: "#f3f4f6", paddingVertical: 5, paddingHorizontal: 4, fontWeight: 700 },
  tablaFila: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4, borderBottom: "0.5pt solid #e5e7eb" },
  colMaterial: { flex: 3.4, paddingRight: 6 },
  colUnidad: { flex: 0.9, textAlign: "center" },
  colCantidad: { flex: 1, textAlign: "right" },
  colPU: { flex: 1.2, textAlign: "right" },
  colImpuesto: { flex: 1, textAlign: "center" },
  colImporte: { flex: 1.3, textAlign: "right" },
  totales: { marginTop: 10, marginLeft: "auto", width: 250 },
  filaTotal: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  filaTotalTenue: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3, color: "#6b7280" },
  filaGranTotal: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, paddingTop: 5, borderTop: "1pt solid #111827" },
  granTotal: { fontSize: 12, fontWeight: 700 },
  texto: { lineHeight: 1.4, color: "#374151" },
  pie: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: "#9ca3af",
  },
});

function etiquetaImpuesto(p: DocumentoCotizacion["partidas"][number]): string {
  if (p.tratamientoImpuesto === "GRAVADO" && p.tasaIva) return `IVA ${Number(p.tasaIva)} %`;
  return p.tratamientoImpuesto === "TASA_CERO" ? "Tasa 0 %" : "Exento";
}

export function CotizacionVentaDocumento({
  documento: d,
  borrador,
  logoBuffer,
}: {
  documento: DocumentoCotizacion;
  borrador: boolean;
  logoBuffer: Buffer | null;
}) {
  return (
    <Document title={`${d.folio}${borrador ? " (BORRADOR)" : ""}`} author={d.empresa.nombre}>
      <Page size="LETTER" style={styles.page} wrap>
        <View style={styles.encabezado} fixed>
          <View style={styles.identidadEmpresa}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image, no es <img> HTML */}
            {logoBuffer && <Image src={logoBuffer} style={styles.logo} />}
            <View>
              {!logoBuffer && <Text style={styles.razonSocial}>{d.empresa.razonSocial ?? d.empresa.nombre}</Text>}
              <Text style={styles.titulo}>Cotización</Text>
            </View>
          </View>
          <View>
            <Text style={styles.folio}>{d.folio}</Text>
            <Text style={styles.fecha}>Fecha: {formatearFechaCalendario(d.fecha)}</Text>
            <Text style={styles.fecha}>Vigente hasta: {formatearFechaCalendario(d.vigenciaHasta)}</Text>
            {borrador && <Text style={styles.marcaBorrador}>BORRADOR</Text>}
          </View>
        </View>

        {borrador && (
          <Text style={styles.avisoBorrador}>
            BORRADOR — vista previa sin validez comercial. Los datos pueden cambiar hasta que la cotización se emita.
          </Text>
        )}

        <View style={styles.datos}>
          <View style={styles.columnaDatos}>
            <View style={styles.filaDatos}>
              <Text style={styles.etiquetaDato}>Cliente</Text>
              <Text style={styles.valorDato}>{d.cliente?.nombre ?? "—"}</Text>
            </View>
            {d.cliente?.contacto && (
              <View style={styles.filaDatos}>
                <Text style={styles.etiquetaDato}>Contacto</Text>
                <Text style={styles.valorDato}>{d.cliente.contacto}</Text>
              </View>
            )}
            <View style={styles.filaDatos}>
              <Text style={styles.etiquetaDato}>Obra</Text>
              <Text style={styles.valorDato}>{d.obra?.nombre ?? "—"}</Text>
            </View>
            {d.obra?.ubicacion && (
              <View style={styles.filaDatos}>
                <Text style={styles.etiquetaDato}>Ubicación</Text>
                <Text style={styles.valorDato}>{d.obra.ubicacion}</Text>
              </View>
            )}
          </View>
          <View style={styles.columnaDatos}>
            {/* Sin vendedor asignado: el documento del cliente omite la fila. */}
            {d.vendedor && (
              <View style={styles.filaDatos}>
                <Text style={styles.etiquetaDato}>Vendedor</Text>
                <Text style={styles.valorDato}>{d.vendedor.nombre}</Text>
              </View>
            )}
            {d.descripcion && (
              <View style={styles.filaDatos}>
                <Text style={styles.etiquetaDato}>Descripción</Text>
                <Text style={styles.valorDato}>{d.descripcion}</Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.seccion}>
          <Text style={styles.seccionTitulo}>Materiales (precios sin IVA)</Text>
          <View style={styles.tablaEncabezado}>
            <Text style={styles.colMaterial}>Material</Text>
            <Text style={styles.colUnidad}>Unidad</Text>
            <Text style={styles.colCantidad}>Cantidad</Text>
            <Text style={styles.colPU}>P. unitario</Text>
            <Text style={styles.colImpuesto}>Impuesto</Text>
            <Text style={styles.colImporte}>Importe</Text>
          </View>
          {d.partidas.map((p, i) => (
            <View style={styles.tablaFila} key={i} wrap={false}>
              <View style={styles.colMaterial}>
                <Text style={{ fontWeight: 700 }}>{p.codigo}</Text>
                <Text style={{ fontSize: 8.5, color: "#4b5563", marginTop: 1 }}>{p.descripcion}</Text>
              </View>
              <Text style={styles.colUnidad}>{p.unidad}</Text>
              <Text style={styles.colCantidad}>{formatearCantidad(p.cantidad)}</Text>
              <Text style={styles.colPU}>{formatearImporte(p.precioUnitario)}</Text>
              <Text style={styles.colImpuesto}>{etiquetaImpuesto(p)}</Text>
              <Text style={styles.colImporte}>{formatearImporte(p.importe)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totales} wrap={false}>
          <View style={styles.filaTotal}>
            <Text>Subtotal</Text>
            <Text>{formatearImporte(d.totales.subtotal)}</Text>
          </View>
          {d.totales.gravado.map((g) => (
            <View style={styles.filaTotal} key={g.tasa}>
              <Text>
                IVA {Number(g.tasa)} % sobre {formatearImporte(g.base)}
              </Text>
              <Text>{formatearImporte(g.iva)}</Text>
            </View>
          ))}
          {d.totales.baseTasaCero !== "0.00" && (
            <View style={styles.filaTotalTenue}>
              <Text>Base tasa 0 % (IVA $0.00)</Text>
              <Text>{formatearImporte(d.totales.baseTasaCero)}</Text>
            </View>
          )}
          {d.totales.baseExenta !== "0.00" && (
            <View style={styles.filaTotalTenue}>
              <Text>Base exenta (sin IVA)</Text>
              <Text>{formatearImporte(d.totales.baseExenta)}</Text>
            </View>
          )}
          <View style={styles.filaGranTotal}>
            <Text style={styles.granTotal}>Total</Text>
            <Text style={styles.granTotal}>{formatearImporte(d.totales.total)}</Text>
          </View>
        </View>

        {d.condiciones && (
          <View style={styles.seccion} wrap>
            <Text style={styles.seccionTitulo}>Condiciones</Text>
            <Text style={styles.texto}>{d.condiciones}</Text>
          </View>
        )}
        {d.observaciones && (
          <View style={styles.seccion} wrap>
            <Text style={styles.seccionTitulo}>Observaciones</Text>
            <Text style={styles.texto}>{d.observaciones}</Text>
          </View>
        )}

        <View style={styles.pie} fixed>
          <Text>
            {d.empresa.razonSocial ?? d.empresa.nombre} · {d.folio}
            {borrador ? " · BORRADOR" : ""}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

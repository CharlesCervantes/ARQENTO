import { createHash } from "node:crypto";
import { db } from "@/lib/server/db";
import { EMPRESA, admin, baseLimpiaConDatos, supervisor } from "./base";

// Datos FICTICIOS para revisar la bandeja «Recibidos por WhatsApp» en un
// navegador local (no es una prueba automática). Solo corre con la
// preparación de las pruebas de integración (base local protegida, identidad
// verificada, servicios externos simulados):
//   node --conditions=react-server --import tsx --import ./tests/setup/integracion.mjs tests/integracion/apoyo/sembrar-bandeja-navegador.ts
// La sesión usa un token ficticio que solo existe en esa base local.

const TOKEN_DE_SESION = process.env.TOKEN_SESION_LOCAL;
if (!TOKEN_DE_SESION)
  throw new Error(
    "Falta TOKEN_SESION_LOCAL (un valor aleatorio, solo para la base local).",
  );

async function sembrar(tokenDeSesion: string) {
  await baseLimpiaConDatos();
  await db.empresa.update({
    where: { id: EMPRESA },
    data: { whatsappHabilitado: true },
  });
  // La pantalla exige que la Empresa tenga el módulo de Contabilidad.
  const modulo = await db.modulo.upsert({ where: { clave: "contabilidad" }, update: {}, create: { clave: "contabilidad", nombre: "Contabilidad" } });
  await db.empresaModulo.create({ data: { empresaId: EMPRESA, moduloId: modulo.id, habilitado: true } });
  await db.sesion.create({
    data: {
      usuarioId: admin.id,
      tokenHash: createHash("sha256").update(tokenDeSesion).digest("hex"),
      expiraEn: new Date(Date.now() + 3_600_000),
    },
  });
  const base = {
    empresaId: EMPRESA,
    tipoMime: "image/jpeg",
    origen: "WHATSAPP" as const,
    subidoPorId: supervisor.id,
  };
  await db.documentoEgreso.createMany({
    data: [
      {
        ...base,
        archivoRef: `contabilidad/${EMPRESA}/documentos-egreso/whatsapp/ficticio-1`,
        archivoNombre: "comprobante-20261110-101500.jpg",
        hashArchivo: "huella-ficticia-1",
        loteId: "lote-1",
        contextoUsuario: "Obra Prueba, lo pagué yo",
      },
      {
        ...base,
        tipoMime: "application/pdf",
        archivoRef: `contabilidad/${EMPRESA}/documentos-egreso/whatsapp/ficticio-2`,
        archivoNombre: "factura-ficticia.pdf",
        hashArchivo: "huella-ficticia-2",
        loteId: "lote-2",
      },
    ],
  });
  const mensaje = {
    remitenteHash: "hmac-ficticio",
    remitentePendiente: "5210000000000",
    empresaId: EMPRESA,
    usuarioId: supervisor.id,
    vinculoId: "vinculo-ficticio",
    recibidoEn: new Date(),
  };
  await db.mensajeWhatsapp.createMany({
    data: [
      {
        ...mensaje,
        wamid: "wamid.ficticio.detenido",
        tipo: "image",
        estadoProceso: "ERROR",
        resultado: "ARCHIVO_DETENIDO",
        intentos: 3,
        etapaArchivo: "ALMACENADO",
        archivoPendiente: {
          mediaId: "media-ficticio",
          nombre: null,
          ref: `contabilidad/${EMPRESA}/documentos-egreso/whatsapp/ficticio-3`,
          hash: "huella-ficticia-3",
          tipoMime: "image/jpeg",
          archivoNombre: "comprobante.jpg",
        },
      },
      {
        ...mensaje,
        remitentePendiente: null,
        wamid: "wamid.ficticio.limitado",
        tipo: "image",
        estadoProceso: "PROCESADO",
        resultado: "ARCHIVO_LIMITADO",
        etapaArchivo: "RECHAZADO",
        respondido: true,
      },
    ],
  });
  console.log("Datos ficticios listos para la bandeja.");
}

sembrar(TOKEN_DE_SESION)
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Error");
    process.exitCode = 1;
  });

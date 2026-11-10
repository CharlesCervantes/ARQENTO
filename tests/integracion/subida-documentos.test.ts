import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { db } from "@/lib/server/db";
import { subirDocumentosEgreso } from "@/lib/server/contabilidad/documentos/documento-egreso";
import { EMPRESA, EMPRESA_AJENA, admin, adminAjeno, baseLimpiaConDatos, repetir, sinInterbloqueos } from "./apoyo/base";

// Subida de documentos de Captura Inteligente contra PostgreSQL REAL (base
// local dedicada) y almacenamiento R2 SIMULADO en memoria (sin credenciales
// ni red — tests/setup/servicios-externos-stub.cjs). Verifica el bloqueo de
// duplicados exactos (misma huella, misma Empresa) con subidas simultáneas.
// Ninguna prueba procesa el documento ni llama a la IA: la subida solo
// encola el trabajo. Archivos ficticios (PNG mínimos).

const almacenamiento: Map<string, Buffer> = createRequire(import.meta.url)("../setup/servicios-externos-stub.cjs").__objetosSimulados;

after(() => db.$disconnect());
beforeEach(async () => {
  await baseLimpiaConDatos();
  await db.empresa.updateMany({ where: { id: { in: [EMPRESA, EMPRESA_AJENA] } }, data: { inteligenciaHabilitada: true } });
});

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (semilla: string) => Buffer.concat([FIRMA_PNG, Buffer.from(`imagen-ficticia-${semilla}`)]);
const archivo = (bytes: Buffer, nombre = "ticket.png") => [{ nombre, tipoMime: "image/png", bytes }];

describe("Subida en PostgreSQL — duplicados exactos del mismo archivo", () => {
  test("Dos subidas simultáneas del mismo archivo crean UN documento y UN trabajo", async () => {
    await repetir(8, async (vuelta) => {
      const bytes = png(`simultaneo-${vuelta}`);
      const r = await Promise.allSettled([
        subirDocumentosEgreso(admin, archivo(bytes), "Contexto A"),
        subirDocumentosEgreso(admin, archivo(bytes), "Contexto B"),
      ]);
      sinInterbloqueos(r);
      assert.ok(r.every((x) => x.status === "fulfilled"), JSON.stringify(r));
      const resultados = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof subirDocumentosEgreso>>>[]).map((x) => x.value.documentos[0]);
      assert.equal(resultados[0].documentoEgresoId, resultados[1].documentoEgresoId, "los dos apuntan al mismo documento");
      assert.deepEqual(resultados.map((d) => d.duplicado).sort(), [false, true]);

      const documentos = await db.documentoEgreso.findMany({ where: { empresaId: EMPRESA, id: resultados[0].documentoEgresoId } });
      assert.equal(documentos.length, 1);
      const delMismoArchivo = await db.documentoEgreso.count({ where: { empresaId: EMPRESA, hashArchivo: documentos[0].hashArchivo } });
      assert.equal(delMismoArchivo, 1);
      const trabajos = await db.trabajoProcesamientoDocumento.findMany({ where: { referenciaModulo: documentos[0].id } });
      assert.equal(trabajos.length, 1);
      assert.equal(documentos[0].trabajoProcesamientoId, trabajos[0].id, "documento enlazado a su trabajo");
      assert.ok(almacenamiento.has(documentos[0].archivoRef), "el archivo del documento existe en el almacenamiento simulado");
    });
  });

  test("Volver a subir el mismo archivo reutiliza el documento y conserva el contexto original", async () => {
    const bytes = png("secuencial");
    const primero = await subirDocumentosEgreso(admin, archivo(bytes), "Villas. Lo pagué yo.");
    const segundo = await subirDocumentosEgreso(admin, archivo(bytes), "Otro contexto");
    assert.equal(segundo.documentos[0].documentoEgresoId, primero.documentos[0].documentoEgresoId);
    assert.equal(segundo.documentos[0].duplicado, true);
    const doc = await db.documentoEgreso.findUniqueOrThrow({ where: { id: primero.documentos[0].documentoEgresoId } });
    assert.equal(doc.contextoUsuario, "Villas. Lo pagué yo.");
    assert.equal(doc.loteId, segundo.loteId, "queda en el lote de la última subida");
    assert.equal((doc.contextosAdicionales as { texto: string }[]).at(-1)?.texto, "Otro contexto");
    assert.equal(await db.trabajoProcesamientoDocumento.count(), 1);
  });

  test("El mismo archivo en otra Empresa es un documento independiente", async () => {
    const bytes = png("multiempresa");
    const propio = await subirDocumentosEgreso(admin, archivo(bytes));
    const ajeno = await subirDocumentosEgreso(adminAjeno, archivo(bytes));
    assert.notEqual(propio.documentos[0].documentoEgresoId, ajeno.documentos[0].documentoEgresoId);
    assert.equal(ajeno.documentos[0].duplicado, false);
    assert.equal(await db.documentoEgreso.count(), 2);
  });

  test("Con ARQENTO IA apagada no se sube nada al almacenamiento ni se escribe en la base", async () => {
    await db.empresa.update({ where: { id: EMPRESA }, data: { inteligenciaHabilitada: false } });
    const objetosAntes = almacenamiento.size;
    await assert.rejects(subirDocumentosEgreso(admin, archivo(png("apagada"))), /no está habilitada/);
    assert.equal(almacenamiento.size, objetosAntes);
    assert.equal(await db.documentoEgreso.count(), 0);
  });

  test("Un archivo que no es PDF/JPG/PNG real se rechaza sin subirlo", async () => {
    const objetosAntes = almacenamiento.size;
    await assert.rejects(subirDocumentosEgreso(admin, [{ nombre: "falso.png", tipoMime: "image/png", bytes: Buffer.from("no soy una imagen") }]), /no es un PDF, JPG o PNG/);
    assert.equal(almacenamiento.size, objetosAntes);
    assert.equal(await db.documentoEgreso.count(), 0);
  });
});

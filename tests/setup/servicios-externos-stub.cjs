// Servicios externos SIMULADOS para las pruebas de integración (ver
// tests/setup/integracion.mjs). Nada aquí abre una conexión de red.
// - OpenAI: importarlo no falla, pero cualquier intento de USARLO lanza un
//   error inmediato — una prueba nunca gasta créditos ni llega a la red.
// - Almacenamiento S3/R2: un bucket EN MEMORIA dentro del proceso de pruebas
//   (PutObject/GetObject), para probar flujos que suben y leen archivos sin
//   credenciales reales de R2. Las URLs firmadas siguen deshabilitadas.

class ServicioExternoDeshabilitado extends Error {
  constructor(nombre) {
    super(`Servicio externo deshabilitado en pruebas de integración: ${nombre}.`);
  }
}

const fallar = (nombre) => () => {
  throw new ServicioExternoDeshabilitado(nombre);
};

class OpenAI {
  constructor() {
    this.responses = { parse: fallar("OpenAI"), create: fallar("OpenAI") };
    this.chat = { completions: { create: fallar("OpenAI") } };
  }
}

class Comando {
  constructor(input) {
    this.input = input;
  }
}
class PutObjectCommand extends Comando {}
class GetObjectCommand extends Comando {}
class DeleteObjectCommand extends Comando {}
class HeadObjectCommand extends Comando {}

// Un solo bucket simulado por proceso de pruebas.
const objetos = new Map();

class S3Client {
  async send(comando) {
    const { Key, Body } = comando.input ?? {};
    if (comando instanceof PutObjectCommand) {
      objetos.set(Key, Buffer.from(Body));
      return {};
    }
    if (comando instanceof GetObjectCommand) {
      const bytes = objetos.get(Key);
      if (!bytes) throw new Error(`Objeto inexistente en el almacenamiento simulado: ${Key}`);
      return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
    }
    if (comando instanceof DeleteObjectCommand) {
      objetos.delete(Key);
      return {};
    }
    if (comando instanceof HeadObjectCommand) {
      if (!objetos.has(Key)) throw new Error("NotFound");
      return {};
    }
    throw new ServicioExternoDeshabilitado("almacenamiento S3/R2 (operación no simulada)");
  }
}

module.exports = {
  __esModule: true,
  default: OpenAI,
  OpenAI,
  zodTextFormat: fallar("OpenAI (zodTextFormat)"),
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  getSignedUrl: () => Promise.reject(new ServicioExternoDeshabilitado("URL firmada S3/R2")),
  ServicioExternoDeshabilitado,
  // Solo para pruebas: inspeccionar el bucket simulado.
  __objetosSimulados: objetos,
};

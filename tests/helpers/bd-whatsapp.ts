import { db } from "@/lib/server/db";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@/lib/generated/prisma/client";

// Base de datos SIMULADA en memoria para la vinculación de WhatsApp (Fase 1
// WhatsApp + ARQENTO IA): implementa solo las consultas que usan esos
// servicios, con transacciones que se revierten si fallan, filtros por
// relación (usuario/empresa/vínculo) y los índices únicos de la migración
// (wamid, codigoHash, remitenteHash y los PARCIALES de vínculos vigentes).
// Nunca toca una base real; se instala sobre `db` y se restaura con
// `restaurar()`.

type Fila = Record<string, unknown>;
const contextoTx = new AsyncLocalStorage<{ liberar: (() => void)[] }>();

export type Usuario = { id: string; nombre: string; rol: string; activo: boolean; empresaId: string | null; whatsappAutorizado: boolean };
export type Empresa = { id: string; nombre: string; activa: boolean; whatsappHabilitado: boolean; inteligenciaHabilitada: boolean };

export function crearBdWhatsapp(inicial: { usuarios: Usuario[]; empresas: Empresa[] }) {
  const t = {
    usuarios: inicial.usuarios.map((u) => ({ ...u })),
    empresas: inicial.empresas.map((e) => ({ ...e })),
    vinculos: [] as Fila[],
    codigos: [] as Fila[],
    sesiones: [] as Fila[],
    mensajes: [] as Fila[],
    auditorias: [] as Fila[],
  };
  let siguiente = 1;
  let fallarEn: string | null = null;
  const bloqueos: string[] = [];
  const id = (prefijo: string) => `${prefijo}-${siguiente++}`;

  const relacion = (tabla: string, fila: Fila, nombre: string): Fila | null | undefined => {
    if (nombre === "usuario") return t.usuarios.find((u) => u.id === fila.usuarioId) as Fila | undefined;
    if (nombre === "empresa") return t.empresas.find((e) => e.id === fila.empresaId) as Fila | undefined;
    if (nombre === "vinculo") return t.vinculos.find((v) => v.id === fila.vinculoId);
    void tabla;
    return undefined;
  };

  function coincide(tabla: string, fila: Fila, where: Fila | undefined): boolean {
    for (const [k, cond] of Object.entries(where ?? {})) {
      if (k === "OR") {
        if (!(cond as Fila[]).some((w) => coincide(tabla, fila, w))) return false;
        continue;
      }
      if (["usuario", "empresa", "vinculo"].includes(k)) {
        const rel = relacion(tabla, fila, k);
        if (!rel || !coincide(k, rel, cond as Fila)) return false;
        continue;
      }
      const v = fila[k];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
        if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
        if ("not" in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
        if ("gte" in c && !((v as Date) >= (c.gte as Date))) return false;
        if ("gt" in c && !((v as Date) > (c.gt as Date))) return false;
        if ("lt" in c && !((v as Date) < (c.lt as Date))) return false;
        if ("lte" in c && !((v as Date) <= (c.lte as Date))) return false;
        continue;
      }
      if (cond === null ? !(v === null || v === undefined) : v !== cond) return false;
    }
    return true;
  }

  const unico = (mensaje: string) => new Prisma.PrismaClientKnownRequestError(mensaje, { code: "P2002", clientVersion: "simulado" });
  function verificarUnicos() {
    const vigentes = t.vinculos.filter((v) => v.estado !== "REVOCADO");
    const porUsuario = new Set<unknown>();
    const porTelefono = new Set<string>();
    for (const v of vigentes) {
      if (porUsuario.has(v.usuarioId)) throw unico("vinculos_whatsapp_usuario_vigente_unico");
      porUsuario.add(v.usuarioId);
      const clave = `${v.empresaId}|${v.telefonoE164}`;
      if (porTelefono.has(clave)) throw unico("vinculos_whatsapp_telefono_empresa_vigente_unico");
      porTelefono.add(clave);
    }
  }
  const escribir = (op: string) => {
    if (fallarEn === op) throw new Error(`Falla simulada en ${op}`);
  };
  const ordenar = (filas: Fila[], orderBy?: Fila | Fila[]) => {
    const criterios = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...filas].sort((a, b) => {
      for (const c of criterios) {
        const [campo, dir] = Object.entries(c)[0] as [string, string];
        const va = a[campo] as number, vb = b[campo] as number;
        if (va === vb) continue;
        const r = (va ?? 0) < (vb ?? 0) ? -1 : 1;
        return dir === "desc" ? -r : r;
      }
      return 0;
    });
  };
  const actualizar = (fila: Fila, data: Fila) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Fila)) fila[k] = ((fila[k] as number) ?? 0) + ((v as Fila).increment as number);
      else if (v !== undefined) fila[k] = v;
    }
    fila.updatedAt = new Date();
    return fila;
  };
  const conRelaciones = (tabla: string, fila: Fila, include?: Fila): Fila => {
    const copia: Fila = { ...fila };
    for (const [nombre, sub] of Object.entries(include ?? {})) {
      if (nombre === "vinculosWhatsapp") {
        const w = (sub as Fila).where as Fila | undefined;
        copia.vinculosWhatsapp = t.vinculos.filter((v) => v.usuarioId === fila.id && coincide("vinculos", v, w)).map((v) => ({ ...v }));
        continue;
      }
      const rel = relacion(tabla, fila, nombre);
      const subInclude = (sub as Fila)?.include as Fila | undefined;
      copia[nombre] = rel ? conRelaciones(nombre, rel, subInclude) : null;
    }
    return copia;
  };
  const relacionesDeSelect = (select?: Fila): Fila | undefined => {
    if (!select) return undefined;
    const inc: Fila = {};
    for (const [k, v] of Object.entries(select)) if (v && typeof v === "object") inc[k] = (v as Fila).select ? { include: relacionesDeSelect((v as Fila).select as Fila), where: (v as Fila).where } : v;
    return inc;
  };

  function modelo(tabla: keyof typeof t, nombreTabla: string, opciones: { unicos?: string[] } = {}) {
    const filas = () => t[tabla] as Fila[];
    const leer = (fila: Fila | undefined, args: Fila) => (fila ? conRelaciones(nombreTabla, fila, (args.include as Fila) ?? relacionesDeSelect(args.select as Fila)) : null);
    return {
      findUnique: async (args: Fila) => leer(filas().find((f) => coincide(nombreTabla, f, args.where as Fila)), args),
      findUniqueOrThrow: async (args: Fila) => {
        const f = filas().find((x) => coincide(nombreTabla, x, args.where as Fila));
        if (!f) throw new Error("No encontrado");
        return leer(f, args);
      },
      findFirst: async (args: Fila = {}) => leer(ordenar(filas().filter((f) => coincide(nombreTabla, f, args.where as Fila)), args.orderBy as Fila)[0], args),
      findMany: async (args: Fila = {}) =>
        ordenar(filas().filter((f) => coincide(nombreTabla, f, args.where as Fila)), args.orderBy as Fila)
          .slice(0, (args.take as number) ?? undefined)
          .map((f) => leer(f, args)),
      count: async (args: Fila = {}) => filas().filter((f) => coincide(nombreTabla, f, args.where as Fila)).length,
      create: async (args: Fila) => {
        escribir(`${nombreTabla}.create`);
        const data = args.data as Fila;
        for (const campo of opciones.unicos ?? []) if (filas().some((f) => f[campo] === data[campo])) throw unico(`${nombreTabla}_${campo}_key`);
        const nueva: Fila = { id: id(nombreTabla), createdAt: new Date(), updatedAt: new Date(), ...defaults(nombreTabla), ...data };
        filas().push(nueva);
        if (tabla === "vinculos") verificarUnicos();
        return { ...nueva };
      },
      update: async (args: Fila) => {
        escribir(`${nombreTabla}.update`);
        const fila = filas().find((f) => coincide(nombreTabla, f, args.where as Fila));
        if (!fila) throw new Error(`No existe ${nombreTabla}`);
        actualizar(fila, args.data as Fila);
        if (tabla === "vinculos") verificarUnicos();
        return { ...fila };
      },
      updateMany: async (args: Fila) => {
        escribir(`${nombreTabla}.updateMany`);
        const seleccion = filas().filter((f) => coincide(nombreTabla, f, args.where as Fila));
        for (const f of seleccion) actualizar(f, args.data as Fila);
        return { count: seleccion.length };
      },
      deleteMany: async (args: Fila = {}) => {
        escribir(`${nombreTabla}.deleteMany`);
        const borrar = filas().filter((f) => coincide(nombreTabla, f, args.where as Fila));
        (t[tabla] as Fila[]) = filas().filter((f) => !borrar.includes(f));
        return { count: borrar.length };
      },
      upsert: async (args: Fila) => {
        escribir(`${nombreTabla}.upsert`);
        const fila = filas().find((f) => coincide(nombreTabla, f, args.where as Fila));
        if (fila) return { ...actualizar(fila, args.update as Fila) };
        const nueva: Fila = { id: id(nombreTabla), createdAt: new Date(), updatedAt: new Date(), ...(args.create as Fila) };
        filas().push(nueva);
        return { ...nueva };
      },
    };
  }
  function defaults(tabla: string): Fila {
    if (tabla === "vinculos") return { estado: "PENDIENTE", waId: null, verificadoEn: null, revocadoEn: null, revocadoPorId: null, motivoRevocacion: null };
    if (tabla === "codigos") return { usadoEn: null, invalidadoEn: null, intentosFallidos: 0 };
    if (tabla === "mensajes") return { estadoProceso: "PENDIENTE", resultado: null, intentos: 0, error: null, respondido: false, vinculoId: null, empresaId: null, usuarioId: null, procesadoEn: null, etapaArchivo: null, archivoPendiente: null, documentoEgresoId: null };
    return {};
  }

  const delegados = {
    usuario: modelo("usuarios", "usuario"),
    empresa: modelo("empresas", "empresa"),
    vinculoWhatsapp: modelo("vinculos", "vinculos"),
    codigoVinculacionWhatsapp: modelo("codigos", "codigos", { unicos: ["codigoHash"] }),
    sesionWhatsapp: modelo("sesiones", "sesiones", { unicos: ["remitenteHash"] }),
    mensajeWhatsapp: modelo("mensajes", "mensajes", { unicos: ["wamid"] }),
    registroAuditoria: {
      create: async ({ data }: { data: Fila }) => {
        escribir("auditoria");
        t.auditorias.push(data);
        return data;
      },
    },
  };

  const clonar = () => JSON.parse(JSON.stringify(t), (k, v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v));
  const cliente = db as unknown as Record<string, unknown>;
  const originales: [Record<string, unknown>, string, unknown][] = [];
  const sustituir = (destino: Record<string, unknown>, metodo: string, impl: unknown) => {
    originales.push([destino, metodo, destino[metodo]]);
    destino[metodo] = impl;
  };
  for (const [nombre, metodos] of Object.entries(delegados)) {
    const destino = cliente[nombre] as Record<string, unknown>;
    for (const [metodo, impl] of Object.entries(metodos)) sustituir(destino, metodo, impl);
  }
  // Bloqueos de fila (SELECT … FOR UPDATE): como en PostgreSQL, una segunda
  // transacción espera a que la primera termine. Cada transacción simulada
  // lleva su contexto en AsyncLocalStorage para saber qué bloqueos son suyos.
  const filasBloqueadas = new Map<string, { dueno: object; liberada: Promise<void> }>();
  sustituir(cliente, "$queryRaw", async (partes: TemplateStringsArray, ...valores: unknown[]) => {
    const sql = partes.join("?");
    bloqueos.push(`${sql} [${valores.join(",")}]`);
    const ctx = contextoTx.getStore();
    if (ctx && sql.includes("FOR UPDATE")) {
      const clave = `${sql}|${valores.join(",")}`;
      for (let b = filasBloqueadas.get(clave); b && b.dueno !== ctx; b = filasBloqueadas.get(clave)) await b.liberada;
      if (!filasBloqueadas.has(clave)) {
        let liberar!: () => void;
        filasBloqueadas.set(clave, { dueno: ctx, liberada: new Promise<void>((r) => (liberar = r)) });
        ctx.liberar.push(() => {
          filasBloqueadas.delete(clave);
          liberar();
        });
      }
    }
    return [];
  });
  sustituir(cliente, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) => {
    const respaldo = clonar();
    const ctx = { liberar: [] as (() => void)[] };
    try {
      return await contextoTx.run(ctx, () => fn(db));
    } catch (error) {
      Object.assign(t, respaldo);
      throw error;
    } finally {
      for (const liberar of ctx.liberar) liberar();
    }
  });

  return {
    t,
    bloqueos,
    fallarEn: (op: string | null) => (fallarEn = op),
    restaurar: () => {
      for (const [destino, metodo, original] of originales.reverse()) destino[metodo] = original;
    },
  };
}

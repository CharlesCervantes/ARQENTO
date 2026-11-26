import "server-only";
import { db } from "@/lib/server/db";
import type { UsuarioSesion } from "@/lib/server/session";

/**
 * El plan de la Empresa decide qué módulos existen para ella (independiente
 * del rol), pero Master (Portal Master → Empresas → Módulos) puede otorgar
 * un override explícito por tenant sobre ese Plan — en cualquier sentido:
 * conceder un módulo que el Plan no incluye, o apagar uno que sí incluye
 * (EmpresaModulo.habilitado). Único punto de resolución: si existe un
 * override para esa Empresa+módulo, manda sobre el Plan; si no existe, se
 * hereda el Plan tal cual. Nada fuera de esta función debe conocer si el
 * acceso viene del Plan o de un override (decisión de sesión, Portal
 * Master/Empresas). Ver /docs/arquitectura/00-decisiones-fundamentales.md.
 */
export function empresaTieneModulo(
  usuario: UsuarioSesion,
  moduloClave: string
): boolean {
  if (usuario.rol === "MASTER") return true; // rol de plataforma, cruza tenants
  const override = usuario.empresa?.modulosOverride?.find(
    (em) => em.modulo.clave === moduloClave
  );
  if (override) return override.habilitado;
  const modulos = usuario.empresa?.plan?.modulos ?? [];
  return modulos.some((pm) => pm.modulo.clave === moduloClave);
}

export function esMaster(usuario: UsuarioSesion): boolean {
  return usuario.rol === "MASTER";
}

/**
 * «Inicio» (panel ejecutivo /dashboard) es un módulo más del catálogo desde
 * noviembre 2026: Master lo habilita o deshabilita por Empresa. Sin Inicio,
 * /dashboard (login, logo) envía al primer módulo que el usuario puede usar
 * — nunca consulta datos de obras.
 */
export const MODULO_INICIO = "inicio";

export function puedeVerInicio(usuario: UsuarioSesion): boolean {
  return Boolean(usuario.empresa) && empresaTieneModulo(usuario, MODULO_INICIO);
}

// Orden fijo del sidebar — Inicio primero (si la Empresa lo tiene), luego
// Reporte General y Proyectos, en ese orden (decisión de sesión, septiembre
// 2026). El resto conserva el orden que ya traía el catálogo (sort estable:
// una clave sin prioridad explícita nunca se reordena entre sí misma y las
// demás sin prioridad).
const PRIORIDAD_NAV: Record<string, number> = {
  inicio: -1,
  reporte_general: 0,
  control_de_obra: 1,
};

// Techo de ROL por módulo, además de si la Empresa lo tiene contratado — un
// módulo cuya pantalla ya bloquea a Supervisor (ej. Contabilidad, Compras,
// Catálogos) tampoco debe aparecer en el sidebar para ese rol: antes se veía
// el enlace y solo al entrar aparecía "No tienes permiso" (bug reportado,
// septiembre 2026). Una clave sin entrada aquí no tiene techo de rol propio
// (Reporte General, Proyectos, Gastos — visibles a los 4 roles, cada uno
// filtra por su cuenta lo que cada quien puede hacer adentro).
const PERMISO_MODULO: Record<string, (usuario: UsuarioSesion) => boolean> = {
  catalogos: puedeAdministrarCatalogos,
  contabilidad: puedeVerContabilidad,
  compras: puedeAutorizarOrdenesCompra,
  comercializacion: puedeUsarComercializacion,
};

// Único punto de construcción de "qué módulos ve este usuario en la nav" —
// recorre TODO el catálogo de Modulo (no solo lo que trae el Plan) y filtra
// con empresaTieneModulo, así un override de Portal Master que CONCEDE un
// módulo fuera del Plan también aparece. Antes, el nav global
// (app/(app)/layout.tsx) leía usuario.empresa.plan.modulos directo, sin
// pasar por empresaTieneModulo — un override que apagara o encendiera un
// módulo específico por Empresa no tenía ningún efecto visual en el sidebar
// (bug encontrado en sesión, Gastos transversal, septiembre 2026). Centraliza
// la resolución aquí para que ninguna otra pantalla necesite reimplementar
// este mismo recorrido.
export async function obtenerModulosVisibles(
  usuario: UsuarioSesion
): Promise<{ clave: string; nombre: string }[]> {
  const catalogo = await db.modulo.findMany({ select: { clave: true, nombre: true } });
  return catalogo
    .filter((m) => empresaTieneModulo(usuario, m.clave))
    .filter((m) => (PERMISO_MODULO[m.clave] ?? (() => true))(usuario))
    .sort((a, b) => (PRIORIDAD_NAV[a.clave] ?? Infinity) - (PRIORIDAD_NAV[b.clave] ?? Infinity));
}

/**
 * Administrar el catálogo de proyectos (crear/editar/cambiar estatus) es
 * exclusivo de Administrador/Director/Master — el Supervisor puede consultar
 * pero no administra (04-modulo-control-de-obra.md, sección 4).
 */
export function puedeAdministrarProyectos(usuario: UsuarioSesion): boolean {
  return (
    usuario.rol === "ADMINISTRADOR" ||
    usuario.rol === "DIRECTOR" ||
    usuario.rol === "MASTER"
  );
}

/**
 * Elegir qué obras puede ver cada Supervisor — solo Administrador/Director de
 * la Empresa (Master es plataforma y no opera el tenant).
 */
export function puedeAsignarObras(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/**
 * Eliminar un proyecto (borrado en cascada, irreversible) es más restrictivo
 * que administrarlo — a propósito no incluye MASTER (decisión de sesión,
 * agosto 2026: el rol de plataforma no debe poder borrar datos de un tenant
 * casualmente desde esta pantalla).
 */
export function puedeEliminarProyectos(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/**
 * Eliminar una Partida o un Concepto de Contrato General — mismo criterio
 * restringido que eliminar proyectos/catálogos: es irreversible cuando no
 * hay historial (borrado real) y afecta presupuesto/contrato cuando sí lo
 * hay (queda cancelado), así que sigue el mismo rol-set sin Master (Eliminar
 * Partidas/Conceptos, septiembre 2026).
 */
export function puedeEliminarEstructuraContractual(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/** Proponer partidas/conceptos en Contrato General; quedan por aprobar. */
export function puedeProponerContrato(usuario: UsuarioSesion): boolean {
  return usuario.rol === "SUPERVISOR";
}

/** Aprobar o rechazar lo propuesto: cambia el contrato. Sin Master. */
export function puedeResolverPropuestas(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/** Aprobar avance que excede lo contratado (amplía el contrato). Sin Master. */
export function puedeAprobarExcedente(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/**
 * Asignar o quitar conceptos en el contrato de un contratista. Incluye al
 * Supervisor (en sus obras); crear contratistas y contratos no.
 */
export function puedeAsignarConceptos(usuario: UsuarioSesion): boolean {
  return usuario.rol === "SUPERVISOR" || puedeAdministrarProyectos(usuario);
}

/**
 * Cerrar/reabrir una semana de Avance de Obra genera y toca movimientos
 * financieros reales en Reporte General — mismo rol-set restringido que
 * eliminar proyectos, sin Master (decisión de sesión, agosto 2026).
 */
export function puedeCerrarSemana(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

// Reabrir toca lo mismo financieramente sensible que cerrar — mismo rol-set,
// no se relaja para nadie más.
export function puedeReabrirSemana(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Reportar avance físico semanal es explícito por rol (no "cualquier usuario
 * activo") para que un rol nuevo en el futuro no reciba este permiso por
 * defecto — debe agregarse aquí a propósito (decisión de sesión, agosto 2026).
 */
export function puedeReportarAvance(usuario: UsuarioSesion): boolean {
  return (
    usuario.rol === "SUPERVISOR" ||
    usuario.rol === "ADMINISTRADOR" ||
    usuario.rol === "DIRECTOR" ||
    usuario.rol === "MASTER"
  );
}

/**
 * Techo de ROL para toda la capa privada (Contrato General Privado, Cliente
 * Priv./Control Contractual, Recibos financieros) — exclusivo de
 * Administrador/Director. Deliberadamente NO es puedeAdministrarProyectos
 * (que incluye Master): Master es un rol de plataforma, no un administrador
 * operativo de una empresa, y no debe obtener acceso a la capa privada de
 * una empresa por este mecanismo — ese alcance se define más adelante, con
 * Administración de Empresas/Master (decisión de sesión, agosto 2026 — Vista
 * Privada). También decide si el switch "Vista privada" existe siquiera
 * para este usuario (Mi perfil → Privacidad).
 */
export function puedeConfigurarVistaPrivada(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/**
 * Único punto de verdad de "¿tiene HOY acceso a la capa privada?": combina
 * tres condiciones, las tres obligatorias (AND, nunca una sustituye a otra):
 * 1) el permiso real de rol (nunca cambia); 2) la preferencia personal Vista
 * privada, que un Administrador/Director puede apagar temporalmente desde Mi
 * perfil para presentar el sistema sin riesgo de mostrar información
 * sensible — sin tocar su rol ni sus permisos operativos; 3) que la Empresa
 * misma tenga la capacidad Privada contratada (Empresa.privadoHabilitado,
 * Portal Master). Supervisor y Master nunca pasan de la condición 1, sin
 * importar el valor guardado en BD (decisión de sesión, agosto 2026 — Vista
 * Privada); ninguna Empresa nueva pasa de la condición 3 hasta que Master la
 * habilite explícitamente (decisión de sesión, Portal Master/Empresas).
 */
export function puedeVerInformacionPrivada(usuario: UsuarioSesion): boolean {
  return (
    puedeConfigurarVistaPrivada(usuario) &&
    usuario.vistaPrivadaActiva &&
    (usuario.empresa?.privadoHabilitado ?? false)
  );
}

/**
 * Contrato General Privado (Indirectos, Herramienta, % utilidad/administración,
 * precio final al cliente, márgenes comerciales) — nombre propio para dejar
 * explícito qué protege esta verificación (04-modulo-control-de-obra.md,
 * sección 49.9). Supervisor SÍ ve el Contrato General operativo (presupuesto
 * de contratista y materiales, cantidades, avance) — lo que no ve es esto.
 */
export function puedeVerContratoGeneralPrivado(usuario: UsuarioSesion): boolean {
  return puedeVerInformacionPrivada(usuario);
}

/**
 * Capturar la cantidad/importe estimado PRIVADO de una semana, independiente
 * del avance físico (noviembre 2026). Es información de la capa privada: mismo
 * techo que verla (Administrador/Director con Vista privada y Empresa con
 * Privado habilitado). Supervisor y Master nunca pasan.
 */
export function puedeCapturarEstimadoPrivado(usuario: UsuarioSesion): boolean {
  return puedeVerInformacionPrivada(usuario);
}

/**
 * Recibos financieros (expediente de contratista: estimado/pagado acumulado,
 * saldo, historial de cortes/estimaciones, generar/ver/subir evidencia de
 * recibo) — deliberadamente SIN exigir Vista privada (mismo criterio que
 * puedeVerFinancieroClienteOperativo/puedeRegistrarMovimientoFinancieroClienteOperativo,
 * corregido en sesión: una obra sin capa privada, o un Administrador/Director
 * con Vista privada apagada, sigue necesitando ver y generar las estimaciones
 * de sus contratistas sin depender de ese interruptor — septiembre 2026). El
 * rol-set no cambia (ADMINISTRADOR/DIRECTOR, igual que puedeCerrarSemana):
 * Supervisor sigue sin ver precios de recibo ni poder generar/subir nada.
 */
export function puedeVerRecibosFinancieros(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Emitir una Estimación Cliente la congela para siempre — mismo criterio
 * financieramente sensible que cerrar/reabrir semana y eliminar proyectos,
 * sin Master (04-modulo-control-de-obra.md, sección "Cliente"). Ya NO exige
 * Vista privada activa (cambio deliberado, gastos cobrables en Estimación
 * Cliente, agosto 2026): una obra sin capa privada (Vista Privada
 * permanentemente apagada, o el proyecto nunca la usa) debe poder emitir
 * desde Cliente normal sin depender de ese interruptor — respaldado por
 * 04-modulo-control-de-obra.md sección 49.9, que ya documenta que el %
 * Administración (a diferencia de %Utilidad de Precio Alzado) es visible
 * para el cliente, no es margen oculto. Quién puede emitir no cambia (sigue
 * siendo exclusivamente ADMINISTRADOR/DIRECTOR vía puedeCerrarSemana, Master
 * sigue excluido) — solo deja de requerir el toggle.
 */
export function puedeEmitirEstimacionCliente(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Materializar retroactivamente la EstimacionCliente de una semana que ya
 * estaba cerrada antes de que este módulo existiera — mismo criterio
 * financieramente sensible que cerrar semana/emitir, sin Master
 * (04-modulo-control-de-obra.md, sección "Cliente"). Respeta Vista privada
 * y la capacidad Privada de Empresa, igual que puedeVerInformacionPrivada.
 */
export function puedeMaterializarEstimacionHistorica(usuario: UsuarioSesion): boolean {
  return (
    puedeCerrarSemana(usuario) &&
    usuario.vistaPrivadaActiva &&
    (usuario.empresa?.privadoHabilitado ?? false)
  );
}

/**
 * Ver Control Contractual — información financiera del cliente (fondo/
 * cuentas por cobrar, aportaciones, pagos), capa Privada: mismo rol-set que
 * el resto de la capa privada de Contrato General (04-modulo-control-de-obra.md,
 * sección "Control Contractual").
 */
export function puedeVerFinancieroCliente(usuario: UsuarioSesion): boolean {
  return puedeVerContratoGeneralPrivado(usuario);
}

/**
 * Igual que puedeVerFinancieroCliente, pero para la capa Cliente (operativo)
 * — deliberadamente SIN exigir Vista privada (mismo criterio que
 * puedeEmitirEstimacionCliente): una obra sin capa privada necesita ver su
 * propio pendiente por cobrar/fondo sin depender de ese interruptor. El
 * rol-set no cambia (ADMINISTRADOR/DIRECTOR, sin Master) — gastos cobrables
 * en Estimación Cliente, agosto 2026.
 */
export function puedeVerFinancieroClienteOperativo(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Registrar movimientos financieros del cliente (aportación al fondo, pago de
 * una estimación) — mismo criterio financieramente sensible que cerrar
 * semana/emitir/materializar histórico, sin Master. Respeta Vista privada y
 * la capacidad Privada de Empresa, igual que puedeVerInformacionPrivada.
 */
export function puedeRegistrarMovimientoFinancieroCliente(usuario: UsuarioSesion): boolean {
  return (
    puedeCerrarSemana(usuario) &&
    usuario.vistaPrivadaActiva &&
    (usuario.empresa?.privadoHabilitado ?? false)
  );
}

/**
 * Igual que puedeRegistrarMovimientoFinancieroCliente, pero para la capa
 * Cliente (operativo) — deliberadamente SIN exigir Vista privada (mismo
 * criterio que puedeVerFinancieroClienteOperativo/puedeEmitirEstimacionCliente):
 * una obra sin capa privada necesita poder registrar pagos y aplicar fondo
 * contra su propia estimación Operativo sin depender de ese interruptor. El
 * rol-set no cambia (ADMINISTRADOR/DIRECTOR, sin Master) — arquitectura por
 * capas, agosto 2026.
 */
export function puedeRegistrarMovimientoFinancieroClienteOperativo(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Capturar/editar Gastos de Obra, subir evidencia, solicitar Órdenes de
 * Compra — operativo, mismo rol-set amplio que reportar avance (Supervisor
 * incluido). 04-modulo-control-de-obra.md, sección "Gastos de Obra".
 */
export function puedeCapturarGastos(usuario: UsuarioSesion): boolean {
  return puedeReportarAvance(usuario);
}

/**
 * Aprobar/rechazar Gastos, crear y aprobar Reposiciones de cualquier
 * beneficiario — financieramente sensible, mismo criterio que cerrar
 * semana/emitir estimación (sin Master).
 */
/**
 * El Supervisor solo registra gastos que pagó él mismo (noviembre 2026,
 * decisión de Charles): no elige quién pagó, el servidor lo fija a su
 * beneficiario vinculado. Administrador y Director sí eligen (la empresa,
 * ellos mismos u otra persona).
 */
export function capturaSoloGastosPropios(usuario: UsuarioSesion): boolean {
  return usuario.rol === "SUPERVISOR";
}

export function puedeAprobarGastos(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Autorizar Órdenes de Compra — mismo criterio que puedeAprobarGastos.
 */
export function puedeAutorizarOrdenesCompra(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

/**
 * Capturar/editar un Gasto de una CATEGORÍA específica — Gastos transversal,
 * septiembre 2026. Extiende puedeCapturarGastos (el techo de rol de siempre)
 * con un segundo eje, por dato: las categorías marcadas sensibles en
 * lib/control-de-obra/categorias-gasto.ts (Nómina, Renta, Impuestos,
 * Servicios de Empresa) exigen además puedeAprobarGastos — un Supervisor
 * sigue capturando cualquier categoría operativa (obra completa, y de
 * Empresa: gasolina/papelería/viáticos) exactamente igual que hoy, pero no
 * puede registrar categorías financieras sensibles de Empresa aunque tenga
 * el permiso general de capturar gastos. La sensibilidad es dato del
 * catálogo (una sola fuente), nunca un segundo hardcode por rol aquí.
 * Server-side siempre — nunca basta con ocultar la opción en el <select>.
 */
export function puedeCapturarCategoriaGasto(
  usuario: UsuarioSesion,
  categoriaEsSensible: boolean
): boolean {
  if (!puedeCapturarGastos(usuario)) return false;
  if (categoriaEsSensible) return puedeAprobarGastos(usuario);
  return true;
}

/**
 * Ver el listado/desglose de Gastos de Empresa en categorías sensibles
 * (Nómina, Renta, Impuestos, Servicios de Empresa) — mismo rol-set que
 * capturarlas (puedeAprobarGastos: Administrador/Director). Un Supervisor
 * sin este permiso sigue viendo el total de Gastos de Empresa y sus propias
 * categorías operativas, pero las filas/montos sensibles se omiten de la
 * lectura, no solo se ocultan en la UI (Gastos transversal, septiembre
 * 2026).
 */
export function puedeVerGastosEmpresaSensibles(usuario: UsuarioSesion): boolean {
  return puedeAprobarGastos(usuario);
}

/**
 * Crear/editar/activar/desactivar una plantilla de Gasto Recurrente —
 * definir una obligación recurrente es más sensible que capturar un gasto
 * puntual, así que exige el mismo techo que aprobar gastos (Administrador/
 * Director). Un Supervisor puede seguir interactuando con una OCURRENCIA ya
 * generada (completar el monto variable, mandarla a revisión) exactamente
 * con los mismos permisos que cualquier otro GastoObra — solo la plantilla
 * en sí queda fuera de su alcance (Gastos transversal, septiembre 2026).
 */
export function puedeAdministrarGastosRecurrentes(usuario: UsuarioSesion): boolean {
  return puedeAprobarGastos(usuario);
}

/**
 * Registrar un abono (pago parcial) contra una Reposición — mismo nivel de
 * autorización que liquidar un pago: es un evento financiero real, nunca
 * algo que un Supervisor pueda declarar (Gastos transversal, septiembre
 * 2026).
 */
export function puedeRegistrarAbonoReposicion(usuario: UsuarioSesion): boolean {
  return puedeLiquidarPagos(usuario);
}

/**
 * Techo de acceso a TODO el módulo Contabilidad (Resumen/Ingresos/Egresos/
 * Facturas pendientes/Cuentas) — Administrador/Director únicamente, nunca
 * Master (rol de plataforma, no opera dentro de una Empresa) ni Supervisor,
 * aunque Supervisor siga originando los Gastos que Contabilidad después
 * decora (Contabilidad, septiembre 2026). No se combina con Vista privada —
 * es un dominio distinto de Contrato General Privado/Cliente Priv.
 */
export function puedeVerContabilidad(usuario: UsuarioSesion): boolean {
  return puedeAprobarGastos(usuario);
}

/**
 * Registrar un Ingreso/Egreso (manual o decorando un GastoObra/
 * MovimientoFinancieroCliente existente) — mismo techo que ver el módulo;
 * Administrador/Director capturan ya con nivel de confianza suficiente, sin
 * un paso de aprobación aparte (mismo criterio que Gastos capturados
 * directamente por Admin/Director).
 */
export function puedeRegistrarMovimientoContable(usuario: UsuarioSesion): boolean {
  return puedeVerContabilidad(usuario);
}

/**
 * Cargar un XML/PDF de Factura (CFDI) y vincularlo a un Egreso/Ingreso — es
 * una acción de Contabilidad, no de Gastos: el checkbox "☐ lleva factura" y
 * adjuntar una foto/PDF simple siguen siendo de Supervisor vía
 * puedeCapturarGastos, sin cambio; la factura estructurada exige el mismo
 * techo que el resto del módulo.
 */
export function puedeCargarFacturaCFDI(usuario: UsuarioSesion): boolean {
  return puedeVerContabilidad(usuario);
}

/** Editar datos fiscales ya cargados de una Factura — mismo techo. */
export function puedeEditarDatosFiscales(usuario: UsuarioSesion): boolean {
  return puedeVerContabilidad(usuario);
}

/**
 * Cancelar (nunca eliminar) un Ingreso/Egreso/Factura — mismo criterio que
 * el resto del sistema financiero (ReposicionGastos/ReciboPago: estatus, no
 * DELETE). Mismo techo que el resto del módulo.
 */
export function puedeCancelarRegistroContable(usuario: UsuarioSesion): boolean {
  return puedeVerContabilidad(usuario);
}

/**
 * Configurar Contabilidad: crear/editar MedioFinanciero (incluido saldo
 * inicial) y el default de inclusión contable de la Empresa
 * (Empresa.defaultInclusionContabilidad) — mismo techo que el resto del
 * módulo hoy (Contabilidad — reconocimiento, septiembre 2026). Función
 * independiente desde el inicio para poder restringirse después sin tocar
 * el resto del módulo.
 */
export function puedeConfigurarContabilidad(usuario: UsuarioSesion): boolean {
  return puedeVerContabilidad(usuario);
}

/**
 * Cambiar el flag de inclusión en Contabilidad (eje 1 — ¿esta operación es
 * del ámbito contable/fiscal de la Empresa?) de un GastoObra/
 * EstimacionClienteCapa/MovimientoFinancieroCliente puntual — decisión
 * confirmada explícitamente: hoy mismo techo que puedeVerContabilidad
 * (Administrador/Director), pero se conserva como función independiente
 * para poder restringirlo después (ej. solo Director) sin modificar la
 * lógica del módulo (Contabilidad — reconocimiento, septiembre 2026).
 */
export function puedeMarcarInclusionContable(usuario: UsuarioSesion): boolean {
  return puedeVerContabilidad(usuario);
}

/**
 * Administrar el catálogo global (Proveedores/Contratistas/Personal y el
 * vínculo Usuario↔Beneficiario) — mismo rol-set que administrar proyectos;
 * Supervisor sigue accediendo a catálogos solo a través de los selects ya
 * existentes dentro de Gastos/OC, sin administrar la pantalla propia
 * (04-modulo-control-de-obra.md, sección "Catálogos").
 */
export function puedeAdministrarCatalogos(usuario: UsuarioSesion): boolean {
  return puedeAdministrarProyectos(usuario);
}

/**
 * Eliminar definitivamente un elemento de catálogo (Proveedor/Contratista/
 * Personal) — a diferencia de puedeAdministrarCatalogos (que incluye Master,
 * igual que administrar proyectos), esto es irreversible y borra datos reales
 * de un tenant, así que sigue el mismo criterio restringido que
 * puedeEliminarProyectos: nunca Master (decisión de sesión, agosto 2026).
 */
export function puedeEliminarCatalogo(usuario: UsuarioSesion): boolean {
  return usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR";
}

/**
 * Liquidar un movimiento de Reporte General (marcar PENDIENTE_PAGO como
 * pagado, con evidencia) — financieramente sensible, mismo criterio que
 * cerrar semana/aprobar gastos/autorizar OC: Administrador y Director,
 * nunca Master (rol de plataforma, no participa en la operación financiera
 * de una empresa) ni Supervisor. Sin relación con Vista privada — liquidar
 * no es información privada del cliente, es una acción operativa de pagos.
 */
export function puedeLiquidarPagos(usuario: UsuarioSesion): boolean {
  return puedeCerrarSemana(usuario);
}

// ---------------------------------------------------------------------------
// Comercialización — B1 (noviembre 2026). Ver docs/negocio/comercializacion.md.
// Todas exigen que la Empresa tenga el módulo `comercializacion` (Plan u
// override de Portal Master) — sin él, ninguna pasa, en pantalla ni en
// servidor. Ninguna toca ni reutiliza las funciones de construcción de
// arriba: el Supervisor conserva exactamente sus permisos de obra.
// ---------------------------------------------------------------------------

export const MODULO_COMERCIALIZACION = "comercializacion";

/**
 * Facultades administrativas de Comercialización (catálogo, precios,
 * costos, vendedores) — Administrador y Director de su propia Empresa,
 * siguiendo la jerarquía existente. Nunca Master: rol de plataforma que solo
 * habilita el módulo desde Portal Master, sin operar dentro de una Empresa.
 */
export function esAdministradorComercial(usuario: UsuarioSesion): boolean {
  return (
    (usuario.rol === "ADMINISTRADOR" || usuario.rol === "DIRECTOR") &&
    Boolean(usuario.empresa) &&
    empresaTieneModulo(usuario, MODULO_COMERCIALIZACION)
  );
}

/**
 * Función "Vendedor": rol SUPERVISOR + marca Usuario.vendedorComercial. No es
 * un rol global ni concede nada fuera del módulo. Un Supervisor sin la marca
 * no entra a Comercialización; la marca en otro rol no tiene efecto.
 */
export function esVendedorComercial(usuario: UsuarioSesion): boolean {
  return (
    usuario.rol === "SUPERVISOR" &&
    usuario.vendedorComercial === true &&
    Boolean(usuario.empresa) &&
    empresaTieneModulo(usuario, MODULO_COMERCIALIZACION)
  );
}

/** Entrar al módulo (menú, pantallas, consultas de su alcance). */
export function puedeUsarComercializacion(usuario: UsuarioSesion): boolean {
  return esAdministradorComercial(usuario) || esVendedorComercial(usuario);
}

/** Alta, edición, desactivación y reactivación de productos del catálogo. */
export function puedeAdministrarCatalogoComercial(usuario: UsuarioSesion): boolean {
  return esAdministradorComercial(usuario);
}

/**
 * Costos de referencia, historial de cambios y datos privados del
 * catálogo — nunca para el vendedor (no se seleccionan en sus consultas).
 */
export function puedeVerCostosComerciales(usuario: UsuarioSesion): boolean {
  return esAdministradorComercial(usuario);
}

/**
 * Modificar el precio de venta (en catálogo hoy; en una cotización a partir
 * de B2). Confirmado P2: solo administración, nunca el vendedor.
 */
export function puedeModificarPrecioComercial(usuario: UsuarioSesion): boolean {
  return esAdministradorComercial(usuario);
}

/**
 * Activar/desactivar la marca de vendedor a Supervisores de SU Empresa. No
 * permite cambiar rol, Empresa ni ningún otro permiso (el servicio solo
 * escribe Usuario.vendedorComercial).
 */
export function puedeAsignarVendedoresComerciales(usuario: UsuarioSesion): boolean {
  return esAdministradorComercial(usuario);
}

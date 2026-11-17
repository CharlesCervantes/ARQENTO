# Conkuali — Sistema de Gestión de Obra

@AGENTS.md

## Objetivo del proyecto

Este repositorio contiene el sistema web interno de Grupo Conkuali para centralizar y automatizar la administración y control de sus proyectos de construcción.

## Forma de trabajo

- La rama `main` representa código estable.
- El desarrollo normal se realiza en `develop`.
- No realizar cambios directamente en `main`.
- Antes de implementar una funcionalidad importante, entender primero el flujo de negocio correspondiente.
- No inventar reglas de negocio. Si falta información, preguntar.
- No eliminar información histórica de negocio cuando pueda conservarse mediante estados o bitácora.
- Mantener trazabilidad de operaciones importantes.

## Contexto de negocio

La documentación funcional del sistema se encuentra en `/docs/negocio`.

Antes de trabajar sobre un módulo, consultar los documentos relacionados.

Para tareas de Comercialización, leer `docs/negocio/comercializacion.md` antes de proponer o modificar modelos, permisos, cotizaciones, compras, créditos, pagos, recordatorios o entregas. Distinguir acuerdos confirmados de propuestas y pendientes. Actualizar ese documento con las decisiones aprobadas y el estado real de implementación. No alterar permisos globales ni flujos de construcción para resolver reglas exclusivas de Comercialización.

## Arquitectura

Las decisiones técnicas y de arquitectura se documentan en `/docs/arquitectura`.

No introducir tecnologías, servicios o patrones importantes sin justificar primero su necesidad.

## Desarrollo

- TypeScript.
- Next.js.
- Priorizar código claro, mantenible y simple.
- Separar lógica de negocio, interfaz y acceso a datos.
- Evitar sobrearquitectura.
- No instalar dependencias innecesarias.
- Antes de dar una tarea por terminada, comprobar que el proyecto compila y funciona.
# Plan de trabajo — Reto 3 · Agente "Órdenes de Compra SAP"

## Modo de trabajo

- `main` siempre verde: `npm run typecheck` y `npm test` pasan antes de cada merge.
- Una rama por tarea importante, cada una en su propio `git worktree`; merge a `main` con `--no-ff` para que el historial muestre cada entrega.
- Los contratos compartidos (`src/domain/tipos.ts`, `src/sap/adapter.ts`, `src/domain/maestros.ts`) se fijan en `main` **antes** de abrir ramas. Cada rama toca solo sus archivos, así los merges no chocan.
- Tests con el runner nativo de Node (`node --test` + `tsx`), sin dependencias extra.

## Ramas, roles y archivos

| Fase | Rama | Rol (subagente) | Archivos que posee | Tests |
|---|---|---|---|---|
| 0 | `main` | Arquitecto (orquestador) | `tipos.ts`, `sap/adapter.ts`, `maestros.ts`, base del agente | `test/maestros.test.ts` |
| 1 | `feat/controles` | Ingeniero de reglas de control | `src/domain/paquete.ts`, `src/domain/controles.ts` | `test/paquete.test.ts`, `test/controles.test.ts` |
| 1 | `feat/sap-evidencia` | Ingeniero de integración SAP | `src/domain/payload.ts`, `src/domain/evidencia.ts`, `src/domain/control.ts`, `src/sap/mock.ts` | `test/payload.test.ts`, `test/evidencia.test.ts`, `test/sap-mock.test.ts` |
| 1 | `docs/solucion` | Arquitecto de soluciones / redactor técnico | `agent/prompt.md`, `src/knowledge/ordenes-compra.md`, `SOLUCION.md`, `README.md` | — |
| 2 | `feat/herramientas-oc` | Orquestador (integración) | `src/tools/oc.ts`, `src/tools/index.ts`, `demo.ts` | `test/e2e.test.ts` (6 casos) |
| 3 | `chore/deploy` | Orquestador | `render.yaml` | smoke test del link |
| 4 | — | QA / revisor de código | revisión de `main` | corre todo |

Las tres ramas de la fase 1 trabajan en paralelo. La fase 2 empieza cuando se mergean las tres.

## Resultado esperado por caso (criterio de aceptación de la e2e)

| Caso | apta | Bloqueos | Confirmaciones | Derivados | Retroactiva | Resultado |
|---|---|---|---|---|---|---|
| sol-001 | sí | — | — | — | no | OC 4500000001; segunda ejecución idempotente |
| sol-002 | no | RC1 (NIT 901999000 no existe) | — | — | no | bloqueada |
| sol-003 | no | RC2 (fvargas no aprueba en CC-2020) | — | — | no | bloqueada |
| sol-004 | sí | — | RC5 (25.000.000 vs 26.500.000, 6 %) | — | no | pendiente → creada con `confirmado` |
| sol-005 | sí | — | RC8 (factura 2026-08-10 < solicitud 2026-08-27) | — | **sí** | pendiente → creada con `confirmado`, marcada retroactiva |
| sol-006 | sí | — | RC6 (IVA derivado C1) | IVA C1, pago Z030 | no | pendiente → creada con `confirmado` |

## Decisión clave de diseño

`oc_crear` **no confía en el payload que le pasa el modelo**: vuelve a leer el paquete, revalida y reconstruye el payload en el servidor, y rechaza si lo que envió el modelo difiere en montos, proveedor o centro de costo. Así el modelo no puede "arreglar" un monto (riesgo explícito del PRD, sección 10).

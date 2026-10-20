# Agente "Órdenes de Compra SAP" — Reto 3 · Periferia IT Group

Agente conversacional que procesa solicitudes de orden de compra: lee el paquete que llega por correo (solicitud, cotización, aprobación y, si existe, factura), lo valida contra los maestros y diez reglas de control, muestra la OC como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un SAP simulado. Las excepciones se clasifican (bloqueo / confirmación / derivado) y se devuelven a la analista con una acción sugerida; las OC retroactivas quedan marcadas para medirlas.

El planteamiento completo (arquitectura, ciclo del agente, controles, diseño del adaptador SAP real, decisiones, supuestos, riesgos y uso de IA) está en [`SOLUCION.md`](./SOLUCION.md).

**Link de prueba:** <!-- TODO: URL de Render --> (sin clave de acceso; link público).

## Requisitos

- **Node 20.12 o superior** (usa `process.loadEnvFile` y `fetch` nativo). Desarrollado con Node 22.
- Una clave de [OpenRouter](https://openrouter.ai) para el chat con modelo. **No hace falta** para `npm run demo` ni para `npm test`.

## Instalación y arranque

```bash
npm install
cp .env.example .env        # y pon tu OPENROUTER_API_KEY
npm run dev                 # desarrollo (recarga al guardar)
# o
npm start                   # producción
```

Abre `http://localhost:3000`. Un solo comando levanta front y backend. Si `OPENROUTER_API_KEY` está vacía, el servidor arranca igual y el chat responde con un mensaje claro en vez de fallar.

### Variables de entorno (`.env.example`)

| Variable | Por defecto | Para qué |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Clave del proveedor. Solo vive en el entorno del backend; nunca en el front, el repo, los logs ni las respuestas de la API. |
| `LLM_MODEL` | `openai/gpt-4o-mini` | Modelo: cualquier id del catálogo de OpenRouter (p. ej. `openai/gpt-4o`, o un modelo de Anthropic, Google o Mistral con el id que publica el catálogo). Cambiarlo no toca código. |
| `LLM_TIMEOUT_MS` | `60000` | Timeout por llamada al modelo; al vencer, el chat muestra el error y la sesión sigue viva. |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones herramienta → modelo por turno (CA1). |
| `MAX_TOKENS_SESION` | `200000` | Tope de tokens (entrada + salida) por sesión; al llegar, pide abrir una sesión nueva. |
| `PORT` | `3000` | Puerto HTTP. |

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | `tsx watch src/server.ts`: servidor con recarga. |
| `npm start` | `tsx src/server.ts`: servidor. |
| `npm run demo` | `tsx demo.ts`: procesa los 6 casos de `fixtures/reto-03/solicitudes/` llamando las herramientas **sin modelo ni clave**. Imprime por caso `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC o motivo; ejecuta `sol-001` dos veces (idempotencia) y `sol-004`, `sol-005` y `sol-006` con confirmación explícita; termina imprimiendo `out/control.csv`. Limpia `out/` al inicio; es determinista salvo timestamps. |
| `npm test` | `node --import tsx --test "test/**/*.test.ts"`: tests unitarios y e2e con `node:test`. |
| `npm run typecheck` | `tsc --noEmit` (TypeScript estricto, sin `any`). |
| `npm run modulo` | Regenera `modulo/` (bonus PRD 9.4) desde `agent/prompt.md` y `src/knowledge/`; `test/modulo.test.ts` falla si diverge. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId: string, message: string }` → `{ reply: string, toolCalls: [{ nombre, argumentos, ok, resumen, requiereConfirmacion }], needsConfirmation: boolean }`. El `sessionId` lo genera el cliente (el front usa `crypto.randomUUID()`); un id nuevo abre una sesión nueva. El mensaje se recorta a 4.000 caracteres. |
| `GET` | `/api/sessions/:id` | `{ sessionId, mensajes: [...] }` con el historial completo (user, assistant con sus tool calls, tool), sin el system prompt. `404` si no existe. |
| `GET` | `/api/health` | `{ ok: true, provider: "openrouter", model: "<LLM_MODEL>" }`. Sin claves. |
| `GET` | `/` | El front de chat (`web/index.html`). |

Ejemplo:

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-1","message":"Procesa la solicitud \"sol-004\". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme."}'

curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-1","message":"Confirmo, procede."}'

curl -s http://localhost:3000/api/sessions/demo-1
```

## Prompt de ejemplo para la demo (PRD, sección 11)

En una sesión nueva del chat:

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Resultado esperado: payload resumido en tabla, lista de confirmaciones con los dos valores (solicitud 25.000.000 vs cotización 26.500.000), las llamadas a herramientas visibles en el chat, y una pregunta cerrando el turno (el front la resalta y ofrece "Confirmo" / "No, cancelar"). Tras "confirmo": número de OC y rutas de la evidencia (`out/sol-004/aprobacion.txt`) y la trazabilidad (`out/sol-004/trazabilidad.json`).

Casos disponibles y lo que ejercita cada uno:

| Caso | Qué pasa |
|---|---|
| `sol-001` | Todo en orden → OC creada sin intervención. Repetirla devuelve la misma OC (idempotencia). |
| `sol-002` | Proveedor inexistente (RC1) → bloqueada. |
| `sol-003` | Aprobador sin autoridad en ese centro (RC2) → bloqueada. |
| `sol-004` | Cotización difiere 6 % de la solicitud (RC5) → confirmación. |
| `sol-005` | Factura anterior a la solicitud (RC8) → confirmación y marcada `retroactiva`. |
| `sol-006` | Sin indicador de IVA ni condiciones de pago → derivados del proveedor (RC6 confirmación, RC7 informado). |

## Estructura del repositorio

```
agent/prompt.md                 system prompt (comportamiento)
src/knowledge/ordenes-compra.md conocimiento del proceso (se concatena al prompt)
src/server.ts                   API HTTP (node:http) y arranque
src/agent/loop.ts               ciclo del agente: iteraciones, tokens, confirmación, log
src/llm/adapter.ts              interfaz AdaptadorLLM
src/llm/openrouter.ts           implementación OpenRouter (formato OpenAI)
src/tools/registry.ts           contrato de herramientas (zod), validación, nunca lanza
src/tools/index.ts              registro de módulos de herramientas
src/tools/oc.ts                 herramientas oc_leer_paquete, oc_validar, oc_generar_evidencia,
                                oc_construir_payload, oc_crear
src/domain/tipos.ts             contratos compartidos (zod): maestros, paquete, validación, OrdenCompra
src/domain/maestros.ts          carga de maestros y normalización de NIT / nombre
src/domain/paquete.ts           lectura y parseo del paquete de un caso
src/domain/controles.ts         reglas RC1–RC10 (función pura)
src/domain/payload.ts           construcción de la OC con trazabilidad
src/domain/evidencia.ts         evidencia de aprobación (txt + sha256; pdf opcional)
src/domain/control.ts           log de control out/control.csv
src/sap/adapter.ts              interfaz SapAdapter
src/sap/mock.ts                 SAP simulado sobre out/sap/ordenes.jsonl
web/index.html                  front de chat (HTML plano, sin build)
fixtures/reto-03/               maestros y 6 casos (entregados; no se modifican)
test/                           node:test
demo.ts                         los 6 casos sin modelo
modulo/                         bonus: agent.md, tools/oc.ts y skill/ordenes-compra/SKILL.md
scripts/construir-modulo.ts     genera modulo/ desde las mismas fuentes que usa la app
out/                            generado en ejecución (ignorado por git)
docs/PRD.md · docs/PLAN.md      enunciado y plan de trabajo
.claude/agents/                 roles del equipo (subagentes de Claude Code)
SOLUCION.md · README.md
```

Salidas en `out/`: `<caso>/aprobacion.txt` (y `.pdf` si aplica), `<caso>/trazabilidad.json`, `sap/ordenes.jsonl`, `control.csv`, `log.jsonl`.

## Cómo se trabajó

- **Una rama por tarea, cada una en su `git worktree`** (`feat/controles`, `feat/sap-evidencia`, `docs/solucion`, `feat/herramientas-oc`, `chore/deploy`), con merge `--no-ff` a `main` para que el historial muestre cada entrega. Los contratos compartidos (`src/domain/tipos.ts`, `src/sap/adapter.ts`, `src/domain/maestros.ts`) se fijaron en `main` antes de abrir ramas.
- **Subagentes por rol** en `.claude/agents/` (Claude Code): `ingeniero-controles`, `ingeniero-sap`, `redactor-tecnico` y `qa-revisor`. Cada uno tiene su instructivo con qué leer, qué archivos posee y qué no puede tocar; el QA solo lee y ejecuta.
- `main` siempre verde: `npm run typecheck` y `npm test` antes de cada merge. Detalle y declaración de uso de IA en `SOLUCION.md`, sección 11.

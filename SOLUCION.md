# SOLUCION.md — Agente "Órdenes de Compra SAP" (Reto 3)

Documento de planteamiento de la solución. Sigue la estructura obligatoria de la sección 9.1 del PRD. Donde algo depende de piezas que se integran en la fase 2 (`src/tools/oc.ts`, `demo.ts`, despliegue), queda marcado con `<!-- TODO: verificar al integrar -->`.

---

## 1. Problema

**Cada factura que entra a Periferia obliga a la analista administrativa a digitar a mano en SAP una orden de compra a partir de un correo con un Excel, una cotización y una aprobación, verificando de memoria controles que nadie mide.**

Le duele a la **analista** (digitación repetitiva, error costoso de corregir en cierre), a **contabilidad y auditoría** (la validación de que quien aprueba puede aprobar ese monto en ese centro es mental, no sistemática) y a la **dirección** (no sabe qué porcentaje de OC se crea después de la factura, es decir, sin control previo).

---

## 2. Arquitectura

```
┌───────────────────────────────┐ POST /api/chat {sessionId, message}     ┌────────────────────────────────────────────────────┐
│ FRONT  web/index.html         │ ─────────────────────────────────────▶  │ BACKEND  src/server.ts (node:http, sin framework)  │
│ - historial de la sesión      │ ◀─────────────────────────────────────  │ GET /api/health · GET /api/sessions/:id · GET /    │
│ - cada tool call (nombre,     │ {reply, toolCalls[], needsConfirmation} │                                                    │
│   argumentos, resultado)      │                                         │ src/agent/loop.ts      ciclo del agente (CA1–CA5)  │
│ - resalta "Requiere tu        │                                         │ src/llm/adapter.ts     interfaz AdaptadorLLM       │
│   confirmación" + botones     │                                         │ src/llm/openrouter.ts  implementación (OpenRouter) │
└───────────────────────────────┘                                         │ src/tools/registry.ts  contrato zod, nunca lanza   │
                                                                          └────┬─────────────────────────────────────┬─────────┘
                          system prompt = agent/prompt.md + src/knowledge/*.md │                                     │ fetch
                                                                               ▼                                     ▼
                                                            ┌──────────────────────────────────────┐    ┌─────────────────────────┐
                                                            │ HERRAMIENTAS  src/tools/oc.ts        │    │ OpenRouter              │
                                                            │ oc_leer_paquete · oc_validar         │    │ LLM_MODEL (gpt-4o-mini) │
                                                            │ oc_generar_evidencia                 │    └─────────────────────────┘
                                                            │ oc_construir_payload · oc_crear      │
                                                            └──────────────────┬───────────────────┘
                                                                               ▼
                                                            ┌──────────────────────────────────────┐
                                                            │ DOMINIO  src/domain/                 │
                                                            │ tipos.ts (zod)  maestros.ts          │
                                                            │ paquete.ts  controles.ts (RC1–RC10)  │
                                                            │ payload.ts  evidencia.ts  control.ts │
                                                            │ SAP  src/sap/adapter.ts ← mock.ts    │
                                                            └──────────────────┬───────────────────┘
                                                                               ▼
                                        fixtures/reto-03/ (solo lectura)              out/ (escritura)
                                        maestros/*.json · solicitudes/<caso>/*        <caso>/aprobacion.txt[.pdf] · <caso>/trazabilidad.json
                                                                                      sap/ordenes.jsonl · control.csv · log.jsonl
```

Separación que pide el PRD (6.5):

| Capa | Dónde vive | Qué cambia si cambia |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Cómo conversa el agente, cuándo pregunta, qué formato usa. No toca código. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` (todo `.md` de la carpeta se concatena al prompt, en orden alfabético) | Explicación del proceso, de las reglas y de los campos SAP. No toca código. |
| **Ejecución** | `src/tools/oc.ts` (contrato), `src/domain/*` (reglas puras y I/O), `src/sap/*` (adaptador) | Una regla de negocio nueva se agrega en `controles.ts`; el servidor y el ciclo no cambian. |

Las herramientas son la **única fuente de valores** que el modelo puede afirmar: el modelo orquesta (decide qué llamar y cómo explicarlo); los montos, códigos y rutas salen de código determinista.

Dependencias (PRD sección 8 pide justificarlas):

| Paquete | Tipo | Por qué |
|---|---|---|
| `zod` | runtime | Obligatorio por el PRD para los argumentos de herramientas; también valida maestros, solicitud y `OrdenCompra`. Zod 4 genera el JSON Schema de cada herramienta (`z.toJSONSchema`) sin librería adicional. |
| `tsx` | runtime | Ejecuta TypeScript sin paso de build (`npm start`, `npm run demo`, `node --import tsx --test`). |
| `typescript`, `@types/node` | dev | `npm run typecheck` (`strict`, `noUncheckedIndexedAccess`). |
| `pdf-lib` | runtime, opcional | Solo si se entrega el P1 de HU-4 (evidencia en PDF). <!-- TODO: verificar al integrar --> |

Sin framework web, sin framework de agentes, sin cliente HTTP (se usa `fetch` nativo de Node 20+).

---

## 3. Ciclo del agente (`src/agent/loop.ts`)

La clase `Agente` mantiene las sesiones en memoria (`Map<sessionId, { mensajes, tokensUsados }>`). Cada sesión nace con un único mensaje `system` que es la concatenación de `agent/prompt.md` y `src/knowledge/*.md`. Un turno (`turno(sessionId, mensaje)`) hace lo siguiente:

1. Agrega el mensaje del usuario (el servidor lo recorta a 4.000 caracteres) y toma las definiciones de herramientas del registro (`RegistroHerramientas.definiciones()`, JSON Schema derivado de zod).
2. Itera como máximo `MAX_ITERACIONES` veces (variable de entorno, 25 por defecto; **CA1**). En cada iteración:
   - Si `tokensUsados ≥ MAX_TOKENS_SESION` (200.000 por defecto), cierra el turno con un mensaje claro ("abre una sesión nueva") sin llamar al modelo. Es el tope de costo por sesión que pide el PRD 8.
   - Llama `llm.enviar(mensajes, definiciones)`. Si el proveedor falla (HTTP ≠ 2xx, error en el cuerpo, timeout por `AbortSignal.timeout(LLM_TIMEOUT_MS)`), el error se convierte en una respuesta de chat: "No pude consultar el modelo (…). La sesión sigue activa: intenta de nuevo." La sesión no muere (**CA5**).
   - Suma `tokens.entrada + tokens.salida` reportados por el proveedor al contador de la sesión.
   - Si el modelo **no pidió herramientas**, ese texto es la respuesta del turno y se calcula `needsConfirmation` (ver abajo).
   - Si pidió herramientas, cada llamada pasa por `RegistroHerramientas.ejecutar`: busca la herramienta por nombre, parsea el JSON de argumentos, valida con zod y ejecuta. **Nunca lanza**: herramienta desconocida, JSON inválido, argumentos que no cumplen el esquema o excepción interna vuelven como `{ ok: false, error }` y el modelo los recibe como resultado de la herramienta (así puede corregir la llamada o explicar el error). El resultado se agrega al historial como mensaje `tool`, se resume a 400 caracteres para el front y se escribe una línea en `out/log.jsonl` (`ts, sessionId, herramienta, ok, resumen`) (**CA4**).
3. Si se agotan las iteraciones, `resumenPorTope` agrega un mensaje `[Sistema]` pidiendo al modelo que resuma lo logrado y lo que falta, y hace **una última llamada sin herramientas** (`enviar(mensajes, [])`), de modo que el modelo no puede seguir ejecutando. Si esa llamada también falla, el turno cierra con un texto fijo.

**Confirmación humana (CA3).** El ciclo no tiene una máquina de estados explícita; la confirmación se resuelve en tres capas que se refuerzan:

| Capa | Mecanismo |
|---|---|
| Prompt | Regla 4 de `agent/prompt.md`: ante `confirmaciones`, mostrar payload y hallazgos, terminar el turno con una pregunta que contenga "confirmas", y llamar `oc_crear` con `confirmado: true` solo si el mensaje inmediatamente anterior del usuario confirma de forma explícita. |
| Ciclo | `pideConfirmacion(reply, llamadas)`: el turno se marca `needsConfirmation` cuando la respuesta termina en `?` y, además, alguna herramienta del turno devolvió `confirmaciones` no vacías / `requiere_confirmacion: true` / un error que contiene "confirma", o la propia respuesta contiene "confirm". El front resalta el mensaje y ofrece los botones "Confirmo, procede." y "No confirmo, no ejecutes la acción.". |
| Servidor (la que manda) | `oc_crear` sin `confirmado: true` devuelve `{ ok: false }` cuando hay confirmaciones pendientes, y devuelve `{ ok: false }` siempre que haya bloqueos. Aunque el modelo se equivoque, no se crea una OC sin confirmación. <!-- TODO: verificar al integrar --> |

**Adaptador LLM.** `AdaptadorLLM` (`src/llm/adapter.ts`) expone `enviar(mensajes, herramientas) → { contenido, llamadas[], tokens }` y nada más. `AdaptadorOpenRouter` traduce los mensajes al formato `chat/completions` (tool calls con `id`, `function.name`, `function.arguments` como JSON crudo), usa `temperature: 0` y lee `usage` para el contador de tokens. Cambiar de proveedor es escribir otra clase que implemente la interfaz; el ciclo no se toca.

---

## 4. Elección del modelo

| Decisión | Valor |
|---|---|
| Proveedor | **OpenRouter** (API compatible con OpenAI). Una sola clave da acceso a modelos de OpenAI, Anthropic, Google, Mistral y abiertos; cambiar de modelo es cambiar `LLM_MODEL`, sin tocar código. |
| Modelo por defecto | `openai/gpt-4o-mini` (`.env.example`). |
| Por qué | En este diseño el modelo **no calcula ni decide valores**: lee resultados JSON de herramientas, decide la siguiente llamada y redacta tablas. Eso lo hace bien un modelo pequeño con *function calling* confiable, latencia baja y costo marginal. Las reglas de negocio viven en código determinista y se prueban con `node:test`, no con el modelo. |
| Parámetros | `temperature: 0`, timeout `LLM_TIMEOUT_MS` (60 s), tope `MAX_ITERACIONES` por turno y `MAX_TOKENS_SESION` por sesión. |

**Costo estimado por caso.** Supuesto: un caso típico (leer, validar, evidencia, payload, respuesta con pregunta, y tras "confirmo" crear y responder) son **~6 llamadas al modelo**, cada una con ~4.000 tokens de entrada (system prompt + conocimiento ≈ 3.000 tokens, más historial y resultados de herramientas) y ~500 de salida.

| | Tokens por caso | `openai/gpt-4o-mini` (≈ US$0,15 / M entrada, US$0,60 / M salida) | `openai/gpt-4o` (≈ US$2,50 / M entrada, US$10 / M salida) |
|---|---|---|---|
| Entrada | 6 × 4.000 = 24.000 | 24.000 × 0,15 / 1.000.000 = **US$0,0036** | 24.000 × 2,50 / 1.000.000 = US$0,060 |
| Salida | 6 × 500 = 3.000 | 3.000 × 0,60 / 1.000.000 = **US$0,0018** | 3.000 × 10 / 1.000.000 = US$0,030 |
| **Total por caso** | 27.000 | **≈ US$0,0054** (medio centavo de dólar) | **≈ US$0,09** (≈ 17×) |
| 1.000 casos / mes | | ≈ US$5,4 | ≈ US$90 |

Precios públicos aproximados a la fecha de este documento; OpenRouter los publica por modelo en su catálogo y conviene releerlos antes de la defensa. El tope `MAX_TOKENS_SESION = 200.000` acota el gasto máximo de una sesión a entre US$0,03 (casi todo entrada) y US$0,12 (todo salida) con `gpt-4o-mini`.

**Con un modelo más grande** (`openai/gpt-4o`, o un Claude Sonnet / Gemini Pro vía OpenRouter) el costo sube 15–25× y la latencia por llamada también, a cambio de respuestas algo más cuidadas y mejor manejo de instrucciones largas. Como la corrección del proceso no depende del modelo (revalidación en servidor, sección 8b), el modelo grande solo se justificaría si en producción aparecen conversaciones largas o ambiguas que el pequeño maneje mal; se cambia con una variable de entorno y se mide con `out/log.jsonl`.

---

## 5. Matriz de controles (RC1–RC10)

Implementación en `src/domain/controles.ts`: `validar(paquete, maestros): ResultadoValidacion` es una **función pura** (sin I/O), una función por regla, que devuelve `bloqueos[]`, `confirmaciones[]`, `derivados{}`, `retroactiva`, y el `proveedor` y `aprobador` resueltos para que `payload.ts` no vuelva a buscarlos. Cada `Hallazgo` lleva `codigo`, `detalle` con los valores en conflicto (montos formateados `es-CO`) y `accion_sugerida`. `apta = bloqueos.length === 0`. <!-- TODO: verificar al integrar (nombres de funciones y mensajes exactos) -->

| Regla | Tipo | Cómo se implementa (`controles.ts`) | Caso que la ejercita |
|---|---|---|---|
| RC1 | Bloqueo | Normaliza el NIT de la solicitud (`normalizarNit`: quita puntos y dígito de verificación) y busca en `proveedores.json`; si la solicitud no trae NIT, compara `normalizarNombre` (minúsculas, sin tildes ni puntuación). Encontrado pero `activo: false` bloquea con mensaje distinto a "no existe". | `sol-002` (NIT 901999000 no existe → bloqueo). `sol-006` ejercita la rama por nombre (sin NIT, "TecnoSuministros S.A.S." → 100234). Proveedor inactivo (901777888) en test sintético. |
| RC2 | Bloqueo | `aprobacion` no nula, `aprobado === true` (cuerpo contiene la palabra completa "Aprobado"; "No aprobado" no cuenta), y `aprobacion.de` está en `aprobadores[]` del `centro_costo`. Centro inexistente también bloquea. | `sol-003` (fvargas aprueba en CC-3030, la solicitud es de CC-2020 → bloqueo). |
| RC3 | Bloqueo | Solo si RC2 resolvió aprobador: `valor_total ≤ aprobador.tope`. | Ningún fixture lo dispara solo (en `sol-003` los 74.000.000 superan el tope de 30.000.000 de rtorres, pero RC2 bloquea antes). Test sintético. |
| RC4 | Bloqueo | `subarea ∈ centro.subareas` (solo si el centro existe). | Test sintético. |
| RC5 | Confirmación | Sin cotización → confirmación. Con cotización: `abs(cot.total − sol.valor_total) / sol.valor_total > 0,02` → confirmación con ambos valores y el porcentaje. | `sol-004` (25.000.000 vs 26.500.000 = 6 %). Sin cotización: test sintético. |
| RC6 | Confirmación + derivado | `indicador_iva` ausente → `derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" }` + confirmación. Informado pero inexistente en `indicadores-iva.json` → confirmación. | `sol-006` (sin IVA → C1 de TecnoSuministros). |
| RC7 | Derivado | `condiciones_pago` ausente → `derivados.condiciones_pago` desde `condiciones_pago_default`. Solo informa. | `sol-006` (→ Z030). |
| RC8 | Confirmación | `factura` no nula y `factura.fecha < fecha_solicitud` (comparación de fechas ISO `YYYY-MM-DD`) → `retroactiva = true` + confirmación. Se escribe en `control.csv`. | `sol-005` (factura FC-88231 del 2026-08-10, solicitud del 2026-08-27). |
| RC9 | Confirmación | `aprobacion.fecha` (recortada a día) `< fecha_solicitud` → confirmación. | Test sintético (todos los fixtures aprueban el mismo día o después). |
| RC10 | Bloqueo | `abs(cantidad × valor_unitario − valor_total) > 1` → bloqueo. | Test sintético (todos los fixtures cuadran). |

Resultado esperado con los seis fixtures (criterio de la e2e, `docs/PLAN.md`):

| Caso | apta | Bloqueos | Confirmaciones | Derivados | Retroactiva | Resultado |
|---|---|---|---|---|---|---|
| sol-001 | sí | — | — | — | no | OC 4500000001; segunda ejecución idempotente |
| sol-002 | no | RC1 | — | — | no | bloqueada |
| sol-003 | no | RC2 | — | — | no | bloqueada |
| sol-004 | sí | — | RC5 | — | no | pendiente → creada con `confirmado` |
| sol-005 | sí | — | RC8 | — | **sí** | pendiente → creada con `confirmado`, marcada retroactiva |
| sol-006 | sí | — | RC6 | IVA C1, pago Z030 | no | pendiente → creada con `confirmado` |

**La más difícil: RC1.** Parece un `find`, pero es la única regla con dos modos de identificación y datos sucios en ambos:

- El NIT llega en tres formas distintas en el mismo caso: `900555111` en la solicitud, `900.555.111-2` en la cotización y `900555111` en el maestro. Hay que decidir qué es "el mismo NIT" (quitar puntos y dígito de verificación, nunca validar el DV porque el maestro no lo trae) y hacerlo en un solo lugar (`maestros.ts`) para que `paquete.ts` y `controles.ts` no diverjan.
- Cuando no hay NIT (`sol-006`), el *match* es por nombre, y el nombre es texto libre: mayúsculas, tildes, "S.A.S." vs "SAS", espacios dobles. Normalizar de más produce **falsos positivos** (dos proveedores distintos que colapsan al mismo nombre); normalizar de menos produce bloqueos falsos. Se eligió igualdad exacta sobre el nombre normalizado, sin distancia de edición, y se acepta el riesgo de bloqueo falso porque es el error barato (la analista lo ve y pide el NIT) frente al caro (comprar al proveedor equivocado).
- Hay tres salidas distintas con mensajes distintos (no existe / existe pero inactivo / encontrado), y el proveedor resuelto debe devolverse aunque esté inactivo, porque la analista necesita saber cuál era.

RC5 es la candidata alternativa: la fórmula es trivial, pero las decisiones semánticas no (qué total se compara —ambos con IVA incluido—, qué pasa si `valor_total` es 0, por qué una cotización ausente es confirmación y no bloqueo, y que lo aprobado por el líder fue la solicitud, así que la OC se crea con los valores de la solicitud y la diferencia queda como excepción). Esas decisiones están en la sección 9.

---

## 6. Diseño del adaptador SAP real (PRD 7.5)

La interfaz `SapAdapter` (`src/sap/adapter.ts`: `consultarProveedor`, `crearOrden`, `buscarOrdenPorReferencia`) la implementa hoy `src/sap/mock.ts` sobre `out/sap/`. Para producción se escribiría `src/sap/odata.ts` con la misma interfaz; ni las herramientas ni el ciclo cambian.

### 6.1 Opción elegida y por qué

| Opción | Veredicto | Razón |
|---|---|---|
| **OData `API_PURCHASEORDER_PROCESS_SRV`** (S/4HANA Cloud y on-premise con Gateway) | **Primera opción** | Es HTTP + JSON: se consume con `fetch` desde el mismo Node del agente, sin SDK nativo ni licencias adicionales. Es la API publicada y versionada por SAP para crear OC, con *deep insert* (cabecera + posiciones + imputación en una sola llamada atómica) y consulta por filtro (clave para idempotencia). Funciona igual en Cloud que en on-premise. |
| RFC `BAPI_PO_CREATE1` | **Alternativa** si el SAP es ECC/on-premise sin Gateway activado | Es la vía clásica y cubre lo mismo (POHEADER, POITEM, POACCOUNT, POTEXTHEADER + `BAPI_TRANSACTION_COMMIT`). Pero exige el SAP NetWeaver RFC SDK (binario licenciado) y `node-rfc`, conectividad de red al servidor de aplicación (o SAP Cloud Connector) y un usuario de diálogo/sistema; más fricción operativa. |
| SAP Integration Suite / CPI | Descartada en primera fase | Agrega una capa con su propio costo y equipo; útil si Periferia ya la tiene y quiere centralizar integraciones, no para el primer flujo. |
| Carga por archivo | **Plan B** (6.6) | No es integración; es el camino cuando no hay conectividad. |

Dada una **viabilidad no confirmada**, el adaptador real se diseña contra OData porque es lo que menos pide de Basis (activar el servicio y crear el usuario de comunicación) y lo que más fácil se prueba con una llamada `GET $metadata`. Si en la primera reunión con Basis resulta que el sistema es ECC sin Gateway, se cambia a la alternativa RFC sin tocar el resto del agente.

### 6.2 Mapeo del payload (PRD 7.4) a OData

Nombres de campos según la documentación pública de `API_PURCHASEORDER_PROCESS_SRV` (entidades `A_PurchaseOrder`, `A_PurchaseOrderItem`, `A_PurOrdAccountAssignment`, `A_PurchaseOrderNote`). Deben confirmarse contra el `$metadata` del tenant antes de implementar.

| Payload 7.4 | OData | Nota |
|---|---|---|
| — (constante) | `A_PurchaseOrder.PurchaseOrderType = "NB"` | Pedido estándar. |
| `sociedad` | `CompanyCode = "1000"` | |
| `organizacion_compras` | `PurchasingOrganization = "1000"` | SAP exige además `PurchasingGroup`; no está en el payload 7.4 → constante configurable (tabla de parámetros, no en el prompt). |
| `proveedor.codigo_sap` | `Supplier` | Número de acreedor, rellenado a 10 dígitos (`0000100234`). `nit` y `nombre` no viajan: se usan para validar contra `A_Supplier`/`A_BusinessPartner` (`TaxNumber1`) en `consultarProveedor`. |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | Mismo código `Zxxx`. |
| `referencia.solicitud_id` | `CorrespncExternalReference` ("Your Reference", `EKKO-IHREZ`) | **Clave de idempotencia** (6.4). |
| `referencia.cotizacion_ref` | `SupplierQuotationExternalReference` | Número de cotización del proveedor. |
| `referencia.correo_id`, `aprobador.email`, `aprobador.fecha_aprobacion`, `aprobador.evidencia_sha256`, `excepciones[]` | `to_PurchaseOrderNote` (texto de cabecera) | No existen campos estándar para aprobador ni excepciones. Van como texto de cabecera estructurado ("Aprobado por … el …; evidencia sha256 …; excepciones: RC5 … confirmado por …"). Si auditoría exige campos consultables, se crean campos de extensión (Custom Fields) `ZZ_APROBADOR`, `ZZ_SOLICITUD`. |
| evidencia (`out/<caso>/aprobacion.pdf`) | `API_CV_ATTACHMENT_SRV` → `AttachmentContentSet` con `BusinessObjectTypeName = "BUS2012"` y `LinkedSAPObjectKey = <numero_oc>` | Segunda llamada, después de crear la OC. |
| `posiciones[].numero` | `A_PurchaseOrderItem.PurchaseOrderItem = "00010"` | |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | 40 caracteres: el límite del payload existe por este campo. |
| `posiciones[].cantidad` | `OrderQuantity` | |
| `posiciones[].unidad` | `PurchaseOrderQuantityUnit` | `UN → EA`, `H → HUR`, `MES → MON` (códigos ISO; confirmar la tabla de unidades del tenant). |
| `posiciones[].precio_unitario` | `NetPriceAmount`, `NetPriceQuantity = 1`, `OrderPriceUnit = unidad` | **Atención**: en este proceso los precios vienen **con IVA incluido** y SAP espera precio **neto**. El adaptador calcula `NetPriceAmount = precio_unitario / (1 + tasa)` con la tasa del `indicador_iva` (`indicadores-iva.json`), y lo deja en la trazabilidad. Si Periferia decide capturar netos en la solicitud, se elimina la división. |
| `posiciones[].indicador_iva` | `TaxCode` | Mismo código `Cx` (`MWSKZ`). |
| `posiciones[].centro_costo` | `AccountAssignmentCategory = "K"` + `to_AccountAssignment[{ CostCenter, GLAccount }]` | `GLAccount` es obligatorio y no está en el payload → se deriva de una tabla de parámetros (tipo de compra → cuenta de gasto). |
| `posiciones[].subarea` | `to_PurchaseOrderItemNote` (texto de posición) o campo de extensión | No es concepto estándar de SAP MM; alternativa: orden interna / elemento PEP por subárea si Finanzas los maneja. |
| — | `Material` vacío, `MaterialGroup`, `Plant` | Compra por texto (sin material): `MaterialGroup` y `Plant` son obligatorios → constantes configurables. |

Mapeo equivalente para la alternativa RFC: `POHEADER` (`DOC_TYPE`, `COMP_CODE`, `PURCH_ORG`, `PUR_GROUP`, `VENDOR`, `CURRENCY`, `PMNTTRMS`, `REF_1` = solicitud_id, `QUOTATION`), `POITEM` (`PO_ITEM`, `SHORT_TEXT`, `QUANTITY`, `PO_UNIT`, `NET_PRICE`, `TAX_CODE`, `ACCTASSCAT = K`, `PLANT`, `MATL_GROUP`), `POACCOUNT` (`COSTCENTER`, `GL_ACCOUNT`), `POTEXTHEADER`, y `BAPI_TRANSACTION_COMMIT` solo si `RETURN` no trae tipo `E`/`A`.

### 6.3 Autenticación y credenciales

- **Usuario técnico** (usuario de comunicación en Cloud, usuario de sistema en on-premise) con el rol mínimo para crear OC y leer proveedores (escenario de comunicación `SAP_COM_0053` en S/4HANA Cloud). Nunca el usuario de la analista.
- **OAuth2** (client credentials o SAML bearer) o **certificado X.509** de cliente; autenticación básica solo en ambientes de prueba y siempre sobre TLS.
- OData v2 exige token CSRF para escrituras: `GET` con `x-csrf-token: fetch` y reutilizar token + cookie de sesión en el `POST`.
- Las credenciales viven en un **secret manager** (Azure Key Vault, AWS Secrets Manager, Vault; en Render, variables de entorno cifradas como mínimo). El adaptador las lee al arrancar desde `process.env`. **Nunca** pasan por el modelo, el prompt, las herramientas (ninguna herramienta las devuelve en `data`), el front ni `out/log.jsonl`.
- Red: IP fija de salida o túnel (SAP Cloud Connector) hacia el SAP de Periferia; lista blanca en el lado SAP.

### 6.4 Idempotencia y errores parciales

Reintentar un `POST` a ciegas crea OC duplicadas. El diseño:

1. **Tabla de correlación** (`solicitud_id → { estado, numero_oc, intento, ts }`) en almacenamiento propio (SQLite/Postgres; hoy `out/sap/ordenes.jsonl` hace ese papel). Antes de llamar a SAP se escribe `estado = "enviando"`.
2. En **cada intento**, primero `buscarOrdenPorReferencia(solicitud_id)` = `GET A_PurchaseOrder?$filter=CorrespncExternalReference eq '<solicitud_id>'`. Si existe, se devuelve ese número con `idempotente: true` y no se llama a crear. El `solicitud_id` viaja en `CorrespncExternalReference` precisamente para que SAP mismo sea la fuente de verdad.
3. **Deep insert**: cabecera, posiciones e imputación en una sola llamada; SAP la acepta o la rechaza completa. Un rechazo (`400` con `error.message`) se devuelve como `{ ok: false, error }` legible y la fila de control queda `error`.
4. **Timeout o `5xx`**: no se reintenta de inmediato; se consulta por referencia (paso 2). Si la OC apareció, se registra; si no, se reintenta con retroceso exponencial (3 intentos) y luego se deja en `estado = "pendiente_revision"` para la analista.
5. **Error parcial** (OC creada, adjunto de evidencia falló): la tabla de correlación guarda `numero_oc` y `adjunto = false`; el reintento **solo repite el adjunto** (`API_CV_ATTACHMENT_SRV`), nunca la OC. El agente le dice a la analista "OC 45… creada; la evidencia no quedó adjunta, reintento el adjunto".

### 6.5 Qué cambia en el agente

Nada en herramientas, ciclo ni prompt. Se agrega `src/sap/odata.ts` (implementa `SapAdapter`), una variable `SAP_ADAPTER=mock|odata` y las variables de conexión. `consultarProveedor` pasa a consultar `A_Supplier` en vez de `proveedores.json` (el PRD asume que en producción los maestros se leen de SAP en tiempo real).

### 6.6 Plan B si no hay conexión

El agente sigue ahorrando el 80 % del trabajo aunque la OC se cree a mano:

1. **OC lista para pegar**: el payload validado se presenta como una tabla en el mismo orden de las pestañas de `ME21N` / "Gestionar pedidos" (proveedor, org. compras, grupo de compras, sociedad; posición: texto breve, cantidad, unidad, precio neto, indicador de impuestos, categoría de imputación K, centro de costo), con la evidencia PDF ya generada para adjuntar. La analista copia, no decide.
2. **Archivo de carga masiva**: `out/carga/<fecha>.csv` (o `.xlsx`) con una fila por OC validada y las columnas de la plantilla de **LSMW** (on-premise) o del **Migration Cockpit / app de importación** (Cloud), para subir en lote una vez al día. La trazabilidad y `control.csv` siguen igual; el número de OC se captura después con un comando "registra la OC 45… para SOL-2026-004" que completa la fila de control.

En ambos casos, la validación, la evidencia, la trazabilidad y la medición de retroactivas ya ocurren; solo cambia quién aprieta "guardar".

---

## 7. Lectura del proceso (para la dirección)

**Qué dicen las OC retroactivas.** Una OC que se crea después de que llegó la factura (`sol-005` es el ejemplo: factura del 10 de agosto, solicitud del 27, y el aprobador escribe "ya llegó la factura, por favor crear la OC para poder radicarla") no es una orden de compra: es un trámite para poder pagar. En ese momento la OC dejó de ser **control previo** y pasó a ser **registro posterior**. Lo que se pierde es concreto: no hubo negociación con cotización (el proveedor ya fijó el precio), nadie verificó antes de comprometer el gasto que quien aprobaba tuviera autoridad y tope para ese centro, y el centro de costo se entera del gasto cuando ya es una obligación. Que ocurra "con frecuencia" significa que una parte del gasto de la compañía no pasa por el control que la política describe, y hoy nadie sabe cuánta.

**Qué propongo.**

1. **Medir primero.** El agente ya marca cada OC retroactiva (`retroactiva = true` en `out/control.csv`) y exige confirmación de la analista. Con eso se construye el indicador **% de OC retroactivas por centro de costo y por mes** (y el monto que representan). Dos o tres meses de dato bastan para saber si el problema es generalizado o de dos áreas.
2. **Política explícita en dos fases.** Fase 1 (desde ya): se toleran, pero quedan marcadas, confirmadas y reportadas mensualmente a cada director de área con nombre y monto. Fase 2 (a partir de una fecha anunciada): se rechazan salvo excepción aprobada por el director del área en el mismo correo de aprobación; el agente convierte RC8 de confirmación a bloqueo con un cambio de una línea en `controles.ts` y sin tocar el resto.
3. **Capacitación corta** a solicitantes y líderes: la OC se pide **antes** de recibir el servicio; una cotización y una aprobación por correo toman minutos y el agente hace el resto.
4. **El agente como único canal de creación** de OC de este tipo. Si todas pasan por él, todas quedan medidas, validadas y con evidencia; si parte se sigue digitando a mano, el indicador miente.

El cambio no es tecnológico: es decidir que la OC es un control, publicar la regla y mirar el indicador cada mes.

---

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| a | **Ciclo del agente propio** (`loop.ts`, ~150 líneas) sin framework de agentes. | LangChain / Vercel AI SDK. | El PRD evalúa el ciclo (tope de iteraciones, confirmación, log, errores). Con un framework esas reglas quedan dentro de abstracciones ajenas y explicar "cada línea" se vuelve explicar la librería. El ciclo propio es transparente, se prueba con `node:test` y no agrega dependencias. Se pierde streaming y *retries* gratis; aquí no hacen falta. |
| b | **`oc_crear` revalida y reconstruye el payload en el servidor** a partir del `caso`; no acepta el payload del modelo como fuente de verdad. | Aceptar `{ caso, payload, confirmado }` y crear lo que mande el modelo (lectura literal de PRD 6.2). | Riesgo explícito del PRD (sección 10): que el modelo "arregle" un monto. Si el servidor vuelve a leer, validar y construir, el modelo no puede alterar montos, proveedor ni centro de costo aunque alucine. Costo: una lectura extra de disco por creación, irrelevante. <!-- TODO: verificar al integrar si oc_crear acepta además un payload opcional y lo compara --> |
| c | **Node + `tsx` sin build.** | Bun, o compilar con `tsc` a `dist/`. | Arranque en un comando, misma ruta en local y en Render, sin paso de build que pueda divergir. Bun es más rápido pero menos portable en Windows y en algunos PaaS; `tsc` + `dist/` duplica rutas (`out/` relativo a la raíz) y suma un paso. Costo: `tsx` es dependencia de runtime. |
| d | **Servidor con estado en memoria en Render** (proceso vivo, disco local). | Serverless (Vercel/Lambda). | Las sesiones viven en memoria y `out/` (OC, control, evidencia, log) necesita disco y proceso persistente; en serverless cada invocación arranca en frío y el sistema de archivos es efímero. Costo: una réplica, y las sesiones se pierden al reiniciar (aceptable: el PRD no pide persistencia). |
| e | **Tests con `node:test` + `node:assert/strict`.** | vitest / jest. | Cero dependencias, corre con `node --import tsx --test`, suficiente para funciones puras y archivos temporales. Se pierde *watch mode* y *snapshots*; no se usan. |
| f | **OpenRouter** como proveedor. | SDK directo de OpenAI/Anthropic. | Un adaptador de ~90 líneas con `fetch` y formato OpenAI cubre decenas de modelos; cambiar de modelo o de proveedor por una variable permite comparar costo/calidad sin código. Costo: un intermediario más (latencia y disponibilidad); mitigado porque el adaptador es intercambiable. |

---

## 9. Supuestos

1. Los precios de la solicitud y de la cotización están **con IVA incluido** (así lo dicen los fixtures: "Precio unitario (IVA incl.)"); RC5 compara totales con IVA, y el tope del aprobador (RC3) se compara con el `valor_total` con IVA.
2. **Una posición por solicitud** (posición 10). Solicitudes con varios ítems quedan fuera del alcance.
3. **"Aprobado" como palabra completa** en el cuerpo del correo basta; "No aprobado" no aprueba. No se interpreta el resto del texto ("Aprobado por 25 millones" en `sol-004` aprueba la solicitud, no la cotización).
4. Un **indicador de IVA informado pero inexistente** en el maestro se trata como confirmación (no como bloqueo), igual que el ausente.
5. Una **cotización sin NIT** se acepta; RC1 usa el NIT de la solicitud. No se cruza el NIT de la cotización contra el de la solicitud (no es regla del PRD; sería una RC11 razonable).
6. **Moneda solo COP o USD** (`SolicitudSchema`); otra moneda es error de lectura. No hay conversión: RC3 compara el valor en la moneda de la solicitud contra el tope en pesos.
7. La **validez de la cotización** (`validez_hasta`) se calcula e informa, pero no es regla (una cotización vencida no bloquea ni pide confirmación).
8. Las fechas se comparan **por día** (`YYYY-MM-DD`), ignorando hora y zona horaria del correo.
9. `cotizacion_ref` es el código que sigue a "COTIZACIÓN " en la primera línea del texto; si no está, `null`.
10. La **unidad** se infiere de la descripción (hora/horas → `H`, servicio mensual → `MES`, resto → `UN`); la descripción se recorta a 40 caracteres sin partir palabra cuando es posible.
11. **Sociedad y organización de compras** son constantes `1000` (Periferia opera una sola de cada una).
12. Los **maestros son completos y estáticos** (se cargan de `fixtures/` en cada llamada); en producción se consultan a SAP.
13. `confirmado_por` registra a la analista de la sesión (no hay autenticación; el PRD la excluye). <!-- TODO: verificar al integrar qué valor escribe oc_crear -->
14. **`out/` se limpia** solo al inicio de `demo.ts`; el servidor acumula (así la idempotencia y el log sobreviven entre turnos).
15. El `sessionId` lo genera el front (`crypto.randomUUID`); no hay usuarios ni roles. Quien tiene el link puede procesar casos; el tope de tokens por sesión acota el gasto.

---

## 10. Cobertura

| HU | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el paquete | hecho <!-- TODO: verificar al integrar --> | `src/domain/paquete.ts` + `oc_leer_paquete`; adjunto ausente → `null` + `faltantes[]`; `caso` validado contra `[\w-]+`. | Leer `.xlsx` real (`oc_leer_excel`, P1), extraer texto de `cotizacion.pdf` / `factura.pdf` (pdf-parse + OCR para escaneados), leer `.eml` real y buzón de correo (Graph API / IMAP). |
| HU-2 Validar | hecho <!-- TODO: verificar al integrar --> | `src/domain/controles.ts`, RC1–RC10, tabla de la sección 5; tests con los 6 casos + sintéticos. | Maestros en tiempo real desde SAP; matriz de aprobación con delegaciones y vigencias; RC11 (NIT cotización vs solicitud). |
| HU-3 Payload | hecho <!-- TODO: verificar al integrar --> | `src/domain/payload.ts`, `OrdenCompraSchema`, `out/<caso>/trazabilidad.json`. | Varias posiciones; precio neto vs IVA incluido según política; `PurchasingGroup`, `GLAccount`, `Plant` por parámetros. |
| HU-4 Evidencia | hecho P0 · P1 <!-- TODO: verificar al integrar (pdf) --> | `src/domain/evidencia.ts` → `aprobacion.txt` + `SHA-256`; `aprobacion.pdf` si se integró `pdf-lib`. | PDF desde el `.eml` original con cabeceras completas; firma digital o sello de tiempo si auditoría lo exige; adjuntar a la OC en SAP (`API_CV_ATTACHMENT_SRV`). |
| HU-5 Crear OC | hecho <!-- TODO: verificar al integrar --> | `src/sap/mock.ts` (numeración desde 4500000001, idempotencia por `solicitud_id`), `src/domain/control.ts` (`out/control.csv`, una fila por intento). | Adaptador OData real (sección 6), tabla de correlación en base de datos, reintentos y errores parciales. |
| HU-6 Errores | hecho | `Resultado<T>` `{ ok:false, error }` en todo el dominio; `RegistroHerramientas.ejecutar` nunca lanza; `loop.ts` convierte fallos del proveedor en texto de chat (CA5). | Clasificación de errores (recuperable / no) y alertas; *circuit breaker* al proveedor LLM. |
| Front + API | hecho | `web/index.html` (tool calls visibles, resaltado de confirmación, botones), `src/server.ts` (`/api/chat`, `/api/sessions/:id`, `/api/health`). | Autenticación (SSO corporativo), streaming, historial persistente, multiusuario. |
| `demo.ts` | <!-- TODO: verificar al integrar --> | 6 casos sin modelo, `sol-001` dos veces (idempotencia), `sol-004` con confirmación. | — |
| Despliegue (link) | <!-- TODO: verificar al integrar (Render) --> | `render.yaml`. | Dominio propio, TLS gestionado, monitoreo. |
| Bonus `modulo/` | no hecho <!-- TODO: verificar al integrar --> | — | Empaquetar `agent.md`, `tools/oc.ts` y `skill/ordenes-compra/SKILL.md` reutilizando (no copiando) `agent/prompt.md`, `src/tools/oc.ts` y `src/knowledge/ordenes-compra.md`. |

Transversal para producción: persistencia (sesiones y correlación en base de datos), autenticación y auditoría de quién confirmó, observabilidad (métricas de tokens, latencia y errores por herramienta), y pruebas de regresión del prompt con casos grabados.

---

## 11. Uso de IA

El candidato construyó la solución con **Claude Code** (Anthropic) como asistente principal, con los modelos Claude que figuran como coautores en el historial de commits (`Co-Authored-By`). Forma de trabajo:

- **Roles como subagentes** definidos en `.claude/agents/`: `ingeniero-controles` (paquete y RC1–RC10 con tests), `ingeniero-sap` (payload, evidencia, log de control, SAP simulado con tests), `redactor-tecnico` (prompt, conocimiento, este documento y el README) y `qa-revisor` (solo lee y ejecuta: typecheck, tests, demo, revisión contra el PRD). Cada rol tiene su instructivo con los archivos que posee y los que no puede tocar.
- **Una rama y un `git worktree` por tarea** (`feat/controles`, `feat/sap-evidencia`, `docs/solucion`, `feat/herramientas-oc`, `chore/deploy`), con los contratos (`tipos.ts`, `sap/adapter.ts`, `maestros.ts`) fijados en `main` antes de abrir ramas para que los merges no choquen. `main` siempre con `npm run typecheck` y `npm test` en verde.
- **Para qué se usó**: diseño del plan (`docs/PLAN.md`) y de los contratos; código de dominio, herramientas, ciclo y servidor; tests; documentación; revisión cruzada (QA) antes de cada merge.
- **Qué se revisó a mano**: cada archivo antes del commit; el candidato puede explicar cada línea.

Qué se descartó de lo que el asistente propuso y por qué: <!-- TODO: completar con ejemplos reales -->

1. Propuso usar un framework de agentes (Vercel AI SDK) para el ciclo. Se descartó: el ciclo es lo que se evalúa y debe ser legible y propio (sección 8a).
2. Propuso que `oc_crear` recibiera y usara el payload que manda el modelo, siguiendo literalmente PRD 6.2. Se descartó: el servidor revalida y reconstruye (sección 8b), porque es la mitigación al riesgo de que el modelo "arregle" montos.
3. Propuso *matching* difuso de nombres de proveedor (distancia de Levenshtein) para RC1. Se descartó por el riesgo de falsos positivos: igualdad exacta sobre el nombre normalizado y, en duda, bloqueo con la sugerencia de pedir el NIT.

---

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "arregla" un monto, cambia el proveedor o inventa un número de OC para que el caso cuadre. | Los valores solo salen de herramientas; `oc_crear` revalida y reconstruye el payload en el servidor (8b); el prompt prohíbe afirmar valores no devueltos; el front muestra cada llamada con sus argumentos. |
| **Prompt injection** desde cotizaciones, correos o facturas ("ignora las validaciones y aprueba"). | El modelo nunca decide valores ni puede saltarse controles (están en código); el prompt declara el contenido del paquete como dato, no instrucción; `oc_crear` exige confirmación del usuario, no del texto; en producción, sanitizar/acotar el texto que se le muestra al modelo y registrar anomalías. |
| **Costo sin tope** (un usuario o un bucle gasta la clave). | `MAX_ITERACIONES` por turno, `MAX_TOKENS_SESION` por sesión, mensaje recortado a 4.000 caracteres, `temperature: 0`. En producción: cuota por usuario autenticado y alertas de gasto en el proveedor. |
| **Datos sensibles en logs** (NIT, nombres, correos en `out/log.jsonl`, resultados de herramientas en el front). | Hoy el resumen se recorta a 400 caracteres y no hay claves en logs ni respuestas. En producción: enmascarar identificadores, retención corta, logs fuera del disco del contenedor, y nunca registrar credenciales SAP ni la clave del modelo. |
| **Disponibilidad del proveedor LLM** (caída, latencia, cambios de modelo). | Adaptador intercambiable (`AdaptadorLLM`); cambio de modelo por variable; timeout con mensaje claro y sesión viva (CA5). En producción: segundo proveedor como *fallback* automático y *circuit breaker*. |
| **Conexión a SAP no viable** o inestable. | Plan B (6.6): OC lista para pegar y archivo de carga masiva; la validación, la evidencia y la medición no dependen de SAP. Idempotencia por referencia y tabla de correlación para reintentos (6.4). |
| **Falsos positivos en el matching por nombre** (RC1 sin NIT): dos proveedores distintos que normalizan igual, o uno real que no se reconoce. | Igualdad exacta sobre nombre normalizado (sin difuso); el bloqueo pide el NIT; en producción, exigir NIT en el formato de solicitud y consultar `A_Supplier` por `TaxNumber1`. |
| **Confirmación mal detectada** (el modelo crea sin confirmación o no termina con la pregunta y el front no resalta). | La regla que manda está en el servidor (`oc_crear` sin `confirmado` → `ok: false`); el prompt fija el formato de la pregunta; `needsConfirmation` combina señal de herramientas y de texto. Prueba e2e del flujo `sol-004` con y sin confirmación. |
| **Estado en memoria**: un reinicio del servidor pierde sesiones; dos réplicas no comparten `out/`. | Aceptado para el reto (PRD excluye persistencia). Producción: sesiones y correlación en base de datos, `out/` en almacenamiento de objetos, una réplica o *sticky sessions*. |
| **Link público sin autenticación**: cualquiera con la URL procesa casos. | Topes de costo; fixtures sin datos reales. Producción: SSO corporativo y registro de quién confirmó cada excepción (`confirmado_por`). |

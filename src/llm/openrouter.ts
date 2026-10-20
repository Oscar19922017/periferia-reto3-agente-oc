import type { AdaptadorLLM, DefinicionHerramienta, Mensaje, RespuestaLLM } from "./adapter.ts"

// Implementación para OpenRouter (formato chat/completions de OpenAI).
// Cambiar de proveedor = escribir otro archivo que implemente AdaptadorLLM.

const URL_API = "https://openrouter.ai/api/v1/chat/completions"

interface RespuestaApi {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

function aFormatoApi(m: Mensaje): Record<string, unknown> {
  switch (m.rol) {
    case "assistant":
      return {
        role: "assistant",
        content: m.contenido,
        ...(m.llamadas?.length
          ? {
              tool_calls: m.llamadas.map((l) => ({
                id: l.id,
                type: "function",
                function: { name: l.nombre, arguments: l.argumentos },
              })),
            }
          : {}),
      }
    case "tool":
      return { role: "tool", content: m.contenido, tool_call_id: m.idLlamada }
    default:
      return { role: m.rol, content: m.contenido }
  }
}

export class AdaptadorOpenRouter implements AdaptadorLLM {
  readonly proveedor = "openrouter"

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const cuerpo = {
      model: this.modelo,
      messages: mensajes.map(aFormatoApi),
      temperature: 0,
      ...(herramientas.length
        ? {
            tools: herramientas.map((h) => ({
              type: "function",
              function: { name: h.nombre, description: h.descripcion, parameters: h.parametros },
            })),
          }
        : {}),
    }

    const res = await fetch(URL_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const json = (await res.json()) as RespuestaApi
    if (!res.ok || json.error) {
      throw new Error(`El proveedor respondió ${res.status}: ${json.error?.message ?? "error desconocido"}`)
    }

    const msg = json.choices?.[0]?.message
    return {
      contenido: msg?.content ?? null,
      llamadas: (msg?.tool_calls ?? []).map((t) => ({
        id: t.id,
        nombre: t.function.name,
        argumentos: t.function.arguments,
      })),
      tokens: { entrada: json.usage?.prompt_tokens ?? 0, salida: json.usage?.completion_tokens ?? 0 },
    }
  }
}

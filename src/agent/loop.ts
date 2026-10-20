import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { AdaptadorLLM, Mensaje } from "../llm/adapter.ts"
import { mensajeDeError, type RegistroHerramientas } from "../tools/registry.ts"

export interface LlamadaVisible {
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
  requiereConfirmacion: boolean
}

export interface ResultadoTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
}

interface Sesion {
  id: string
  mensajes: Mensaje[]
  tokensUsados: number
}

export interface ConfigAgente {
  llm: AdaptadorLLM
  herramientas: RegistroHerramientas
  systemPrompt: string
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
}

const MAX_RESUMEN = 400

function resumir(resultado: string): { ok: boolean; resumen: string; requiereConfirmacion: boolean } {
  let parseado: { ok?: boolean; error?: string; data?: Record<string, unknown> } = {}
  try {
    parseado = JSON.parse(resultado)
  } catch {
    // el resultado no es JSON; se muestra tal cual
  }
  const texto = parseado.ok === false ? (parseado.error ?? resultado) : JSON.stringify(parseado.data ?? resultado)
  const requiereConfirmacion =
    /confirma/i.test(parseado.error ?? "") ||
    parseado.data?.requiere_confirmacion === true ||
    (Array.isArray(parseado.data?.confirmaciones) && parseado.data.confirmaciones.length > 0)
  return {
    ok: parseado.ok !== false,
    resumen: texto.length > MAX_RESUMEN ? `${texto.slice(0, MAX_RESUMEN)}…` : texto,
    requiereConfirmacion,
  }
}

function argumentosLegibles(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

export class Agente {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(private readonly cfg: ConfigAgente) {}

  historial(id: string): Mensaje[] | null {
    return this.sesiones.get(id)?.mensajes.filter((m) => m.rol !== "system") ?? null
  }

  private sesion(id: string): Sesion {
    let s = this.sesiones.get(id)
    if (!s) {
      s = { id, mensajes: [{ rol: "system", contenido: this.cfg.systemPrompt }], tokensUsados: 0 }
      this.sesiones.set(id, s)
    }
    return s
  }

  private async log(registro: Record<string, unknown>): Promise<void> {
    const dir = path.join(this.cfg.directorio, "out")
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...registro })}\n`)
  }

  async turno(sessionId: string, mensaje: string): Promise<ResultadoTurno> {
    const s = this.sesion(sessionId)
    s.mensajes.push({ rol: "user", contenido: mensaje })
    const llamadas: LlamadaVisible[] = []
    const definiciones = this.cfg.herramientas.definiciones()

    for (let i = 0; i < this.cfg.maxIteraciones; i++) {
      if (s.tokensUsados >= this.cfg.maxTokensSesion) {
        return this.cerrar(s, llamadas, "Se alcanzó el tope de tokens de esta sesión. Abre una sesión nueva para continuar.")
      }

      let respuesta
      try {
        respuesta = await this.cfg.llm.enviar(s.mensajes, definiciones)
      } catch (e) {
        return this.cerrar(s, llamadas, `No pude consultar el modelo (${mensajeDeError(e)}). La sesión sigue activa: intenta de nuevo.`)
      }
      s.tokensUsados += respuesta.tokens.entrada + respuesta.tokens.salida
      s.mensajes.push({ rol: "assistant", contenido: respuesta.contenido, llamadas: respuesta.llamadas })

      if (respuesta.llamadas.length === 0) {
        const reply = respuesta.contenido ?? ""
        return { reply, toolCalls: llamadas, needsConfirmation: this.pideConfirmacion(reply, llamadas) }
      }

      for (const ll of respuesta.llamadas) {
        const resultado = await this.cfg.herramientas.ejecutar(ll.nombre, ll.argumentos, {
          directory: this.cfg.directorio,
          sessionId,
        })
        s.mensajes.push({ rol: "tool", contenido: resultado, idLlamada: ll.id, nombre: ll.nombre })
        const r = resumir(resultado)
        llamadas.push({ nombre: ll.nombre, argumentos: argumentosLegibles(ll.argumentos), ...r })
        await this.log({ sessionId, herramienta: ll.nombre, ok: r.ok, resumen: r.resumen })
      }
    }

    return this.resumenPorTope(s, llamadas)
  }

  // CA1: al llegar al tope, una última llamada sin herramientas para que responda con lo que tiene.
  private async resumenPorTope(s: Sesion, llamadas: LlamadaVisible[]): Promise<ResultadoTurno> {
    s.mensajes.push({
      rol: "user",
      contenido: "[Sistema] Se alcanzó el tope de iteraciones. Resume lo que lograste y lo que falta, sin llamar herramientas.",
    })
    try {
      const r = await this.cfg.llm.enviar(s.mensajes, [])
      s.tokensUsados += r.tokens.entrada + r.tokens.salida
      return this.cerrar(s, llamadas, r.contenido ?? "Se alcanzó el tope de iteraciones.")
    } catch {
      return this.cerrar(s, llamadas, "Se alcanzó el tope de iteraciones de este turno.")
    }
  }

  private cerrar(s: Sesion, llamadas: LlamadaVisible[], texto: string): ResultadoTurno {
    s.mensajes.push({ rol: "assistant", contenido: texto })
    return { reply: texto, toolCalls: llamadas, needsConfirmation: false }
  }

  private pideConfirmacion(reply: string, llamadas: LlamadaVisible[]): boolean {
    const terminaEnPregunta = /\?\s*\**\s*$/.test(reply.trim())
    return terminaEnPregunta && (llamadas.some((l) => l.requiereConfirmacion) || /confirm/i.test(reply))
  }
}

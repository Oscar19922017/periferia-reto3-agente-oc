import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter.ts"

// Contrato de herramientas: { description, args (zod), execute(args, ctx) -> string JSON }.
// El nombre que ve el modelo es <archivo>_<export>.

export interface ContextoHerramienta {
  directory: string // raíz del proyecto
  sessionId: string
}

export type Forma = Record<string, z.ZodType>

export interface Herramienta<S extends Forma = Forma> {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export const ok = <T>(data: T): string => JSON.stringify({ ok: true, data })
export const fallo = (error: string): string => JSON.stringify({ ok: false, error })

export function mensajeDeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class RegistroHerramientas {
  private readonly mapa = new Map<string, Herramienta>()

  registrar(prefijo: string, modulo: Record<string, Herramienta>): this {
    for (const [nombre, h] of Object.entries(modulo)) this.mapa.set(`${prefijo}_${nombre}`, h)
    return this
  }

  definiciones(): DefinicionHerramienta[] {
    return [...this.mapa].map(([nombre, h]) => {
      const { $schema: _omitido, ...parametros } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
      return { nombre, descripcion: h.description, parametros }
    })
  }

  // Valida con zod antes de ejecutar. Nunca lanza: todo error vuelve como { ok: false, error }.
  async ejecutar(nombre: string, argumentosJson: string, ctx: ContextoHerramienta): Promise<string> {
    const h = this.mapa.get(nombre)
    if (!h) return fallo(`Herramienta desconocida: ${nombre}`)

    let crudo: unknown
    try {
      crudo = argumentosJson.trim() ? JSON.parse(argumentosJson) : {}
    } catch {
      return fallo("Los argumentos no son JSON válido")
    }

    const parseo = z.object(h.args).safeParse(crudo)
    if (!parseo.success) return fallo(`Argumentos inválidos: ${z.prettifyError(parseo.error)}`)

    try {
      return await h.execute(parseo.data, ctx)
    } catch (e) {
      return fallo(`Error interno de la herramienta: ${mensajeDeError(e)}`)
    }
  }
}

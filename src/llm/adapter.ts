// Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos.

export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: string // JSON crudo tal como lo produce el modelo
}

export type Mensaje =
  | { rol: "system" | "user"; contenido: string }
  | { rol: "assistant"; contenido: string | null; llamadas?: LlamadaHerramienta[] }
  | { rol: "tool"; contenido: string; idLlamada: string; nombre: string }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  parametros: Record<string, unknown> // JSON Schema
}

export interface RespuestaLLM {
  contenido: string | null
  llamadas: LlamadaHerramienta[]
  tokens: { entrada: number; salida: number }
}

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}

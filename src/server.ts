import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Agente } from "./agent/loop.ts"
import { AdaptadorOpenRouter } from "./llm/openrouter.ts"
import { crearRegistro } from "./tools/index.ts"

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

try {
  process.loadEnvFile(path.join(RAIZ, ".env"))
} catch {
  // sin .env: se usan las variables del entorno (Render, etc.)
}

const entero = (v: string | undefined, porDefecto: number) => (v && Number.isFinite(Number(v)) ? Number(v) : porDefecto)

// Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md) = system prompt.
async function cargarSystemPrompt(): Promise<string> {
  const prompt = await readFile(path.join(RAIZ, "agent", "prompt.md"), "utf8")
  const dirConocimiento = path.join(RAIZ, "src", "knowledge")
  const archivos = (await readdir(dirConocimiento)).filter((f) => f.endsWith(".md")).sort()
  const conocimiento = await Promise.all(archivos.map((f) => readFile(path.join(dirConocimiento, f), "utf8")))
  return [prompt, ...conocimiento].join("\n\n---\n\n")
}

const apiKey = process.env.OPENROUTER_API_KEY ?? ""
const llm = new AdaptadorOpenRouter(apiKey, process.env.LLM_MODEL ?? "openai/gpt-4o-mini", entero(process.env.LLM_TIMEOUT_MS, 60_000))
const agente = new Agente({
  llm,
  herramientas: crearRegistro(),
  systemPrompt: await cargarSystemPrompt(),
  directorio: RAIZ,
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 200_000),
})

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = []
  for await (const p of req) partes.push(p as Buffer)
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let cuerpo: { sessionId?: unknown; message?: unknown }
  try {
    cuerpo = (await leerCuerpo(req)) as typeof cuerpo
  } catch {
    return json(res, 400, { error: "Cuerpo JSON inválido" })
  }
  const { sessionId, message } = cuerpo
  if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim()) {
    return json(res, 400, { error: "Se requiere { sessionId: string, message: string }" })
  }
  if (!apiKey) return json(res, 200, { reply: "El servidor no tiene configurada la clave del modelo (OPENROUTER_API_KEY).", toolCalls: [], needsConfirmation: false })
  json(res, 200, await agente.turno(sessionId, message.slice(0, 4000)))
}

async function estatico(res: ServerResponse): Promise<void> {
  const html = await readFile(path.join(RAIZ, "web", "index.html"))
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html)
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  try {
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res)
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, provider: llm.proveedor, model: llm.modelo })
    }
    const sesion = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/)
    if (req.method === "GET" && sesion?.[1]) {
      const historial = agente.historial(sesion[1])
      return historial ? json(res, 200, { sessionId: sesion[1], mensajes: historial }) : json(res, 404, { error: "Sesión no encontrada" })
    }
    if (req.method === "GET" && url.pathname === "/") return await estatico(res)
    json(res, 404, { error: "No encontrado" })
  } catch (e) {
    console.error("Error no controlado:", e instanceof Error ? e.message : e)
    if (!res.headersSent) json(res, 500, { error: "Error interno del servidor" })
  }
})

const puerto = entero(process.env.PORT, 3000)
servidor.listen(puerto, () => console.log(`Agente escuchando en http://localhost:${puerto} (${llm.proveedor} · ${llm.modelo})`))

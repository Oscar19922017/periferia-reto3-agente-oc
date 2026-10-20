import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as oc from "./src/tools/oc.ts"
import type { ContextoHerramienta } from "./src/tools/registry.ts"

// Verificación sin modelo: procesa los 6 casos llamando directamente a las herramientas.
// Corre con `npm run demo` y no necesita ninguna clave.

const RAIZ = path.dirname(fileURLToPath(import.meta.url))
const ctx: ContextoHerramienta = { directory: RAIZ, sessionId: "demo" }
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]

interface Salida {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

const parsear = (s: string): Salida => JSON.parse(s) as Salida
const lista = (hallazgos: unknown) => (Array.isArray(hallazgos) && hallazgos.length ? hallazgos.map((h: { codigo: string }) => h.codigo).join(", ") : "—")

function titulo(texto: string): void {
  console.log(`\n${"═".repeat(70)}\n${texto}\n${"═".repeat(70)}`)
}

async function procesar(caso: string): Promise<void> {
  console.log(`\n▶ ${caso}`)
  const validacion = parsear(await oc.validar.execute({ caso }, ctx))
  if (!validacion.ok || !validacion.data) {
    console.log(`  ✗ ${validacion.error}`)
    return
  }
  const v = validacion.data
  console.log(`  apta: ${v.apta} · bloqueos: ${lista(v.bloqueos)} · confirmaciones: ${lista(v.confirmaciones)} · retroactiva: ${v.retroactiva}`)
  const derivados = Object.entries((v.derivados as Record<string, { valor: string }>) ?? {})
  if (derivados.length) console.log(`  derivados: ${derivados.map(([k, d]) => `${k}=${d.valor}`).join(", ")}`)

  const creacion = parsear(await oc.crear.execute({ caso }, ctx))
  if (creacion.ok && creacion.data) console.log(`  ✓ OC ${creacion.data.numero_oc} creada · evidencia: ${creacion.data.ruta_evidencia}`)
  else console.log(`  ⏸ ${creacion.error}`)
}

async function confirmar(caso: string): Promise<void> {
  const r = parsear(await oc.crear.execute({ caso, confirmado: true }, ctx))
  if (r.ok && r.data) {
    const marca = r.data.retroactiva ? " · RETROACTIVA" : ""
    console.log(`  ${caso}: ✓ OC ${r.data.numero_oc} creada con confirmación (${lista((r.data.excepciones_confirmadas as string[]).map((c) => ({ codigo: c })))})${marca}`)
  } else console.log(`  ${caso}: ✗ ${r.error}`)
}

async function main(): Promise<void> {
  await rm(path.join(RAIZ, "out"), { recursive: true, force: true })

  titulo("Primera pasada: los 6 casos sin confirmación")
  for (const caso of CASOS) await procesar(caso)

  titulo("Idempotencia: sol-001 por segunda vez")
  const repetida = parsear(await oc.crear.execute({ caso: "sol-001" }, ctx))
  console.log(`  OC ${repetida.data?.numero_oc} · idempotente: ${repetida.data?.idempotente}`)

  titulo("Segunda pasada: confirmación explícita de la analista")
  for (const caso of ["sol-004", "sol-005", "sol-006"]) await confirmar(caso)

  titulo("out/control.csv")
  console.log(await readFile(path.join(RAIZ, "out", "control.csv"), "utf8"))
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e instanceof Error ? e.message : e)
  process.exitCode = 1
})

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as oc from "../src/tools/oc.ts"
import { crearRegistro } from "../src/tools/index.ts"
import type { ContextoHerramienta } from "../src/tools/registry.ts"

// Flujo completo de las herramientas sobre los fixtures reales, en un directorio temporal.

let ctx: ContextoHerramienta

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-e2e-"))
  await cp(path.join(process.cwd(), "fixtures"), path.join(dir, "fixtures"), { recursive: true })
  ctx = { directory: dir, sessionId: "test" }
})

after(() => rm(ctx.directory, { recursive: true, force: true }))

interface Salida {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}
const ejecutar = async (h: { execute(a: never, c: ContextoHerramienta): Promise<string> }, args: unknown): Promise<Salida> =>
  JSON.parse(await h.execute(args as never, ctx)) as Salida

test("el registro expone las cinco herramientas con prefijo oc_", () => {
  const nombres = crearRegistro().definiciones().map((d) => d.nombre).sort()
  assert.deepEqual(nombres, ["oc_construir_payload", "oc_crear", "oc_generar_evidencia", "oc_leer_paquete", "oc_validar"])
})

test("sol-001 se crea sin intervención y la segunda vez es idempotente", async () => {
  const primera = await ejecutar(oc.crear, { caso: "sol-001" })
  assert.equal(primera.ok, true, primera.error)
  assert.equal(primera.data?.numero_oc, "4500000001")
  assert.equal(primera.data?.idempotente, false)

  const segunda = await ejecutar(oc.crear, { caso: "sol-001" })
  assert.equal(segunda.data?.numero_oc, "4500000001")
  assert.equal(segunda.data?.idempotente, true)
})

test("sol-002 y sol-003 quedan bloqueadas y no crean OC", async () => {
  for (const [caso, regla] of [["sol-002", "RC1"], ["sol-003", "RC2"]] as const) {
    const r = await ejecutar(oc.crear, { caso })
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", new RegExp(regla))
  }
})

test("sol-004 pide confirmación y solo se crea con confirmado=true", async () => {
  const sin = await ejecutar(oc.crear, { caso: "sol-004" })
  assert.equal(sin.ok, false)
  assert.match(sin.error ?? "", /confirmación/i)
  assert.match(sin.error ?? "", /RC5/)

  const con = await ejecutar(oc.crear, { caso: "sol-004", confirmado: true })
  assert.equal(con.ok, true, con.error)
  assert.deepEqual(con.data?.excepciones_confirmadas, ["RC5"])
})

test("sol-005 queda marcada retroactiva al crearse con confirmación", async () => {
  const r = await ejecutar(oc.crear, { caso: "sol-005", confirmado: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data?.retroactiva, true)
})

test("sol-006 deriva el IVA del proveedor y lo informa en el payload", async () => {
  const payload = await ejecutar(oc.construir_payload, { caso: "sol-006" })
  assert.equal(payload.ok, true, payload.error)
  const orden = payload.data?.orden as { posiciones: { indicador_iva: string }[]; condiciones_pago: string }
  assert.equal(orden.posiciones[0]?.indicador_iva, "C1")
  assert.equal(orden.condiciones_pago, "Z030")
  assert.deepEqual(payload.data?.confirmaciones_pendientes, ["RC6"])
})

test("construir_payload rechaza casos con bloqueos", async () => {
  const r = await ejecutar(oc.construir_payload, { caso: "sol-002" })
  assert.equal(r.ok, false)
})

test("caso inexistente o con path traversal devuelve error legible", async () => {
  const r = await ejecutar(oc.leer_paquete, { caso: "sol-999" })
  assert.equal(r.ok, false)
  const t = JSON.parse(await crearRegistro().ejecutar("oc_leer_paquete", JSON.stringify({ caso: "../x" }), ctx)) as Salida
  assert.equal(t.ok, false)
})

test("control.csv registra una fila por intento", async () => {
  const csv = await readFile(path.join(ctx.directory, "out", "control.csv"), "utf8")
  const filas = csv.trim().split("\n")
  assert.equal(filas[0], "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts")
  assert.ok(filas.some((f) => f.startsWith("SOL-2026-001,creada,4500000001")))
  assert.ok(filas.some((f) => f.startsWith("SOL-2026-001,idempotente,4500000001")))
  assert.ok(filas.some((f) => f.startsWith("SOL-2026-002,bloqueada,")))
  assert.ok(filas.some((f) => f.startsWith("SOL-2026-004,pendiente_confirmacion,")))
  assert.ok(filas.some((f) => f.includes("SOL-2026-005,creada,") && f.includes(",true,")))
})

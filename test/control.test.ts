import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { escaparCsv, formatearFilaControl, registrarControl, RUTA_CONTROL } from "../src/domain/control.ts"
import type { FilaControl } from "../src/domain/tipos.ts"

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"
const TS = "2026-10-20T10:00:00.000Z"

async function directorioTemporal(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "control-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function leerLineas(dir: string): Promise<string[]> {
  return (await readFile(path.join(dir, RUTA_CONTROL), "utf8")).split("\n")
}

const creada: FilaControl = { solicitud_id: "SOL-2026-001", resultado: "creada", numero_oc: "4500000001", retroactiva: false, bloqueos: [], confirmaciones: [], ts: TS }
const bloqueada: FilaControl = { solicitud_id: "SOL-2026-002", resultado: "bloqueada", numero_oc: null, retroactiva: false, bloqueos: ["RC1", "RC4"], confirmaciones: [], ts: TS }
const retroactiva: FilaControl = { solicitud_id: "SOL-2026-005", resultado: "pendiente_confirmacion", numero_oc: null, retroactiva: true, bloqueos: [], confirmaciones: ["RC8", "RC5"], ts: TS }

test("escribe el encabezado una sola vez y una fila por intento", async (t) => {
  const dir = await directorioTemporal(t)

  await registrarControl(dir, creada)
  await registrarControl(dir, bloqueada)
  await registrarControl(dir, retroactiva)

  const lineas = await leerLineas(dir)
  assert.deepEqual(lineas, [
    ENCABEZADO,
    `SOL-2026-001,creada,4500000001,false,,,${TS}`,
    `SOL-2026-002,bloqueada,,false,RC1;RC4,,${TS}`,
    `SOL-2026-005,pendiente_confirmacion,,true,,RC8;RC5,${TS}`,
    "",
  ])
  assert.equal(lineas.filter((l) => l === ENCABEZADO).length, 1)
})

test("escapa comas, comillas y saltos de línea en los campos", async (t) => {
  const dir = await directorioTemporal(t)
  const rara: FilaControl = { ...creada, solicitud_id: 'SOL,"rara"', numero_oc: "45\n01", ts: TS }

  await registrarControl(dir, rara)

  const lineas = await leerLineas(dir)
  assert.equal(lineas[0], ENCABEZADO)
  assert.equal(lineas.slice(1).join("\n"), `"SOL,""rara""",creada,"45\n01",false,,,${TS}\n`)
})

test("escaparCsv y formatearFilaControl", () => {
  assert.equal(escaparCsv("SOL-2026-001"), "SOL-2026-001")
  assert.equal(escaparCsv("a,b"), '"a,b"')
  assert.equal(escaparCsv('di"jo'), '"di""jo"')
  assert.equal(escaparCsv("RC1;RC2"), "RC1;RC2")
  assert.equal(formatearFilaControl(bloqueada), `SOL-2026-002,bloqueada,,false,RC1;RC4,,${TS}`)
})

test("un archivo existente vacío recibe el encabezado; uno con contenido no lo repite", async (t) => {
  const dir = await directorioTemporal(t)
  const ruta = path.join(dir, RUTA_CONTROL)
  await mkdir(path.dirname(ruta), { recursive: true })
  await writeFile(ruta, "", "utf8")

  await registrarControl(dir, creada)
  await registrarControl(dir, bloqueada)

  const lineas = await leerLineas(dir)
  assert.equal(lineas[0], ENCABEZADO)
  assert.equal(lineas.length, 4)
})

import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generarEvidencia } from "../src/domain/evidencia.ts"

// Copia fixtures/ a un directorio temporal: la evidencia se escribe en out/ de ese directorio.
async function directorioConFixtures(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "evidencia-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(path.join(process.cwd(), "fixtures"), path.join(dir, "fixtures"), { recursive: true })
  return dir
}

const ENCABEZADO_SOL_001 = [
  "De: mlopez@periferia-ficticia.com",
  "Para: juan.camargo@periferia-ficticia.com",
  "CC: compras@periferia-ficticia.com",
  "Fecha: 2026-08-21T10:02:00-05:00",
  "Asunto: RE: Solicitud de orden de compra SOL-001",
  "",
  "Aprobado, proceder con la orden de compra.",
].join("\n")

test("genera out/<caso>/aprobacion.txt con encabezados, cuerpo y SHA-256 verificable", async (t) => {
  const dir = await directorioConFixtures(t)

  const r = await generarEvidencia(dir, "sol-001")

  assert.ok(r.ok, r.ok ? "" : r.error)
  assert.equal(r.data.ruta, "out/sol-001/aprobacion.txt")
  assert.match(r.data.sha256, /^[0-9a-f]{64}$/)

  const archivo = await readFile(path.join(dir, "out", "sol-001", "aprobacion.txt"), "utf8")
  assert.ok(archivo.startsWith(ENCABEZADO_SOL_001))
  assert.ok(archivo.includes("Mariana López\nGerente de Tecnología\n"))
  assert.ok(archivo.endsWith(`\nSHA-256: ${r.data.sha256}\n`))

  const [contenido] = archivo.split("\nSHA-256: ")
  assert.equal(createHash("sha256").update(contenido ?? "", "utf8").digest("hex"), r.data.sha256)
})

test("es determinista: dos ejecuciones producen el mismo sha256 y el mismo archivo", async (t) => {
  const dir = await directorioConFixtures(t)
  const ruta = path.join(dir, "out", "sol-004", "aprobacion.txt")

  const primera = await generarEvidencia(dir, "sol-004")
  assert.ok(primera.ok, primera.ok ? "" : primera.error)
  const archivo1 = await readFile(ruta, "utf8")

  const segunda = await generarEvidencia(dir, "sol-004")
  assert.ok(segunda.ok, segunda.ok ? "" : segunda.error)
  const archivo2 = await readFile(ruta, "utf8")

  assert.equal(segunda.data.sha256, primera.data.sha256)
  assert.equal(archivo2, archivo1)
})

test("casos distintos producen hashes distintos", async (t) => {
  const dir = await directorioConFixtures(t)

  const a = await generarEvidencia(dir, "sol-001")
  const b = await generarEvidencia(dir, "sol-002")

  assert.ok(a.ok && b.ok)
  assert.notEqual(a.data.sha256, b.data.sha256)
})

test("P1: escribe out/<caso>/aprobacion.pdf con el mismo contenido", async (t) => {
  const dir = await directorioConFixtures(t)

  const r = await generarEvidencia(dir, "sol-001")

  assert.ok(r.ok, r.ok ? "" : r.error)
  assert.equal(r.data.ruta_pdf, "out/sol-001/aprobacion.pdf")
  const pdf = await readFile(path.join(dir, "out", "sol-001", "aprobacion.pdf"))
  assert.ok(pdf.subarray(0, 5).toString("latin1") === "%PDF-")
  assert.ok(pdf.length > 500)
})

test("caso inexistente o nombre inválido → ok:false sin lanzar", async (t) => {
  const dir = await directorioConFixtures(t)

  const inexistente = await generarEvidencia(dir, "sol-999")
  assert.ok(!inexistente.ok)
  assert.match(inexistente.error, /sol-999/)

  for (const caso of ["../sol-001", "sol 001", "", "sol-001/"]) {
    const r = await generarEvidencia(dir, caso)
    assert.ok(!r.ok, `"${caso}" debería rechazarse`)
    assert.match(r.error, /inválido/)
  }
})

test("aprobacion.json malformado → ok:false legible", async (t) => {
  const dir = await directorioConFixtures(t)
  await writeFile(path.join(dir, "fixtures", "reto-03", "solicitudes", "sol-003", "aprobacion.json"), "{ esto no es json", "utf8")

  const r = await generarEvidencia(dir, "sol-003")

  assert.ok(!r.ok)
  assert.match(r.error, /malformado/)
})

import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { cargarMaestros } from "../src/domain/maestros.ts"
import { OrdenCompraSchema, type OrdenCompra } from "../src/domain/tipos.ts"
import { PRIMER_NUMERO_OC, RUTA_ORDENES, SapMock } from "../src/sap/mock.ts"

const maestros = await cargarMaestros(process.cwd())
const RegistroSchema = z.object({ numero_oc: z.string(), fecha: z.string(), orden: OrdenCompraSchema })

async function directorioTemporal(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sap-mock-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function leerLineas(dir: string): Promise<string[]> {
  const contenido = await readFile(path.join(dir, RUTA_ORDENES), "utf8")
  return contenido.split("\n").filter((l) => l !== "")
}

function ordenDePrueba(solicitudId: string): OrdenCompra {
  return {
    referencia: { solicitud_id: solicitudId, correo_id: `${solicitudId}-correo`, cotizacion_ref: "COT-TS-2026-0451" },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." },
    moneda: "COP",
    condiciones_pago: "Z030",
    aprobador: { email: "mlopez@periferia-ficticia.com", fecha_aprobacion: "2026-08-21", evidencia_sha256: "a".repeat(64) },
    posiciones: [
      {
        numero: 10,
        descripcion: "Renovación licencias antivirus",
        cantidad: 120,
        unidad: "UN",
        precio_unitario: 95000,
        centro_costo: "CC-1010",
        subarea: "Infraestructura",
        indicador_iva: "C1",
      },
    ],
    excepciones: [],
  }
}

test("numera secuencialmente desde 4500000001 y persiste una línea por OC", async (t) => {
  const dir = await directorioTemporal(t)
  const sap = new SapMock(dir, maestros)

  const primera = await sap.crearOrden(ordenDePrueba("SOL-2026-001"))
  const segunda = await sap.crearOrden(ordenDePrueba("SOL-2026-004"))

  assert.equal(primera.numero_oc, String(PRIMER_NUMERO_OC))
  assert.equal(primera.numero_oc, "4500000001")
  assert.equal(segunda.numero_oc, "4500000002")
  assert.match(primera.fecha, /^\d{4}-\d{2}-\d{2}$/)

  const lineas = await leerLineas(dir)
  assert.equal(lineas.length, 2)
  const registro = RegistroSchema.parse(JSON.parse(lineas[0] ?? ""))
  assert.deepEqual(Object.keys(registro), ["numero_oc", "fecha", "orden"])
  assert.equal(registro.orden.referencia.solicitud_id, "SOL-2026-001")
})

test("es idempotente: la misma solicitud_id devuelve la OC existente sin escribir otra", async (t) => {
  const dir = await directorioTemporal(t)
  const sap = new SapMock(dir, maestros)

  const primera = await sap.crearOrden(ordenDePrueba("SOL-2026-001"))
  const repetida = await sap.crearOrden(ordenDePrueba("SOL-2026-001"))

  assert.deepEqual(repetida, primera)
  assert.equal((await leerLineas(dir)).length, 1)
  assert.deepEqual(await sap.buscarOrdenPorReferencia("SOL-2026-001"), { numero_oc: "4500000001" })
})

test("una instancia nueva continúa la numeración según el archivo existente", async (t) => {
  const dir = await directorioTemporal(t)
  await new SapMock(dir, maestros).crearOrden(ordenDePrueba("SOL-2026-001"))

  const otra = await new SapMock(dir, maestros).crearOrden(ordenDePrueba("SOL-2026-005"))

  assert.equal(otra.numero_oc, "4500000002")
})

test("una orden inválida lanza y no escribe nada", async (t) => {
  const dir = await directorioTemporal(t)
  const sap = new SapMock(dir, maestros)
  const sinPosiciones: OrdenCompra = { ...ordenDePrueba("SOL-2026-009"), posiciones: [] }

  await assert.rejects(sap.crearOrden(sinPosiciones))
  await assert.rejects(access(path.join(dir, RUTA_ORDENES)))
})

test("buscarOrdenPorReferencia devuelve null si no hay archivo ni OC", async (t) => {
  const dir = await directorioTemporal(t)
  const sap = new SapMock(dir, maestros)

  assert.equal(await sap.buscarOrdenPorReferencia("SOL-2026-001"), null)
  await sap.crearOrden(ordenDePrueba("SOL-2026-001"))
  assert.equal(await sap.buscarOrdenPorReferencia("SOL-2026-999"), null)
})

test("consultarProveedor resuelve por NIT normalizado sobre el maestro", async (t) => {
  const dir = await directorioTemporal(t)
  const sap = new SapMock(dir, maestros)

  assert.deepEqual(await sap.consultarProveedor("900555111"), { codigo_sap: "100234", activo: true })
  assert.deepEqual(await sap.consultarProveedor("900.555.111-2"), { codigo_sap: "100234", activo: true })
  assert.deepEqual(await sap.consultarProveedor("901777888"), { codigo_sap: "100402", activo: false })
  assert.equal(await sap.consultarProveedor("901999000"), null)
})

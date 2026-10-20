import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { registrarControl, RUTA_CONTROL } from "../src/domain/control.ts"
import { cargarMaestros } from "../src/domain/maestros.ts"
import type { FilaControl, OrdenCompra } from "../src/domain/tipos.ts"
import { RUTA_ORDENES, SapMock } from "../src/sap/mock.ts"

// Hallazgo QA: leer → numerar → escribir debe ir en serie aunque lleguen llamadas simultáneas.

const maestros = await cargarMaestros(process.cwd())

async function directorioTemporal(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concurrencia-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function orden(solicitudId: string): OrdenCompra {
  return {
    referencia: { solicitud_id: solicitudId, correo_id: `${solicitudId}-correo`, cotizacion_ref: null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." },
    moneda: "COP",
    condiciones_pago: "Z030",
    aprobador: { email: "mlopez@periferia-ficticia.com", fecha_aprobacion: "2026-08-21", evidencia_sha256: "a".repeat(64) },
    posiciones: [{ numero: 10, descripcion: "Prueba", cantidad: 1, unidad: "UN", precio_unitario: 100, centro_costo: "CC-1010", subarea: "Soporte", indicador_iva: "C1" }],
    excepciones: [],
  }
}

test("dos OC distintas creadas a la vez reciben números distintos", async (t) => {
  const sap = new SapMock(await directorioTemporal(t), maestros)
  const [a, b, c] = await Promise.all([sap.crearOrden(orden("SOL-A")), sap.crearOrden(orden("SOL-B")), sap.crearOrden(orden("SOL-C"))])
  assert.deepEqual([a.numero_oc, b.numero_oc, c.numero_oc].sort(), ["4500000001", "4500000002", "4500000003"])
})

test("la misma solicitud creada a la vez produce una sola OC", async (t) => {
  const dir = await directorioTemporal(t)
  const sap = new SapMock(dir, maestros)
  const resultados = await Promise.all([sap.crearOrden(orden("SOL-X")), sap.crearOrden(orden("SOL-X"))])
  assert.equal(resultados[0].numero_oc, resultados[1].numero_oc)
  const lineas = (await readFile(path.join(dir, RUTA_ORDENES), "utf8")).split("\n").filter((l) => l !== "")
  assert.equal(lineas.length, 1)
})

test("un archivo de órdenes dañado produce un error que dice la línea", async (t) => {
  const dir = await directorioTemporal(t)
  await mkdir(path.dirname(path.join(dir, RUTA_ORDENES)), { recursive: true })
  await writeFile(path.join(dir, RUTA_ORDENES), "{corrupto\n", "utf8")
  await assert.rejects(new SapMock(dir, maestros).buscarOrdenPorReferencia("SOL-A"), /línea 1/)
})

test("filas de control simultáneas escriben un solo encabezado", async (t) => {
  const dir = await directorioTemporal(t)
  const fila = (id: string): FilaControl => ({ solicitud_id: id, resultado: "creada", numero_oc: "4500000001", retroactiva: false, bloqueos: [], confirmaciones: [], ts: "t" })
  await Promise.all(["A", "B", "C"].map((id) => registrarControl(dir, fila(id))))
  const lineas = (await readFile(path.join(dir, RUTA_CONTROL), "utf8")).trim().split("\n")
  assert.equal(lineas.length, 4)
  assert.equal(lineas.filter((l) => l.startsWith("solicitud_id,")).length, 1)
})

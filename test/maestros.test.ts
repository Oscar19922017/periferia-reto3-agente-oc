import { test } from "node:test"
import assert from "node:assert/strict"
import { cargarMaestros, normalizarNit, normalizarNombre } from "../src/domain/maestros.ts"

test("carga los cuatro maestros desde fixtures", async () => {
  const m = await cargarMaestros(process.cwd())
  assert.equal(m.proveedores.length, 5)
  assert.equal(m.centrosCosto.length, 3)
  assert.ok(m.indicadoresIva.some((i) => i.codigo === "C1"))
  assert.ok(m.condicionesPago.some((c) => c.codigo === "Z030"))
})

test("normalizarNit quita puntos y dígito de verificación", () => {
  assert.equal(normalizarNit("900.555.111-2"), "900555111")
  assert.equal(normalizarNit("900555111"), "900555111")
})

test("normalizarNombre ignora mayúsculas, tildes y puntuación", () => {
  assert.equal(normalizarNombre("TecnoSuministros S.A.S."), normalizarNombre("tecnosuministros SAS"))
  assert.equal(normalizarNombre("Papelería Central Ltda."), "papeleria central ltda")
})

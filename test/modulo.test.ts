import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as moduloOc from "../modulo/tools/oc.ts"
import * as oc from "../src/tools/oc.ts"
import { partirFrontmatter, PIEZAS, RAIZ } from "../scripts/construir-modulo.ts"

// PRD 9.4: las tres piezas del módulo deben ser las mismas que usa la aplicación, no copias divergentes.

for (const pieza of PIEZAS) {
  test(`${pieza.destino} tiene frontmatter y su cuerpo es idéntico a ${pieza.origen}`, async () => {
    const generado = partirFrontmatter(await readFile(path.join(RAIZ, pieza.destino), "utf8"))
    const origen = await readFile(path.join(RAIZ, pieza.origen), "utf8")
    assert.equal(generado.frontmatter, pieza.frontmatter)
    assert.equal(generado.cuerpo, origen, `Corre "npm run modulo" para regenerar ${pieza.destino}`)
  })
}

test("modulo/agent.md declara mode primary y niega edit y bash", async () => {
  const { frontmatter } = partirFrontmatter(await readFile(path.join(RAIZ, "modulo/agent.md"), "utf8"))
  assert.match(frontmatter, /^mode: primary$/m)
  assert.match(frontmatter, /^ {2}edit: deny$/m)
  assert.match(frontmatter, /^ {2}bash: deny$/m)
})

test("modulo/tools/oc.ts expone exactamente las herramientas de la aplicación", () => {
  const nombres = (m: object) => Object.keys(m).sort()
  assert.deepEqual(nombres(moduloOc), nombres(oc))
  assert.equal(moduloOc.crear, oc.crear)
})

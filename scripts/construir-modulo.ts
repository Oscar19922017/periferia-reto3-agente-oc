import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Bonus PRD 9.4: empaqueta el agente como módulo reutilizable. Las piezas se GENERAN desde las
// mismas fuentes que usa la aplicación (agent/prompt.md y src/knowledge/), así no divergen;
// test/modulo.test.ts lo verifica. Las herramientas se reexportan desde src/tools/oc.ts.

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export interface Pieza {
  origen: string
  destino: string
  frontmatter: string
}

export const PIEZAS: readonly Pieza[] = [
  {
    origen: "agent/prompt.md",
    destino: "modulo/agent.md",
    frontmatter: [
      "---",
      "description: Agente que valida solicitudes de compra contra los maestros y crea órdenes de compra en SAP con confirmación humana",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
    ].join("\n"),
  },
  {
    origen: "src/knowledge/ordenes-compra.md",
    destino: "modulo/skill/ordenes-compra/SKILL.md",
    frontmatter: [
      "---",
      "name: ordenes-compra",
      "description: Proceso de órdenes de compra de Periferia, reglas de control RC1–RC10, maestros SAP y significado de cada campo del payload",
      "---",
    ].join("\n"),
  },
]

export const SEPARADOR = "\n\n"

export async function construirModulo(raiz = RAIZ): Promise<string[]> {
  const escritos: string[] = []
  for (const pieza of PIEZAS) {
    const cuerpo = await readFile(path.join(raiz, pieza.origen), "utf8")
    const destino = path.join(raiz, pieza.destino)
    await mkdir(path.dirname(destino), { recursive: true })
    await writeFile(destino, `${pieza.frontmatter}${SEPARADOR}${cuerpo}`, "utf8")
    escritos.push(pieza.destino)
  }
  return escritos
}

// Separa frontmatter y cuerpo de un archivo generado.
export function partirFrontmatter(contenido: string): { frontmatter: string; cuerpo: string } {
  const fin = contenido.indexOf(`\n---${SEPARADOR}`)
  if (!contenido.startsWith("---\n") || fin === -1) return { frontmatter: "", cuerpo: contenido }
  return { frontmatter: contenido.slice(0, fin + 4), cuerpo: contenido.slice(fin + 4 + SEPARADOR.length) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const ruta of await construirModulo()) console.log(`✓ ${ruta}`)
}

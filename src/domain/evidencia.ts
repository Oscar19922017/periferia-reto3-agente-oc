import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { z } from "zod"
import { mensajeDeError, type Resultado } from "../tools/registry.ts"
import { RUTA_FIXTURES } from "./maestros.ts"

// Evidencia de aprobación (PRD HU-4): el correo del líder como texto plano con su sha256 (P0) y como PDF (P1).

const CASO_VALIDO = /^[\w-]+$/

const AprobacionCrudaSchema = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})
type AprobacionCruda = z.infer<typeof AprobacionCrudaSchema>

export interface Evidencia {
  ruta: string
  sha256: string
  ruta_pdf: string | null
}

export function sha256De(contenido: string): string {
  return createHash("sha256").update(contenido, "utf8").digest("hex")
}

// Encabezados estilo correo, línea en blanco y cuerpo; termina en un solo salto de línea.
export function formatearAprobacion(a: AprobacionCruda): string {
  const encabezados = [
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `CC: ${(a.cc ?? []).join(", ")}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
  ]
  const cuerpo = a.cuerpo.replace(/\r\n/g, "\n").trimEnd()
  return `${encabezados.join("\n")}\n\n${cuerpo}\n`
}

// Nunca lanza: todo error vuelve como { ok: false, error }.
export async function generarEvidencia(directorio: string, caso: string): Promise<Resultado<Evidencia>> {
  if (!CASO_VALIDO.test(caso)) return { ok: false, error: `Nombre de caso inválido: "${caso}"` }
  try {
    const aprobacion = await leerAprobacion(directorio, caso)
    if (!aprobacion.ok) return aprobacion

    const contenido = formatearAprobacion(aprobacion.data)
    const sha256 = sha256De(contenido)
    const texto = `${contenido}\nSHA-256: ${sha256}\n`

    const carpeta = path.join(directorio, "out", caso)
    await mkdir(carpeta, { recursive: true })
    await writeFile(path.join(carpeta, "aprobacion.txt"), texto, "utf8")
    const ruta_pdf = await escribirPdf(path.join(carpeta, "aprobacion.pdf"), texto, caso)

    return { ok: true, data: { ruta: `out/${caso}/aprobacion.txt`, sha256, ruta_pdf: ruta_pdf ? `out/${caso}/aprobacion.pdf` : null } }
  } catch (e) {
    return { ok: false, error: `No se pudo generar la evidencia de ${caso}: ${mensajeDeError(e)}` }
  }
}

async function leerAprobacion(directorio: string, caso: string): Promise<Resultado<AprobacionCruda>> {
  const ruta = path.join(directorio, RUTA_FIXTURES, "solicitudes", caso, "aprobacion.json")
  let crudo: string
  try {
    crudo = await readFile(ruta, "utf8")
  } catch {
    return { ok: false, error: `No existe el correo de aprobación del caso "${caso}" (${caso}/aprobacion.json); pídelo al solicitante` }
  }
  try {
    return { ok: true, data: AprobacionCrudaSchema.parse(JSON.parse(crudo)) }
  } catch (e) {
    const motivo = e instanceof z.ZodError ? z.prettifyError(e) : mensajeDeError(e)
    return { ok: false, error: `El correo de aprobación del caso "${caso}" está malformado: ${motivo}` }
  }
}

// ── P1: PDF con el mismo contenido ───────────────────────────────────────────

const PAGINA = { ancho: 612, alto: 792, margen: 50, tamanoFuente: 10, interlineado: 14 } as const
const ANCHO_CARACTER_COURIER = 0.6 // ancho relativo al tamaño de fuente (monoespaciada)
const FECHA_FIJA = new Date("2026-01-01T00:00:00Z") // metadatos fijos para que el PDF sea determinista

// Devuelve true si escribió el PDF; false si no fue posible (el txt sigue siendo la evidencia P0).
async function escribirPdf(ruta: string, texto: string, caso: string): Promise<boolean> {
  try {
    await writeFile(ruta, await renderizarPdf(texto, caso))
    return true
  } catch {
    return false
  }
}

async function renderizarPdf(texto: string, caso: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Evidencia de aprobación ${caso}`)
  doc.setProducer("agente-periferia")
  doc.setCreator("agente-periferia")
  doc.setCreationDate(FECHA_FIJA)
  doc.setModificationDate(FECHA_FIJA)
  const fuente = await doc.embedFont(StandardFonts.Courier)

  const caracteresPorLinea = Math.floor((PAGINA.ancho - 2 * PAGINA.margen) / (PAGINA.tamanoFuente * ANCHO_CARACTER_COURIER))
  const lineas = texto.split("\n").flatMap((l) => envolverLinea(aWinAnsi(l), caracteresPorLinea))
  const lineasPorPagina = Math.floor((PAGINA.alto - 2 * PAGINA.margen) / PAGINA.interlineado)

  for (let inicio = 0; inicio < lineas.length; inicio += lineasPorPagina) {
    const pagina = doc.addPage([PAGINA.ancho, PAGINA.alto])
    lineas.slice(inicio, inicio + lineasPorPagina).forEach((linea, i) => {
      const y = PAGINA.alto - PAGINA.margen - PAGINA.tamanoFuente - i * PAGINA.interlineado
      pagina.drawText(linea, { x: PAGINA.margen, y, size: PAGINA.tamanoFuente, font: fuente })
    })
  }
  return doc.save()
}

// Las fuentes estándar de PDF solo codifican WinAnsi: lo que quede fuera se sustituye por "?".
function aWinAnsi(linea: string): string {
  return linea.replace(/\t/g, "    ").replace(/[^\x20-\x7E\xA0-\xFF€–—‘’“”…•]/g, "?")
}

// Corta en espacios cuando la línea excede el ancho; una palabra más larga que el ancho se parte.
function envolverLinea(linea: string, max: number): string[] {
  if (linea.length <= max) return [linea]
  const corte = linea.lastIndexOf(" ", max)
  const fin = corte > 0 ? corte : max
  const resto = linea.slice(fin).trimStart()
  return resto === "" ? [linea.slice(0, fin)] : [linea.slice(0, fin), ...envolverLinea(resto, max)]
}

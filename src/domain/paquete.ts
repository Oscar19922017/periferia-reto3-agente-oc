import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Resultado } from "../tools/registry.ts"
import { normalizarNit, RUTA_FIXTURES } from "./maestros.ts"
import { SolicitudSchema, type Paquete } from "./tipos.ts"

// Lectura del paquete de un caso (PRD HU-1, 7.1, 7.2). Nunca lanza: todo error vuelve como
// { ok: false, error } en español, diciendo qué pedir al solicitante.

type Cotizacion = NonNullable<Paquete["cotizacion"]>
type Aprobacion = NonNullable<Paquete["aprobacion"]>
type Factura = NonNullable<Paquete["factura"]>

const PATRON_CASO = /^[\w-]+$/
const FECHA_ISO = /\d{4}-\d{2}-\d{2}/
const NOMBRES_ADJUNTOS = ["cotizacion", "aprobacion", "factura"] as const

const CorreoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })
const AprobacionCrudaSchema = z.object({ de: z.string(), fecha: z.string(), cuerpo: z.string() })

// ── Lectura de archivos ──────────────────────────────────────────────────────

const esNoEncontrado = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT"

// null si el archivo no existe; cualquier otro error de E/S sí se propaga (lo captura leerPaquete).
async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch (e) {
    if (esNoEncontrado(e)) return null
    throw e
  }
}

async function existeDirectorio(ruta: string): Promise<boolean> {
  try {
    return (await stat(ruta)).isDirectory()
  } catch {
    return false
  }
}

function parsearJson(texto: string): Resultado<unknown> {
  try {
    return { ok: true, data: JSON.parse(texto) }
  } catch {
    return { ok: false, error: "no es un JSON válido" }
  }
}

// ── Solicitud (Excel normalizado) ────────────────────────────────────────────

function describirProblema(issue: z.core.$ZodIssue, crudo: unknown): string {
  const campo = issue.path.map(String).join(".") || "solicitud"
  const falta = typeof crudo === "object" && crudo !== null && !(campo in crudo)
  if (falta) return `falta el campo "${campo}"`
  if (issue.code === "invalid_type") {
    return `el campo "${campo}" debe ser ${issue.expected === "number" ? "numérico" : `de tipo ${issue.expected}`}`
  }
  if (issue.code === "invalid_value") return `el campo "${campo}" debe ser uno de: ${issue.values.join(", ")}`
  return `el campo "${campo}" es inválido (${issue.message})`
}

function validarSolicitud(texto: string, caso: string): Resultado<Paquete["solicitud"]> {
  const json = parsearJson(texto)
  if (!json.ok) {
    return { ok: false, error: `solicitud.json del caso "${caso}" ${json.error}. Pida al solicitante reenviar el Excel de solicitud.` }
  }
  const parseo = SolicitudSchema.safeParse(json.data)
  if (parseo.success) return { ok: true, data: parseo.data }
  const problemas = parseo.error.issues.map((i) => describirProblema(i, json.data)).join("; ")
  return {
    ok: false,
    error: `La solicitud del caso "${caso}" tiene datos inválidos: ${problemas}. Pida al solicitante corregir esos campos en el Excel de solicitud y reenviarlo.`,
  }
}

// ── Parseo de textos ─────────────────────────────────────────────────────────

const capturar = (texto: string, patron: RegExp): string | null => texto.match(patron)?.[1]?.trim() ?? null

// Formato colombiano: punto de miles, coma decimal. "11.400.000" → 11400000; "1.250,50" → 1250.5
export function parsearMonto(crudo: string): number {
  const n = Number(crudo.trim().replace(/\./g, "").replace(",", "."))
  return Number.isFinite(n) ? n : 0
}

// Fecha de calendario real en YYYY-MM-DD ("2026-02-30" no lo es: V8 la convertiría en 2026-03-02).
export function fechaIsoValida(fecha: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false
  const d = new Date(`${fecha}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha
}

// "2026-08-21T10:02:00-05:00" → "2026-08-21"; "21/08/2026" → "2026-08-21". Si no hay fecha reconocible,
// devuelve el texto tal cual: las reglas de control lo tratan como fecha ilegible y piden confirmación.
export function recortarFecha(fecha: string): string {
  const texto = fecha.trim()
  const iso = texto.match(FECHA_ISO)?.[0]
  if (iso) return iso
  const dmy = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/)
  if (!dmy) return texto
  const [, dia = "", mes = "", anio = ""] = dmy
  const candidata = `${anio}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`
  return fechaIsoValida(candidata) ? candidata : texto
}

// Última línea "TOTAL (IVA incluido): COP 11.400.000" o "TOTAL: COP 3.200.000" → { moneda, total }
function extraerTotal(texto: string): { moneda: string | null; total: number } {
  const m = [...texto.matchAll(/^TOTAL\b[^:\n]*:\s*(?:([A-Z]{3})\s+)?([\d.,]+)/gim)].at(-1)
  if (!m?.[2]) return { moneda: null, total: 0 }
  return { moneda: m[1] ?? null, total: parsearMonto(m[2]) }
}

// null si la fecha no es una fecha real (p. ej. "2026-13-45" o "2026-02-30"): nunca lanza.
function sumarDias(fechaIso: string, dias: number): string | null {
  if (!fechaIsoValida(fechaIso)) return null
  const fecha = new Date(`${fechaIso}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): Cotizacion {
  const nit = capturar(texto, /^NIT:\s*(.+)$/im)
  const { moneda, total } = extraerTotal(texto)
  const fecha = capturar(texto, /^Fecha:\s*(.+)$/im)
  const dias = capturar(texto, /^Validez de la oferta:\s*(\d+)\s*d[ií]as/im)
  return {
    proveedor: capturar(texto, /^Proveedor:\s*(.+)$/im) ?? "",
    nit: nit ? normalizarNit(nit) || null : null,
    total,
    moneda: moneda ?? capturar(texto, /\b(COP|USD)\b/) ?? "",
    validez_hasta: fecha && dias ? sumarDias(recortarFecha(fecha), Number(dias)) : null,
    texto,
  }
}

// "Fecha de emisión: 2026-08-10", "Fecha de expedición: 10/08/2026", "Fecha de factura: …" o "Fecha: …".
// Si la fecha no se reconoce, se conserva el texto para que RC8 lo reporte como ilegible.
function fechaFactura(texto: string): string {
  const cruda = capturar(texto, /^Fecha(?: de (?:emisi[oó]n|expedici[oó]n|factura))?:\s*(.+)$/im)
  return cruda ? recortarFecha(cruda) : ""
}

export function parsearFactura(texto: string): Factura {
  return {
    numero: capturar(texto, /\bN(?:o\.?|[°º])\s*([A-Z]*-?\d[A-Z0-9-]*)/i) ?? "",
    fecha: fechaFactura(texto),
    total: extraerTotal(texto).total,
  }
}

// "Aprobado" como palabra completa, sin un "no" antes en la misma frase ("No aprobado" → false).
export function contieneAprobado(cuerpo: string): boolean {
  const negado = /\bno\b[^.,;:\n]*\baprobado\b/i.test(cuerpo)
  return !negado && /\baprobado\b/i.test(cuerpo)
}

function parsearAprobacion(texto: string): Resultado<Aprobacion> {
  const json = parsearJson(texto)
  if (!json.ok) return json
  const parseo = AprobacionCrudaSchema.safeParse(json.data)
  if (!parseo.success) return { ok: false, error: "no tiene los campos de, fecha y cuerpo" }
  const { de, fecha, cuerpo } = parseo.data
  return { ok: true, data: { de: de.trim(), fecha: recortarFecha(fecha), aprobado: contieneAprobado(cuerpo), texto: cuerpo } }
}

// ── Paquete ──────────────────────────────────────────────────────────────────

async function leerCorreo(carpeta: string, caso: string): Promise<Resultado<Paquete["correo"]>> {
  const texto = await leerTextoOpcional(path.join(carpeta, "correo.json"))
  if (texto === null) return { ok: false, error: `El caso "${caso}" no tiene correo.json. Pida al solicitante reenviar el correo de la solicitud.` }
  const json = parsearJson(texto)
  const parseo = json.ok ? CorreoSchema.safeParse(json.data) : null
  if (!parseo?.success) return { ok: false, error: `correo.json del caso "${caso}" no es válido. Pida al solicitante reenviar el correo de la solicitud.` }
  return { ok: true, data: parseo.data }
}

async function leerContenido(directorio: string, caso: string): Promise<Resultado<Paquete>> {
  const carpeta = path.join(directorio, RUTA_FIXTURES, "solicitudes", caso)
  if (!(await existeDirectorio(carpeta))) {
    return { ok: false, error: `No existe el caso "${caso}" en ${path.join(RUTA_FIXTURES, "solicitudes")}. Verifique el nombre de la carpeta del caso.` }
  }
  const correo = await leerCorreo(carpeta, caso)
  if (!correo.ok) return correo

  const textoSolicitud = await leerTextoOpcional(path.join(carpeta, "solicitud.json"))
  if (textoSolicitud === null) {
    return { ok: false, error: `El caso "${caso}" no tiene solicitud.json. Pida al solicitante adjuntar el Excel de solicitud.` }
  }
  const solicitud = validarSolicitud(textoSolicitud, caso)
  if (!solicitud.ok) return solicitud

  const [cotizacion, aprobacion, factura] = await Promise.all([
    leerTextoOpcional(path.join(carpeta, "cotizacion.txt")),
    leerTextoOpcional(path.join(carpeta, "aprobacion.json")),
    leerTextoOpcional(path.join(carpeta, "factura.txt")),
  ])
  const aprobacionParseada = aprobacion === null ? null : parsearAprobacion(aprobacion)
  if (aprobacionParseada && !aprobacionParseada.ok) {
    return { ok: false, error: `aprobacion.json del caso "${caso}" ${aprobacionParseada.error}. Pida al solicitante reenviar el correo de aprobación del líder.` }
  }

  const adjuntos = { cotizacion, aprobacion, factura }
  return {
    ok: true,
    data: {
      correo: correo.data,
      solicitud: solicitud.data,
      cotizacion: cotizacion === null ? null : parsearCotizacion(cotizacion),
      aprobacion: aprobacionParseada?.data ?? null,
      factura: factura === null ? null : parsearFactura(factura),
      faltantes: NOMBRES_ADJUNTOS.filter((nombre) => adjuntos[nombre] === null),
    },
  }
}

// `directorio` es la raíz del proyecto; el caso es una carpeta de fixtures/reto-03/solicitudes/.
export async function leerPaquete(directorio: string, caso: string): Promise<Resultado<Paquete>> {
  if (!PATRON_CASO.test(caso)) {
    return { ok: false, error: `Nombre de caso inválido: "${caso}". Use solo letras, números, guion y guion bajo (p. ej. "sol-001").` }
  }
  try {
    return await leerContenido(directorio, caso)
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `No fue posible leer el caso "${caso}": ${mensaje}` }
  }
}

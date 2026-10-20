import { appendFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import type { FilaControl } from "./tipos.ts"

// Log de control para contabilidad/auditoría (PRD HU-5): una fila por intento en out/control.csv.
export const RUTA_CONTROL = "out/control.csv"
export const COLUMNAS_CONTROL = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

// RFC 4180: comillas dobles alrededor del campo si trae coma, comilla o salto de línea; comilla interna se duplica.
export function escaparCsv(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function formatearFilaControl(fila: FilaControl): string {
  const campos = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(";"),
    fila.confirmaciones.join(";"),
    fila.ts,
  ]
  return campos.map(escaparCsv).join(",")
}

async function tieneContenido(ruta: string): Promise<boolean> {
  try {
    return (await stat(ruta)).size > 0
  } catch {
    return false
  }
}

// Agrega la fila; escribe el encabezado solo cuando el archivo no existe (o está vacío).
export async function registrarControl(directorio: string, fila: FilaControl): Promise<void> {
  const ruta = path.join(directorio, RUTA_CONTROL)
  await mkdir(path.dirname(ruta), { recursive: true })
  const encabezado = (await tieneContenido(ruta)) ? "" : `${COLUMNAS_CONTROL.join(",")}\n`
  await appendFile(ruta, `${encabezado}${formatearFilaControl(fila)}\n`, "utf8")
}

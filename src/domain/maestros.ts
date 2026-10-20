import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  type Maestros,
} from "./tipos.ts"

export const RUTA_FIXTURES = path.join("fixtures", "reto-03")

async function leerLista<T>(directorio: string, archivo: string, esquema: z.ZodType<T>): Promise<T[]> {
  const ruta = path.join(directorio, RUTA_FIXTURES, "maestros", archivo)
  return z.array(esquema).parse(JSON.parse(await readFile(ruta, "utf8")))
}

// Lanza si un maestro falta o está malformado: es un error de configuración, no de un caso.
export async function cargarMaestros(directorio: string): Promise<Maestros> {
  const [proveedores, centrosCosto, indicadoresIva, condicionesPago] = await Promise.all([
    leerLista(directorio, "proveedores.json", ProveedorSchema),
    leerLista(directorio, "centros-costo.json", CentroCostoSchema),
    leerLista(directorio, "indicadores-iva.json", IndicadorIvaSchema),
    leerLista(directorio, "condiciones-pago.json", CondicionPagoSchema),
  ])
  return { proveedores, centrosCosto, indicadoresIva, condicionesPago }
}

// Normalizaciones compartidas por paquete.ts y controles.ts.
export const soloDigitos = (s: string) => s.replace(/\D/g, "")

// "900.555.111-2" → "900555111" (quita puntos y dígito de verificación)
export function normalizarNit(nit: string): string {
  const sinDv = nit.includes("-") ? nit.slice(0, nit.lastIndexOf("-")) : nit
  return soloDigitos(sinDv)
}

// "TecnoSuministros S.A.S." → "tecnosuministros sas"
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

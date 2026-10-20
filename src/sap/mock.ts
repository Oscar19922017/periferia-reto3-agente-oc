import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { enCola } from "../domain/cola.ts"
import { normalizarNit } from "../domain/maestros.ts"
import { OrdenCompraSchema, type Maestros, type OrdenCompra } from "../domain/tipos.ts"
import type { SapAdapter } from "./adapter.ts"

// SAP simulado sobre archivos (PRD HU-5): una línea JSON por OC en out/sap/ordenes.jsonl.
export const RUTA_ORDENES = "out/sap/ordenes.jsonl"
export const PRIMER_NUMERO_OC = 4500000001

const RegistroOrdenSchema = z.object({ numero_oc: z.string(), fecha: z.string(), orden: OrdenCompraSchema })
type RegistroOrden = z.infer<typeof RegistroOrdenSchema>

function hoyIso(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, "0")
  const dia = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mes}-${dia}`
}

function siguienteNumero(registros: RegistroOrden[]): string {
  const mayor = registros.reduce((max, r) => {
    const n = Number(r.numero_oc)
    return Number.isFinite(n) ? Math.max(max, n) : max
  }, PRIMER_NUMERO_OC - 1)
  return String(mayor + 1)
}

function esArchivoInexistente(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
}

export class SapMock implements SapAdapter {
  private readonly rutaOrdenes: string

  constructor(
    directorio: string,
    private readonly maestros: Maestros,
  ) {
    this.rutaOrdenes = path.join(directorio, RUTA_ORDENES)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const buscado = normalizarNit(nit)
    const p = this.maestros.proveedores.find((x) => normalizarNit(x.nit) === buscado)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  // Lanza si la orden no cumple el esquema; quien llama captura.
  // Idempotente: la misma solicitud_id devuelve la OC ya creada sin escribir otra.
  // Leer → numerar → escribir va en cola por archivo: dos creaciones simultáneas no comparten número.
  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const valida = OrdenCompraSchema.parse(orden)
    return enCola(this.rutaOrdenes, async () => {
      const registros = await this.leerRegistros()
      const existente = registros.find((r) => r.orden.referencia.solicitud_id === valida.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }

      const registro: RegistroOrden = { numero_oc: siguienteNumero(registros), fecha: hoyIso(), orden: valida }
      await mkdir(path.dirname(this.rutaOrdenes), { recursive: true })
      await appendFile(this.rutaOrdenes, `${JSON.stringify(registro)}\n`, "utf8")
      return { numero_oc: registro.numero_oc, fecha: registro.fecha }
    })
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const registros = await this.leerRegistros()
    const r = registros.find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  private async leerRegistros(): Promise<RegistroOrden[]> {
    let contenido: string
    try {
      contenido = await readFile(this.rutaOrdenes, "utf8")
    } catch (e) {
      if (esArchivoInexistente(e)) return []
      throw e
    }
    return contenido
      .split("\n")
      .map((linea, i) => ({ linea, numero: i + 1 }))
      .filter(({ linea }) => linea.trim() !== "")
      .map(({ linea, numero }) => {
        try {
          return RegistroOrdenSchema.parse(JSON.parse(linea))
        } catch {
          throw new Error(`El SAP simulado está dañado en la línea ${numero} de ${RUTA_ORDENES}; limpia la carpeta out/ y vuelve a intentar`)
        }
      })
  }
}

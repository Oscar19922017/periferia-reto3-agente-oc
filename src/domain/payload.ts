import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Resultado } from "../tools/registry.ts"
import {
  OrdenCompraSchema,
  type Aprobador,
  type OrdenCompra,
  type Paquete,
  type Proveedor,
  type ResultadoValidacion,
  type Trazabilidad,
  type ValorDerivado,
} from "./tipos.ts"

// Construcción del payload de la OC (PRD HU-3, 7.4) con trazabilidad campo → fuente.

type Fuente =
  | "solicitud"
  | "cotizacion"
  | "correo"
  | "aprobacion"
  | "evidencia"
  | "maestro.proveedores"
  | "maestro.centros-costo"
  | "constante"
  | "validacion"
  | "confirmacion"
  | `derivado:${string}`

type Unidad = OrdenCompra["posiciones"][number]["unidad"]

interface Insumos {
  paquete: Paquete
  validacion: ResultadoValidacion
  aprobacion: NonNullable<Paquete["aprobacion"]>
  proveedor: Proveedor
  aprobador: Aprobador
}

const MAX_DESCRIPCION = 40
const SHA256_HEX = /^[0-9a-f]{64}$/i
const CASO_VALIDO = /^[\w-]+$/

export function construirPayload(
  paquete: Paquete,
  validacion: ResultadoValidacion,
  evidenciaSha256: string,
  confirmadoPor: string | null,
): Resultado<{ orden: OrdenCompra; trazabilidad: Trazabilidad }> {
  const insumos = reunirInsumos(paquete, validacion)
  if (!insumos.ok) return insumos
  if (!SHA256_HEX.test(evidenciaSha256)) {
    return { ok: false, error: "La evidencia de aprobación no tiene un sha256 válido; genera la evidencia primero" }
  }

  const pago = conFuente(paquete.solicitud.condiciones_pago, validacion.derivados.condiciones_pago)
  if (!pago) return { ok: false, error: "Faltan las condiciones de pago: ni la solicitud ni el maestro las informan" }
  const iva = conFuente(paquete.solicitud.indicador_iva, validacion.derivados.indicador_iva)
  if (!iva) return { ok: false, error: "Falta el indicador de IVA: ni la solicitud ni el maestro lo informan" }
  if (recortarDescripcion(paquete.solicitud.descripcion) === "") {
    return { ok: false, error: "La solicitud no trae descripción de lo que se compra; pídala al solicitante" }
  }

  const candidata = armarOrden(insumos.data, evidenciaSha256, confirmadoPor, pago.valor, iva.valor)
  const parseo = OrdenCompraSchema.safeParse(candidata)
  if (!parseo.success) return { ok: false, error: `El payload no cumple el esquema de la OC: ${z.prettifyError(parseo.error)}` }

  const trazabilidad = construirTrazabilidad(pago.fuente, iva.fuente, parseo.data.excepciones.length)
  return { ok: true, data: { orden: parseo.data, trazabilidad } }
}

function reunirInsumos(paquete: Paquete, validacion: ResultadoValidacion): Resultado<Insumos> {
  if (!validacion.apta) {
    const codigos = validacion.bloqueos.map((b) => b.codigo).join(", ") || "sin detalle"
    return { ok: false, error: `La solicitud no es apta para crear la OC (bloqueos: ${codigos})` }
  }
  if (!validacion.proveedor) return { ok: false, error: "No hay proveedor resuelto en el maestro" }
  if (!validacion.aprobador) return { ok: false, error: "No hay aprobador resuelto para el centro de costo" }
  if (!paquete.aprobacion) return { ok: false, error: "El paquete no trae el correo de aprobación" }
  return {
    ok: true,
    data: { paquete, validacion, aprobacion: paquete.aprobacion, proveedor: validacion.proveedor, aprobador: validacion.aprobador },
  }
}

function armarOrden(
  { paquete, validacion, aprobacion, proveedor, aprobador }: Insumos,
  evidenciaSha256: string,
  confirmadoPor: string | null,
  condicionesPago: string,
  indicadorIva: string,
): OrdenCompra {
  const { solicitud, correo, cotizacion } = paquete
  return {
    referencia: { solicitud_id: solicitud.solicitud_id, correo_id: correo.id, cotizacion_ref: extraerCotizacionRef(cotizacion?.texto) },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: solicitud.moneda,
    condiciones_pago: condicionesPago,
    // El email canónico sale del maestro (RC2 ya lo resolvió); la fecha, del correo de aprobación.
    aprobador: { email: aprobador.email, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion: recortarDescripcion(solicitud.descripcion),
        cantidad: solicitud.cantidad,
        unidad: inferirUnidad(solicitud.descripcion),
        precio_unitario: solicitud.valor_unitario,
        centro_costo: solicitud.centro_costo,
        subarea: solicitud.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: confirmadoPor })),
  }
}

// Valor informado en la solicitud, o el derivado del maestro; null si no hay ninguno.
function conFuente(desdeSolicitud: string | undefined, derivado: ValorDerivado | undefined): { valor: string; fuente: Fuente } | null {
  if (desdeSolicitud !== undefined && desdeSolicitud.trim() !== "") return { valor: desdeSolicitud, fuente: "solicitud" }
  if (derivado) return { valor: derivado.valor, fuente: `derivado:${derivado.fuente}` }
  return null
}

// Primera línea no vacía "COTIZACIÓN COT-TS-2026-0451" → "COT-TS-2026-0451".
export function extraerCotizacionRef(texto: string | undefined): string | null {
  const primera = (texto ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? ""
  const m = /^COTIZACI[ÓO]N\s+(\S+)/i.exec(primera.trim())
  return m?.[1] ?? null
}

// Texto breve SAP: máximo 40 caracteres; si la palabra no cabe, corta en el último espacio.
export function recortarDescripcion(texto: string, max = MAX_DESCRIPCION): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const corte = limpio.lastIndexOf(" ", max)
  return limpio.slice(0, corte > 0 ? corte : max).replace(/[\s,;:.-]+$/, "")
}

// Heurística: "hora/horas" → H; servicio mensual explícito ("mensual", "por mes") → MES; si no, UN.
export function inferirUnidad(descripcion: string): Unidad {
  if (/\bhoras?\b/i.test(descripcion)) return "H"
  if (/\b(mensual(?:es|idad(?:es)?)?|por mes|al mes)\b/i.test(descripcion)) return "MES"
  return "UN"
}

function construirTrazabilidad(fuentePago: Fuente, fuenteIva: Fuente, cantidadExcepciones: number): Trazabilidad {
  const traza: Record<string, Fuente> = {
    "referencia.solicitud_id": "solicitud",
    "referencia.correo_id": "correo",
    "referencia.cotizacion_ref": "cotizacion",
    sociedad: "constante",
    organizacion_compras: "constante",
    "proveedor.codigo_sap": "maestro.proveedores",
    "proveedor.nit": "maestro.proveedores",
    "proveedor.nombre": "maestro.proveedores",
    moneda: "solicitud",
    condiciones_pago: fuentePago,
    "aprobador.email": "maestro.centros-costo",
    "aprobador.fecha_aprobacion": "aprobacion",
    "aprobador.evidencia_sha256": "evidencia",
    "posiciones[0].numero": "constante",
    "posiciones[0].descripcion": "solicitud",
    "posiciones[0].cantidad": "solicitud",
    "posiciones[0].unidad": "derivado:solicitud.descripcion",
    "posiciones[0].precio_unitario": "solicitud",
    "posiciones[0].centro_costo": "solicitud",
    "posiciones[0].subarea": "solicitud",
    "posiciones[0].indicador_iva": fuenteIva,
  }
  for (let i = 0; i < cantidadExcepciones; i++) {
    traza[`excepciones[${i}].codigo`] = "validacion"
    traza[`excepciones[${i}].detalle`] = "validacion"
    traza[`excepciones[${i}].confirmado_por`] = "confirmacion"
  }
  return traza
}

// Escribe out/<caso>/trazabilidad.json y devuelve la ruta relativa con "/".
export async function guardarTrazabilidad(directorio: string, caso: string, trazabilidad: Trazabilidad): Promise<string> {
  if (!CASO_VALIDO.test(caso)) throw new Error(`Nombre de caso inválido: ${caso}`)
  const relativa = `out/${caso}/trazabilidad.json`
  const absoluta = path.join(directorio, relativa)
  await mkdir(path.dirname(absoluta), { recursive: true })
  await writeFile(absoluta, `${JSON.stringify(trazabilidad, null, 2)}\n`, "utf8")
  return relativa
}

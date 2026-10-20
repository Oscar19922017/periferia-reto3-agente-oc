import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { cargarMaestros } from "../src/domain/maestros.ts"
import {
  construirPayload,
  extraerCotizacionRef,
  guardarTrazabilidad,
  inferirUnidad,
  recortarDescripcion,
} from "../src/domain/payload.ts"
import { OrdenCompraSchema, SolicitudSchema, type Hallazgo, type Paquete, type ResultadoValidacion } from "../src/domain/tipos.ts"

const maestros = await cargarMaestros(process.cwd())
const SHA = "3f786850e387550fdab836ed7e6dc881de23001b1b8d7d6c7e3a6e0a1f5c2b9d"
const ANALISTA = "camila.ortiz@periferia-ficticia.com"

const CorreoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })
const AprobacionSchema = z.object({ de: z.string(), fecha: z.string(), cuerpo: z.string() })

// Paquete construido como literal tipado desde los fixtures reales (paquete.ts vive en otra rama).
async function paqueteDe(caso: string, cotizacion: { nit: string; total: number }): Promise<Paquete> {
  const base = path.join(process.cwd(), "fixtures", "reto-03", "solicitudes", caso)
  const leer = async (archivo: string) => readFile(path.join(base, archivo), "utf8")
  const correo = CorreoSchema.parse(JSON.parse(await leer("correo.json")))
  const solicitud = SolicitudSchema.parse(JSON.parse(await leer("solicitud.json")))
  const aprobacion = AprobacionSchema.parse(JSON.parse(await leer("aprobacion.json")))
  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: { proveedor: solicitud.proveedor_nombre, nit: cotizacion.nit, total: cotizacion.total, moneda: "COP", validez_hasta: null, texto: await leer("cotizacion.txt") },
    aprobacion: { de: aprobacion.de, fecha: aprobacion.fecha.slice(0, 10), aprobado: true, texto: aprobacion.cuerpo },
    factura: null,
    faltantes: [],
  }
}

function validacionApta(nit: string, centro: string, email: string, extra: Partial<ResultadoValidacion> = {}): ResultadoValidacion {
  const proveedor = maestros.proveedores.find((p) => p.nit === nit) ?? null
  const aprobador = maestros.centrosCosto.find((c) => c.centro_costo === centro)?.aprobadores.find((a) => a.email === email) ?? null
  return { apta: true, bloqueos: [], confirmaciones: [], derivados: {}, retroactiva: false, proveedor, aprobador, ...extra }
}

// Rutas hoja de un objeto en la misma notación de la trazabilidad: "posiciones[0].unidad".
function rutasHoja(valor: unknown, prefijo = ""): string[] {
  if (Array.isArray(valor)) return valor.flatMap((v, i) => rutasHoja(v, `${prefijo}[${i}]`))
  if (valor !== null && typeof valor === "object") {
    return Object.entries(valor).flatMap(([k, v]) => rutasHoja(v, prefijo ? `${prefijo}.${k}` : k))
  }
  return [prefijo]
}

async function directorioTemporal(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "payload-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("sol-001: payload válido con proveedor del maestro, pago e IVA de la solicitud y cotizacion_ref", async () => {
  const paquete = await paqueteDe("sol-001", { nit: "900555111", total: 11400000 })
  const validacion = validacionApta("900555111", "CC-1010", "mlopez@periferia-ficticia.com")

  const r = construirPayload(paquete, validacion, SHA, null)

  assert.ok(r.ok, r.ok ? "" : r.error)
  const { orden, trazabilidad } = r.data
  assert.ok(OrdenCompraSchema.safeParse(orden).success)
  assert.deepEqual(orden.referencia, { solicitud_id: "SOL-2026-001", correo_id: "sol-001-correo", cotizacion_ref: "COT-TS-2026-0451" })
  assert.equal(orden.sociedad, "1000")
  assert.equal(orden.organizacion_compras, "1000")
  assert.deepEqual(orden.proveedor, { codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." })
  assert.equal(orden.moneda, "COP")
  assert.equal(orden.condiciones_pago, "Z030")
  assert.deepEqual(orden.aprobador, { email: "mlopez@periferia-ficticia.com", fecha_aprobacion: "2026-08-21", evidencia_sha256: SHA })
  assert.equal(orden.posiciones.length, 1)
  const [pos] = orden.posiciones
  assert.ok(pos)
  assert.equal(pos.numero, 10)
  assert.ok(pos.descripcion.length <= 40)
  assert.equal(pos.descripcion, "Renovación licencias antivirus")
  assert.equal(pos.cantidad, 120)
  assert.equal(pos.unidad, "UN")
  assert.equal(pos.precio_unitario, 95000)
  assert.equal(pos.centro_costo, "CC-1010")
  assert.equal(pos.subarea, "Infraestructura")
  assert.equal(pos.indicador_iva, "C1")
  assert.deepEqual(orden.excepciones, [])

  assert.equal(trazabilidad["posiciones[0].indicador_iva"], "solicitud")
  assert.equal(trazabilidad["condiciones_pago"], "solicitud")
  assert.equal(trazabilidad["proveedor.codigo_sap"], "maestro.proveedores")
  assert.equal(trazabilidad["referencia.cotizacion_ref"], "cotizacion")
  assert.equal(trazabilidad["referencia.correo_id"], "correo")
  assert.equal(trazabilidad["aprobador.email"], "aprobacion")
  assert.equal(trazabilidad["aprobador.evidencia_sha256"], "evidencia")
  assert.equal(trazabilidad["sociedad"], "constante")
})

test("todo campo hoja del payload tiene fuente en la trazabilidad (y nada más)", async () => {
  const paquete = await paqueteDe("sol-004", { nit: "901222333", total: 26500000 })
  const rc5: Hallazgo = { codigo: "RC5", detalle: "solicitud 25.000.000 vs cotización 26.500.000 (6 %)", accion_sugerida: "Confirmar con el solicitante" }
  const validacion = validacionApta("901222333", "CC-1010", "dgarcia@periferia-ficticia.com", { confirmaciones: [rc5] })

  const r = construirPayload(paquete, validacion, SHA, ANALISTA)

  assert.ok(r.ok, r.ok ? "" : r.error)
  assert.deepEqual(rutasHoja(r.data.orden).sort(), Object.keys(r.data.trazabilidad).sort())
})

test("sol-004: '100 horas' → unidad H y la confirmación RC5 queda como excepción con confirmado_por", async () => {
  const paquete = await paqueteDe("sol-004", { nit: "901222333", total: 26500000 })
  const rc5: Hallazgo = { codigo: "RC5", detalle: "solicitud 25.000.000 vs cotización 26.500.000 (6 %)", accion_sugerida: "Confirmar con el solicitante" }
  const validacion = validacionApta("901222333", "CC-1010", "dgarcia@periferia-ficticia.com", { confirmaciones: [rc5] })

  const confirmada = construirPayload(paquete, validacion, SHA, ANALISTA)
  assert.ok(confirmada.ok, confirmada.ok ? "" : confirmada.error)
  assert.equal(confirmada.data.orden.posiciones[0]?.unidad, "H")
  assert.equal(confirmada.data.orden.posiciones[0]?.cantidad, 100)
  assert.equal(confirmada.data.orden.proveedor.codigo_sap, "100310")
  assert.equal(confirmada.data.orden.condiciones_pago, "Z000")
  assert.deepEqual(confirmada.data.orden.excepciones, [{ codigo: "RC5", detalle: rc5.detalle, confirmado_por: ANALISTA }])
  assert.equal(confirmada.data.trazabilidad["excepciones[0].codigo"], "validacion")
  assert.equal(confirmada.data.trazabilidad["excepciones[0].confirmado_por"], "confirmacion")

  const sinConfirmar = construirPayload(paquete, validacion, SHA, null)
  assert.ok(sinConfirmar.ok, sinConfirmar.ok ? "" : sinConfirmar.error)
  assert.equal(sinConfirmar.data.orden.excepciones[0]?.confirmado_por, null)
})

test("sol-006: IVA y condiciones de pago salen de los derivados y la trazabilidad lo dice", async () => {
  const paquete = await paqueteDe("sol-006", { nit: "900555111", total: 5400000 })
  assert.equal(paquete.solicitud.indicador_iva, undefined)
  assert.equal(paquete.solicitud.condiciones_pago, undefined)
  const rc6: Hallazgo = { codigo: "RC6", detalle: "Indicador de IVA no informado; se deriva C1 del proveedor", accion_sugerida: "Confirmar el indicador C1" }
  const validacion = validacionApta("900555111", "CC-1010", "mlopez@periferia-ficticia.com", {
    confirmaciones: [rc6],
    derivados: {
      indicador_iva: { valor: "C1", fuente: "maestro.proveedores.indicador_iva_default" },
      condiciones_pago: { valor: "Z030", fuente: "maestro.proveedores.condiciones_pago_default" },
    },
  })

  const r = construirPayload(paquete, validacion, SHA, ANALISTA)

  assert.ok(r.ok, r.ok ? "" : r.error)
  assert.equal(r.data.orden.posiciones[0]?.indicador_iva, "C1")
  assert.equal(r.data.orden.condiciones_pago, "Z030")
  assert.equal(r.data.trazabilidad["posiciones[0].indicador_iva"], "derivado:maestro.proveedores.indicador_iva_default")
  assert.equal(r.data.trazabilidad["condiciones_pago"], "derivado:maestro.proveedores.condiciones_pago_default")
  assert.deepEqual(r.data.orden.excepciones.map((e) => e.codigo), ["RC6"])
})

test("no apta → ok:false con los bloqueos; proveedor, aprobador o aprobación ausentes → ok:false", async () => {
  const paquete = await paqueteDe("sol-001", { nit: "900555111", total: 11400000 })
  const rc1: Hallazgo = { codigo: "RC1", detalle: "NIT 901999000 no existe", accion_sugerida: "Pedir creación del proveedor" }

  const bloqueada = construirPayload(paquete, { ...validacionApta("900555111", "CC-1010", "mlopez@periferia-ficticia.com"), apta: false, bloqueos: [rc1], proveedor: null }, SHA, null)
  assert.ok(!bloqueada.ok)
  assert.match(bloqueada.error, /RC1/)

  const sinProveedor = construirPayload(paquete, validacionApta("000", "CC-1010", "mlopez@periferia-ficticia.com"), SHA, null)
  assert.ok(!sinProveedor.ok)
  assert.match(sinProveedor.error, /proveedor/i)

  const sinAprobador = construirPayload(paquete, validacionApta("900555111", "CC-1010", "nadie@periferia-ficticia.com"), SHA, null)
  assert.ok(!sinAprobador.ok)
  assert.match(sinAprobador.error, /aprobador/i)

  const sinAprobacion = construirPayload({ ...paquete, aprobacion: null }, validacionApta("900555111", "CC-1010", "mlopez@periferia-ficticia.com"), SHA, null)
  assert.ok(!sinAprobacion.ok)
  assert.match(sinAprobacion.error, /aprobaci/i)
})

test("valida contra OrdenCompraSchema: cantidad 0 o sha256 inválido → error legible", async () => {
  const paquete = await paqueteDe("sol-001", { nit: "900555111", total: 11400000 })
  const validacion = validacionApta("900555111", "CC-1010", "mlopez@periferia-ficticia.com")

  const cantidadCero = construirPayload({ ...paquete, solicitud: { ...paquete.solicitud, cantidad: 0 } }, validacion, SHA, null)
  assert.ok(!cantidadCero.ok)
  assert.match(cantidadCero.error, /cantidad/)

  const shaMalo = construirPayload(paquete, validacion, "no-es-un-hash", null)
  assert.ok(!shaMalo.ok)
  assert.match(shaMalo.error, /sha256/)
})

test("sin IVA informado ni derivado → ok:false", async () => {
  const paquete = await paqueteDe("sol-006", { nit: "900555111", total: 5400000 })
  const validacion = validacionApta("900555111", "CC-1010", "mlopez@periferia-ficticia.com", {
    derivados: { condiciones_pago: { valor: "Z030", fuente: "maestro.proveedores.condiciones_pago_default" } },
  })

  const r = construirPayload(paquete, validacion, SHA, null)

  assert.ok(!r.ok)
  assert.match(r.error, /IVA/)
})

test("recortarDescripcion respeta 40 caracteres sin cortar palabras cuando puede", () => {
  assert.equal(recortarDescripcion("Renovación licencias antivirus corporativo 120 puestos, vigencia 12 meses"), "Renovación licencias antivirus")
  assert.equal(recortarDescripcion("Papelería y tóner para el trimestre"), "Papelería y tóner para el trimestre")
  assert.equal(recortarDescripcion("Diademas con micrófono para la mesa de soporte"), "Diademas con micrófono para la mesa de")
  assert.equal(recortarDescripcion("x".repeat(50)), "x".repeat(40))
  assert.equal(recortarDescripcion("  espacios   múltiples  "), "espacios múltiples")
})

test("inferirUnidad: horas → H, servicio mensual → MES, resto → UN", () => {
  assert.equal(inferirUnidad("Bolsa de 100 horas de arquitectura de nube"), "H")
  assert.equal(inferirUnidad("Una hora de consultoría"), "H")
  assert.equal(inferirUnidad("Servicio mensual de soporte"), "MES")
  assert.equal(inferirUnidad("Licencia antivirus 12 meses"), "UN")
  assert.equal(inferirUnidad("Entrega ahora mismo"), "UN")
  assert.equal(inferirUnidad("Diademas con micrófono"), "UN")
})

test("extraerCotizacionRef lee el código de la primera línea o devuelve null", () => {
  assert.equal(extraerCotizacionRef("COTIZACIÓN COT-TS-2026-0451\nFecha: 2026-08-18"), "COT-TS-2026-0451")
  assert.equal(extraerCotizacionRef("\n  cotizacion PC-5520\r\nFecha"), "PC-5520")
  assert.equal(extraerCotizacionRef("Propuesta comercial sin número"), null)
  assert.equal(extraerCotizacionRef(undefined), null)
})

test("guardarTrazabilidad escribe out/<caso>/trazabilidad.json y devuelve la ruta relativa", async (t) => {
  const dir = await directorioTemporal(t)
  const trazabilidad = { "referencia.solicitud_id": "solicitud", sociedad: "constante" }

  const ruta = await guardarTrazabilidad(dir, "sol-001", trazabilidad)

  assert.equal(ruta, "out/sol-001/trazabilidad.json")
  const guardada: unknown = JSON.parse(await readFile(path.join(dir, "out", "sol-001", "trazabilidad.json"), "utf8"))
  assert.deepEqual(guardada, trazabilidad)
  await assert.rejects(guardarTrazabilidad(dir, "../sol-001", trazabilidad), /inválido/)
})

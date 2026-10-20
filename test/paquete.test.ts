import { after, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  contieneAprobado,
  fechaIsoValida,
  leerPaquete,
  parsearCotizacion,
  parsearFactura,
  parsearMonto,
  recortarFecha,
} from "../src/domain/paquete.ts"
import type { Resultado } from "../src/tools/registry.ts"

const RAIZ = process.cwd()
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]

function exigirOk<T>(r: Resultado<T>): T {
  assert.ok(r.ok, r.ok ? undefined : r.error)
  return r.data
}

function exigirError<T>(r: Resultado<T>): string {
  assert.equal(r.ok, false, "se esperaba { ok: false }")
  return r.ok ? "" : r.error
}

// ── Casos sintéticos: directorio temporal con la estructura fixtures/reto-03/solicitudes/<caso>/ ──

const temporales: string[] = []
after(() => Promise.all(temporales.map((d) => rm(d, { recursive: true, force: true }))))

const CORREO = JSON.stringify({
  id: "caso-x-correo",
  de: "solicitante@periferia-ficticia.com",
  asunto: "Solicitud X",
  fecha: "2026-08-20T09:00:00-05:00",
})
const SOLICITUD = {
  solicitud_id: "SOL-X",
  solicitante: "Persona X",
  proveedor_nombre: "TecnoSuministros S.A.S.",
  proveedor_nit: "900555111",
  descripcion: "Compra de prueba",
  centro_costo: "CC-1010",
  subarea: "Soporte",
  cantidad: 2,
  valor_unitario: 100,
  valor_total: 200,
  moneda: "COP",
  fecha_solicitud: "2026-08-20",
}
const COTIZACION = [
  "COTIZACIÓN X-1",
  "Fecha: 2026-08-18",
  "Proveedor: TecnoSuministros S.A.S.",
  "NIT: 900.555.111-2",
  "",
  "TOTAL (IVA incluido): COP 200",
  "",
  "Validez de la oferta: 30 días",
].join("\n")
const aprobacionCon = (cuerpo: string) =>
  JSON.stringify({ de: "mlopez@periferia-ficticia.com", para: "x", fecha: "2026-08-21T10:02:00-05:00", asunto: "RE", cuerpo })

const BASE: Record<string, string> = {
  "correo.json": CORREO,
  "solicitud.json": JSON.stringify(SOLICITUD),
  "cotizacion.txt": COTIZACION,
  "aprobacion.json": aprobacionCon("Aprobado."),
}

async function crearCaso(archivos: Record<string, string>, caso = "caso-x"): Promise<string> {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "paquete-"))
  temporales.push(raiz)
  const carpeta = path.join(raiz, "fixtures", "reto-03", "solicitudes", caso)
  await mkdir(carpeta, { recursive: true })
  await Promise.all(Object.entries(archivos).map(([nombre, contenido]) => writeFile(path.join(carpeta, nombre), contenido, "utf8")))
  return raiz
}

const sin = (...nombres: string[]) => Object.fromEntries(Object.entries(BASE).filter(([n]) => !nombres.includes(n)))

// ── Fixtures reales ──────────────────────────────────────────────────────────

describe("leerPaquete con los fixtures reales", () => {
  test("sol-001: correo, solicitud, cotización y aprobación; sin factura", async () => {
    const { correo, solicitud, cotizacion, aprobacion, factura, faltantes } = exigirOk(await leerPaquete(RAIZ, "sol-001"))
    assert.equal(correo.id, "sol-001-correo")
    assert.equal(solicitud.solicitud_id, "SOL-2026-001")
    assert.ok(cotizacion)
    assert.deepEqual(
      { proveedor: cotizacion.proveedor, nit: cotizacion.nit, total: cotizacion.total, moneda: cotizacion.moneda, validez: cotizacion.validez_hasta },
      { proveedor: "TecnoSuministros S.A.S.", nit: "900555111", total: 11400000, moneda: "COP", validez: "2026-09-17" },
    )
    assert.ok(cotizacion.texto.includes("COT-TS-2026-0451"), "conserva el texto íntegro")
    assert.deepEqual(aprobacion, {
      de: "mlopez@periferia-ficticia.com",
      fecha: "2026-08-21",
      aprobado: true,
      texto: "Aprobado, proceder con la orden de compra.\n\nMariana López\nGerente de Tecnología",
    })
    assert.equal(factura, null)
    assert.deepEqual(faltantes, ["factura"])
  })

  test("sol-005: factura con número, fecha de emisión y total", async () => {
    const { factura, faltantes } = exigirOk(await leerPaquete(RAIZ, "sol-005"))
    assert.deepEqual(factura, { numero: "FC-88231", fecha: "2026-08-10", total: 3200000 })
    assert.deepEqual(faltantes, [])
  })

  test("sol-006: los opcionales ausentes de la solicitud quedan undefined y el NIT sale de la cotización", async () => {
    const { solicitud, cotizacion } = exigirOk(await leerPaquete(RAIZ, "sol-006"))
    assert.equal(solicitud.proveedor_nit, undefined)
    assert.equal(solicitud.indicador_iva, undefined)
    assert.equal(solicitud.condiciones_pago, undefined)
    assert.equal(cotizacion?.nit, "900555111")
  })

  test("los seis casos se leen sin error", async () => {
    for (const caso of CASOS) exigirOk(await leerPaquete(RAIZ, caso))
  })
})

// ── Parsers ──────────────────────────────────────────────────────────────────

describe("parsearCotizacion", () => {
  test("extrae proveedor, NIT normalizado, total colombiano, moneda y validez", () => {
    const c = parsearCotizacion(COTIZACION)
    assert.equal(c.proveedor, "TecnoSuministros S.A.S.")
    assert.equal(c.nit, "900555111")
    assert.equal(c.total, 200)
    assert.equal(c.moneda, "COP")
    assert.equal(c.validez_hasta, "2026-09-17")
    assert.equal(c.texto, COTIZACION)
  })

  test("lo que no encuentra queda en null/0, nunca inventado", () => {
    const c = parsearCotizacion("COTIZACIÓN sin datos\nProveedor: Alguien\n")
    assert.deepEqual(c, { proveedor: "Alguien", nit: null, total: 0, moneda: "", validez_hasta: null, texto: "COTIZACIÓN sin datos\nProveedor: Alguien\n" })
  })

  test("toma el último TOTAL del texto y entiende decimales con coma", () => {
    const c = parsearCotizacion("Fecha: 2026-01-31\nTotal IVA: COP 190\nTOTAL: USD 1.190,50\n")
    assert.equal(c.total, 1190.5)
    assert.equal(c.moneda, "USD")
    assert.equal(c.validez_hasta, null, "sin días de validez no hay fecha límite")
  })

  test("la validez cruza el cambio de mes y de año", () => {
    const c = parsearCotizacion("Fecha: 2026-12-20\nValidez de la oferta: 15 días\n")
    assert.equal(c.validez_hasta, "2027-01-04")
  })

  test("fecha inválida o inexistente no lanza y deja validez_hasta en null", () => {
    for (const fecha of ["2026-13-45", "2026-02-30", "ayer"]) {
      const c = parsearCotizacion(`Fecha: ${fecha}\nValidez de la oferta: 30 días\nTOTAL: COP 100\n`)
      assert.equal(c.validez_hasta, null, fecha)
      assert.equal(c.total, 100, "el resto de la cotización se sigue leyendo")
    }
  })

  test("fecha en DD/MM/YYYY también calcula la validez", () => {
    assert.equal(parsearCotizacion("Fecha: 18/08/2026\nValidez de la oferta: 30 días\n").validez_hasta, "2026-09-17")
  })
})

describe("fechaIsoValida", () => {
  test("solo acepta fechas de calendario reales en YYYY-MM-DD", () => {
    for (const ok of ["2026-08-18", "2024-02-29", "2026-12-31"]) assert.equal(fechaIsoValida(ok), true, ok)
    for (const mal of ["2026-02-30", "2026-13-45", "2026-8-1", "18/08/2026", "", "2026-08-18T10:00:00Z"]) {
      assert.equal(fechaIsoValida(mal), false, mal)
    }
  })
})

describe("parsearFactura", () => {
  test("extrae número, fecha de emisión y total de la factura real", () => {
    const texto = [
      "FACTURA ELECTRÓNICA DE VENTA No. FC-88231",
      "Fecha de emisión: 2026-08-10",
      "Base gravable: COP 2.689.076",
      "TOTAL: COP 3.200.000",
    ].join("\n")
    assert.deepEqual(parsearFactura(texto), { numero: "FC-88231", fecha: "2026-08-10", total: 3200000 })
  })

  test("sin datos reconocibles devuelve vacíos, sin confundir 'Nota' con un número", () => {
    assert.deepEqual(parsearFactura("Nota: documento sin número ni fecha"), { numero: "", fecha: "", total: 0 })
  })

  test("acepta 'Fecha de expedición', 'Fecha de factura', 'Fecha:' y DD/MM/YYYY", () => {
    assert.equal(parsearFactura("No. FC-1\nFecha de expedición: 2026-08-10\n").fecha, "2026-08-10")
    assert.equal(parsearFactura("No. FC-1\nFecha de factura: 2026-08-11\n").fecha, "2026-08-11")
    assert.equal(parsearFactura("No. FC-1\nFecha de emisión: 10/08/2026\n").fecha, "2026-08-10")
    assert.equal(parsearFactura("No. FC-1\nFecha: 9/8/2026\n").fecha, "2026-08-09")
  })

  test("una fecha ilegible se conserva tal cual para que RC8 la reporte", () => {
    assert.equal(parsearFactura("Fecha de emisión: Fri, 19 Aug 2026 10:02:00 -0500\n").fecha, "Fri, 19 Aug 2026 10:02:00 -0500")
    assert.equal(parsearFactura("Fecha de emisión: 31/02/2026\n").fecha, "31/02/2026")
    assert.equal(parsearFactura("Fecha de vencimiento: 2026-09-10\n").fecha, "", "el vencimiento no es la fecha de emisión")
  })
})

describe("parsearMonto (formato colombiano)", () => {
  test("punto de miles y coma decimal", () => {
    assert.equal(parsearMonto("11.400.000"), 11400000)
    assert.equal(parsearMonto("1.250,50"), 1250.5)
    assert.equal(parsearMonto(" 95.000 "), 95000)
  })
  test("texto no numérico → 0", () => {
    assert.equal(parsearMonto("abc"), 0)
  })
})

describe("aprobación", () => {
  test("contieneAprobado exige la palabra completa y niega 'No aprobado'", () => {
    assert.equal(contieneAprobado("Aprobado, proceder con la orden."), true)
    assert.equal(contieneAprobado("APROBADO"), true)
    assert.equal(contieneAprobado("No aprobado, falta presupuesto."), false)
    assert.equal(contieneAprobado("Por ahora no queda aprobado."), false)
    assert.equal(contieneAprobado("El aprobador revisará mañana."), false)
    assert.equal(contieneAprobado("No tengo objeción, aprobado."), true)
  })

  test("recortarFecha deja YYYY-MM-DD, convierte DD/MM/YYYY y respeta formatos desconocidos", () => {
    assert.equal(recortarFecha("2026-08-21T10:02:00-05:00"), "2026-08-21")
    assert.equal(recortarFecha("21/08/2026"), "2026-08-21")
    assert.equal(recortarFecha("31/02/2026"), "31/02/2026", "fecha inexistente no se convierte")
    assert.equal(recortarFecha("Fri, 19 Aug 2026 10:02:00 -0500"), "Fri, 19 Aug 2026 10:02:00 -0500")
  })

  test("una aprobación con fecha RFC 2822 conserva el texto (RC9 pedirá confirmación)", async () => {
    const cruda = JSON.parse(aprobacionCon("Aprobado.")) as Record<string, string>
    const raiz = await crearCaso({ ...BASE, "aprobacion.json": JSON.stringify({ ...cruda, fecha: "Fri, 21 Aug 2026 10:02:00 -0500" }) })
    const { aprobacion } = exigirOk(await leerPaquete(raiz, "caso-x"))
    assert.equal(aprobacion?.fecha, "Fri, 21 Aug 2026 10:02:00 -0500")
    assert.equal(aprobacion?.aprobado, true)
  })

  test("un correo con 'No aprobado' se lee con aprobado = false", async () => {
    const raiz = await crearCaso({ ...BASE, "aprobacion.json": aprobacionCon("No aprobado. Falta presupuesto.\n\nMariana López") })
    const { aprobacion } = exigirOk(await leerPaquete(raiz, "caso-x"))
    assert.deepEqual(aprobacion, { de: "mlopez@periferia-ficticia.com", fecha: "2026-08-21", aprobado: false, texto: "No aprobado. Falta presupuesto.\n\nMariana López" })
  })
})

// ── Errores y adjuntos faltantes ─────────────────────────────────────────────

describe("leerPaquete: errores legibles y adjuntos faltantes", () => {
  test("caso inexistente → ok:false con el nombre del caso", async () => {
    const error = exigirError(await leerPaquete(RAIZ, "no-existe"))
    assert.ok(error.includes('"no-existe"'), error)
  })

  test("nombres con path traversal o vacíos se rechazan sin tocar el disco", async () => {
    for (const caso of ["../x", "sol-001/../sol-002", "..\\x", "", "sol 001"]) {
      const error = exigirError(await leerPaquete(RAIZ, caso))
      assert.ok(error.includes("inválido"), `${caso}: ${error}`)
    }
  })

  test("cotización y factura ausentes → null y nombres en faltantes", async () => {
    const raiz = await crearCaso(sin("cotizacion.txt"))
    const { cotizacion, aprobacion, factura, faltantes } = exigirOk(await leerPaquete(raiz, "caso-x"))
    assert.equal(cotizacion, null)
    assert.equal(factura, null)
    assert.ok(aprobacion)
    assert.deepEqual(faltantes, ["cotizacion", "factura"])
  })

  test("aprobación ausente → null y 'aprobacion' en faltantes", async () => {
    const raiz = await crearCaso(sin("aprobacion.json"))
    const { aprobacion, faltantes } = exigirOk(await leerPaquete(raiz, "caso-x"))
    assert.equal(aprobacion, null)
    assert.deepEqual(faltantes, ["aprobacion", "factura"])
  })

  test("solicitud.json ausente → ok:false pidiendo el Excel", async () => {
    const raiz = await crearCaso(sin("solicitud.json"))
    const error = exigirError(await leerPaquete(raiz, "caso-x"))
    assert.ok(error.includes("solicitud.json") && error.includes("solicitante"), error)
  })

  test("solicitud.json malformado → ok:false", async () => {
    const raiz = await crearCaso({ ...BASE, "solicitud.json": "{ esto no es json" })
    const error = exigirError(await leerPaquete(raiz, "caso-x"))
    assert.ok(error.includes("JSON"), error)
  })

  test("monto no numérico → ok:false nombrando el campo", async () => {
    const raiz = await crearCaso({ ...BASE, "solicitud.json": JSON.stringify({ ...SOLICITUD, valor_total: "11.400.000" }) })
    const error = exigirError(await leerPaquete(raiz, "caso-x"))
    assert.ok(error.includes('"valor_total"') && error.includes("numérico"), error)
  })

  test("campo obligatorio ausente y moneda inválida se describen en español", async () => {
    const { centro_costo: _omitido, ...sinCentro } = SOLICITUD
    const raiz = await crearCaso({ ...BASE, "solicitud.json": JSON.stringify({ ...sinCentro, moneda: "EUR" }) })
    const error = exigirError(await leerPaquete(raiz, "caso-x"))
    assert.ok(error.includes('falta el campo "centro_costo"'), error)
    assert.ok(error.includes('"moneda" debe ser uno de: COP, USD'), error)
  })

  test("aprobacion.json malformado → ok:false", async () => {
    const raiz = await crearCaso({ ...BASE, "aprobacion.json": "{ roto" })
    const error = exigirError(await leerPaquete(raiz, "caso-x"))
    assert.ok(error.includes("aprobacion.json"), error)
  })

  test("una cotización con fecha inválida no tumba la lectura del paquete", async () => {
    const raiz = await crearCaso({ ...BASE, "cotizacion.txt": COTIZACION.replace("Fecha: 2026-08-18", "Fecha: 2026-13-45") })
    const { cotizacion } = exigirOk(await leerPaquete(raiz, "caso-x"))
    assert.equal(cotizacion?.validez_hasta, null)
    assert.equal(cotizacion?.total, 200)
  })

  test("correo.json ausente → ok:false", async () => {
    const raiz = await crearCaso(sin("correo.json"))
    const error = exigirError(await leerPaquete(raiz, "caso-x"))
    assert.ok(error.includes("correo.json"), error)
  })
})

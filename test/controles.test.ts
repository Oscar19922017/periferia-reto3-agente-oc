import { before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { validar } from "../src/domain/controles.ts"
import { cargarMaestros } from "../src/domain/maestros.ts"
import { leerPaquete } from "../src/domain/paquete.ts"
import type { CodigoControl, Hallazgo, Maestros, Paquete, ResultadoValidacion } from "../src/domain/tipos.ts"

const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"] as const
const DERIVADO_IVA_C1 = { valor: "C1", fuente: "maestro.proveedores.indicador_iva_default" }
const DERIVADO_PAGO_Z030 = { valor: "Z030", fuente: "maestro.proveedores.condiciones_pago_default" }

let maestros: Maestros
const paquetes = new Map<string, Paquete>()

before(async () => {
  maestros = await cargarMaestros(process.cwd())
  for (const caso of CASOS) {
    const r = await leerPaquete(process.cwd(), caso)
    assert.ok(r.ok, r.ok ? undefined : r.error)
    paquetes.set(caso, r.data)
  }
})

function paquete(caso: string): Paquete {
  const p = paquetes.get(caso)
  assert.ok(p, `paquete ${caso} no cargado`)
  return p
}

// Clon profundo para mutar sin tocar el paquete compartido.
const clonar = (caso: string = "sol-001"): Paquete => structuredClone(paquete(caso))
const codigos = (hallazgos: Hallazgo[]): CodigoControl[] => hallazgos.map((h) => h.codigo)
const resumen = (r: ResultadoValidacion) => ({
  apta: r.apta,
  bloqueos: codigos(r.bloqueos),
  confirmaciones: codigos(r.confirmaciones),
  derivados: r.derivados,
  retroactiva: r.retroactiva,
})

function conCotizacionDe(p: Paquete, total: number): Paquete {
  assert.ok(p.cotizacion, "el clon debe traer cotización")
  p.cotizacion.total = total
  return p
}

function unico(hallazgos: Hallazgo[], codigo: CodigoControl): Hallazgo {
  const encontrados = hallazgos.filter((h) => h.codigo === codigo)
  assert.equal(encontrados.length, 1, `se esperaba exactamente un ${codigo}`)
  return encontrados[0] as Hallazgo
}

// ── Tabla de resultados esperados con los fixtures reales ────────────────────

const ESPERADO: Array<{ caso: (typeof CASOS)[number] } & ReturnType<typeof resumen>> = [
  { caso: "sol-001", apta: true, bloqueos: [], confirmaciones: [], derivados: {}, retroactiva: false },
  { caso: "sol-002", apta: false, bloqueos: ["RC1"], confirmaciones: [], derivados: {}, retroactiva: false },
  { caso: "sol-003", apta: false, bloqueos: ["RC2"], confirmaciones: [], derivados: {}, retroactiva: false },
  { caso: "sol-004", apta: true, bloqueos: [], confirmaciones: ["RC5"], derivados: {}, retroactiva: false },
  { caso: "sol-005", apta: true, bloqueos: [], confirmaciones: ["RC8"], derivados: {}, retroactiva: true },
  {
    caso: "sol-006",
    apta: true,
    bloqueos: [],
    confirmaciones: ["RC6"],
    derivados: { indicador_iva: DERIVADO_IVA_C1, condiciones_pago: DERIVADO_PAGO_Z030 },
    retroactiva: false,
  },
]

describe("casos reales: tabla esperada", () => {
  for (const { caso, ...esperado } of ESPERADO) {
    test(`${caso} → apta=${esperado.apta} bloqueos=${esperado.bloqueos} confirmaciones=${esperado.confirmaciones}`, () => {
      assert.deepEqual(resumen(validar(paquete(caso), maestros)), esperado)
    })
  }
})

describe("casos reales: proveedor/aprobador resueltos y detalle con valores concretos", () => {
  test("sol-001 resuelve proveedor y aprobador", () => {
    const r = validar(paquete("sol-001"), maestros)
    assert.equal(r.proveedor?.codigo_sap, "100234")
    assert.equal(r.aprobador?.email, "mlopez@periferia-ficticia.com")
  })

  test("sol-002 (RC1): proveedor null y el detalle nombra el NIT inexistente", () => {
    const r = validar(paquete("sol-002"), maestros)
    assert.equal(r.proveedor, null)
    const h = unico(r.bloqueos, "RC1")
    assert.ok(h.detalle.includes("901999000") && h.detalle.includes("Soluciones Digitales del Norte"), h.detalle)
    assert.ok(h.accion_sugerida.includes("solicitante"), h.accion_sugerida)
  })

  test("sol-003 (RC2): aprobador null, se nombra quién sí aprueba y no se evalúa RC3", () => {
    const r = validar(paquete("sol-003"), maestros)
    assert.equal(r.aprobador, null)
    assert.equal(r.proveedor?.codigo_sap, "100150")
    const h = unico(r.bloqueos, "RC2")
    for (const esperado of ["fvargas@periferia-ficticia.com", "CC-2020", "rtorres@periferia-ficticia.com"]) {
      assert.ok(h.detalle.includes(esperado), `${h.detalle} debía incluir ${esperado}`)
    }
  })

  test("sol-004 (RC5): ambos montos en formato es-CO y el porcentaje", () => {
    const h = unico(validar(paquete("sol-004"), maestros).confirmaciones, "RC5")
    for (const esperado of ["COP 25.000.000", "COP 26.500.000", "6 %"]) {
      assert.ok(h.detalle.includes(esperado), `${h.detalle} debía incluir ${esperado}`)
    }
  })

  test("sol-005 (RC8): número de factura y ambas fechas", () => {
    const h = unico(validar(paquete("sol-005"), maestros).confirmaciones, "RC8")
    for (const esperado of ["FC-88231", "2026-08-10", "2026-08-27"]) {
      assert.ok(h.detalle.includes(esperado), `${h.detalle} debía incluir ${esperado}`)
    }
  })

  test("sol-006 (RC6): el detalle explica el indicador derivado y su origen", () => {
    const h = unico(validar(paquete("sol-006"), maestros).confirmaciones, "RC6")
    assert.ok(h.detalle.includes("C1") && h.detalle.includes("TecnoSuministros"), h.detalle)
    assert.ok(h.accion_sugerida.includes("C1"), h.accion_sugerida)
  })
})

// ── Casos sintéticos: clones mutados de los paquetes reales ──────────────────

describe("RC1 · proveedor", () => {
  test("proveedor inactivo (NIT 901777888) bloquea con mensaje distinto y queda resuelto", () => {
    const p = clonar()
    p.solicitud.proveedor_nit = "901777888"
    p.solicitud.proveedor_nombre = "Consultores Ágiles S.A.S."
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC1"])
    assert.equal(r.apta, false)
    assert.equal(r.proveedor?.codigo_sap, "100402")
    assert.equal(r.proveedor?.activo, false)
    assert.ok(unico(r.bloqueos, "RC1").detalle.includes("inactivo"))
  })

  test("sin NIT se busca por nombre normalizado", () => {
    const p = clonar()
    delete p.solicitud.proveedor_nit
    p.solicitud.proveedor_nombre = "tecnosuministros sas"
    const r = validar(p, maestros)
    assert.equal(r.apta, true)
    assert.equal(r.proveedor?.codigo_sap, "100234")
  })

  test("el NIT se normaliza (puntos y dígito de verificación)", () => {
    const p = clonar()
    p.solicitud.proveedor_nit = "900.555.111-2"
    assert.equal(validar(p, maestros).proveedor?.codigo_sap, "100234")
  })
})

describe("RC2 / RC3 / RC4 · aprobación, tope y subárea", () => {
  test("RC2: sin aprobación bloquea", () => {
    const p = clonar()
    p.aprobacion = null
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC2"])
    assert.equal(r.aprobador, null)
  })

  test("RC2: correo sin 'Aprobado' bloquea aunque el remitente sea aprobador", () => {
    const p = clonar()
    assert.ok(p.aprobacion)
    p.aprobacion.aprobado = false
    p.aprobacion.texto = "No aprobado, falta presupuesto."
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC2"])
    assert.equal(r.aprobador?.email, "mlopez@periferia-ficticia.com")
    assert.ok(unico(r.bloqueos, "RC2").detalle.includes('"Aprobado"'))
  })

  test("RC2: centro de costo inexistente bloquea por RC2 y no evalúa RC4", () => {
    const p = clonar()
    p.solicitud.centro_costo = "CC-9999"
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC2"])
    assert.ok(unico(r.bloqueos, "RC2").detalle.includes("CC-9999"))
  })

  test("RC3: valor por encima del tope bloquea y sugiere un aprobador con tope suficiente", () => {
    const p = conCotizacionDe(clonar(), 60000000)
    p.solicitud.valor_unitario = 500000
    p.solicitud.valor_total = 60000000
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC3"])
    assert.deepEqual(codigos(r.confirmaciones), [])
    const h = unico(r.bloqueos, "RC3")
    assert.ok(h.detalle.includes("COP 60.000.000") && h.detalle.includes("COP 50.000.000"), h.detalle)
    assert.ok(h.accion_sugerida.includes("dgarcia@periferia-ficticia.com"), h.accion_sugerida)
  })

  test("RC3: valor igual al tope no bloquea", () => {
    const p = conCotizacionDe(clonar(), 50000000)
    p.solicitud.cantidad = 1
    p.solicitud.valor_unitario = 50000000
    p.solicitud.valor_total = 50000000
    assert.deepEqual(codigos(validar(p, maestros).bloqueos), [])
  })

  test("RC4: subárea de otro centro bloquea y lista las válidas", () => {
    const p = clonar()
    p.solicitud.subarea = "Marketing"
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC4"])
    assert.ok(unico(r.bloqueos, "RC4").detalle.includes("Infraestructura, Soporte, Desarrollo"))
  })

  test("RC4: la comparación ignora mayúsculas y tildes", () => {
    const p = clonar()
    p.solicitud.subarea = "INFRAESTRUCTURA"
    assert.equal(validar(p, maestros).apta, true)
  })
})

describe("RC5 · cotización", () => {
  test("sin cotización pide confirmación con el valor de la solicitud", () => {
    const p = clonar()
    p.cotizacion = null
    const r = validar(p, maestros)
    assert.equal(r.apta, true)
    assert.deepEqual(codigos(r.confirmaciones), ["RC5"])
    assert.ok(unico(r.confirmaciones, "RC5").detalle.includes("COP 11.400.000"))
  })

  test("desviación dentro del 2 % no genera confirmación", () => {
    const p = conCotizacionDe(clonar(), 11600000) // 1,75 %
    assert.deepEqual(codigos(validar(p, maestros).confirmaciones), [])
  })

  test("total de cotización ilegible (0) pide confirmación", () => {
    const p = conCotizacionDe(clonar(), 0)
    assert.deepEqual(codigos(validar(p, maestros).confirmaciones), ["RC5"])
  })

  test("el borde exacto del 2 % con decimales no pide confirmación (3 vs 3,06); 3,07 sí", () => {
    const p = clonar()
    p.solicitud.cantidad = 1
    p.solicitud.valor_unitario = 3
    p.solicitud.valor_total = 3
    assert.deepEqual(codigos(validar(conCotizacionDe(p, 3.06), maestros).confirmaciones), [])
    assert.deepEqual(codigos(validar(conCotizacionDe(p, 3.07), maestros).confirmaciones), ["RC5"])
  })

  test("valor total de la solicitud no positivo pide confirmación sin imprimir infinito", () => {
    const p = clonar()
    p.solicitud.cantidad = 1
    p.solicitud.valor_unitario = 0
    p.solicitud.valor_total = 0
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.confirmaciones), ["RC5"])
    const h = unico(r.confirmaciones, "RC5")
    assert.ok(h.detalle.includes("no es válido") && !h.detalle.includes("∞"), h.detalle)
  })
})

describe("RC6 / RC7 · derivados", () => {
  test("RC6: indicador informado que no existe en el maestro pide confirmación sin derivar", () => {
    const p = clonar()
    p.solicitud.indicador_iva = "C9"
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.confirmaciones), ["RC6"])
    assert.deepEqual(r.derivados, {})
    assert.ok(unico(r.confirmaciones, "RC6").detalle.includes("C0, C1, C2"))
  })

  test("RC6/RC7: con IVA y condiciones informados no se deriva nada", () => {
    assert.deepEqual(validar(paquete("sol-001"), maestros).derivados, {})
  })

  test("RC7: condiciones de pago ausentes se derivan sin pedir confirmación", () => {
    const p = clonar()
    delete p.solicitud.condiciones_pago
    const r = validar(p, maestros)
    assert.deepEqual(r.derivados, { condiciones_pago: DERIVADO_PAGO_Z030 })
    assert.deepEqual(codigos(r.confirmaciones), [])
  })
})

describe("RC8 / RC9 / RC10 · fechas y aritmética", () => {
  test("RC9: aprobación anterior a la solicitud pide confirmación", () => {
    const p = clonar()
    assert.ok(p.aprobacion)
    p.aprobacion.fecha = "2026-08-19"
    const r = validar(p, maestros)
    assert.equal(r.apta, true)
    assert.deepEqual(codigos(r.confirmaciones), ["RC9"])
    const h = unico(r.confirmaciones, "RC9")
    assert.ok(h.detalle.includes("2026-08-19") && h.detalle.includes("2026-08-20"), h.detalle)
  })

  test("RC8: factura posterior a la solicitud no es retroactiva", () => {
    const p = clonar("sol-005")
    assert.ok(p.factura)
    p.factura.fecha = "2026-08-30"
    const r = validar(p, maestros)
    assert.equal(r.retroactiva, false)
    assert.deepEqual(codigos(r.confirmaciones), [])
  })

  test("RC10: cantidad × valor unitario distinto del total bloquea", () => {
    const p = conCotizacionDe(clonar(), 11400500)
    p.solicitud.valor_total = 11400500
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.bloqueos), ["RC10"])
    const h = unico(r.bloqueos, "RC10")
    assert.ok(h.detalle.includes("COP 11.400.000") && h.detalle.includes("COP 11.400.500"), h.detalle)
  })

  test("RC10: una diferencia de ± 1 se tolera", () => {
    const p = conCotizacionDe(clonar(), 11400001)
    p.solicitud.valor_total = 11400001
    assert.deepEqual(codigos(validar(p, maestros).bloqueos), [])
  })

  test("RC8: fecha de factura ilegible pide confirmación sin marcar retroactiva", () => {
    const p = clonar("sol-005")
    assert.ok(p.factura)
    p.factura.fecha = "Fri, 07 Aug 2026 09:00:00 -0500"
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.confirmaciones), ["RC8"])
    assert.equal(r.retroactiva, false)
    const h = unico(r.confirmaciones, "RC8")
    assert.ok(h.detalle.includes("No se pudo leer") && h.detalle.includes("FC-88231") && h.detalle.includes("Fri, 07 Aug 2026"), h.detalle)
    assert.ok(h.accion_sugerida.includes("retroactiva"), h.accion_sugerida)
  })

  test("RC8: una fecha con forma ISO pero inexistente (2026-02-30) también es ilegible", () => {
    const p = clonar("sol-005")
    assert.ok(p.factura)
    p.factura.fecha = "2026-02-30"
    const r = validar(p, maestros)
    assert.deepEqual(codigos(r.confirmaciones), ["RC8"])
    assert.equal(r.retroactiva, false)
    assert.ok(unico(r.confirmaciones, "RC8").detalle.includes("No se pudo leer"))
  })

  test("RC9: fecha de aprobación no ISO pide confirmación", () => {
    const p = clonar()
    assert.ok(p.aprobacion)
    p.aprobacion.fecha = "Fri, 19 Aug 2026 10:02:00 -0500"
    const r = validar(p, maestros)
    assert.equal(r.apta, true)
    assert.deepEqual(codigos(r.confirmaciones), ["RC9"])
    const h = unico(r.confirmaciones, "RC9")
    assert.ok(h.detalle.includes("No se pudo leer") && h.detalle.includes("Fri, 19 Aug 2026"), h.detalle)
  })

  test("RC10: cantidad y valor total en cero bloquean aunque haya cotización", () => {
    const p = clonar()
    p.solicitud.cantidad = 0
    p.solicitud.valor_total = 0
    const r = validar(p, maestros)
    assert.equal(r.apta, false)
    assert.deepEqual(codigos(r.bloqueos), ["RC10"])
    assert.deepEqual(codigos(r.confirmaciones), ["RC5"])
    assert.ok(!unico(r.confirmaciones, "RC5").detalle.includes("∞"))
    const h = unico(r.bloqueos, "RC10")
    assert.ok(h.detalle.includes("cantidad 0") && h.detalle.includes("valor total COP 0"), h.detalle)
    assert.ok(h.accion_sugerida.includes("positivos"), h.accion_sugerida)
  })

  test("RC10: cantidad y valor unitario negativos con total positivo bloquean", () => {
    const p = clonar()
    p.solicitud.cantidad = -120
    p.solicitud.valor_unitario = -95000
    const r = validar(p, maestros)
    assert.equal(r.apta, false)
    assert.deepEqual(codigos(r.bloqueos), ["RC10"])
    const h = unico(r.bloqueos, "RC10")
    assert.ok(h.detalle.includes("cantidad -120") && h.detalle.includes("COP -95.000"), h.detalle)
  })
})

test("validar es pura: no muta el paquete ni los maestros", () => {
  const p = clonar("sol-006")
  const copiaPaquete = structuredClone(p)
  const copiaMaestros = structuredClone(maestros)
  validar(p, maestros)
  assert.deepEqual(p, copiaPaquete)
  assert.deepEqual(maestros, copiaMaestros)
})

import { normalizarNit, normalizarNombre } from "./maestros.ts"
import type {
  CentroCosto,
  CodigoControl,
  Hallazgo,
  Maestros,
  Paquete,
  Proveedor,
  ResultadoValidacion,
  Solicitud,
} from "./tipos.ts"

// Reglas de control RC1–RC10 (PRD 7.3). `validar` es pura: no hace I/O ni muta el paquete ni los maestros.
// Cada regla es una función que lee el contexto y anota hallazgos en el resultado que se va construyendo.

const TOLERANCIA_COTIZACION = 0.02 // RC5: 2 % de desviación entre cotización y solicitud
const TOLERANCIA_ARITMETICA = 1 // RC10: ± 1 unidad monetaria
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/

const formatoNumero = new Intl.NumberFormat("es-CO")
const formatoPorcentaje = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 })

const monto = (valor: number, moneda: string) => `${moneda} ${formatoNumero.format(valor)}`
const porcentaje = (fraccion: number) => `${formatoPorcentaje.format(fraccion * 100)} %`
const describirTexto = (s: string) => (s ? ` (texto: "${s}")` : "")

// Fecha de calendario real en YYYY-MM-DD ("2026-02-30" no lo es: V8 la convertiría en 2026-03-02).
function fechaIsoValida(fecha: string): boolean {
  if (!FECHA_ISO.test(fecha)) return false
  const d = new Date(`${fecha}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha
}
// Campo opcional sin valor útil (undefined o solo espacios). El guard permite usar el valor como string en la rama contraria.
const ausente = (s: string | undefined): s is undefined | "" => s === undefined || s.trim() === ""
const mismoEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const primeraLinea = (texto: string) => texto.trim().split("\n")[0]?.slice(0, 80) ?? ""
const listarAprobadores = (centro: CentroCosto) => centro.aprobadores.map((a) => `${a.email} (${a.nombre})`).join(", ")

interface Contexto {
  paquete: Paquete
  maestros: Maestros
  centro: CentroCosto | null // centro de costo de la solicitud, si existe en el maestro
  resultado: ResultadoValidacion
}

function anotar(lista: Hallazgo[], codigo: CodigoControl, detalle: string, accion_sugerida: string): void {
  lista.push({ codigo, detalle, accion_sugerida })
}

// ── RC1 · Proveedor existe y está activo ─────────────────────────────────────

function buscarProveedor(solicitud: Solicitud, proveedores: Proveedor[]): Proveedor | null {
  const nit = ausente(solicitud.proveedor_nit) ? "" : normalizarNit(solicitud.proveedor_nit)
  if (nit) return proveedores.find((p) => normalizarNit(p.nit) === nit) ?? null
  const nombre = normalizarNombre(solicitud.proveedor_nombre)
  return proveedores.find((p) => normalizarNombre(p.nombre) === nombre) ?? null
}

function rc1Proveedor({ paquete: { solicitud }, maestros, resultado }: Contexto): void {
  const proveedor = buscarProveedor(solicitud, maestros.proveedores)
  resultado.proveedor = proveedor
  if (proveedor?.activo) return
  if (!proveedor) {
    const identidad = ausente(solicitud.proveedor_nit) ? "sin NIT" : `NIT ${normalizarNit(solicitud.proveedor_nit)}`
    anotar(
      resultado.bloqueos,
      "RC1",
      `El proveedor "${solicitud.proveedor_nombre}" (${identidad}) no existe en el maestro de proveedores.`,
      "Pida al solicitante confirmar el NIT y la razón social del proveedor, o solicite a contabilidad crearlo en SAP antes de generar la OC.",
    )
    return
  }
  anotar(
    resultado.bloqueos,
    "RC1",
    `El proveedor ${proveedor.nombre} (NIT ${proveedor.nit}, código SAP ${proveedor.codigo_sap}) existe pero está inactivo en el maestro.`,
    "Solicite a contabilidad reactivar el proveedor en SAP o pida al solicitante cotizar con un proveedor activo.",
  )
}

// ── RC2 · Aprobación válida de un aprobador del centro ───────────────────────

function rc2Aprobacion({ paquete: { solicitud, aprobacion }, maestros, centro, resultado }: Contexto): void {
  const cc = solicitud.centro_costo
  const bloquear = (detalle: string, accion: string) => anotar(resultado.bloqueos, "RC2", detalle, accion)
  if (!aprobacion) {
    return bloquear(
      `No se encontró el correo de aprobación para la solicitud ${solicitud.solicitud_id}.`,
      `Pida al solicitante reenviar el correo de aprobación del líder del centro ${cc}.`,
    )
  }
  if (!centro) {
    return bloquear(
      `El centro de costo "${cc}" no existe en el maestro; no es posible verificar quién puede aprobar.`,
      `Pida al solicitante corregir el centro de costo en la solicitud (centros válidos: ${maestros.centrosCosto.map((c) => c.centro_costo).join(", ")}).`,
    )
  }
  const aprobador = centro.aprobadores.find((a) => mismoEmail(a.email, aprobacion.de)) ?? null
  resultado.aprobador = aprobador
  if (!aprobador) {
    return bloquear(
      `${aprobacion.de} no está autorizado para aprobar en el centro ${cc} (${centro.nombre}); aprobadores válidos: ${listarAprobadores(centro)}.`,
      `Pida la aprobación a uno de los aprobadores del centro ${cc}, o corrija el centro de costo si la solicitud debía ir a otro.`,
    )
  }
  if (!aprobacion.aprobado) {
    bloquear(
      `El correo de ${aprobacion.de} del ${aprobacion.fecha} no contiene la palabra "Aprobado" (dice: "${primeraLinea(aprobacion.texto)}").`,
      `Pida al líder ${aprobacion.de} responder explícitamente "Aprobado" a la solicitud ${solicitud.solicitud_id}.`,
    )
  }
}

// ── RC3 · Valor dentro del tope del aprobador ────────────────────────────────

function rc3Tope({ paquete: { solicitud }, centro, resultado }: Contexto): void {
  const { aprobador } = resultado
  const { valor_total, moneda, centro_costo } = solicitud
  if (!aprobador || valor_total <= aprobador.tope) return
  const conTope = (centro?.aprobadores ?? []).filter((a) => a.tope >= valor_total)
  const accion = conTope.length
    ? `Solicite la aprobación a ${conTope.map((a) => `${a.email} (tope ${monto(a.tope, moneda)})`).join(" o ")}.`
    : `Ningún aprobador del centro ${centro_costo} tiene tope suficiente; escale la aprobación según la matriz vigente o divida la compra.`
  anotar(
    resultado.bloqueos,
    "RC3",
    `El valor total ${monto(valor_total, moneda)} supera el tope ${monto(aprobador.tope, moneda)} de ${aprobador.email} en el centro ${centro_costo}.`,
    accion,
  )
}

// ── RC4 · Subárea pertenece al centro ────────────────────────────────────────

function rc4Subarea({ paquete: { solicitud }, centro, resultado }: Contexto): void {
  if (!centro) return // el centro inexistente ya lo bloqueó RC2
  const objetivo = normalizarNombre(solicitud.subarea)
  if (centro.subareas.some((s) => normalizarNombre(s) === objetivo)) return
  anotar(
    resultado.bloqueos,
    "RC4",
    `La subárea "${solicitud.subarea}" no pertenece al centro ${solicitud.centro_costo} (${centro.nombre}); subáreas válidas: ${centro.subareas.join(", ")}.`,
    "Pida al solicitante corregir la subárea o el centro de costo en la solicitud.",
  )
}

// ── RC5 · Cotización presente y dentro del 2 % ───────────────────────────────

function rc5Cotizacion({ paquete: { solicitud, cotizacion }, resultado }: Contexto): void {
  const valor = monto(solicitud.valor_total, solicitud.moneda)
  const confirmar = (detalle: string, accion: string) => anotar(resultado.confirmaciones, "RC5", detalle, accion)
  if (!cotizacion) {
    return confirmar(
      `La solicitud ${solicitud.solicitud_id} no trae cotización; no es posible contrastar el valor ${valor}.`,
      "Pida al solicitante adjuntar la cotización del proveedor, o confirme que la OC se crea sin cotización.",
    )
  }
  if (solicitud.valor_total <= 0) {
    return confirmar(
      `El valor total de la solicitud (${valor}) no es válido: debe ser mayor que cero; no es posible contrastarlo con la cotización.`,
      "Pida al solicitante corregir el valor total de la solicitud antes de crear la OC.",
    )
  }
  if (cotizacion.total === 0) {
    return confirmar(
      `No se pudo leer el total de la cotización para contrastarlo con el valor de la solicitud (${valor}).`,
      "Revise la cotización manualmente y confirme el valor, o pida al solicitante una cotización legible.",
    )
  }
  // Redondeo a 6 decimales: 3,06 vs 3 da 0,020000000000000018 en coma flotante y debe contar como 2 % exacto.
  const desviacion = Math.round((Math.abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total) * 1e6) / 1e6
  if (desviacion <= TOLERANCIA_COTIZACION) return
  confirmar(
    `El valor de la solicitud ${valor} difiere del total de la cotización ${monto(cotizacion.total, cotizacion.moneda || solicitud.moneda)} en ${porcentaje(desviacion)} (tolerancia ${porcentaje(TOLERANCIA_COTIZACION)}).`,
    "Confirme con el solicitante cuál valor es el correcto y, si corresponde, pida una solicitud o cotización actualizada antes de crear la OC.",
  )
}

// ── RC6 · Indicador de IVA (derivado del proveedor si falta) ─────────────────

function describirIva(codigo: string, maestros: Maestros): string {
  const indicador = maestros.indicadoresIva.find((i) => i.codigo === codigo)
  return indicador ? `${codigo} (${indicador.descripcion})` : codigo
}

function rc6IndicadorIva({ paquete: { solicitud }, maestros, resultado }: Contexto): void {
  const confirmar = (detalle: string, accion: string) => anotar(resultado.confirmaciones, "RC6", detalle, accion)
  if (!ausente(solicitud.indicador_iva)) {
    // Supuesto: un indicador informado que no existe en el maestro no se corrige en silencio; se pide confirmación.
    const codigo = solicitud.indicador_iva.trim()
    if (maestros.indicadoresIva.some((i) => i.codigo === codigo)) return
    return confirmar(
      `El indicador de IVA "${codigo}" informado en la solicitud no existe en el maestro (válidos: ${maestros.indicadoresIva.map((i) => i.codigo).join(", ")}).`,
      "Pida al solicitante corregir el indicador de IVA o confirme cuál aplica a esta compra.",
    )
  }
  const { proveedor } = resultado
  if (!proveedor) {
    return confirmar(
      "La solicitud no informa indicador de IVA y no se pudo derivar porque el proveedor no está en el maestro.",
      "Resuelva primero el proveedor (RC1) o pida al solicitante indicar el IVA aplicable.",
    )
  }
  const codigo = proveedor.indicador_iva_default
  resultado.derivados.indicador_iva = { valor: codigo, fuente: "maestro.proveedores.indicador_iva_default" }
  confirmar(
    `La solicitud no informa indicador de IVA; se tomó ${describirIva(codigo, maestros)}, el valor por defecto del proveedor ${proveedor.nombre} en el maestro.`,
    `Confirme que el indicador de IVA ${codigo} aplica a esta compra o indique el correcto.`,
  )
}

// ── RC7 · Condiciones de pago (derivado del proveedor, solo informa) ─────────

function rc7CondicionesPago({ paquete: { solicitud }, resultado }: Contexto): void {
  const { proveedor } = resultado
  if (!ausente(solicitud.condiciones_pago) || !proveedor) return
  resultado.derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
}

// ── RC8 · Factura anterior a la solicitud (OC retroactiva) ───────────────────

function rc8Retroactiva({ paquete: { solicitud, factura }, resultado }: Contexto): void {
  if (!factura) return
  const confirmar = (detalle: string, accion: string) => anotar(resultado.confirmaciones, "RC8", detalle, accion)
  const numero = factura.numero || "(sin número)"
  if (!fechaIsoValida(factura.fecha)) {
    return confirmar(
      `No se pudo leer la fecha de la factura ${numero}${describirTexto(factura.fecha)}; no es posible saber si es anterior a la solicitud del ${solicitud.fecha_solicitud}.`,
      "Revise la factura y confirme si su fecha es anterior a la solicitud (la OC sería retroactiva), o pida al solicitante una factura legible.",
    )
  }
  if (factura.fecha >= solicitud.fecha_solicitud) return
  resultado.retroactiva = true
  confirmar(
    `La factura ${numero} fue emitida el ${factura.fecha}, antes de la fecha de solicitud ${solicitud.fecha_solicitud}: la OC sería retroactiva.`,
    "Confirme que la OC se crea de forma retroactiva; quedará marcada como tal en el registro de control.",
  )
}

// ── RC9 · Aprobación no anterior a la solicitud ──────────────────────────────

function rc9FechaAprobacion({ paquete: { solicitud, aprobacion }, resultado }: Contexto): void {
  if (!aprobacion) return
  const confirmar = (detalle: string, accion: string) => anotar(resultado.confirmaciones, "RC9", detalle, accion)
  if (!fechaIsoValida(aprobacion.fecha)) {
    return confirmar(
      `No se pudo leer la fecha de la aprobación de ${aprobacion.de}${describirTexto(aprobacion.fecha)}; no es posible verificar que sea posterior a la solicitud del ${solicitud.fecha_solicitud}.`,
      "Revise el correo de aprobación y confirme que es posterior a la solicitud, o pida al líder reenviarlo.",
    )
  }
  if (aprobacion.fecha >= solicitud.fecha_solicitud) return
  confirmar(
    `La aprobación de ${aprobacion.de} tiene fecha ${aprobacion.fecha}, anterior a la fecha de solicitud ${solicitud.fecha_solicitud}.`,
    "Verifique con el solicitante que esa aprobación corresponde a esta solicitud o pida al líder una aprobación posterior a la solicitud.",
  )
}

// ── RC10 · valores positivos y cantidad × valor_unitario = valor_total (± 1) ─

function valoresInvalidos({ cantidad, valor_unitario, valor_total, moneda }: Solicitud): string[] {
  const problemas: string[] = []
  if (cantidad <= 0) problemas.push(`cantidad ${formatoNumero.format(cantidad)} (debe ser mayor que cero)`)
  if (valor_unitario < 0) problemas.push(`valor unitario ${monto(valor_unitario, moneda)} (no puede ser negativo)`)
  if (valor_total <= 0) problemas.push(`valor total ${monto(valor_total, moneda)} (debe ser mayor que cero)`)
  return problemas
}

function rc10Aritmetica({ paquete: { solicitud }, resultado }: Contexto): void {
  const { cantidad, valor_unitario, valor_total, moneda } = solicitud
  const problemas = valoresInvalidos(solicitud)
  if (problemas.length) {
    anotar(
      resultado.bloqueos,
      "RC10",
      `La solicitud trae valores no válidos: ${problemas.join("; ")}.`,
      "Pida al solicitante corregir la cantidad y los valores de la solicitud; deben ser positivos.",
    )
    return
  }
  const calculado = cantidad * valor_unitario
  const diferencia = Math.abs(calculado - valor_total)
  if (diferencia <= TOLERANCIA_ARITMETICA) return
  anotar(
    resultado.bloqueos,
    "RC10",
    `${formatoNumero.format(cantidad)} × ${monto(valor_unitario, moneda)} = ${monto(calculado, moneda)}, pero el valor total informado es ${monto(valor_total, moneda)} (diferencia ${monto(diferencia, moneda)}).`,
    "Pida al solicitante corregir la cantidad, el valor unitario o el valor total en la solicitud.",
  )
}

// ── Orquestación ─────────────────────────────────────────────────────────────

const REGLAS: ReadonlyArray<(ctx: Contexto) => void> = [
  rc1Proveedor,
  rc2Aprobacion,
  rc3Tope,
  rc4Subarea,
  rc5Cotizacion,
  rc6IndicadorIva,
  rc7CondicionesPago,
  rc8Retroactiva,
  rc9FechaAprobacion,
  rc10Aritmetica,
]

function buscarCentro(codigo: string, centros: CentroCosto[]): CentroCosto | null {
  const objetivo = codigo.trim().toUpperCase()
  return centros.find((c) => c.centro_costo.trim().toUpperCase() === objetivo) ?? null
}

export function validar(paquete: Paquete, maestros: Maestros): ResultadoValidacion {
  const resultado: ResultadoValidacion = {
    apta: true,
    bloqueos: [],
    confirmaciones: [],
    derivados: {},
    retroactiva: false,
    proveedor: null,
    aprobador: null,
  }
  const ctx: Contexto = { paquete, maestros, centro: buscarCentro(paquete.solicitud.centro_costo, maestros.centrosCosto), resultado }
  for (const regla of REGLAS) regla(ctx)
  resultado.apta = resultado.bloqueos.length === 0
  return resultado
}

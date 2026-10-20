import { z } from "zod"
import { registrarControl } from "../domain/control.ts"
import { validar } from "../domain/controles.ts"
import { generarEvidencia } from "../domain/evidencia.ts"
import { cargarMaestros } from "../domain/maestros.ts"
import { leerPaquete } from "../domain/paquete.ts"
import { construirPayload, guardarTrazabilidad } from "../domain/payload.ts"
import type { CodigoControl, FilaControl, OrdenCompra, Paquete, ResultadoValidacion } from "../domain/tipos.ts"
import { SapMock } from "../sap/mock.ts"
import { fallo, mensajeDeError, ok, type ContextoHerramienta, type Resultado } from "./registry.ts"

// Herramientas del Reto 3. El nombre que ve el modelo es oc_<export>.
//
// Decisión de diseño: cada herramienta recibe solo `caso` y vuelve a derivar paquete,
// validación y payload desde los fixtures y los maestros. El modelo nunca puede
// alterar un monto, un proveedor o un centro de costo "de paso" (riesgo del PRD §10).

const argCaso = z.string().regex(/^[\w-]+$/, "solo letras, números, guion y guion bajo").describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)")
const argConfirmado = z.boolean().optional().describe("true solo si la analista confirmó explícitamente en el mensaje inmediatamente anterior")

interface Evaluacion {
  paquete: Paquete
  validacion: ResultadoValidacion
}

// Lee y valida en un solo paso; es el punto de partida de todas las herramientas.
async function evaluar(directorio: string, caso: string): Promise<Resultado<Evaluacion>> {
  const paquete = await leerPaquete(directorio, caso)
  if (!paquete.ok) return paquete
  try {
    const maestros = await cargarMaestros(directorio)
    return { ok: true, data: { paquete: paquete.data, validacion: validar(paquete.data, maestros) } }
  } catch (e) {
    return { ok: false, error: `No pude cargar los maestros: ${mensajeDeError(e)}` }
  }
}

const codigos = (hallazgos: { codigo: CodigoControl }[]) => hallazgos.map((h) => h.codigo)

function describirValidacion(v: ResultadoValidacion) {
  return {
    apta: v.apta,
    bloqueos: v.bloqueos,
    confirmaciones: v.confirmaciones,
    derivados: v.derivados,
    retroactiva: v.retroactiva,
    proveedor: v.proveedor ? { codigo_sap: v.proveedor.codigo_sap, nombre: v.proveedor.nombre, activo: v.proveedor.activo } : null,
    aprobador: v.aprobador ? { email: v.aprobador.email, nombre: v.aprobador.nombre, tope: v.aprobador.tope } : null,
  }
}

export const leer_paquete = {
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    const r = await leerPaquete(ctx.directory, args.caso)
    return r.ok ? ok(r.data) : fallo(r.error)
  },
}

export const validar_solicitud = {
  description: "Aplica las reglas de control RC1–RC10 a un caso y devuelve bloqueos, confirmaciones pendientes, valores derivados y si la compra es retroactiva.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    const r = await evaluar(ctx.directory, args.caso)
    return r.ok ? ok(describirValidacion(r.data.validacion)) : fallo(r.error)
  },
}

export const generar_evidencia = {
  description: "Genera out/<caso>/aprobacion.txt con el correo de aprobación y su huella SHA-256 para adjuntar a la OC.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    const r = await generarEvidencia(ctx.directory, args.caso)
    return r.ok ? ok(r.data) : fallo(r.error)
  },
}

interface PayloadListo {
  orden: OrdenCompra
  ruta_trazabilidad: string
  ruta_evidencia: string
}

async function prepararPayload(directorio: string, caso: string, ev: Evaluacion, confirmadoPor: string | null): Promise<Resultado<PayloadListo>> {
  const evidencia = await generarEvidencia(directorio, caso)
  if (!evidencia.ok) return evidencia
  const payload = construirPayload(ev.paquete, ev.validacion, evidencia.data.sha256, confirmadoPor)
  if (!payload.ok) return payload
  const ruta_trazabilidad = await guardarTrazabilidad(directorio, caso, payload.data.trazabilidad)
  return { ok: true, data: { orden: payload.data.orden, ruta_trazabilidad, ruta_evidencia: evidencia.data.ruta } }
}

export const construir_payload = {
  description: "Construye la orden de compra exactamente como quedaría en SAP (validada con zod) y guarda la trazabilidad de cada campo; no la crea.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    const ev = await evaluar(ctx.directory, args.caso)
    if (!ev.ok) return fallo(ev.error)
    if (!ev.data.validacion.apta) {
      return fallo(`La solicitud tiene bloqueos (${codigos(ev.data.validacion.bloqueos).join(", ")}); no se construye la OC.`)
    }
    const r = await prepararPayload(ctx.directory, args.caso, ev.data, null)
    return r.ok ? ok({ ...r.data, confirmaciones_pendientes: codigos(ev.data.validacion.confirmaciones) }) : fallo(r.error)
  },
}

async function anotarControl(directorio: string, ev: Evaluacion, resultado: FilaControl["resultado"], numero_oc: string | null): Promise<void> {
  await registrarControl(directorio, {
    solicitud_id: ev.paquete.solicitud.solicitud_id,
    resultado,
    numero_oc,
    retroactiva: ev.validacion.retroactiva,
    bloqueos: codigos(ev.validacion.bloqueos),
    confirmaciones: codigos(ev.validacion.confirmaciones),
    ts: new Date().toISOString(),
  })
}

export const crear = {
  description: "Crea la orden de compra en SAP (simulado) si la solicitud es apta y no quedan confirmaciones pendientes, o si la analista confirmó; es idempotente por solicitud.",
  args: { caso: argCaso, confirmado: argConfirmado },
  async execute(args: { caso: string; confirmado?: boolean }, ctx: ContextoHerramienta): Promise<string> {
    const ev = await evaluar(ctx.directory, args.caso)
    if (!ev.ok) return fallo(ev.error)
    const { validacion } = ev.data

    if (!validacion.apta) {
      await anotarControl(ctx.directory, ev.data, "bloqueada", null)
      const detalle = validacion.bloqueos.map((b) => `${b.codigo}: ${b.detalle} → ${b.accion_sugerida}`).join(" | ")
      return fallo(`No se puede crear la OC. Bloqueos: ${detalle}`)
    }
    if (validacion.confirmaciones.length > 0 && !args.confirmado) {
      await anotarControl(ctx.directory, ev.data, "pendiente_confirmacion", null)
      const detalle = validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join(" | ")
      return fallo(`Requiere confirmación explícita de la analista antes de crear la OC. Pendientes: ${detalle}`)
    }

    const confirmadoPor = validacion.confirmaciones.length > 0 ? `analista (sesión ${ctx.sessionId})` : null
    const payload = await prepararPayload(ctx.directory, args.caso, ev.data, confirmadoPor)
    if (!payload.ok) {
      await anotarControl(ctx.directory, ev.data, "error", null)
      return fallo(payload.error)
    }

    try {
      const sap = new SapMock(ctx.directory, await cargarMaestros(ctx.directory))
      const solicitudId = payload.data.orden.referencia.solicitud_id
      const existente = await sap.buscarOrdenPorReferencia(solicitudId)
      const creada = existente ?? (await sap.crearOrden(payload.data.orden))
      const idempotente = existente !== null
      await anotarControl(ctx.directory, ev.data, idempotente ? "idempotente" : "creada", creada.numero_oc)
      return ok({
        numero_oc: creada.numero_oc,
        fecha: "fecha" in creada ? creada.fecha : null,
        idempotente,
        retroactiva: validacion.retroactiva,
        excepciones_confirmadas: codigos(validacion.confirmaciones),
        ruta_evidencia: payload.data.ruta_evidencia,
        ruta_trazabilidad: payload.data.ruta_trazabilidad,
      })
    } catch (e) {
      await anotarControl(ctx.directory, ev.data, "error", null)
      return fallo(`SAP rechazó la orden: ${mensajeDeError(e)}`)
    }
  },
}

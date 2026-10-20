import { z } from "zod"

// Contratos compartidos del Reto 3. Todos los módulos de dominio dependen de este archivo;
// ningún módulo de dominio depende de otro salvo a través de estos tipos.

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha en formato YYYY-MM-DD")

// ── Maestros (fixtures/reto-03/maestros/) ────────────────────────────────────

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const AprobadorSchema = z.object({ email: z.string(), nombre: z.string(), tope: z.number() })
export type Aprobador = z.infer<typeof AprobadorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(AprobadorSchema),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>

export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })
export type CondicionPago = z.infer<typeof CondicionPagoSchema>

export interface Maestros {
  proveedores: Proveedor[]
  centrosCosto: CentroCosto[]
  indicadoresIva: IndicadorIva[]
  condicionesPago: CondicionPago[]
}

// ── Paquete de entrada (PRD 7.1 / 7.2) ───────────────────────────────────────

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fechaIso,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export interface Paquete {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: {
    proveedor: string
    nit: string | null // normalizado: solo dígitos, sin dígito de verificación
    total: number
    moneda: string
    validez_hasta: string | null // YYYY-MM-DD (fecha cotización + días de validez)
    texto: string
  } | null
  aprobacion: { de: string; fecha: string; aprobado: boolean; texto: string } | null // fecha YYYY-MM-DD
  factura: { numero: string; fecha: string; total: number } | null // fecha YYYY-MM-DD
  faltantes: string[] // adjuntos ausentes, p. ej. ["cotizacion"]
}

// ── Resultado de validación (PRD 7.3, RC1–RC10) ──────────────────────────────

export type CodigoControl = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"

export interface Hallazgo {
  codigo: CodigoControl
  detalle: string // incluye los valores en conflicto, p. ej. "solicitud 25.000.000 vs cotización 26.500.000"
  accion_sugerida: string // qué debe hacer la analista o qué pedir al solicitante
}

export interface ValorDerivado {
  valor: string
  fuente: string // p. ej. "maestro.proveedores.indicador_iva_default"
}

export interface ResultadoValidacion {
  apta: boolean // true si no hay bloqueos
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Partial<Record<"indicador_iva" | "condiciones_pago", ValorDerivado>>
  retroactiva: boolean
  proveedor: Proveedor | null // proveedor resuelto en el maestro (aunque esté inactivo)
  aprobador: Aprobador | null // aprobador resuelto en el centro de costo
}

// ── Orden de compra (PRD 7.4) ────────────────────────────────────────────────

export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string() }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

// Trazabilidad: ruta del campo en el payload → fuente ("solicitud", "cotizacion", "maestro.<nombre>", "derivado", "constante")
export type Trazabilidad = Record<string, string>

// ── Registro de control (out/control.csv, PRD HU-5) ─────────────────────────

export interface FilaControl {
  solicitud_id: string
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "error"
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: CodigoControl[]
  confirmaciones: CodigoControl[]
  ts: string
}

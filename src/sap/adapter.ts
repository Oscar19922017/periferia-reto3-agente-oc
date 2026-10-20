import type { OrdenCompra } from "../domain/tipos.ts"

// Interfaz obligatoria (PRD 7.4). La implementación simulada vive en mock.ts;
// la real (OData / BAPI) se diseña en SOLUCION.md.
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}

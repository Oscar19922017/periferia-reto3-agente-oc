import * as oc from "./oc.ts"
import { RegistroHerramientas } from "./registry.ts"

// Punto único donde se registran los módulos de herramientas: cada export de oc.ts → oc_<export>.
export function crearRegistro(): RegistroHerramientas {
  return new RegistroHerramientas().registrar("oc", oc)
}

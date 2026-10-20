import { RegistroHerramientas } from "./registry.ts"

// Punto único donde se registran los módulos de herramientas del reto.
export function crearRegistro(): RegistroHerramientas {
  return new RegistroHerramientas()
}

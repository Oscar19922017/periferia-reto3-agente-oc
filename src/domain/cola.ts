// Serializa los trabajos que comparten una clave (p. ej. la ruta de un archivo) dentro del proceso,
// para que una secuencia leer → decidir → escribir no se intercale con otra igual.
const colas = new Map<string, Promise<unknown>>()

export function enCola<T>(clave: string, trabajo: () => Promise<T>): Promise<T> {
  const anterior = colas.get(clave) ?? Promise.resolve()
  const actual = anterior.then(trabajo, trabajo)
  colas.set(
    clave,
    actual.catch(() => undefined),
  )
  return actual
}

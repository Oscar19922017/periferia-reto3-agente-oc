// Las mismas herramientas que usa la aplicación, importables sin el servidor HTTP.
// Cada export sigue el contrato { description, args (zod), execute(args, ctx) → string JSON }.
export * from "../../src/tools/oc.ts"
export type { ContextoHerramienta, Herramienta, Resultado } from "../../src/tools/registry.ts"

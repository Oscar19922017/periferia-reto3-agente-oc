// Se ejecuta en `npm install` (script "prepare"): activa los hooks versionados en .githooks/.
// Si no hay repositorio git (p. ej. el zip descomprimido o el build de Render), no hace nada.
import { execSync } from "node:child_process"

try {
  execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" })
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" })
  console.log("hooks de git activados (.githooks/pre-push)")
} catch {
  // sin git no hay hooks que activar
}

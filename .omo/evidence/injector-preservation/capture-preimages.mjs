import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const cache = "/home/nowaker/.cache/opencode/packages/oh-my-openagent@latest"
const config = "/home/nowaker/.config/opencode"
const destination = join(import.meta.dirname, "preimages")
mkdirSync(destination, { mode: 0o700 })
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const links = []
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = realpathSync(path)
      links.push({ path, link: readlinkSync(path), target, external: !target.startsWith(cache + "/") })
    } else if (entry.isDirectory()) scan(path)
  }
}
scan(cache)
cpSync(cache, join(destination, "cache-project"), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
const externalTargets = [...new Set(links.filter((link) => link.external).map((link) => link.target))]
for (const [index, target] of externalTargets.entries()) {
  cpSync(target, join(destination, `external-${index}`), { recursive: lstatSync(target).isDirectory(), dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
}
const configs = []
for (const name of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc", "oh-my-openagent.json", "oh-my-openagent.jsonc", "oh-my-opencode.json", "oh-my-opencode.jsonc"]) {
  const path = join(config, name)
  if (!existsSync(path)) continue
  const backup = join(destination, name)
  cpSync(path, backup, { dereference: true, preserveTimestamps: true })
  configs.push({ path, target: realpathSync(path), backup, sha256: digest(path) })
}
const manifestPath = join(cache, "node_modules/oh-my-openagent/package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const inventory = { cache, capturedAt: new Date().toISOString(), package: { name: manifest.name, version: manifest.version, manifestSHA256: digest(manifestPath), entrySHA256: digest(join(cache, "node_modules/oh-my-openagent/dist/index.js")) }, links, externalTargets, configs }
writeFileSync(join(destination, "inventory.json"), JSON.stringify(inventory, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ package: inventory.package, symlinks: links.length, externalTargets: externalTargets.length, configFiles: configs.length, destination }))

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export function safeDiagnostics(root: string, error: Error) {
  const directory = join(root, "data/opencode/log")
  const logs = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".log")).map((file) => readFileSync(join(directory, file), "utf8")).join("\n") : ""
  const text = error.message + "\n" + logs
  const known = ["no such pane", "cannot find pane", "Missing isolated", "Cannot find module", "Cannot find package", "ENOENT", "SyntaxError", "TypeError", "ReferenceError", "is not a function", "PluginInstallError", "pane disappeared", "not ready", "ConfigInvalidError", "ENAMETOOLONG", "EACCES"]
  return {
    categories: known.filter((token) => text.toLowerCase().includes(token.toLowerCase())),
    missingModules: Array.from(text.matchAll(/Cannot find (?:module|package) ['"]([@a-zA-Z0-9_./-]+)['"]/g), (match) => match[1]),
    logBytes: logs.length,
    initialized: existsSync(join(root, "proof.jsonl")),
    errorLines: error.message.split("\n").length,
  }
}

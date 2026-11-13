import { resolve } from "node:path"
import { parseArgs } from "node:util"

export type SuitePaths = {
  readonly binary: string
  readonly toolsDirectory: string
  readonly pluginBundle: string
  readonly baselineBundle?: string
  readonly evidenceDirectory: string
}
export type ParityCommand =
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly detail: string }
  | { readonly kind: "run"; readonly input: SuitePaths; readonly format: "text" | "json" }

export function parseParityArgs(argv: readonly string[]): ParityCommand {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: {
      binary: { type: "string" }, "tools-directory": { type: "string" }, "plugin-bundle": { type: "string" },
      "baseline-bundle": { type: "string" }, "evidence-dir": { type: "string" }, format: { type: "string", default: "text" },
      help: { type: "boolean", short: "h" },
    } })
    if (values.help) return { kind: "help" }
    if (positionals.length > 0) return { kind: "usage-error", detail: `unexpected argument: ${positionals[0]}` }
    type PathFlag = "binary" | "tools-directory" | "plugin-bundle" | "baseline-bundle"
    function optionalPath(key: PathFlag): string | undefined {
      const value = values[key]
      if (value === undefined) return undefined
      if (value.trim().length === 0) throw new TypeError(`invalid empty path: --${key}`)
      return resolve(value)
    }
    function requiredPath(key: PathFlag): string {
      const value = optionalPath(key)
      if (value === undefined) throw new TypeError(`missing required argument: --${key} PATH`)
      return value
    }
    const baselineBundle = optionalPath("baseline-bundle")
    if (values.format !== "text" && values.format !== "json") return { kind: "usage-error", detail: `invalid --format: ${values.format}; expected text or json` }
    if (values["evidence-dir"]?.trim().length === 0) return { kind: "usage-error", detail: "invalid empty path: --evidence-dir" }
    return { kind: "run", format: values.format, input: {
      binary: requiredPath("binary"), toolsDirectory: requiredPath("tools-directory"), pluginBundle: requiredPath("plugin-bundle"),
      ...(baselineBundle === undefined ? {} : { baselineBundle }),
      evidenceDirectory: resolve(values["evidence-dir"] ?? ".omo/evidence/v2-parity"),
    } }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { kind: "usage-error", detail: error.message }
  }
}

import type { ProbeResult } from "./contracts"

export type MatrixRow = { readonly id: string; readonly label: string } & (
  | { readonly kind: "runtime"; readonly probes: readonly [string, ...string[]]; readonly note?: string }
  | { readonly kind: "unsupported"; readonly reason: string }
)

export type MatrixResult = {
  readonly id: string
  readonly label: string
  readonly status: "pass" | "fail" | "skip"
  readonly detail: string
  readonly probes: readonly string[]
}

export function evaluateMatrix(rows: readonly MatrixRow[], results: readonly ProbeResult[]): readonly MatrixResult[] {
  const byId = new Map(results.map((result) => [result.id, result]))
  if (byId.size !== results.length) throw new TypeError("Duplicate runtime probe identifiers")
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new TypeError("Duplicate matrix row identifiers")
  return rows.map((row) => {
    switch (row.kind) {
      case "unsupported":
        if (row.reason.trim().length === 0) throw new TypeError(`Missing unsupported reason for ${row.id}`)
        return { id: row.id, label: row.label, status: "skip", detail: row.reason, probes: [] }
      case "runtime": {
        const checks = row.probes.map((id) => byId.get(id))
        const missing = row.probes.filter((id) => !byId.has(id))
        const failed = checks.filter((check) => check?.status === "fail")
        const skipped = checks.filter((check) => check?.status === "skip")
        const detail = [...checks.flatMap((check) => check === undefined ? [] : [`${check.id}: ${check.status}: ${check.detail}`]),
          ...(row.note === undefined ? [] : [row.note])].join("; ")
        return { id: row.id, label: row.label,
          status: missing.length > 0 || failed.length > 0 ? "fail" : skipped.length > 0 ? "skip" : "pass",
          detail: missing.length > 0 ? `Missing runtime results: ${missing.join(", ")}; ${detail}` : detail,
          probes: row.probes }
      }
      default:
        throw new TypeError(`Unknown matrix row: ${row satisfies never}`)
    }
  })
}

export function paritySucceeded(results: readonly ProbeResult[], matrix: readonly MatrixResult[]): boolean {
  return results.length > 0 && matrix.length > 0
    && results.every((result) => result.status !== "fail")
    && matrix.every((result) => result.status !== "fail")
}

import type { Harness } from "./contracts"
import type { ParityReport } from "./suite"

export function renderParityReport(report: ParityReport, format: "text" | "json", harness: Harness): string {
  switch (format) {
    case "json": return JSON.stringify(report, null, 2) + "\n"
    case "text": {
      const rows = report.matrix.map((row) => `${row.status.toUpperCase().padEnd(4)} ${row.id}: ${row.label}\n     ${row.detail}`)
      const count = (status: "pass" | "fail" | "skip") => report.matrix.filter((row) => row.status === status).length
      return harness.renderProbeReport(report, "text") + "\nUpstream #9391 coverage (derived from runtime checks; skips are separate):\n"
        + rows.join("\n") + `\n${count("pass")} covered, ${count("fail")} failed, ${count("skip")} skipped\n`
    }
    default: throw new TypeError(`Unknown report format: ${format satisfies never}`)
  }
}

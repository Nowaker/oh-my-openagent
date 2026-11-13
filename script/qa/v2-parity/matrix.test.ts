import { describe, expect, test } from "bun:test"
import type { ProbeResult } from "./contracts"
import { evaluateMatrix, paritySucceeded, type MatrixRow } from "./matrix"

describe("parity result accounting", () => {
  const rows: readonly MatrixRow[] = [{ id: "tools", label: "Tools", kind: "runtime", probes: ["admission", "execution"] }]
  const result = (id: string, status: ProbeResult["status"]): ProbeResult => ({ id, label: id, status, detail: `${id} receipt`, durationMs: 1 })

  test.each([
    ["pass", "pass", "pass"],
    ["pass", "skip", "skip"],
    ["skip", "fail", "fail"],
    ["fail", "pass", "fail"],
  ] as const)("reports %s and %s dependencies as %s", (first, second, expected) => {
    // given
    const results = [result("admission", first), result("execution", second)]
    // when
    const matrix = evaluateMatrix(rows, results)
    // then
    expect(matrix.map((row) => row.status)).toEqual([expected])
    expect(paritySucceeded(results, matrix)).toBe(expected !== "fail")
  })

  test("fails a mapped row when its execution result is absent", () => {
    // given
    const results = [result("admission", "pass")]
    // when
    const matrix = evaluateMatrix(rows, results)
    // then
    expect(matrix.map((row) => row.status)).toEqual(["fail"])
    expect(matrix[0]?.detail).toContain("Missing runtime results: execution")
    expect(paritySucceeded(results, matrix)).toBe(false)
  })

  test("retains an unsupported reason without counting it as a pass", () => {
    // given
    const reason = "Native host does not expose the required extension"
    const unsupported: readonly MatrixRow[] = [{ id: "host-extension", label: "Host extension", kind: "unsupported", reason }]
    // when
    const matrix = evaluateMatrix(unsupported, [result("admission", "pass")])
    // then
    expect(matrix.map(({ status, detail, probes }) => ({ status, detail, probes }))).toEqual([
      { status: "skip", detail: reason, probes: [] },
    ])
  })

  test("rejects duplicate results instead of masking a failure with a later pass", () => {
    // given
    const results = [result("admission", "fail"), result("admission", "pass")]
    // when / then
    expect(() => evaluateMatrix(rows, results)).toThrow("Duplicate runtime probe identifiers")
  })

  test("rejects duplicate row identifiers", () => {
    // given
    const duplicateRows = [...rows, ...rows]
    // when / then
    expect(() => evaluateMatrix(duplicateRows, [])).toThrow("Duplicate matrix row identifiers")
  })

  test("rejects unsupported entries without a concrete reason", () => {
    // given
    const unsupported: readonly MatrixRow[] = [{ id: "host-extension", label: "Host extension", kind: "unsupported", reason: " " }]
    // when / then
    expect(() => evaluateMatrix(unsupported, [])).toThrow("Missing unsupported reason")
  })

  test.each(["runtime", "matrix"] as const)("refuses a successful suite without %s checks", (empty) => {
    // given
    const results = empty === "runtime" ? [] : [result("admission", "pass")]
    const matrix = empty === "matrix" ? [] : evaluateMatrix([{ id: "admission-row", label: "Admission", kind: "runtime", probes: ["admission"] }], [result("admission", "pass")])
    // when / then
    expect(paritySucceeded(results, matrix)).toBe(false)
  })
})

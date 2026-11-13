import { describe, expect, test } from "bun:test"
import { parityPlan } from "./plan"

describe("parity plan", () => {
  test("every runtime row names a probe the suite runs", () => {
    // given
    const plan = parityPlan("/baseline.js")
    const ids = new Set(plan.probes.map((probe) => probe.id))
    // when
    const missing = plan.rows.flatMap((row) => row.kind === "runtime" ? row.probes.filter((id) => !ids.has(id)).map((id) => `${row.id}: ${id}`) : [])
    // then
    expect(missing).toEqual([])
    expect(ids.size).toBe(plan.probes.length)
  })
})

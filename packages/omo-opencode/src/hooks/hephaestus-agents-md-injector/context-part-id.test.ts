import { expect, test } from "bun:test"
import { ContextPartOrderingError, createContextPartId } from "./context-part-id"

test("creates unique native-shaped IDs before the original without changing existing ordering", () => {
  // Given: surrounding existing parts and an original with a minimal nonzero time field.
  const original = "prt_000000000001AAAAAAAAAAAAAA"
  const existing = ["prt_000000000000AAAAAAAAAAAAAA", original, "prt_000000000002AAAAAAAAAAAAAA"]
  const snapshot = [...existing]
  // When: independently generated context parts are added for that original.
  const generated = Array.from({ length: 100 }, () => createContextPartId(original, existing))
  // Then: every ID is valid and earlier, while every pre-existing relative position survives.
  expect(new Set(generated).size).toBe(100)
  for (const id of generated) {
    expect(id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(id < original).toBe(true)
    expect([...existing, id].sort().filter((part) => part !== id)).toEqual(snapshot)
  }
  expect(existing).toEqual(snapshot)
})

test.each([undefined, "prt_legacy", "prt_000000000000AAAAAAAAAAAAAA"])("refuses an unsupported lower-bound ordering: %s", (original) => {
  // Given: no safe earlier native time/counter interval can be established.
  // When/Then: fail explicitly rather than mutating original IDs or generating invalid IDs.
  expect(() => createContextPartId(original, [])).toThrow(ContextPartOrderingError)
})

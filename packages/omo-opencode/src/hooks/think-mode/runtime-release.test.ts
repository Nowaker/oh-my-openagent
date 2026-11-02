import { describe, expect, test, spyOn } from "bun:test"
import { createThinkModeHook } from "./index"
import { createCompactionContextInjector } from "../compaction-context-injector"

describe("session runtime memory release", () => {
  test.each(["think-mode", "compaction-tail"] as const)(
    "%s removes the retired entry and retains a sibling",
    async (owner) => {
      // given - observe the real store allocation without a production-only getter
      const stores = new Set<Map<unknown, unknown>>()
      const originalSet = Map.prototype.set
      const setSpy = spyOn(Map.prototype, "set").mockImplementation(function (
        this: Map<unknown, unknown>, key: unknown, value: unknown,
      ) {
        if (key === "memory-retired") stores.add(this)
        return originalSet.call(this, key, value)
      })
      const think = createThinkModeHook()
      const compaction = createCompactionContextInjector()
      const hook = owner === "think-mode" ? think : compaction
      try {
        for (const sessionID of ["memory-retired", "memory-sibling"]) {
          if (owner === "think-mode") {
            await think["chat.message"]({ sessionID }, { message: {}, parts: [] })
          } else {
            await compaction.event({ event: { type: "session.idle", properties: { sessionID } } })
          }
        }
      } finally {
        setSpy.mockRestore()
      }

      // when
      hook.releaseSession("memory-retired")
      hook.releaseSession("memory-retired")

      // then - the memory lifetime is the contract, not an output-text proxy
      expect(stores.size).toBe(1)
      for (const store of stores) {
        expect(store.has("memory-retired")).toBe(false)
        expect(store.has("memory-sibling")).toBe(true)
      }
      hook.releaseSession("memory-sibling")
    },
  )
})

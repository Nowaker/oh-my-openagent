import { describe, expect, test } from "bun:test"
import { createContinuationHooks } from "./create-continuation-hooks"
import { createHostDelegationFixture } from "../../testing/host-delegation-test-fixture"

describe("continuation hooks with host delegation", () => {
  test("skips strict background hooks while preserving independent continuation controls", async () => {
    const { ctx, args } = createHostDelegationFixture()

    const hooks = createContinuationHooks({ ctx, pluginConfig: args.pluginConfig, isHookEnabled: () => true, safeHookEnabled: false })

    try {
      expect(hooks.backgroundNotificationHook).toBeNull()
      expect(hooks.unstableAgentBabysitter).toBeNull()
      if (!hooks.stopContinuationGuard) throw new Error("Missing stop control")
      hooks.stopContinuationGuard.stop("session")
      expect(hooks.stopContinuationGuard.isStopped("session")).toBe(true)
      hooks.stopContinuationGuard.clear("session")
      expect(hooks.stopContinuationGuard.isStopped("session")).toBe(false)
      expect(typeof hooks.compactionContextInjector?.capture).toBe("function")
      expect(typeof hooks.compactionTodoPreserver?.event).toBe("function")
      expect(typeof hooks.todoContinuationEnforcer?.handler).toBe("function")
      expect(typeof hooks.atlasHook?.handler).toBe("function")
    } finally {
      hooks.todoContinuationEnforcer?.dispose()
      hooks.atlasHook?.dispose()
    }
  })
})

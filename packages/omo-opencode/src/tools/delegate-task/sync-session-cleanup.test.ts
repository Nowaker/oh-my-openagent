import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { cancelSyncSessionCleanup, scheduleSyncSessionCleanup } from "./sync-session-cleanup"

type RecordedTimer = {
  handle: ReturnType<typeof setTimeout>
  delay: number
  callback: () => void
}

type FakeTimers = {
  timers: RecordedTimer[]
  clearedHandles: Array<ReturnType<typeof setTimeout>>
  restore: () => void
}

function installFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers: RecordedTimer[] = []
  const clearedHandles: Array<ReturnType<typeof setTimeout>> = []

  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    delay?: number,
    ..._args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    if (typeof handler !== "function") {
      throw new Error("Expected function timeout handler")
    }

    //#given - a real, immediately-cleared handle so the production timer.unref() call works
    const handle = originalSetTimeout(() => {}, 0)
    originalClearTimeout(handle)
    timers.push({ handle, delay: delay ?? 0, callback: handler as () => void })
    return handle
  }) as typeof setTimeout

  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>): void => {
    if (timer !== undefined) clearedHandles.push(timer)
  }) as typeof clearTimeout

  return {
    timers,
    clearedHandles,
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

const SESSION_IDS = ["ses_sscd_a", "ses_sscd_b", "ses_sscd_c", "ses_sscd_d"] as const

describe("sync-session-cleanup", () => {
  let fakeTimers: FakeTimers

  beforeEach(() => {
    //#given - fake timers so scheduling records the delay without leaving a real pending timeout
    fakeTimers = installFakeTimers()
  })

  afterEach(() => {
    //#given - cancel any still-pending cleanup so no timer leaks into the next test file
    for (const id of SESSION_IDS) {
      cancelSyncSessionCleanup(id)
    }
    handedBackSyncSessions.clear()
    fakeTimers.restore()
  })

  test("releases runtime state with the provided delay", async () => {
    //#given
    const retired = Promise.withResolvers<string>()

    //#when
    scheduleSyncSessionCleanup("ses_sscd_a", 120000, (id) => { retired.resolve(id) })

    //#then - exactly one fake timer is recorded carrying that delay
    expect(fakeTimers.timers).toHaveLength(1)
    expect(fakeTimers.timers[0]?.delay).toBe(120000)

    //#when - the recorded callback fires
    fakeTimers.timers[0]?.callback()

    //#then
    expect(await retired.promise).toBe("ses_sscd_a")
  })

  test("falls back to TASK_CLEANUP_DELAY_MS when the delay argument is undefined", () => {
    //#when - cleanup is scheduled without an explicit delay
    scheduleSyncSessionCleanup("ses_sscd_b", undefined)

    //#then - the recorded delay is the module fallback
    expect(fakeTimers.timers).toHaveLength(1)
    expect(fakeTimers.timers[0]?.delay).toBe(TASK_CLEANUP_DELAY_MS)

    //#then - the fallback constant itself is pinned to ten minutes
    expect(TASK_CLEANUP_DELAY_MS).toBe(600000)
  })

  test("cancelSyncSessionCleanup clears the pending timer and preserves active runtime", () => {
    //#given
    const retire = mock(() => {})
    handedBackSyncSessions.add("ses_sscd_c")
    scheduleSyncSessionCleanup("ses_sscd_c", 120000, retire)
    const scheduledHandle = fakeTimers.timers[0]?.handle

    //#when
    cancelSyncSessionCleanup("ses_sscd_c")

    //#then - the exact recorded timer handle was cleared, so the callback can never fire
    expect(fakeTimers.clearedHandles).toContain(scheduledHandle)

    //#then
    expect(retire).not.toHaveBeenCalled()
    expect(handedBackSyncSessions.has("ses_sscd_c")).toBe(true)
  })

  test("expires handback before asynchronous runtime teardown completes", async () => {
    //#given
    const teardown = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    handedBackSyncSessions.add("ses_sscd_d")
    scheduleSyncSessionCleanup("ses_sscd_d", 120000, async () => { entered.resolve(); await teardown.promise })

    //#when
    fakeTimers.timers[0]?.callback()
    await entered.promise

    //#then - the session is no longer marked as handed back
    expect(handedBackSyncSessions.has("ses_sscd_d")).toBe(false)
    teardown.resolve()
  })
})

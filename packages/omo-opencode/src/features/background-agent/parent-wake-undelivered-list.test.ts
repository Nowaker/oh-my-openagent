import { afterEach, describe, expect, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { ParentWakeNotifier } from "./parent-wake-notifier"

type ParentWakeNotifierClientForTest = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]

const NOTICE = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"
const PARENT = "ses_parent_undelivered"

afterEach(() => {
  releaseAllPromptAsyncReservationsForTesting()
})

function createNotifier(promptAsync: () => Promise<unknown>): ParentWakeNotifier {
  const client: ParentWakeNotifierClientForTest = {
    session: {
      messages: async () => ({ data: [{ info: { role: "assistant", finish: "stop", time: { created: Date.now() - 10_000 } } }] }),
      status: async () => ({ data: {} }),
      promptAsync: async () => promptAsync(),
    },
  }
  return new ParentWakeNotifier(
    { client, directory: "/tmp/test-omo", enqueueNotificationForParent: async (_sessionID, operation) => { await operation() } },
    { pendingRetryMs: 1_000, acceptedMessageSkewMs: 100, toolCallDeferMaxMs: 5_000, failureRequeueWindowMs: 60_000, userMessageInProgressWindowMs: 0 },
  )
}

describe("ParentWakeNotifier.listUndeliveredWakes", () => {
  test("#given a wake from reservation to dispatch #then the parent is listed at every step, with its notice once queued, until the wake is cleared", async () => {
    let releaseDispatch: () => void = () => {}
    const dispatchStarted = Promise.withResolvers<void>()
    const notifier = createNotifier(() => {
      dispatchStarted.resolve()
      return new Promise((resolve) => { releaseDispatch = () => resolve({ data: {} }) })
    })

    // given: the child just went terminal, its wake not written yet
    notifier.reserveNotificationPreparation(PARENT)
    expect(notifier.listUndeliveredWakes()).toEqual([{ sessionID: PARENT, notifications: [] }])

    // when: the wake is queued and the reservation released
    notifier.queuePendingParentWake(PARENT, NOTICE, {}, true, 60_000)
    notifier.releaseNotificationPreparation(PARENT)
    // then
    expect(notifier.listUndeliveredWakes().map((wake) => [wake.sessionID, wake.notifications])).toEqual([[PARENT, [NOTICE]]])

    // when: it is mid-dispatch, out of the pending queue
    notifier.clearPendingParentWakeTimer(PARENT)
    const flushing = notifier.flushPendingParentWake(PARENT)
    await dispatchStarted.promise
    // then
    expect(notifier.getPendingParentWakes().has(PARENT)).toBe(false)
    expect(notifier.listUndeliveredWakes().map((wake) => [wake.sessionID, wake.notifications])).toEqual([[PARENT, [NOTICE]]])

    // when: dispatched, its turn not answered yet
    releaseDispatch()
    await flushing
    // then
    expect(notifier.getDispatchedParentWakes().has(PARENT)).toBe(true)
    expect(notifier.listUndeliveredWakes().map((wake) => [wake.sessionID, wake.notifications])).toEqual([[PARENT, [NOTICE]]])

    // when: the parent's turn consumed it
    notifier.clearDispatchedParentWake(PARENT)
    // then
    expect(notifier.listUndeliveredWakes()).toEqual([])
    notifier.shutdown()
  })
})

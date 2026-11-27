import { describe, expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { remainingTestTime } from "../../../../../test-support/test-deadline"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import {
  DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS,
  releaseAllPromptAsyncReservationsForTesting,
} from "../../shared/prompt-async-gate"
import { DEFAULT_SESSION_IDLE_SETTLE_MS } from "../../shared/session-idle-settle"
import { MIN_IDLE_TIME_MS, POLLING_INTERVAL_MS } from "./constants"
import { BackgroundManager } from "./manager"
import { TaskRecoveryStore } from "./task-recovery-store"
import { forgetBackgroundTask } from "./task-registry"
import type { BackgroundTask } from "./types"

type TextPart = { readonly type: string; readonly text?: string }
type SessionPath = { readonly path: { readonly id: string } }
type StoredMessage = {
  readonly info: {
    readonly id: string
    readonly sessionID: string
    readonly role: "user" | "assistant"
    readonly finish?: "stop"
    readonly parentID?: string
    readonly time: { readonly created: number; readonly completed?: number }
  }
  readonly parts: readonly TextPart[]
}

const realSetImmediate = setImmediate
const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

// Fake timer callbacks enqueue SDK work on the promise queue. Drain that work before advancing the next timer.
const drainReadyWork = () => new Promise<void>((resolve) => realSetImmediate(resolve))

function terminalNotices(parts: readonly TextPart[]) {
  return parts.flatMap((part) =>
    Array.from((part.text ?? "").matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g), ([, fields]) => ({
      taskId: fields?.match(/<task-id>([^<]*)<\/task-id>/)?.[1],
      sessionId: fields?.match(/<session-id>([^<]*)<\/session-id>/)?.[1],
      status: fields?.match(/<status>([^<]*)<\/status>/)?.[1],
      result: fields?.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim(),
    })),
  )
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "omo-repeated-child-notices-"))
  const parentSessionId = `ses_parent_${basename(directory)}`
  const sessionId = `ses_child_${basename(directory)}`
  const child: StoredMessage[] = []
  const parent: StoredMessage[] = []
  const parentAdmissions: (readonly TextPart[])[] = []
  let childStatus: "idle" | "busy" = "idle"
  let childAdmission: (() => void) | undefined
  let taskId: string | undefined
  jest.useFakeTimers({ now: new Date("2026-11-27T12:00:00.000Z") })

  function storeMessage(history: StoredMessage[], role: StoredMessage["info"]["role"], parts: readonly TextPart[]) {
    const created = Date.now()
    const sessionID = history === child ? sessionId : parentSessionId
    const parentID = history.findLast((message) => message.info.role === "user")?.info.id
    const info = {
      id: `msg_${history.length + 1}`,
      sessionID,
      role,
      ...(role === "assistant"
        ? { parentID, finish: "stop" as const, time: { created, completed: created } }
        : { time: { created } }),
    }
    history.push({ info, parts })
    manager.handleEvent({ type: "message.updated", properties: { info } })
    for (const [index, part] of parts.entries()) {
      manager.handleEvent({
        type: "message.part.updated",
        properties: { part: { ...part, id: `${info.id}_part_${index}`, sessionID, messageID: info.id } },
      })
    }
  }

  const manager = new BackgroundManager({
    pluginContext: unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          create: async () => ({ data: { id: sessionId } }),
          get: async ({ path }: SessionPath) => ({
            data: { id: path.id, directory, ...(path.id === sessionId ? { parentID: parentSessionId } : {}) },
          }),
          status: async () => ({ data: { [sessionId]: { type: childStatus } } }),
          messages: async ({ path }: SessionPath) => ({ data: [...(path.id === sessionId ? child : parent)] }),
          todo: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
          promptAsync: async ({ path, body }: SessionPath & { readonly body: { readonly parts: readonly TextPart[] } }) => {
            if (path.id === sessionId) {
              childStatus = "busy"
              storeMessage(child, "user", body.parts)
              childAdmission?.()
            } else if (path.id === parentSessionId) {
              parentAdmissions.push(body.parts)
              parent.push({
                info: {
                  id: `msg_${parent.length + 1}`,
                  sessionID: parentSessionId,
                  role: "user",
                  time: { created: Date.now() },
                },
                parts: body.parts,
              })
            }
            return { data: {} }
          },
        },
      },
    }),
  })

  async function admitChild(start: () => Promise<BackgroundTask>): Promise<string> {
    const admission = Promise.withResolvers<void>()
    childAdmission = admission.resolve
    const deadline = realSetTimeout(
      () => admission.reject(new Error(`No prompt admitted to ${sessionId}`)),
      remainingTestTime(),
    )
    try {
      const [task] = await Promise.all([start(), admission.promise])
      taskId = task.id
      // Let the SDK return to the prompt gate before the fake clock moves the child to completion.
      await drainReadyWork()
      return task.id
    } finally {
      childAdmission = undefined
      realClearTimeout(deadline)
    }
  }

  function childIdle() {
    childStatus = "idle"
    manager.handleEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } })
    manager.handleEvent({ type: "session.idle", properties: { sessionID: sessionId } })
  }

  async function flushParent() {
    await drainReadyWork()
    manager.handleEvent({ type: "session.idle", properties: { sessionID: parentSessionId } })
    await drainReadyWork()
    jest.advanceTimersByTime(DEFAULT_SESSION_IDLE_SETTLE_MS)
    await drainReadyWork()
  }

  const delegation = { parentSessionId, description: "Check the result", agent: "explore", wake: "each" } as const
  return {
    sessionId,
    launch: () => admitChild(() => manager.launch({ ...delegation, parentMessageId: "msg_parent_1", prompt: "Check" })),
    resume: () =>
      admitChild(() => manager.resume({ sessionId, parentSessionId, parentMessageId: "msg_parent_2", prompt: "Check again" })),
    async handOffForeground() {
      childStatus = "busy"
      storeMessage(child, "user", [{ type: "text", text: "Check" }])
      const task = await manager.adoptForegroundSession({
        ...delegation,
        taskId: `sync_${sessionId}`,
        sessionId,
        startedAt: new Date(),
      })
      taskId = task.id
      return task.id
    },
    async finishAtNextPoll(result: string) {
      jest.advanceTimersByTime(1)
      storeMessage(child, "assistant", [{ type: "text", text: result }])
      childStatus = "idle"
      jest.advanceTimersByTime(POLLING_INTERVAL_MS - 1)
      await flushParent()
    },
    acknowledgeParentNotice() {
      jest.advanceTimersByTime(1)
      storeMessage(parent, "assistant", [{ type: "text", text: "Acknowledged" }])
    },
    async finishDirectTurn(result: string) {
      childStatus = "busy"
      storeMessage(child, "user", [{ type: "text", text: "Check one more thing" }])
      manager.handleEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } })
      jest.advanceTimersByTime(MIN_IDLE_TIME_MS)
      await drainReadyWork()
      storeMessage(child, "assistant", [{ type: "text", text: result }])
      childIdle()
      await flushParent()
    },
    childIdle,
    flushParent,
    notices: () => parentAdmissions.map(terminalNotices),
    async cleanup() {
      try {
        await manager.shutdown()
      } finally {
        if (taskId !== undefined) forgetBackgroundTask(taskId)
        releaseAllPromptAsyncReservationsForTesting()
        jest.useRealTimers()
        new TaskRecoveryStore().remove(sessionId)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

describe("BackgroundManager repeated child completion notices", () => {
  test.each(["background launch", "foreground handoff"] as const)(
    "admits a terminal parent notice for each same-child run with identical results after %s",
    async (origin) => {
      const fixture = createFixture()
      const result = "All checks passed"
      try {
        // given
        const taskId = await (origin === "background launch" ? fixture.launch() : fixture.handOffForeground())
        const notice = { taskId, sessionId: fixture.sessionId, status: "completed", result }
        await fixture.finishAtNextPoll(result)
        expect(fixture.notices()).toEqual([[notice]])

        // when
        expect(await fixture.resume()).toBe(taskId)
        await fixture.finishAtNextPoll(result)

        // then
        expect(fixture.notices()).toEqual([[notice], [notice]])
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test("reports a direct child turn after the delegated run has already reported", async () => {
    const fixture = createFixture()
    try {
      // given
      const taskId = await fixture.launch()
      const first = { taskId, sessionId: fixture.sessionId, status: "completed", result: "Delegated check passed" }
      await fixture.finishAtNextPoll(first.result)
      expect(fixture.notices()).toEqual([[first]])
      fixture.acknowledgeParentNotice()
      // The replay must not be hidden by either the notifier's dispatched entry or the gate's recent-dispatch cache.
      jest.advanceTimersByTime(DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS + 1)
      fixture.childIdle()
      await fixture.flushParent()
      expect(fixture.notices()).toEqual([[first]])

      // when
      const result = "Direct check found a new result"
      await fixture.finishDirectTurn(result)

      // then
      expect(fixture.notices()).toEqual([[first], [{ ...first, taskId: expect.any(String), result }]])
    } finally {
      await fixture.cleanup()
    }
  })
})

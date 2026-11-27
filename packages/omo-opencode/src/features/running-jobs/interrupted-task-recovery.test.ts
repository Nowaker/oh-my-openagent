import { $ } from "bun"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { awaitWithinTestBudget } from "../../../../../test-support/test-deadline"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { BackgroundManager } from "../background-agent"
import { withRunningJobsClaim } from "./claim-on-message"
import { createRunningJobsLedger } from "./wiring"

type SessionPath = { readonly path: { readonly id: string } }
type TextPart = { readonly type: "text"; readonly text: string; readonly synthetic?: boolean }
type SessionMessage = {
  readonly info: {
    readonly id: string
    readonly sessionID: string
    readonly role: "user" | "assistant"
    readonly parentID?: string
    readonly time: { readonly created: number; readonly completed?: number }
    readonly finish?: string
  }
  readonly parts: readonly TextPart[]
}

test.each([
  ["acknowledged", true],
  ["stored without a reply", false],
] satisfies [scenario: string, acknowledged: boolean][])("#given an interrupted task notice is %s #when the parent reopens #then only an owed reply is retriggered", async (_scenario, acknowledged) => {
  const directory = mkdtempSync(join(tmpdir(), "omo-interrupted-task-recovery-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = directory
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 14)
  const rootID = `ses_000000000000${suffix}`
  const parentID = `ses_000000000001${suffix}`
  const childID = `ses_000000000002${suffix}`
  const parentMessageID = `msg_000000000000${suffix}`
  const child = { id: childID, parentID, directory, title: "Child", time: { created: 3 } }
  const sessions = [
    { id: rootID, directory, title: "Root", time: { created: 1 } },
    { id: parentID, parentID: rootID, directory, title: "Parent", time: { created: 2 } },
    child,
  ]
  const idle = { type: "idle" } as const
  const busy = { type: "busy" } as const
  const parentHistory: SessionMessage[] = [
    {
      info: { id: parentMessageID, sessionID: parentID, role: "user", time: { created: 4 } },
      parts: [{ type: "text", text: "Delegate the review" }],
    },
    {
      info: {
        id: `msg_000000000001${suffix}`,
        sessionID: parentID,
        role: "assistant",
        parentID: parentMessageID,
        time: { created: 5, completed: 6 },
        finish: "stop",
      },
      parts: [{ type: "text", text: "Waiting for the review" }],
    },
  ]
  const childHistory: SessionMessage[] = []
  let childStatus: typeof idle | typeof busy = idle
  const childStarted = Promise.withResolvers<void>()
  type ParentDelivery = {
    readonly messageID: string
    readonly created: number
    readonly noReply: boolean
    readonly text: string
  }
  const parentDeliveries: ParentDelivery[] = []
  const parentAdmitted = Promise.withResolvers<ParentDelivery>()
  const pointerAdmitted = Promise.withResolvers<ParentDelivery>()
  const admissions = [parentAdmitted, pointerAdmitted] as const
  const serverUrl = new URL("http://127.0.0.1:1")
  const client = createOpencodeClient({ baseUrl: serverUrl.href })
  Object.assign(client.session, {
    create: async () => ({ data: child }),
    get: async ({ path }: SessionPath) => ({ data: sessions.find((session) => session.id === path.id) }),
    children: async ({ path }: SessionPath) => ({ data: sessions.filter((session) => session.parentID === path.id) }),
    status: async () => ({ data: { [rootID]: idle, [parentID]: idle, [childID]: childStatus } }),
    messages: async ({ path }: SessionPath) => ({
      data: path.id === parentID ? parentHistory : path.id === childID ? childHistory : [],
    }),
    todo: async () => ({ data: [] }),
    abort: async () => {
      childStatus = idle
      return { data: true }
    },
    promptAsync: async ({ path, body }: Parameters<PluginInput["client"]["session"]["promptAsync"]>[0]) => {
      const parts = body?.parts?.filter((part) => part.type === "text") ?? []
      const created = Date.now()
      if (path.id === childID) {
        childStatus = busy
        childHistory.push({
          info: { id: `msg_000000000002${suffix}`, sessionID: childID, role: "user", time: { created } },
          parts,
        })
        childStarted.resolve()
      }
      if (path.id === parentID) {
        const messageID = body?.messageID ?? `msg_000000000003${suffix}`
        parentHistory.push({ info: { id: messageID, sessionID: parentID, role: "user", time: { created } }, parts })
        const delivery = { messageID, created, noReply: body?.noReply === true, text: parts.map((part) => part.text).join("\n") }
        admissions[parentDeliveries.length]?.resolve(delivery)
        parentDeliveries.push(delivery)
      }
      return {}
    },
  })
  const pluginContext: PluginInput = {
    client,
    project: { id: "interrupted-task-recovery", worktree: directory, time: { created: 1 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl,
    $,
  }
  const hosts: Array<{
    readonly manager: BackgroundManager
    readonly ledger: ReturnType<typeof createRunningJobsLedger>
  }> = []
  const openHost = () => {
    const manager = new BackgroundManager({ pluginContext })
    const ledger = createRunningJobsLedger({
      backgroundManager: manager,
      bashBackgroundManager: { listAll: () => [] },
      argv: [],
      root: join(directory, "running-jobs"),
      pid: process.pid + hosts.length,
      isAlive: () => false,
    })
    const host = { manager, ledger, receiveFirstMessage: withRunningJobsClaim(ledger, async () => {}) }
    hosts.push(host)
    return host
  }

  async function receiveWake(host: ReturnType<typeof openHost>, admission: Promise<ParentDelivery>) {
    const manager = host.manager
    const wakeSettled = manager.awaitScheduledFlush(parentID, manager.getScheduledFlushSettledCount(parentID))
    await host.receiveFirstMessage({ sessionID: parentID }, undefined)
    const delivery = await awaitWithinTestBudget(admission, "the recovered parent's SDK prompt")
    // The flush writes a continuation marker after admission, even if the assertion below fails.
    await awaitWithinTestBudget(wakeSettled, "the recovered parent wake flush to settle")
    return delivery
  }

  function acknowledge(manager: BackgroundManager, delivery: ParentDelivery): void {
    const created = delivery.created + 1
    const info = {
      id: `msg_ffffffffffff${suffix}`,
      sessionID: parentID,
      parentID: delivery.messageID,
      role: "assistant",
      time: { created, completed: created },
      finish: "stop",
    } as const
    parentHistory.push({ info, parts: [{ type: "text", text: "I saw the interruption." }] })
    manager.handleEvent({ type: "message.updated", properties: { info } })
  }

  async function closeHost({ ledger, manager }: ReturnType<typeof openHost>): Promise<void> {
    ledger.flush()
    ledger.shutdown()
    await manager.shutdown()
    releasePromptAsyncReservation(parentID, "background-agent-parent-wake")
  }

  try {
    // given
    const owner = openHost()
    const task = await owner.manager.launch({
      agent: "explore",
      description: "Review the report",
      prompt: "Review the report without finishing before the stop",
      model: { providerID: "openai", modelID: "review-model" },
      parentSessionId: parentID,
      parentMessageId: parentMessageID,
      wake: "none",
    })
    await awaitWithinTestBudget(childStarted.promise, "the original child prompt admission")
    await closeHost(owner)
    releasePromptAsyncReservation(childID, "background-agent-launch")

    // when
    const reopened = openHost()
    if (acknowledged) {
      childStatus = busy
      await reopened.receiveFirstMessage({ sessionID: parentID }, undefined)
      expect(reopened.manager.listUndeliveredParentWakes()).toEqual([])
      expect(parentDeliveries).toHaveLength(0)
      childStatus = idle
    }
    const delivery = await receiveWake(reopened, parentAdmitted.promise)

    // then
    expect(delivery.noReply).toBe(false)
    expect(delivery.text).toContain("<task-notification>")
    const noticeFields = [...delivery.text.matchAll(/<(task-id|session-id|run-id|status)>([^<]+)<\/\1>/g)].map(
      ([, field, value]) => [field, value] as const,
    )
    expect(Object.fromEntries(noticeFields)).toEqual({
      "task-id": task.id,
      "session-id": childID,
      "run-id": task.runId,
      status: "interrupted",
    })
    expect(noticeFields).toHaveLength(4)

    if (acknowledged) acknowledge(reopened.manager, delivery)
    await closeHost(reopened)

    if (!acknowledged) {
      const replay = openHost()
      const pointer = await receiveWake(replay, pointerAdmitted.promise)
      expect(pointer.noReply).toBe(false)
      expect(pointer.text.match(/<resume-run-id>([^<]+)<\/resume-run-id>/)?.[1]).toBe(task.runId)
      expect(pointer.text).not.toContain("<task-notification>")
      acknowledge(replay.manager, pointer)
      await closeHost(replay)
    }

    const restartedAgain = openHost()
    await restartedAgain.receiveFirstMessage({ sessionID: parentID }, undefined)
    expect(restartedAgain.manager.listUndeliveredParentWakes()).toEqual([])
    expect(parentDeliveries).toHaveLength(acknowledged ? 1 : 2)
  } finally {
    for (const { ledger, manager } of hosts) {
      ledger.shutdown()
      await manager.shutdown()
    }
    releasePromptAsyncReservation(childID, "background-agent-launch")
    releasePromptAsyncReservation(parentID, "background-agent-parent-wake")
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    rmSync(directory, { recursive: true, force: true })
  }
})

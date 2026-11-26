import { describe, expect, mock, test } from "bun:test"
import {
  BashBackgroundManager,
  BASH_BACKGROUND_EXITED_EVENT,
  BASH_BACKGROUND_EXPIRY_MARGIN_MS,
  BASH_BACKGROUND_STARTED_EVENT,
} from "./manager"
import { cancelBackgroundJob } from "./cancel-route"
import type { BashBackgroundExited, BashBackgroundStarted } from "./types"

function started(id: string, sessionID = "ses_parent"): { type: string; properties: BashBackgroundStarted } {
  return {
    type: BASH_BACKGROUND_STARTED_EVENT,
    properties: {
      sessionID,
      messageID: "msg_1",
      callID: "call_1",
      id,
      command: "npm run build",
      outputPath: `/tmp/${id}`,
      reason: "requested",
      timeoutMs: 7_200_000,
    },
  }
}

function exited(
  id: string,
  overrides: Partial<BashBackgroundExited> = {},
): { type: string; properties: BashBackgroundExited } {
  return {
    type: BASH_BACKGROUND_EXITED_EVENT,
    properties: {
      sessionID: "ses_parent",
      id,
      command: "npm run build",
      status: "failed",
      exitCode: 2,
      durationMs: 75_000,
      outputPath: `/tmp/${id}`,
      output: "error TS2322\n",
      ...overrides,
    },
  }
}

describe("BashBackgroundManager", () => {
  test("#given a background command #when it exits #then it is no longer listed", async () => {
    // given
    const manager = new BashBackgroundManager({ cancelJob: async () => true })
    await manager.handleEvent(started("bash_1"))
    expect(manager.list("ses_parent").map((record) => record.id)).toEqual(["bash_1"])

    // when
    await manager.handleEvent(exited("bash_1"))

    // then
    expect(manager.list("ses_parent")).toEqual([])
    expect(manager.get("bash_1")).toBeUndefined()
  })

  test("#given commands of two sessions #when one session is forgotten #then only the other's remain", async () => {
    const manager = new BashBackgroundManager({ cancelJob: async () => true })
    await manager.handleEvent(started("bash_a", "ses_a"))
    await manager.handleEvent(started("bash_b", "ses_b"))
    manager.forgetSession("ses_a")
    expect(manager.list("ses_a")).toEqual([])
    expect(manager.list("ses_b").map((record) => record.id)).toEqual(["bash_b"])
  })

  test("#given an exit that arrived before its start #when the start arrives #then the command is not recorded as running", async () => {
    // given
    const manager = new BashBackgroundManager({ cancelJob: async () => true })
    await manager.handleEvent(exited("bash_late", { status: "completed", exitCode: 0 }))

    // when
    await manager.handleEvent(started("bash_late"))

    // then
    expect(manager.get("bash_late")).toBeUndefined()
    expect(manager.list("ses_parent")).toEqual([])
  })

  test("#given a record older than its timeout plus the margin #when listed #then it is gone, while one without a timeout stays", async () => {
    // given
    let now = 1_000_000
    const manager = new BashBackgroundManager({ cancelJob: async () => true, now: () => now })
    await manager.handleEvent(started("bash_capped"))
    const unbounded = started("bash_unbounded")
    await manager.handleEvent({ ...unbounded, properties: { ...unbounded.properties, timeoutMs: null } })

    // when
    now += 7_200_000 + BASH_BACKGROUND_EXPIRY_MARGIN_MS - 1
    const beforeExpiry = manager.list("ses_parent").map((record) => record.id)
    now += 2
    const afterExpiry = manager.list("ses_parent").map((record) => record.id)

    // then
    expect(beforeExpiry).toEqual(["bash_capped", "bash_unbounded"])
    expect(afterExpiry).toEqual(["bash_unbounded"])
    expect(manager.get("bash_capped")).toBeUndefined()
  })

  test("#given a record past its timeout plus the margin #when every session's commands are listed #then it is gone", async () => {
    // given
    let now = 1_000_000
    const manager = new BashBackgroundManager({ cancelJob: async () => true, now: () => now })
    await manager.handleEvent(started("bash_capped", "ses_a"))

    // when
    now += 7_200_000 + BASH_BACKGROUND_EXPIRY_MARGIN_MS + 1
    await manager.handleEvent(started("bash_fresh", "ses_b"))

    // then
    expect(manager.listAll().map((record) => record.id)).toEqual(["bash_fresh"])
  })
})

describe("BashBackgroundManager stop through the owner SDK", () => {
  const route = { url: "/experimental/background/{jobID}/cancel", path: { jobID: "bash_9" } }
  const directory = "/work/project"
  const parent = "ses_parent"

  test.each([
    { name: "without an advertisement", tracked: true, advertisement: undefined, query: { directory } },
    { name: "with a version-1 advertisement", tracked: true, advertisement: 1, query: { directory, toolResultForSessionID: parent } },
    { name: "with a string instead of version 1", tracked: true, advertisement: "1", query: { directory } },
    { name: "with no local start record", tracked: false, advertisement: undefined, query: { directory } },
  ])("sends one request and retires a confirmed stop $name", async ({ tracked, advertisement, query }) => {
    const post = mock(async (_options: unknown) => ({ data: true }))
    const manager = new BashBackgroundManager({
      cancelJob: (request) => cancelBackgroundJob({ _client: { post } }, directory, request),
    })
    if (tracked) {
      const event = started("bash_9", parent)
      await manager.handleEvent({ ...event, properties: { ...event.properties, cancelToolReceipt: advertisement } })
    }

    expect(await manager.stop("bash_9", parent)).toBe(true)
    expect(post.mock.calls).toEqual([[{ ...route, query }]])
    expect(manager.list(parent)).toEqual([])
  })

  test("refuses a stop if the current record belongs to a different session", async () => {
    const post = mock(async (_options: unknown) => ({ data: true }))
    const manager = new BashBackgroundManager({
      cancelJob: (request) => cancelBackgroundJob({ _client: { post } }, directory, request),
    })
    const event = started("bash_9", "ses_other")
    await manager.handleEvent({ ...event, properties: { ...event.properties, cancelToolReceipt: 1 } })

    expect(await manager.stop("bash_9", parent)).toBe(false)
    expect(post.mock.calls).toEqual([])
    expect(manager.list("ses_other").map(({ id }) => id)).toEqual(["bash_9"])
  })

  test.each([
    { name: "false", answer: async () => ({ data: false }) },
    { name: "SDK rejection", answer: async () => ({ error: { name: "NotFound" } }) },
    { name: "transport failure", answer: async () => { throw new Error("Owner SDK unavailable") } },
  ])("keeps the running record until exit after $name, without retrying", async ({ name, answer }) => {
    const post = mock(async (_options: unknown) => answer())
    const manager = new BashBackgroundManager({
      cancelJob: (request) => cancelBackgroundJob({ _client: { post } }, directory, request),
    })
    const event = started("bash_9", parent)
    await manager.handleEvent({ ...event, properties: { ...event.properties, cancelToolReceipt: 1 } })

    const stopping = manager.stop("bash_9", parent)
    if (name === "false") await expect(stopping).resolves.toBe(false)
    else await expect(stopping).rejects.toThrow(name === "SDK rejection" ? "refused to stop bash_9" : "Owner SDK unavailable")

    expect(post.mock.calls).toEqual([[{ ...route, query: { directory, toolResultForSessionID: parent } }]])
    expect(manager.list(parent).map(({ id }) => id)).toEqual(["bash_9"])
    await manager.handleEvent(exited("bash_9"))
    expect(manager.list(parent)).toEqual([])
  })
})

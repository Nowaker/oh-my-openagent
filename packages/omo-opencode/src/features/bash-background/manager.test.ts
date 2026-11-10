import { describe, expect, mock, test } from "bun:test"
import { BashBackgroundManager, BASH_BACKGROUND_EXITED_EVENT, BASH_BACKGROUND_STARTED_EVENT } from "./manager"
import { cancelBackgroundJob } from "./cancel-route"
import type { BashBackgroundExited, BashBackgroundStarted } from "./types"

function started(id: string, sessionID = "ses_parent"): { type: string; properties: BashBackgroundStarted } {
  return {
    type: BASH_BACKGROUND_STARTED_EVENT,
    properties: { sessionID, messageID: "msg_1", callID: "call_1", id, command: "npm run build", outputPath: `/tmp/${id}`, reason: "requested", timeoutMs: 7_200_000 },
  }
}

function exited(id: string, overrides: Partial<BashBackgroundExited> = {}): { type: string; properties: BashBackgroundExited } {
  return {
    type: BASH_BACKGROUND_EXITED_EVENT,
    properties: { sessionID: "ses_parent", id, command: "npm run build", status: "failed", exitCode: 2, durationMs: 75_000, outputPath: `/tmp/${id}`, output: "error TS2322\n", ...overrides },
  }
}

describe("BashBackgroundManager", () => {
  test("#given a background command #when it exits #then its session gets one notice with the exit code and output tail", async () => {
    // given
    const notify = mock(async (_sessionID: string, _notice: string) => {})
    const manager = new BashBackgroundManager({ notify, cancelJob: async () => true })
    await manager.handleEvent(started("bash_1"))
    expect(manager.list("ses_parent").map((record) => record.id)).toEqual(["bash_1"])

    // when
    await manager.handleEvent(exited("bash_1"))

    // then
    expect(notify).toHaveBeenCalledTimes(1)
    const [sessionID, notice] = notify.mock.calls[0] ?? []
    expect(sessionID).toBe("ses_parent")
    expect(notice?.split("\n")[1]).toBe("[BASH COMMAND FAILED]")
    expect(notice).toContain("<task-id>bash_1</task-id>")
    expect(notice).toContain("<exit-code>2</exit-code>")
    expect(notice).toContain("error TS2322")
    expect(notice).toContain("Full output: /tmp/bash_1")
    expect(manager.list("ses_parent")).toEqual([])
  })

  test("#given a command stopped through stop() #when its exit arrives #then no notice is sent", async () => {
    // given
    const notify = mock(async () => {})
    const cancelJob = mock(async (_id: string) => true)
    const manager = new BashBackgroundManager({ notify, cancelJob })
    await manager.handleEvent(started("bash_2"))

    // when
    expect(await manager.stop("bash_2")).toBe(true)
    await manager.handleEvent(exited("bash_2", { status: "cancelled", exitCode: undefined }))

    // then
    expect(cancelJob).toHaveBeenCalledWith("bash_2")
    expect(notify).not.toHaveBeenCalled()
  })

  test("#given a stop that found nothing running #when an exit for that id arrives later #then it is still reported", async () => {
    // given
    const notify = mock(async () => {})
    const manager = new BashBackgroundManager({ notify, cancelJob: async () => false })

    // when
    expect(await manager.stop("bash_3")).toBe(false)
    await manager.handleEvent(exited("bash_3", { status: "completed", exitCode: 0 }))

    // then
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test("#given commands of two sessions #when one session is forgotten #then only the other's remain", async () => {
    const manager = new BashBackgroundManager({ notify: async () => {}, cancelJob: async () => true })
    await manager.handleEvent(started("bash_a", "ses_a"))
    await manager.handleEvent(started("bash_b", "ses_b"))
    manager.forgetSession("ses_a")
    expect(manager.list("ses_a")).toEqual([])
    expect(manager.list("ses_b").map((record) => record.id)).toEqual(["bash_b"])
  })
})

describe("cancelBackgroundJob", () => {
  test("#given the SDK transport #when a job is cancelled #then it posts to the cancel route and returns the route's answer", async () => {
    // given
    const post = mock(async (_options: unknown) => ({ data: true }))
    const client = { _client: { post } }

    // when
    const stopped = await cancelBackgroundJob(client, "/work/project", "bash_9")

    // then
    expect(stopped).toBe(true)
    expect(post).toHaveBeenCalledWith({ url: "/experimental/background/{jobID}/cancel", path: { jobID: "bash_9" }, query: { directory: "/work/project" } })
  })

  test("#given the route answers with an error #when cancelled #then the error is raised", async () => {
    const client = { _client: { post: async () => ({ error: { name: "NotFound" } }) } }
    await expect(cancelBackgroundJob(client, "/work", "bash_9")).rejects.toThrow("refused to stop bash_9")
  })
})

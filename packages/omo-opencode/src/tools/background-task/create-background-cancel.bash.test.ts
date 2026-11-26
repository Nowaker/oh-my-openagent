import { describe, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { BackgroundManager } from "../../features/background-agent"
import {
  BashBackgroundManager,
  BASH_BACKGROUND_STARTED_EVENT,
  type BashBackgroundCancelRequest,
  type BashBackgroundStarted,
} from "../../features/bash-background"
import { createBackgroundCancel } from "./create-background-cancel"

const backgroundManager = unsafeTestValue<BackgroundManager>({
  getTask: () => undefined,
  getAllDescendantTasks: () => [],
})
const context = unsafeTestValue({ sessionID: "ses_parent" })

type Command = Pick<BashBackgroundStarted, "id" | "sessionID" | "cancelToolReceipt"> & {
  readonly stopError?: string
}

async function withCommands(...commands: Command[]) {
  const cancelJob = mock(async (request: BashBackgroundCancelRequest) => {
    const stopError = commands.find(({ id }) => id === request.jobID)?.stopError
    if (stopError) throw new Error(stopError)
    return true
  })
  const bash = new BashBackgroundManager({ cancelJob })
  for (const { id, sessionID, cancelToolReceipt } of commands) {
    await bash.handleEvent({
      type: BASH_BACKGROUND_STARTED_EVENT,
      properties: {
        sessionID,
        messageID: "msg_1",
        callID: "call_1",
        id,
        command: "npm run dev",
        outputPath: `/tmp/${id}`,
        reason: "requested",
        timeoutMs: null,
        cancelToolReceipt,
      },
    })
  }
  return { bash, cancelJob, cancel: createBackgroundCancel(backgroundManager, unsafeTestValue({}), undefined, bash) }
}

describe("background_cancel with a background bash command id", () => {
  test("#given a running command of this session #when its id is cancelled #then the command is stopped", async () => {
    // given
    const { cancel, cancelJob } = await withCommands({ id: "bash_1", sessionID: "ses_parent", cancelToolReceipt: 1 })

    // when
    const result = await cancel.execute({ taskId: "bash_1" }, context)

    // then
    expect(cancelJob.mock.calls).toEqual([[{ jobID: "bash_1", toolResultForSessionID: "ses_parent" }]])
    expect(result).toContain("Background command stopped")
    expect(result).toContain("Output file: /tmp/bash_1")
  })

  test("#given another session's command #when its id is cancelled here #then it is left running", async () => {
    // given
    const { cancel, cancelJob } = await withCommands({ id: "bash_2", sessionID: "ses_other", cancelToolReceipt: 1 })

    // when
    const result = await cancel.execute({ taskId: "bash_2" }, context)

    // then
    expect(cancelJob).not.toHaveBeenCalled()
    expect(result).toContain("not found")
  })

  test("#given all=true #when cancelling #then only this session's background commands are stopped", async () => {
    // given
    const { cancel, cancelJob } = await withCommands(
      { id: "bash_3", sessionID: "ses_parent" },
      { id: "bash_4", sessionID: "ses_other", cancelToolReceipt: 1 },
      { id: "bash_5", sessionID: "ses_parent", cancelToolReceipt: 1 },
    )

    // when
    const result = await cancel.execute({ all: true }, context)

    // then
    expect(cancelJob.mock.calls).toEqual([
      [{ jobID: "bash_3" }],
      [{ jobID: "bash_5", toolResultForSessionID: "ses_parent" }],
    ])
    expect(result).toContain("Stopped 2 background command(s)")
  })

  test("returns a confirmed Bash job ID even if the next stop throws", async () => {
    const { bash, cancel, cancelJob } = await withCommands(
      { id: "bash_confirmed", sessionID: "ses_parent", cancelToolReceipt: 1 },
      { id: "bash_refused", sessionID: "ses_parent", cancelToolReceipt: 1, stopError: "Owner refused" },
    )

    const result = await cancel.execute({ all: true }, context)

    expect(result).toContain("`bash_confirmed`")
    expect(result).toContain("[ERROR]")
    expect(result).not.toContain("`bash_refused`")
    expect(cancelJob.mock.calls).toEqual([
      [{ jobID: "bash_confirmed", toolResultForSessionID: "ses_parent" }],
      [{ jobID: "bash_refused", toolResultForSessionID: "ses_parent" }],
    ])
    expect(bash.list("ses_parent").map(({ id }) => id)).toEqual(["bash_refused"])
  })
})

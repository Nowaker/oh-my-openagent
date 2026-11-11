import { describe, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { BackgroundManager } from "../../features/background-agent"
import { BashBackgroundManager, BASH_BACKGROUND_STARTED_EVENT } from "../../features/bash-background"
import { createBackgroundCancel } from "./create-background-cancel"

const backgroundManager = unsafeTestValue<BackgroundManager>({ getTask: () => undefined, getAllDescendantTasks: () => [] })
const context = unsafeTestValue({ sessionID: "ses_parent" })

async function withCommands(...commands: Array<{ id: string; sessionID: string }>) {
  const cancelJob = mock(async (_id: string) => true)
  const bash = new BashBackgroundManager({ cancelJob })
  for (const { id, sessionID } of commands) {
    await bash.handleEvent({
      type: BASH_BACKGROUND_STARTED_EVENT,
      properties: { sessionID, messageID: "msg_1", callID: "call_1", id, command: "npm run dev", outputPath: `/tmp/${id}`, reason: "requested", timeoutMs: null },
    })
  }
  return { bash, cancelJob, cancel: createBackgroundCancel(backgroundManager, unsafeTestValue({}), undefined, bash) }
}

describe("background_cancel with a background bash command id", () => {
  test("#given a running command of this session #when its id is cancelled #then the command is stopped", async () => {
    // given
    const { cancel, cancelJob } = await withCommands({ id: "bash_1", sessionID: "ses_parent" })

    // when
    const result = await cancel.execute({ taskId: "bash_1" }, context)

    // then
    expect(cancelJob).toHaveBeenCalledWith("bash_1")
    expect(result).toContain("Background command stopped")
    expect(result).toContain("Output file: /tmp/bash_1")
  })

  test("#given another session's command #when its id is cancelled here #then it is left running", async () => {
    // given
    const { cancel, cancelJob } = await withCommands({ id: "bash_2", sessionID: "ses_other" })

    // when
    const result = await cancel.execute({ taskId: "bash_2" }, context)

    // then
    expect(cancelJob).not.toHaveBeenCalled()
    expect(result).toContain("not found")
  })

  test("#given all=true #when cancelling #then only this session's background commands are stopped", async () => {
    // given
    const { cancel, cancelJob } = await withCommands({ id: "bash_3", sessionID: "ses_parent" }, { id: "bash_4", sessionID: "ses_other" })

    // when
    const result = await cancel.execute({ all: true }, context)

    // then
    expect(cancelJob.mock.calls.map(([id]) => id)).toEqual(["bash_3"])
    expect(result).toContain("Stopped 1 background command(s)")
  })
})

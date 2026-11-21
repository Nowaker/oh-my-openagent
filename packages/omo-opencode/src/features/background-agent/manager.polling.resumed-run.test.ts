/// <reference types="bun-types" />

import { describe, test, expect } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { ensureCurrentAttempt } from "./attempt-lifecycle"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type StoredMessage = {
  info: { role: string; id: string; finish?: string; time: { created: number; completed?: number } }
  parts: Array<{ type: string; text?: string }>
}

function createPluginContext(client: object): PluginInput {
  const directory = tmpdir()
  return {
    project: { id: "test-project", worktree: directory, time: { created: Date.now() } },
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    $: {} as PluginInput["$"],
    client: client as PluginInput["client"],
  }
}

/*
 * A resumed child keeps its earlier run's answer in its history. Between the continuation being admitted and the
 * child's loop starting, opencode reports the session idle (absent from session.status), so a poll in that window
 * once read the old answer as the new run's output, completed the task and aborted the child, cancelling the
 * continuation before it ran (2026-11-18, ses_e141de0d1ffeKiqOglmynGpUao).
 */
describe("BackgroundManager polling a resumed run", () => {
  const sessionId = "ses_resumed_child"
  const earlier = Date.now() - 60_000

  function rig(options?: { readonly notify?: true; readonly holdAbort?: () => Promise<void> }) {
    const messages: StoredMessage[] = [
      { info: { role: "user", id: "msg_1", time: { created: earlier } }, parts: [{ type: "text", text: "go" }] },
      {
        info: {
          role: "assistant",
          id: "msg_2",
          finish: "stop",
          time: { created: earlier + 1, completed: earlier + 2 },
        },
        parts: [{ type: "text", text: "earlier answer" }],
      },
    ]
    const aborted: string[] = []
    const resumeDispatched = Promise.withResolvers<void>()
    let prompted = 0
    const client = {
      session: {
        status: async () => ({ data: options?.notify ? { "parent-session": { type: "busy" } } : {} }),
        get: async () => ({ data: { id: sessionId } }),
        prompt: async () => ({}),
        promptAsync: async ({ path }: { path: { id: string } }) => {
          prompted += 1
          if (path.id === sessionId) resumeDispatched.resolve()
          return {}
        },
        abort: async (input: { path: { id: string } }) => {
          aborted.push(input.path.id)
          if (aborted.length === 1) await options?.holdAbort?.()
          return {}
        },
        todo: async () => ({ data: [] }),
        messages: async () => ({ data: [...messages] }),
      },
    }
    const manager = new BackgroundManager({
      pluginContext: createPluginContext(client),
      config: undefined,
      enableParentSessionNotifications: options?.notify ?? false,
    })
    const task: BackgroundTask = {
      id: "bg_resumed",
      sessionId,
      parentSessionId: "parent-session",
      parentMessageId: "parent-msg",
      description: "resumed task",
      prompt: "go",
      agent: "explore",
      status: "completed",
      startedAt: new Date(earlier),
      completedAt: new Date(earlier + 2),
      concurrencyGroup: "explore",
    }
    manager["tasks"].set(task.id, task)
    // The earlier run's output was seen as it streamed.
    manager["markSessionOutputObserved"](sessionId)
    return { manager, task, messages, aborted, resumeDispatched: resumeDispatched.promise, promptCount: () => prompted }
  }

  async function resume(manager: BackgroundManager): Promise<void> {
    await manager.resume({
      sessionId,
      prompt: "continue with the next step",
      parentSessionId: "parent-session",
      parentMessageId: "parent-msg-2",
    })
  }

  test("#given only the earlier run's answer #when polled before the continuation starts #then the task keeps running and the child is not aborted", async () => {
    const { manager, task, aborted, promptCount } = rig()

    await resume(manager)
    for (let attempt = 0; attempt < 50 && promptCount() === 0; attempt += 1) await Promise.resolve()
    await manager["pollRunningTasks"]()

    expect(promptCount()).toBe(1)
    expect(task.status).toBe("running")
    expect(aborted).toEqual([])
    await manager.shutdown()
  })

  test("#given an answer written after the resume #when polled #then the resumed run completes", async () => {
    const { manager, task, messages } = rig()

    await resume(manager)
    const now = Date.now()
    messages.push(
      { info: { role: "user", id: "msg_3", time: { created: now } }, parts: [{ type: "text", text: "continue" }] },
      {
        info: { role: "assistant", id: "msg_4", finish: "stop", time: { created: now + 1, completed: now + 2 } },
        parts: [{ type: "text", text: "next answer" }],
      },
    )
    await manager["pollRunningTasks"]()

    expect(task.status).toBe("completed")
    await manager.shutdown()
  })

  function noticeResults(manager: BackgroundManager): Array<string | null> {
    return manager
      .listUndeliveredParentWakes()
      .flatMap(({ notifications }) =>
        notifications.map((text) => /<result>\n(.*?)\n<\/result>/s.exec(text)?.[1] ?? null),
      )
  }

  test.each(["next answer", null])(
    "#when an existing native task completes its continuation (%s) #then both finishes report only their own result",
    async (answer) => {
      const { manager, task, messages, resumeDispatched } = rig({ notify: true })
      try {
        task.status = "running"
        task.completedAt = undefined
        ensureCurrentAttempt(task)
        await manager["pollRunningTasks"]()
        expect(noticeResults(manager)).toEqual(["earlier answer"])

        await resume(manager)
        await resumeDispatched
        const now = Date.now()
        messages.push({
          info: { role: "assistant", id: "msg_3", finish: "stop", time: { created: now, completed: now } },
          parts: answer === null ? [] : [{ type: "text", text: answer }],
        })
        await manager["pollRunningTasks"]()

        expect(noticeResults(manager)).toEqual(["earlier answer", answer])
      } finally {
        await manager.shutdown()
      }
    },
  )

  test("#given first completion is still being prepared #when the child resumes #then the old notice still reports the original result", async () => {
    const abortEntered = Promise.withResolvers<void>()
    const abortReleased = Promise.withResolvers<void>()
    const { manager, task, messages, resumeDispatched } = rig({
      notify: true,
      holdAbort: () => {
        abortEntered.resolve()
        return abortReleased.promise
      },
    })
    task.status = "running"
    task.completedAt = undefined
    ensureCurrentAttempt(task)
    const firstCompletion = manager["pollRunningTasks"]()
    try {
      await abortEntered.promise
      await resume(manager)
      await resumeDispatched
      messages.push({
        info: { role: "assistant", id: "msg_3", time: { created: Date.now() + 1 } },
        parts: [{ type: "text", text: "continued work in progress" }],
      })
      abortReleased.resolve()
      await firstCompletion

      expect(noticeResults(manager)).toEqual(["earlier answer"])
      expect(manager.listUnfinishedTasks().map(({ id }) => id)).toEqual([task.id])
    } finally {
      abortReleased.resolve()
      await firstCompletion
      await manager.shutdown()
    }
  })
})

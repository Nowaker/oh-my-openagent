import { describe, expect, test, spyOn } from "bun:test"
import { z } from "zod"
import { createNativeTaskFixture } from "./native-task-test-fixture"
import { NativeTaskCapabilityError } from "./native-task-types"

const resultMessages = z.object({ messages: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()) })

describe("native task durable output", () => {
  test.each([
    { busy: 8, idle: 3, expected: "running" },
    { busy: 3, idle: 8, expected: "completed" },
  ])("uses the latest execution timestamps instead of a stale terminal outcome: %j", async ({ busy, idle, expected }) => {
    // given
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      const child = fixture.sessions.get("ses_child_1")
      if (!child) throw new Error("Missing child")
      fixture.sessions.set(child.id, { ...child, time: { created: 1, updated: 9, busy, idle }, outcome: "succeeded" })
      // when
      const result = await fixture.call("background_output", { task_id: child.id })
      // then
      expect(result.output).toMatchObject({ status: expected })
    } finally { await fixture.close() }
  })

  test.each(["shell" as const, "image" as const])("reads opaque $kind job failures directly from the native owner", async (kind) => {
    const fixture = await createNativeTaskFixture({ dependencies: {
      listJobs: async () => [{ id: "opaque-native-job", sessionID: "ses_parent", kind, status: "error" }],
      resultJob: async () => ({ id: "opaque-native-job", sessionID: "ses_parent", kind, status: "error", output: "partial job output", error: "native job failed" }),
    } })
    try {
      const result = await fixture.call("background_output", { task_id: "opaque-native-job" })
      expect(result.output).toMatchObject({ jobID: "opaque-native-job", kind, status: "error", output: "partial job output", error: "native job failed" })
      expect(result.content).toContain("native job failed")
      expect(result.content).toContain("partial job output")
    } finally { await fixture.close() }
  })

  test("refuses a native job returned under another parent before exposing output", async () => {
    const fixture = await createNativeTaskFixture({ dependencies: { listJobs: async () => [{ id: "opaque-native-job", sessionID: "ses_other", kind: "shell", status: "completed" }] } })
    try {
      await expect(fixture.call("background_output", { task_id: "opaque-native-job" })).rejects.toMatchObject({ code: "parent-mismatch" })
    } finally { await fixture.close() }
  })

  test.each([{ full_session: true }, { include_thinking: true }, { include_tool_results: true }, { message_limit: 1 }, { from_end: true }, { since_message_id: "message" }, { thinking_max_chars: 10 }])("refuses unsupported native job message filters %j", async (options) => {
    const fixture = await createNativeTaskFixture({ dependencies: {
      listJobs: async () => [{ id: "opaque-native-job", sessionID: "ses_parent", kind: "shell", status: "running" }],
      resultJob: async () => ({ id: "opaque-native-job", sessionID: "ses_parent", kind: "shell", status: "running", output: "working" }),
    } })
    try {
      await expect(fixture.call("background_output", { task_id: "opaque-native-job", ...options })).rejects.toMatchObject({ capability: "native shell/image message filters" })
    } finally { await fixture.close() }
  })

  test("shows the actual durable child failure before partial result text", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed", dependencies: { listJobs: async () => [{ id: "ses_child_1", sessionID: "ses_parent", kind: "subagent", status: "error" }] } })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      const transcript = fixture.messages.get("ses_child_1")
      const latest = transcript?.findLast((message) => message.type === "assistant")
      if (!transcript || !latest || latest.type !== "assistant") throw new Error("Missing native child answer")
      transcript.splice(transcript.indexOf(latest), 1, { ...latest, error: { type: "unknown", message: "native-owned failure" }, content: [{ type: "text", text: "partial native text" }] })
      const result = await fixture.call("background_output", { task_id: "bg_ses_child_1" })
      expect(result.output).toMatchObject({ status: "error", error: "native-owned failure" })
      expect(result.content).toContain("native-owned failure")
    } finally { await fixture.close() }
  })

  test.each(["reason", "effect"] as const)("bounds a native job-result wait without cancelling the job with %s interruption", async (interruption) => {
    let cancelled = false
    const fixture = await createNativeTaskFixture({ dependencies: {
      listJobs: async () => [{ id: "opaque-job", sessionID: "ses_parent", kind: "shell", status: "running" }],
      cancelJob: async () => { cancelled = true; return { status: "cancelled" } },
      resultJob: async ({ wait, signal }) => {
        if (wait) await new Promise<void>((_resolve, reject) => { signal.throwIfAborted(); signal.addEventListener("abort", () => reject(interruption === "reason" ? signal.reason : new Error("Native SDK interruption")), { once: true }) })
        return { id: "opaque-job", sessionID: "ses_parent", kind: "shell", status: "running" }
      },
    } })
    try {
      const result = await fixture.call("background_output", { task_id: "opaque-job", block: true, timeout: 1 })
      expect(result.output).toMatchObject({ jobID: "opaque-job", status: "running", waitTimedOut: true })
      expect(cancelled).toBe(false)
    } finally { await fixture.close() }
  })

  test("refuses to fabricate generic output when the native result API is unavailable", async () => {
    const fixture = await createNativeTaskFixture({ dependencies: { listJobs: async () => [{ id: "opaque-job", sessionID: "ses_parent", kind: "shell", status: "completed" }] } })
    try {
      await expect(fixture.call("background_output", { task_id: "opaque-job" })).rejects.toMatchObject({ capability: "jobResults" })
    } finally { await fixture.close() }
  })

  test("keeps an older failed reply out of the current running execution summary", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "first" })
      const child = fixture.sessions.get("ses_child_1")
      const transcript = fixture.messages.get("ses_child_1")
      const latest = transcript?.findLast((message) => message.type === "assistant")
      if (!child || !transcript || !latest || latest.type !== "assistant") throw new Error("Missing previous native execution")
      fixture.sessions.set(child.id, { ...child, outcome: "failed", time: { created: 1, updated: 9, busy: 8, idle: 3 } })
      transcript.splice(transcript.indexOf(latest), 1, { ...latest, error: { type: "unknown", message: "previous execution failed" } })
      const result = await fixture.call("background_output", { task_id: child.id })
      expect(result.output).toMatchObject({ status: "running" })
      expect(result.output).not.toHaveProperty("error")
      expect(result.content).not.toContain("previous execution failed")
    } finally { await fixture.close() }
  })

  test("fork output excludes inherited context using its awaited durable boundary", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "fork", prompt: "own work" })

      const result = await fixture.call("background_output", { task_id: "bg_ses_child_1", full_session: true })

      expect(resultMessages.parse(result.output).messages.map((message) => message.id)).toEqual(["msg_user_1", "msg_answer_1"])
      expect(JSON.stringify(result)).not.toContain("parent context")
      expect(result.content).toContain("native answer ses_child_1")
    } finally { await fixture.close() }
  })

  test("refuses missing fork boundaries instead of exposing inherited history", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "fork", prompt: "own work" })
      fixture.messages.set("ses_child_1", [...fixture.messages.get("ses_child_1") ?? []].filter((message) => message.id !== "msg_inherited"))

      await expect(fixture.call("background_output", { task_id: "bg_ses_child_1", full_session: true })).rejects.toMatchObject({ code: "fork-boundary-unavailable" })
    } finally { await fixture.close() }
  })

  test("applies reasoning and tool-result filters to both structured and rendered output", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      const messages = fixture.messages.get("ses_child_1")
      const answer = messages?.find((message) => message.type === "assistant")
      if (!messages || !answer || answer.type !== "assistant") throw new Error("Missing native answer")
      messages.splice(messages.indexOf(answer), 1, { ...answer, content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "tool", id: "call", name: "read", time: { created: 3 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "tool output" }] } },
        { type: "text", text: "visible response" },
      ] })
      messages.push({ id: "msg_shell", type: "shell", shellID: "shell", command: "fixture", status: "exited", time: { created: 4, completed: 5 }, output: { output: "shell private output", cursor: 0, size: 20, truncated: false } })

      const result = await fixture.call("background_output", { task_id: "bg_ses_child_1", full_session: true })

      expect(result.content).toContain("visible response")
      expect(JSON.stringify(result)).not.toContain("private reasoning")
      expect(JSON.stringify(result)).not.toContain("tool output")
      expect(JSON.stringify(result)).not.toContain("shell private output")
    } finally { await fixture.close() }
  })

  test("enforces durable parent ownership before reading task messages", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      const child = fixture.sessions.get("ses_child_1")
      if (!child) throw new Error("Missing child")
      fixture.sessions.set(child.id, { ...child, parentID: "ses_other" })
      await expect(fixture.call("background_output", { task_id: "bg_ses_child_1" })).rejects.toMatchObject({ code: "parent-mismatch" })
    } finally { await fixture.close() }
  })

  test("requires advertised durable message support instead of using a lossy context window", async () => {
    const fixture = await createNativeTaskFixture({ capabilities: { subagentOptions: true }, status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      await expect(fixture.call("background_output", { task_id: "bg_ses_child_1" })).rejects.toBeInstanceOf(NativeTaskCapabilityError)
    } finally { await fixture.close() }
  })

  test("preserves native message read failures and delegates blocking to native wait", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      await fixture.call("background_output", { task_id: "bg_ses_child_1", block: true, timeout: 50 })
      expect(fixture.trace).toContain("native.wait")
      const messages = fixture.ctx.session.messages
      if (!messages) throw new Error("Missing messages API")
      const failure = new Error("native message store failed")
      const reader = spyOn(fixture.ctx.session, "messages").mockImplementation(async () => { throw failure })
      try { await expect(fixture.call("background_output", { task_id: "bg_ses_child_1" })).rejects.toBe(failure) }
      finally { reader.mockRestore() }
    } finally { await fixture.close() }
  })

  test.each(["reason", "effect"] as const)("bounds native waiting without false cancellation/completion with %s interruption", async (interruption) => {
    const fixture = await createNativeTaskFixture()
    const nativeWait = spyOn(fixture.ctx.session, "wait").mockImplementation(async (_input, options) => {
      const signal = options?.signal
      if (!signal) throw new Error("Native wait has no cancellation signal")
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return }
        signal.addEventListener("abort", () => reject(interruption === "reason" ? signal.reason : new Error("Native SDK interruption")), { once: true })
      })
    })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      const result = await fixture.call("background_output", { task_id: "bg_ses_child_1", block: true, timeout: 1 })
      expect(result.output).toMatchObject({ waitTimedOut: true, status: "unconfirmed" })
      expect(fixture.sessions.get("ses_child_1")?.outcome).toBeUndefined()
    } finally { nativeWait.mockRestore(); await fixture.close() }
  })

  test("walks descending native cursors only until the durable fork boundary", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    try {
      await fixture.call("task", { subagent_type: "fork", prompt: "own work" })
      const child = fixture.messages.get("ses_child_1")
      const inherited = child?.[0]
      const user = child?.[1]
      const answer = child?.[2]
      if (!inherited || !user || !answer) throw new Error("Missing fork fixture")
      const reader = spyOn(fixture.ctx.session, "messages").mockImplementation(async (input) => {
        if (!input.cursor) {
          expect(input.order).toBe("desc")
          return { data: [answer], cursor: { next: "older" } }
        }
        expect(input.cursor).toBe("older")
        expect(input.order).toBeUndefined()
        return { data: [user, inherited], cursor: { next: "parent-history-must-not-be-read" } }
      })
      const lossyContext = spyOn(fixture.ctx.session, "context").mockImplementation(async () => { throw new Error("Lossy context is not a durable message reader") })
      try {
        const result = await fixture.call("background_output", { task_id: "bg_ses_child_1", full_session: true })
        expect(resultMessages.parse(result.output).messages.map((message) => message.id)).toEqual([user.id, answer.id])
      } finally { reader.mockRestore(); lossyContext.mockRestore() }
    } finally { await fixture.close() }
  })
})

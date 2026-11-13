import { describe, expect, test } from "bun:test"
import { createV1ClientAdapter, UnsupportedV1ClientCallError } from "./v1-client"
import { assistantMessage, createClientFixture, sessionInfo, userMessage } from "./v1-client-fixture.test"
import { projectV1Message, type V2SessionMessage } from "./v1-session-messages"
import { pollSyncSession } from "../tools/delegate-task/sync-session-poller"
import { __resetTimingConfig, __setTimingConfig } from "../tools/delegate-task/timing"

describe("v1 session bridge", () => {
  test("hands back a completed child when a native idle record follows its answer", async () => {
    // given
    const { ctx, messages } = createClientFixture()
    const idle = { id: "msg-003", type: "idle", outcome: "succeeded", time: { created: 13 } } satisfies V2SessionMessage
    messages.set("session-1", [{ ...userMessage, id: "msg-001" }, { ...assistantMessage, id: "msg-002", content: [{ type: "text", text: "answer" }] }, idle])
    const client = createV1ClientAdapter(ctx)
    __setTimingConfig({ POLL_INTERVAL_MS: 1, MAX_POLL_TIME_MS: 50 })
    try {
      // when
      const result = await pollSyncSession({ sessionID: "parent", messageID: "request", agent: "sisyphus", abort: new AbortController().signal }, client, {
        sessionID: "session-1", agentToUse: "worker", toastManager: null, taskId: undefined,
      })
      // then
      expect(result).toBeNull()
    } finally {
      __resetTimingConfig()
    }
  })

  test("projects complete native assistant records and tool content into the v1 message view", async () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = await client.session.messages({ path: { id: "session-1" } })

    expect(result.data).toHaveLength(2)
    expect(result.data[1]?.info).toMatchObject({ role: "assistant", sessionID: "session-1", finish: "stop", modelID: "model", v2: assistantMessage })
    expect(result.data[1]?.parts).toEqual([
      assistantMessage.content[0],
      { ...assistantMessage.content[1], callID: "call-1", tool: "read", state: { status: "completed", input: { file: "code.ts" }, content: [{ type: "text", text: "tool result" }], metadata: { title: "read file" }, output: "tool result" } },
      assistantMessage.content[2],
    ])
  })

  test("returns a promptAsync admission receipt without waiting for model completion", async () => {
    const { ctx, admitted, authority } = createClientFixture()
    ctx.session.wait = async () => { throw new Error("promptAsync must not wait") }
    const client = createV1ClientAdapter(ctx)

    const result = await client.session.promptAsync({ path: { id: "session-1" }, body: {
      agent: "worker", model: { providerID: "provider", modelID: "chosen" }, variant: "high",
      parts: [{ type: "text", text: "first" }, { type: "text", text: "second" }, { type: "file", mime: "text/plain", url: "file:///scratch/input.txt", filename: "input.txt" }],
    } })

    expect(result.data.id).toBe("msg-user")
    expect(authority).toEqual(["agent:worker", "model:provider/chosen:high", "prompt:first\n\nsecond"])
    expect(admitted[0]).toMatchObject({ sessionID: "session-1", text: "first\n\nsecond", files: [{ uri: "file:///scratch/input.txt", name: "input.txt" }], resume: true })
  })

  test("serializes concurrent prompt authority changes through admission", async () => {
    const { ctx, authority } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    await Promise.all(["one", "two"].map((agent) => client.session.promptAsync({ path: { id: "session-1" }, body: { agent, parts: [{ type: "text", text: agent }] } })))

    expect(authority).toEqual(["agent:one", "prompt:one", "agent:two", "prompt:two"])
  })

  test("does not admit a prompt after an agent selection failure", async () => {
    const { ctx, admitted } = createClientFixture()
    const failure = new Error("agent selection failed")
    ctx.session.switchAgent = async () => { throw failure }
    const client = createV1ClientAdapter(ctx)

    await expect(client.session.promptAsync({ path: { id: "session-1" }, body: { agent: "worker", parts: [{ type: "text", text: "request" }] } })).rejects.toBe(failure)

    expect(admitted).toEqual([])
  })

  test("waits for a native result when the legacy caller requests a synchronous prompt", async () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = await client.session.prompt({ path: { id: "session-1" }, body: { parts: [{ type: "text", text: "request" }] } })

    expect(result.data.info.id).toBe("msg-assistant")
    expect(result.data.info.v2).toEqual(assistantMessage)
  })

  test("honors noReply without discarding the admitted input", async () => {
    const { ctx, admitted } = createClientFixture()
    ctx.session.wait = async () => { throw new Error("noReply must not wait") }
    const client = createV1ClientAdapter(ctx)

    const result = await client.session.prompt({ path: { id: "session-1" }, body: { noReply: true, parts: [{ type: "text", text: "stored" }] } })

    expect(admitted[0]?.resume).toBe(false)
    expect(result.data.parts).toEqual([{ type: "text", text: "stored" }])
  })

  test("retains native session metadata and projects its actual directory", async () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = await client.session.get({ path: { id: "session-1" } })

    expect(result.data).toEqual({ ...sessionInfo, directory: "/scratch/project/worktree" })
  })

  test("reads every native status page and distinguishes the latest execution from its previous idle", async () => {
    // given
    const { ctx } = createClientFixture()
    const active = { ...sessionInfo, id: "active", time: { created: 1, updated: 9, busy: 8, idle: 3 } }
    const completed = { ...sessionInfo, id: "completed", time: { created: 1, updated: 10, busy: 8, idle: 9 } }
    ctx.session.list = async (input) => input?.cursor === "next-page"
      ? { data: [completed, sessionInfo], cursor: { next: null } }
      : { data: [active], cursor: { next: "next-page" } }
    const client = createV1ClientAdapter(ctx)
    // when
    const result = await client.session.status()
    // then
    expect(result.data).toEqual({
      active: { type: "busy", updatedAt: 9 },
      completed: { type: "idle", updatedAt: 10 },
      "session-1": { type: "idle", updatedAt: 2 },
    })
  })

  test.each(["children"] as const)("rejects unsupported session.%s", async (method) => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = client.session[method]()

    await expect(result).rejects.toMatchObject({ name: "UnsupportedV1ClientCallError", message: `session.${method}`, method: `session.${method}` })
  })

  test("exposes the latest successful native todos through the v1 envelope", async () => {
    const { ctx } = createClientFixture()
    ctx.session.context = async () => [{ ...assistantMessage, content: [{
      type: "tool", id: "todos", name: "todowrite", time: { created: 1 }, state: {
        status: "completed", input: {}, metadata: { todos: [{ content: "current task", status: "in_progress" }] },
        content: [{ type: "text", text: "Updated todos" }],
      },
    }] }]
    const client = createV1ClientAdapter(ctx)
    expect(await client.session.todo({ path: { id: "session-1" } })).toEqual({
      data: [{ id: "0", content: "current task", status: "in_progress", priority: "medium" }],
    })
  })

  test("rejects ignored prompt text before authority side effects", async () => {
    const { ctx, admitted, authority } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = client.session.promptAsync({ path: { id: "session-1" }, body: { system: "private content", agent: "worker", parts: [{ type: "text", text: "request", ignored: true }] } })

    await expect(result).rejects.toBeInstanceOf(UnsupportedV1ClientCallError)
    await expect(result).rejects.toMatchObject({ message: "session.promptAsync.parts.text" })
    expect(admitted).toEqual([])
    expect(authority).toEqual([])
  })

  test.each([undefined, 0, 1, 2, 5])("returns newest %s native context records chronologically", async (limit) => {
    const { ctx, messages } = createClientFixture()
    const third = { id: "third", type: "synthetic", text: "continuation", time: { created: 13 } } satisfies V2SessionMessage
    messages.set("session-1", [assistantMessage, { ...assistantMessage, id: "second" }, third])
    const client = createV1ClientAdapter(ctx)
    const result = await client.session.messages({ path: { id: "session-1" }, query: { limit } })
    const expected = limit === 0 ? [] : limit === 1 ? ["third"] : limit === 2 ? ["second", "third"] : ["msg-assistant", "second", "third"]
    expect(result.data.map((row) => row.info.id)).toEqual(expected)
    if (limit !== 0) expect(result.data.at(-1)?.info.v2).toEqual(third)
  })

  test("retains native user attachments and control messages", () => {
    const message: Extract<V2SessionMessage, { readonly type: "user" }> = {
      id: "attached", type: "user", time: { created: 5 }, text: "look", metadata: { source: "test" },
      files: [{ data: "aGVsbG8=", mime: "text/plain", source: { type: "inline" }, name: "hello.txt" }],
      agents: [{ name: "worker" }], skills: [{ id: "skill-1", name: "Skill" }],
    }

    const projected = projectV1Message(message, "session-1")

    expect(projected.info.v2).toEqual(message)
    expect(projected.parts.map((part) => part.type)).toEqual(["text", "file", "agent", "skill"])
    expect(projected.parts[1]).toMatchObject({ url: "data:text/plain;base64,aGVsbG8=", name: "hello.txt", data: "aGVsbG8=" })
    const control = { id: "control", type: "agent-switched", agent: "worker", previous: "old", time: { created: 6 } } satisfies V2SessionMessage
    expect(projectV1Message(control, "session-1").info.v2).toEqual(control)
  })
})

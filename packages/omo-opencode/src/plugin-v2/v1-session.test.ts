import { describe, expect, test } from "bun:test"
import { createV1ClientAdapter, UnsupportedV1ClientCallError } from "./v1-client"
import { assistantMessage, createClientFixture, sessionInfo } from "./v1-client-fixture.test"
import { projectV1Message, type V2SessionMessage } from "./v1-session-messages"

describe("v1 session bridge", () => {
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

  test.each(["status", "todo", "children"] as const)("rejects unsupported session.%s", async (method) => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = client.session[method]()

    await expect(result).rejects.toMatchObject({ name: "UnsupportedV1ClientCallError", message: `session.${method}`, method: `session.${method}` })
  })

  test("rejects prompt options that the native API cannot represent before side effects", async () => {
    const { ctx, admitted, authority } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = client.session.promptAsync({ path: { id: "session-1" }, body: { system: "private content", agent: "worker", parts: [{ type: "text", text: "request" }] } })

    await expect(result).rejects.toBeInstanceOf(UnsupportedV1ClientCallError)
    await expect(result).rejects.toMatchObject({ message: "session.promptAsync.system" })
    expect(admitted).toEqual([])
    expect(authority).toEqual([])
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

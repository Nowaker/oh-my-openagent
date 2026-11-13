import { describe, expect, test } from "bun:test"
import { applyChatMessageView, buildChatMessageView } from "./hook-bridge-chat"
import { applyChatParamsView, buildChatParamsView } from "./hook-bridge-params"
import { applyToolAfter, applyToolBefore } from "./hook-bridge-tools"
import { applyCompactionHook, applyContextHooks } from "./hook-bridge-transforms"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { createNativeInstructions } from "./native-instructions"

function modelContext(): Parameters<typeof applyContextHooks>[0] {
  return {
    model: { list: async () => ({ location: { directory: "/scratch/project" }, data: [{
      id: "model", modelID: "model", providerID: "provider", name: "Model", enabled: true, status: "active", cost: [], variants: [],
      time: { released: 0 }, limit: { context: 100, output: 10 }, capabilities: { tools: true, input: ["text"], output: ["text"] },
    }] }) },
    provider: { list: async () => ({ location: { directory: "/scratch/project" }, data: [{ id: "provider", name: "Provider", package: "provider-package", activation: "enabled" }] }) },
  }
}

describe("v2 hook observable effects", () => {
  test("applies a prompt rewrite without changing attachments or agent mentions", () => {
    const files = [{ uri: "file:///scratch/a" }]
    const agents = [{ name: "reviewer" }]
    const event = { sessionID: "session", messageID: "message", prompt: { text: "request", files, agents } }
    const view = buildChatMessageView(event, { agent: "active-agent", model: { providerID: "provider", id: "model", variant: "high" } })
    const text = view.output.parts[0]
    if (text?.type !== "text") throw new Error("Missing prompt text")
    text.text = "rewritten request"
    applyChatMessageView(event, view.output)
    expect(event.prompt).toEqual({ text: "rewritten request", files, agents })
    expect(view.input).toMatchObject({ agent: "active-agent", model: { providerID: "provider", modelID: "model" }, variant: "high" })
  })

  test("propagates replaced provider options and scalar deletion without adding omitted defaults", () => {
    const options: SessionContext["options"] = { temperature: 0.7, maxTokens: 20, providerSetting: "old" }
    const view = buildChatParamsView(options)
    view.output.options = { providerSetting: "new" }
    Reflect.deleteProperty(view.output, "temperature")
    view.output.maxOutputTokens = undefined
    applyChatParamsView(options, view)
    expect(options).toEqual({ providerSetting: "new" })
  })

  test("propagates before-hook denial rather than allowing execution", async () => {
    const denial = new Error("denied")
    const event = { tool: "write", sessionID: "session", id: "call", input: { file: "a" } }
    await expect(applyToolBefore(event, async () => { throw denial })).rejects.toBe(denial)
  })

  test("propagates before-hook argument replacement", async () => {
    const event = { tool: "read", sessionID: "session", id: "call", input: { file: "a" } }
    await applyToolBefore(event, async (input, output) => { input.tool = "custom-read"; output.args = { file: "b" } })
    expect(event.input).toEqual({ file: "b" })
    expect(event.tool).toBe("custom-read")
  })

  test("delivers after-hook text and metadata changes while retaining files and structured output", async () => {
    const file = { type: "file" as const, uri: "file:///scratch/a", mime: "text/plain" }
    const event: Parameters<typeof applyToolAfter>[0] = {
      tool: "read", sessionID: "session", id: "call", input: {}, status: "completed",
      result: { output: { count: 7 }, content: [{ type: "text", text: "original" }, file], metadata: { title: "old", native: "keep" } },
    }
    await applyToolAfter(event, async (_input, output) => {
      output.output = "transformed"
      output.title = "new"
      output.metadata = { ...output.metadata, observed: true }
    })
    expect(event.result).toEqual({ output: { count: 7 }, content: [{ type: "text", text: "transformed" }, file], metadata: { title: "new", native: "keep", observed: true } })
  })

  test.each(["read", "write", "edit"])("provides the native %s path to v1 file-scoped rule hooks", async (tool) => {
    const event: Parameters<typeof applyToolAfter>[0] = {
      tool, sessionID: "session", id: "call", input: { path: "nested/fixture.ts" }, status: "completed",
      result: { content: "file content", metadata: { truncated: false } },
    }
    await applyToolAfter(event, async (_input, output) => {
      output.output = output.metadata.filePath === "nested/fixture.ts" ? "scoped rule applied" : "no file scope"
    })
    expect(event.result.content).toBe("scoped rule applied")
  })

  test("replaces the compaction prompt and appends context in hook order", async () => {
    const event = { sessionID: "session", system: [{ type: "text" as const, text: "default prompt" }] }
    await applyCompactionHook(async (_input, output) => { output.prompt = "replacement"; output.context.push("extra") }, event)
    expect(event.system).toEqual([{ type: "text", text: "replacement" }, { type: "text", text: "extra" }])
  })

  test("awaits definition hooks and propagates the schema to the request", async () => {
    const ctx = modelContext()
    const event: Parameters<typeof applyContextHooks>[2] = {
      sessionID: "session", agent: "agent", model: { id: "model", providerID: "provider" }, system: [], messages: [], options: {},
      tools: { read: { description: "original", input: { type: "object" } } },
    }
    await applyContextHooks(ctx, { "tool.definition": async (_input, output) => {
      await Promise.resolve()
      output.description = "transformed"
      output.parameters = { type: "object", required: ["file"], properties: { file: { type: "string" } } }
    } }, event)
    expect(event.tools.read).toEqual({ description: "transformed", input: { type: "object", required: ["file"], properties: { file: { type: "string" } } } })
  })

  test.each([
    { role: undefined, stored: false },
    { role: "system", stored: true },
    { role: "user", stored: false },
    { role: "assistant", stored: false },
  ] as const)("recognizes only authoritative system guidance as an existing carrier: %j", async ({ role, stored }) => {
    const text = "dynamic system fixture"
    const writes: unknown[] = []
    const instructions = createNativeInstructions({ session: { instructions: { entry: {
      list: async () => [], put: async ({ value }) => { writes.push(value) }, remove: async () => {},
    } } } })
    const event: Parameters<typeof applyContextHooks>[2] = {
      sessionID: "session", agent: "agent", model: { id: "model", providerID: "provider" },
      system: [{ type: "text", text: "agent fixture" }], messages: role === undefined ? [] : [{ role, content: [{ type: "text", text }] }], options: {}, tools: {},
    }
    await applyContextHooks(modelContext(), { "experimental.chat.system.transform": async (_input, output) => { output.system.push(text) } }, event, instructions)
    expect(event.system.map((part) => part.text)).toEqual(stored ? ["agent fixture"] : ["agent fixture", text])
    expect(writes).toEqual(stored ? [] : [text])
  })
})

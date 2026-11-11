import { describe, expect, test } from "bun:test"
import { applyChatMessageView, buildChatMessageView } from "./hook-bridge-chat"
import { applyChatParamsView, buildChatParamsView } from "./hook-bridge-params"
import { applyToolAfter, applyToolBefore } from "./hook-bridge-tools"
import { applyCompactionHook, applyContextHooks } from "./hook-bridge-transforms"
import type { SessionContext } from "@opencode/plugin/promise/session"

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

  test("replaces the compaction prompt and appends context in hook order", async () => {
    const event = { sessionID: "session", system: [{ type: "text" as const, text: "default prompt" }] }
    await applyCompactionHook(async (_input, output) => { output.prompt = "replacement"; output.context.push("extra") }, event)
    expect(event.system).toEqual([{ type: "text", text: "replacement" }, { type: "text", text: "extra" }])
  })

  test("awaits definition hooks and propagates the schema to the request", async () => {
    const ctx: Parameters<typeof applyContextHooks>[0] = {
      model: { list: async () => ({ location: { directory: "/scratch/project" }, data: [{
        id: "model", modelID: "model", providerID: "provider", name: "Model", enabled: true, status: "active", cost: [], variants: [],
        time: { released: 0 }, limit: { context: 100, output: 10 }, capabilities: { tools: true, input: ["text"], output: ["text"] },
      }] }) },
      provider: { list: async () => ({ location: { directory: "/scratch/project" }, data: [{ id: "provider", name: "Provider", package: "provider-package", activation: "enabled" }] }) },
    }
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
})

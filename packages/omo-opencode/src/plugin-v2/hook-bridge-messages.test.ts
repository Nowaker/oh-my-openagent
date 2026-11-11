import { describe, expect, test } from "bun:test"
import { createMessagesView } from "./hook-bridge-messages"
import { userMessageInfo } from "./hook-bridge-message-info"
import type { ContextMessage } from "./hook-bridge-types"

const identity = { sessionID: "session", agent: "agent", model: { providerID: "provider", id: "model" } }

describe("v2 message transform translation", () => {
  test("retains identity and native content when a hook inserts, clones and reorders messages", () => {
    const reasoning = { type: "reasoning" as const, text: "thinking", encrypted: "signed-replay" }
    const call = { type: "tool-call" as const, id: "call", name: "read", input: { file: "a" }, providerMetadata: { provider: { signature: "call-signature" } } }
    const result = { role: "tool" as const, content: [{ type: "tool-result" as const, id: "call", name: "read", result: { type: "content" as const, value: [{ type: "file" as const, uri: "file:///scratch/a", mime: "text/plain" }] } }] }
    const messages: ContextMessage[] = [
      { id: "user", role: "user", content: [{ type: "text", text: "request" }] },
      { id: "assistant", role: "assistant", content: [reasoning, call, { type: "text", text: "answer" }] },
      result,
    ]
    const view = createMessagesView({ ...identity, messages })
    const user = view.output.messages.find((row) => row.info.id === "user")
    const assistant = view.output.messages.find((row) => row.info.id === "assistant")
    if (!user || !assistant) throw new Error("Missing projected messages")
    const text = assistant.parts.find((part) => part.type === "text")
    if (text?.type !== "text") throw new Error("Missing projected text")
    text.text = "edited answer"
    view.output.messages = [
      { info: userMessageInfo(identity, "synthetic"), parts: [{ id: "inserted", messageID: "synthetic", sessionID: "session", type: "text", text: "injected context", synthetic: true }] },
      { info: { ...assistant.info }, parts: [...assistant.parts] }, user,
    ]
    const restored = view.restore()
    expect(restored.map((row) => row.id)).toEqual(["synthetic", "assistant", undefined, "user"])
    expect(restored[0]?.content).toEqual([{ type: "text", text: "injected context" }])
    expect(restored[1]?.content[0]).toBe(reasoning)
    expect(restored[1]?.content[1]).toEqual(call)
    expect(restored[1]?.content[2]).toEqual({ type: "text", text: "edited answer" })
    expect(restored[2]).toBe(result)
  })

  test("preserves opaque native parts when the preceding text is removed", () => {
    const checkpoint = { type: "tool-call" as const, id: "native-call", name: "native", input: "raw-input" }
    const view = createMessagesView({ ...identity, messages: [{ id: "assistant", role: "assistant", content: [{ type: "text", text: "remove" }, checkpoint] }] })
    const row = view.output.messages[0]
    if (!row) throw new Error("Missing projected row")
    row.parts = []
    expect(view.restore()[0]?.content).toEqual([checkpoint])
  })

  test("preserves an empty context instead of manufacturing a user turn", () => {
    expect(createMessagesView({ ...identity, messages: [] }).restore()).toEqual([])
  })
})

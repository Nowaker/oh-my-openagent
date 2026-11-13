import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { CreatedHooks } from "../create-hooks"
import { createNativeInstructions } from "./native-instructions"

function fixture() {
  const entries = new Map<string, Parameters<Plugin.Context["session"]["instructions"]["entry"]["put"]>[0]["value"]>()
  const instructions = createNativeInstructions({ session: { instructions: { entry: {
    list: async () => [],
    put: async ({ key, value }) => { entries.set(key, value) },
    remove: async ({ key }) => { entries.delete(key) },
  } } } })
  return { entries, instructions }
}

function keywordHook(): NonNullable<CreatedHooks["keywordDetector"]> {
  return {
    "chat.message": async (_input, output) => {
      const part = output.parts[0]
      if (part && typeof part.text === "string") part.text += "\n\nmode fixture"
    },
    clearSession: () => {},
    getSystemTransformGuidance: () => undefined,
    event: () => {},
    dispose: () => {},
  }
}

describe("native OMO instruction carriers", () => {
  test("moves rule additions into persistent entries while retaining the original tool output", async () => {
    // given
    const { entries, instructions } = fixture()
    const hooks = instructions.wrap({ keywordDetector: null, rulesInjector: {
      releaseSession: () => {}, event: async () => {}, "tool.execute.before": async () => {},
      "tool.execute.after": async (_input, output) => { output.output += "\nrule fixture" },
    } })
    const output = { title: "file", output: "file content", metadata: {} }
    // when
    await hooks.rulesInjector?.["tool.execute.after"]({ tool: "read", sessionID: "session", callID: "call" }, output)
    // then
    expect(output.output).toBe("file content")
    expect([...entries.values()]).toEqual(["\nrule fixture"])
  })

  test("retains rule output if storing its instruction fails", async () => {
    // given
    const rejected = new Error("instruction write rejected")
    const instructions = createNativeInstructions({ session: { instructions: { entry: {
      list: async () => [], put: async () => { throw rejected }, remove: async () => {},
    } } } })
    const hooks = instructions.wrap({ keywordDetector: null, rulesInjector: {
      releaseSession: () => {}, event: async () => {}, "tool.execute.before": async () => {},
      "tool.execute.after": async (_input, output) => { output.output += "\nrule fixture" },
    } })
    const output = { title: "file", output: "file content", metadata: {} }
    // when / then
    await expect(hooks.rulesInjector?.["tool.execute.after"]({ tool: "read", sessionID: "session", callID: "call" }, output)).rejects.toBe(rejected)
    expect(output.output).toBe("file content\nrule fixture")
  })

  test("moves keyword guidance into an entry without rewriting the user's prompt", async () => {
    // given
    const { entries, instructions } = fixture()
    const hooks = instructions.wrap({ rulesInjector: null, keywordDetector: keywordHook() })
    const output = { message: {}, parts: [{ type: "text", text: "user fixture" }] }
    // when
    await hooks.keywordDetector?.["chat.message"]({ sessionID: "session" }, output)
    // then
    expect(output.parts).toEqual([{ type: "text", text: "user fixture" }])
    expect(entries.get("omo-mode")).toBe("\n\nmode fixture")
  })

  test("keeps full mode guidance when a later turn carries only the activation marker", async () => {
    // given
    const { entries, instructions } = fixture()
    const keyword = keywordHook()
    const hooks = instructions.wrap({ rulesInjector: null, keywordDetector: keyword })
    await instructions.put("session", "omo-mode", "existing full guidance")
    keyword["chat.message"] = async (_input, output) => {
      output.parts.push({ type: "text", text: "<ultrawork-mode>active</ultrawork-mode>", synthetic: true })
    }
    const output = { message: {}, parts: [{ type: "text", text: "next fixture" }] }
    // when
    await hooks.keywordDetector?.["chat.message"]({ sessionID: "session" }, output)
    // then
    expect(entries.get("omo-mode")).toBe("existing full guidance")
    expect(output.parts).toEqual([{ type: "text", text: "next fixture" }])
  })
})

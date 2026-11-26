/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import { createNoSisyphusGptHook } from "./index"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

const SISYPHUS_DISPLAY = getAgentDisplayName("sisyphus")

function run(options: { gptToHephaestus?: boolean }, modelID: string, hephaestus = true) {
  _resetForTesting()
  if (hephaestus) registerAgentName("hephaestus")
  const showToast = spyOn({ fn: async () => ({}) }, "fn")
  const hook = createNoSisyphusGptHook(unsafeTestValue<PluginInput>({ client: { tui: { showToast } } }), options)
  const input = { sessionID: "ses_1", agent: SISYPHUS_DISPLAY, model: { providerID: "openai", modelID } }
  const output: { message: { agent?: string; variant?: string } } = { message: {} }
  return hook["chat.message"](input, output).then(() => ({ input, output, showToast }))
}

describe("no-sisyphus-gpt hook with gptToHephaestus", () => {
  test.each(["gpt-6.2-sol", "gpt-5.5", "gpt-5.6-sol"])(
    "moves Sisyphus on %s, which has a GPT-native prompt, to Hephaestus",
    async (modelID) => {
      const { input, output, showToast } = await run({ gptToHephaestus: true }, modelID)
      expect(output.message.agent).toBe("hephaestus")
      expect(input.agent).toBe("hephaestus")
      expect(output.message.variant).toBeUndefined()
      expect(showToast).toHaveBeenCalledTimes(1)
    },
  )

  test("keeps Sisyphus on a GPT-native model when the option is off", async () => {
    const { output, showToast } = await run({}, "gpt-6.2-sol")
    expect(output.message.agent).toBeUndefined()
    expect(output.message.variant).toBe("high")
    expect(showToast).not.toHaveBeenCalled()
  })

  test("leaves non-GPT models on Sisyphus", async () => {
    const { output, showToast } = await run({ gptToHephaestus: true }, "claude-opus-5-5")
    expect(output.message.agent).toBeUndefined()
    expect(showToast).not.toHaveBeenCalled()
  })

  test("keeps Sisyphus and warns when Hephaestus is not registered", async () => {
    const { output, showToast } = await run({ gptToHephaestus: true }, "gpt-6.2-sol", false)
    expect(output.message.agent).toBeUndefined()
    expect(showToast).toHaveBeenCalledTimes(1)
  })
})

/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import * as shared from "../../shared"

// Every GPT family Hephaestus runs on (./model-support.ts). An OMO bump that changes either agent's prompt
// pipeline so the two drift apart fails here instead of in a session.
const GPT_MODELS = [
  "openai/gpt-5.3-codex",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.6-sol",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.2-sol",
]

async function agentsFor(model: string, share: boolean) {
  const { createBuiltinAgents } = await import(`../builtin-agents?test=${Date.now()}-${Math.random()}`)
  return createBuiltinAgents(
    [],
    { sisyphus: { model }, hephaestus: { model } },
    undefined,
    "anthropic/claude-opus-5-5",
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    false,
    share,
  )
}

beforeEach(() => {
  mock.restore()
  connectedProvidersCache._resetMemCacheForTesting()
  spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue(null)
  spyOn(shared, "fetchAvailableModels").mockResolvedValue(new Set())
})

afterEach(() => {
  connectedProvidersCache._resetMemCacheForTesting()
  mock.restore()
})

describe("sisyphus_agent.share_prompt_with_hephaestus", () => {
  test.each(GPT_MODELS)("Hephaestus on %s gets exactly Sisyphus's prompt and permissions", async (model) => {
    const agents = await agentsFor(model, true)
    expect(agents.hephaestus.model).toBe(model)
    expect(agents.sisyphus.model).toBe(model)
    expect(agents.hephaestus.prompt).toBe(agents.sisyphus.prompt)
    expect(agents.hephaestus.permission).toEqual(agents.sisyphus.permission)
  })

  test("Hephaestus keeps its own prompt when the option is off", async () => {
    const agents = await agentsFor("openai/gpt-6.2-sol", false)
    expect(agents.hephaestus.prompt).not.toBe(agents.sisyphus.prompt)
  })
})

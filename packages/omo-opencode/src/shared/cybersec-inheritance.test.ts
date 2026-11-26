import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as logger from "./logger"
import { inheritCybersecFallbackChain, inheritCybersecModel } from "./cybersec-inheritance"

const CYBER_PARENT = { providerID: "anthropic-cybersec", modelID: "claude-opus-5-5" }
const listed = (modelID: string) => ["claude-opus-5-5", "claude-sonnet-5-5"].includes(modelID)
const context = { sessionID: "ses_parent", agent: "explore", listed }

afterEach(() => {
  ;(logger.log as unknown as { mockRestore?: () => void }).mockRestore?.()
})

describe("inheritCybersecModel", () => {
  it("moves an anthropic child of a cybersec parent onto anthropic-cybersec, keeping its settings", () => {
    const child = { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "max" }
    expect(inheritCybersecModel(CYBER_PARENT, child, context)).toEqual({ providerID: "anthropic-cybersec", modelID: "claude-sonnet-5-5", variant: "max" })
  })

  it("keeps anthropic and logs it when the model is not listed under anthropic-cybersec", () => {
    const logged: unknown[] = []
    spyOn(logger, "log").mockImplementation((message: string, data?: unknown) => {
      logged.push({ message, data })
    })
    const child = { providerID: "anthropic", modelID: "claude-haiku-5-5" }
    expect(inheritCybersecModel(CYBER_PARENT, child, context)).toBe(child)
    expect(logged).toContainEqual({
      message: "[cybersec] child kept on anthropic: model not listed under anthropic-cybersec",
      data: { sessionID: "ses_parent", agent: "explore", model: "anthropic/claude-haiku-5-5" },
    })
  })

  it("leaves children of a parent not on cybersec, and children on other providers, alone", () => {
    const anthropicChild = { providerID: "anthropic", modelID: "claude-sonnet-5-5" }
    expect(inheritCybersecModel({ providerID: "anthropic", modelID: "claude-opus-5-5" }, anthropicChild, context)).toBe(anthropicChild)
    expect(inheritCybersecModel(undefined, anthropicChild, context)).toBe(anthropicChild)
    const gptChild = { providerID: "openai", modelID: "gpt-6.1-sol" }
    expect(inheritCybersecModel(CYBER_PARENT, gptChild, context)).toBe(gptChild)
    expect(inheritCybersecModel(CYBER_PARENT, undefined, context)).toBeUndefined()
  })
})

describe("inheritCybersecFallbackChain", () => {
  it("swaps anthropic for anthropic-cybersec in listed entries only", () => {
    const chain = [
      { providers: ["anthropic", "github-copilot"], model: "claude-opus-5-5", variant: "max" },
      { providers: ["anthropic"], model: "claude-haiku-5-5" },
      { providers: ["openai"], model: "gpt-6.1-sol" },
    ]
    expect(inheritCybersecFallbackChain(CYBER_PARENT, chain, context)).toEqual([
      { providers: ["anthropic-cybersec", "github-copilot"], model: "claude-opus-5-5", variant: "max" },
      { providers: ["anthropic"], model: "claude-haiku-5-5" },
      { providers: ["openai"], model: "gpt-6.1-sol" },
    ])
  })

  it("leaves the chain of a parent not on cybersec alone", () => {
    const chain = [{ providers: ["anthropic"], model: "claude-opus-5-5" }]
    expect(inheritCybersecFallbackChain({ providerID: "anthropic", modelID: "claude-opus-5-5" }, chain, context)).toBe(chain)
  })
})

describe("anthropic-restricted parents", () => {
  const RESTRICTED_PARENT = { providerID: "anthropic-restricted", modelID: "claude-opus-5-5" }

  it("keep an anthropic child on anthropic-restricted, so it never spends a CVP account's allowance", () => {
    const child = { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "max" }
    expect(inheritCybersecModel(RESTRICTED_PARENT, child, context)).toEqual({ providerID: "anthropic-restricted", modelID: "claude-sonnet-5-5", variant: "max" })
  })

  it("swap anthropic for anthropic-restricted in listed fallback entries only", () => {
    const chain = [
      { providers: ["anthropic"], model: "claude-opus-5-5" },
      { providers: ["anthropic"], model: "claude-haiku-5-5" },
    ]
    expect(inheritCybersecFallbackChain(RESTRICTED_PARENT, chain, context)).toEqual([
      { providers: ["anthropic-restricted"], model: "claude-opus-5-5" },
      { providers: ["anthropic"], model: "claude-haiku-5-5" },
    ])
  })
})

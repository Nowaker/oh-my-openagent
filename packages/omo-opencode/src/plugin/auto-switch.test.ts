import { expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createPluginInterface } from "../plugin-interface"
import { clearSessionAgent, getSessionAgent, updateSessionAgent } from "../features/claude-code-session-state"
import { ContextCollector, createContextInjectorMessagesTransformHook } from "../features/context-injector"
import { getAgentDisplayName } from "../shared/agent-display-names"
import { clearSessionPromptParams, setSessionPromptParams } from "../shared/session-prompt-params-state"

const source = {
  agent: getAgentDisplayName("sisyphus"),
  providerID: "anthropic",
  modelID: "claude-opus-5-5",
  variant: "high",
}
const target = {
  agent: getAgentDisplayName("hephaestus"),
  providerID: "openai",
  modelID: "gpt-6.2-sol",
  variant: "xhigh",
}
const sessionID = "ses-phase-one-switch"
const prepare = { version: 1, sessionID, source, target }
const autoSwitch = { version: 1, preferred: source, effective: target }

function createOwner(options: { teamMode?: boolean; collector?: ContextCollector } = {}) {
  return createPluginInterface({
    ctx: unsafeTestValue({ client: { session: {} } }),
    pluginConfig: unsafeTestValue({
      agents: { hephaestus: { variant: "medium" } },
      team_mode: options.teamMode === undefined ? undefined : { enabled: options.teamMode },
    }),
    firstMessageVariantGate: {
      shouldOverride: () => false,
      markApplied: () => {},
      markSessionCreated: () => {},
      clear: () => {},
    },
    managers: unsafeTestValue({
      backgroundManager: { setSessionRuntimeRetirementHandler() {} },
      configHandler: async () => {},
    }),
    hooks: unsafeTestValue({
      contextInjectorMessagesTransform:
        options.collector && createContextInjectorMessagesTransformHook(options.collector),
    }),
    tools: {},
  })
}

async function prepareFor(instance: ReturnType<typeof createOwner>, input: unknown) {
  const output: { decision?: "allow" | "deny" } = {}
  await instance["experimental.chat.autoSwitch.prepare"]?.(input, output)
  return output.decision
}

function configuredAgent(route: typeof source) {
  return {
    mode: "primary",
    prompt: "Fixture",
    model: `${route.providerID}/${route.modelID}`,
    variant: route.variant,
  } as const
}

test("allows only the exact registered primary pair on this owner without rewriting session identity", async () => {
  const api = createOwner()
  const otherOwner = createOwner()
  const sourceAgent = configuredAgent(source)
  const targetAgent = configuredAgent(target)
  await api.config?.({ agent: { [source.agent]: sourceAgent, [target.agent]: targetAgent } })
  updateSessionAgent(sessionID, source.agent)

  try {
    expect(await prepareFor(api, prepare)).toBe("allow")
    expect(await prepareFor(otherOwner, prepare)).toBe("deny")
    for (const input of [
      { ...prepare, version: 2 },
      { ...prepare, target: { ...target, agent: "hephaestus" } },
      { ...prepare, source: target, target },
      { ...prepare, target: { ...target, agent: "build" } },
      { ...prepare, target: { ...target, variant: "high" } },
      { ...prepare, source: { ...source, modelID: "seat/claude-opus-5-5" } },
      { ...prepare, target: { ...target, providerID: "openai-meridian" } },
      { ...prepare, target: { ...target, modelID: "gpt-6.2-sol-fast" } },
    ]) {
      expect(await prepareFor(api, input)).toBe("deny")
    }
    expect(getSessionAgent(sessionID)).toBe(source.agent)
    for (const ineligible of [
      { ...targetAgent, disable: true },
      { ...targetAgent, hidden: true },
      { ...targetAgent, variant: "high" },
      { ...targetAgent, model: "openai/gpt-6.2-astra" },
    ]) {
      await api.config?.({ agent: { [source.agent]: sourceAgent, [target.agent]: ineligible } })
      expect(await prepareFor(api, prepare)).toBe("deny")
    }
  } finally {
    clearSessionAgent(sessionID)
  }
})

test.each(["xhigh", "max"])(
  "qualifies reverse OMO at exact Sol %s without changing the session agent",
  async (variant) => {
    const api = createOwner()
    const preferred = { ...target, variant }
    const reverse = { ...prepare, source: preferred, target: source }
    const hephaestus = configuredAgent(preferred)
    const sisyphus = configuredAgent(source)
    const register = (from: typeof hephaestus, to: typeof sisyphus) =>
      api.config?.({ agent: { [preferred.agent]: from, [source.agent]: to } })
    await register(hephaestus, sisyphus)
    updateSessionAgent(sessionID, preferred.agent)

    try {
      expect(await prepareFor(api, reverse)).toBe("allow")
      expect(await prepareFor(createOwner(), reverse)).toBe("deny")
      expect(
        await prepareFor(api, { ...reverse, source: { ...preferred, variant: variant === "max" ? "xhigh" : "max" } }),
      ).toBe("deny")

      const unqualifiedTarget = { ...source, variant: "max" }
      await register(hephaestus, configuredAgent(unqualifiedTarget))
      expect(await prepareFor(api, { ...reverse, target: unqualifiedTarget })).toBe("deny")

      const unqualifiedSource = { ...preferred, variant: "high" }
      await register(configuredAgent(unqualifiedSource), sisyphus)
      expect(await prepareFor(api, { ...reverse, source: unqualifiedSource })).toBe("deny")
      expect(getSessionAgent(sessionID)).toBe(preferred.agent)
    } finally {
      clearSessionAgent(sessionID)
    }
  },
)

test("refuses sessions with unqualified pending context without consuming it or disabling a sibling session", async () => {
  const collector = new ContextCollector()
  const api = createOwner({ collector })
  await api.config?.({ agent: { [source.agent]: configuredAgent(source), [target.agent]: configuredAgent(target) } })
  expect(await prepareFor(api, prepare)).toBe("allow")

  collector.register(sessionID, { id: "late-context", source: "custom", content: "Retain this constraint." })
  const messageID = "msg_phase_one_context"
  await api["experimental.chat.messages.transform"]?.(unsafeTestValue({ autoSwitch }), {
    messages: [
      {
        info: { id: messageID, sessionID, time: { created: 1 }, role: "user", agent: source.agent, model: source },
        parts: [{ id: "prt_phase_one_context", sessionID, messageID, type: "text", text: "Proceed." }],
      },
    ],
  })
  expect(await prepareFor(api, prepare)).toBe("deny")
  expect(await prepareFor(api, { ...prepare, sessionID: "ses-unrelated" })).toBe("allow")
  expect(collector.getPending(sessionID).merged).toBe("Retain this constraint.")
})

test("refuses team mode before an alternate can consume a mailbox message", async () => {
  const api = createOwner({ teamMode: true })
  await api.config?.({ agent: { [source.agent]: configuredAgent(source), [target.agent]: configuredAgent(target) } })

  expect(await prepareFor(api, prepare)).toBe("deny")
})

test.each([
  { preferred: source, effective: target },
  { preferred: { ...target, variant: "max" }, effective: source },
])("does not carry preferred prompt settings onto $effective.providerID", async ({ preferred, effective }) => {
  const api = createOwner()
  const message = { variant: preferred.variant }
  const options = effective.providerID === "anthropic" ? { effort: "high" } : { reasoningEffort: "xhigh" }
  const output = { options: { ...options } }
  setSessionPromptParams(sessionID, { options: { reasoningEffort: "low", preferredOnly: true } })

  try {
    await api["chat.params"]?.(
      unsafeTestValue({
        sessionID,
        agent: { name: effective.agent },
        model: { providerID: effective.providerID, id: effective.modelID },
        provider: { id: effective.providerID },
        message,
        autoSwitch: { version: 1, preferred, effective },
      }),
      output,
    )

    expect(output.options).toEqual(options)
    expect(message.variant).toBe(preferred.variant)
  } finally {
    clearSessionPromptParams(sessionID)
  }
})

test("keeps Junior's role on a model-only alternate without carrying its Claude request options", async () => {
  const api = createOwner()
  const junior = "Sisyphus-Junior"
  const preferred = { ...source, agent: junior }
  const effective = { ...target, agent: junior }
  const message = { variant: "high" }
  const output = { options: { reasoningEffort: "xhigh" } }
  setSessionPromptParams(sessionID, { options: { reasoningEffort: "low", preferredOnly: true } })

  try {
    await api["chat.params"]?.(
      unsafeTestValue({
        sessionID,
        agent: { name: junior },
        model: { providerID: effective.providerID, id: effective.modelID },
        provider: { id: effective.providerID },
        message,
        autoSwitch: { version: 1, preferred, effective },
      }),
      output,
    )
    expect(message.variant).toBe("high")
    expect(output.options).toEqual({ reasoningEffort: "xhigh" })
    expect(await prepareFor(api, { ...prepare, source: preferred, target: effective })).toBe("deny")
  } finally {
    clearSessionPromptParams(sessionID)
  }
})

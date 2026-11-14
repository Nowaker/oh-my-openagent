import { describe, expect, it } from "bun:test"
import { Agent, type Plugin } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { registerV1Agents, translateAgentConfigToV2Draft } from "./translate-agent"
import { createClientFixture } from "./v1-client-fixture.test"

describe("V1 agent translation", () => {
  it.each([
    { permission: { task: "deny", call_omo_agent: "allow" }, expected: ["deny", "allow", "allow", "allow", "ask"] },
    { permission: { call_omo_agent: "allow", task: "deny" }, expected: ["deny", "allow", "allow", "allow", "ask"] },
    { permission: { task: "allow", call_omo_agent: "deny" }, expected: ["allow", "deny", "allow", "allow", "allow"] },
    { permission: { call_omo_agent: "deny", task: "allow" }, expected: ["allow", "deny", "allow", "allow", "allow"] },
    { permission: { task: "deny", call_omo_agent: "deny" }, expected: ["deny", "deny", "ask", "ask", "ask"] },
    { permission: { task: "deny", call_omo_agent: "ask" }, expected: ["deny", "ask", "allow", "allow", "ask"] },
    { permission: {}, expected: ["ask", "ask", "allow", "allow", "allow"] },
  ])("keeps host frontend actions independent and projects only callable backend targets: %j", ({ permission, expected }) => {
    // given / when
    const draft = translateAgentConfigToV2Draft("worker", { permission }, { delegationOwner: "host" })
    // then
    const requests = [["task", "*"], ["call_omo_agent", "*"], ["subagent", "explore"], ["subagent", "librarian"], ["subagent", "worker"]]
    expect(requests.map(([action, resource]) => draft?.permissions?.findLast((rule) => rule.action === action && (rule.resource === "*" || rule.resource === resource))?.effect ?? "ask")).toEqual([...expected])
  })

  it("keeps authored native backend deny and ask order after host projection", () => {
    // given / when
    const draft = translateAgentConfigToV2Draft("worker", { permission: { task: "allow", call_omo_agent: "deny", subagent: { "*": "deny", explore: "allow", librarian: "ask" } } }, { delegationOwner: "host" })
    // then
    expect(["explore", "librarian", "worker"].map((target) => draft?.permissions?.findLast((rule) => rule.action === "subagent" && (rule.resource === "*" || rule.resource === target))?.effect)).toEqual(["allow", "ask", "deny"])
  })

  it("permits a scoped frontend allow after a whole-tool deny without a second backend ask", () => {
    const draft = translateAgentConfigToV2Draft("worker", { permission: { task: { "*": "deny", oracle: "allow" }, call_omo_agent: "deny" } }, { delegationOwner: "host" })
    const decision = draft?.permissions?.findLast((rule) => rule.action === "subagent" && (rule.resource === "*" || rule.resource === "oracle"))?.effect ?? "ask"
    expect(decision).toBe("allow")
  })

  it.each([
    {
      name: "retained native deny and ask after generated grants",
      nativeRules: [
        { action: "subagent", resource: "*", effect: "allow" },
        { action: "subagent", resource: "explore", effect: "deny" },
        { action: "subagent", resource: "librarian", effect: "ask" },
        { action: "subagent", resource: "worker", effect: "deny" },
        { action: "subagent", resource: "worker", effect: "allow" },
      ] satisfies NonNullable<Agent.Info["permissions"]>,
      authored: {}, expected: ["deny", "ask", "allow"],
    },
    {
      name: "authored backend deny and ask after native default allow",
      nativeRules: [{ action: "*", resource: "*", effect: "allow" }] satisfies NonNullable<Agent.Info["permissions"]>,
      authored: { subagent: { explore: "deny", librarian: "ask", worker: "allow" } }, expected: ["deny", "ask", "allow"],
    },
    {
      name: "authored later allow keeps ordered resource precedence",
      nativeRules: [{ action: "*", resource: "*", effect: "allow" }] satisfies NonNullable<Agent.Info["permissions"]>,
      authored: { subagent: { "*": "deny", explore: "allow", librarian: "ask" } }, expected: ["allow", "ask", "deny"],
    },
  ])("preserves host registration policy: $name", async ({ nativeRules, authored, expected }) => {
    // given
    const { ctx } = createClientFixture()
    const agent: ReturnType<AgentEditor["list"]>[number] = { id: Agent.ID.make("worker"), name: Agent.Name.make("worker"), mode: "subagent", hidden: false, permissions: nativeRules, request: { settings: {}, headers: {}, body: {} } }
    const domain: Plugin.Context["agent"] = { ...ctx.agent,
      get: async () => ({ location: ctx.location, data: agent }), reload: async () => {},
      transform: async (callback) => {
        callback({ list: () => [agent], get: () => agent, default: () => {}, remove: () => {}, update: (_id, update) => update(agent) })
        return { dispose: async () => {} }
      },
    }
    // when
    await registerV1Agents({ agent: domain }, { worker: { permission: { task: "deny", call_omo_agent: "allow", ...authored } } }, undefined, { delegationOwner: "host" })
    // then
    expect(["explore", "librarian", "worker"].map((target) => agent.permissions?.findLast((rule) => rule.action === "subagent" && (rule.resource === "*" || rule.resource === target))?.effect)).toEqual([...expected])
    expect(["task", "call_omo_agent"].map((action) => agent.permissions?.findLast((rule) => rule.action === action)?.effect)).toEqual(["deny", "allow"])
  })

  it.each([
    { task: "deny", call_omo_agent: "allow" },
    { call_omo_agent: "allow", task: "deny" },
  ])("keeps the native launcher denied without dropping the original callable-agent allowance: %j", (permission) => {
    // given
    const config = { permission }
    // when
    const draft = translateAgentConfigToV2Draft("sisyphus-junior", config)
    // then
    const decisions = ["task", "call_omo_agent", "subagent"].map((action) => draft?.permissions?.findLast((rule) => rule.action === action && rule.resource === "*")?.effect)
    expect(decisions).toEqual(["deny", "allow", "deny"])
  })

  it("retains the resolved prompt and configured model variant", () => {
    // given
    const config = { prompt: "fixture from the resolved builder", model: "fixture/provider/model", variant: "high", mode: "primary" }
    // when
    const draft = translateAgentConfigToV2Draft("Sisyphus - ultraworker", config)
    // then
    expect(draft).toMatchObject({ id: "sisyphus", prompt: config.prompt, model: { providerID: "fixture", id: "provider/model", variant: "high" }, mode: "primary" })
  })

  it("translates shell permission precedence without dropping explicit allow rules", () => {
    // given
    const config = { tools: { write: false }, permission: { bash: { "*": "ask", "git status": "allow", "rm *": "deny" } } }
    // when
    const draft = translateAgentConfigToV2Draft("oracle", config)
    // then
    expect(draft?.permissions).toEqual([
      { action: "write", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "bash", resource: "git status", effect: "allow" },
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "bash", resource: "rm *", effect: "deny" },
      { action: "shell", resource: "rm *", effect: "deny" },
    ])
  })

  it("omits an explicitly disabled agent", () => {
    // given
    const config = { disable: true, model: "fixture/model" }
    // when
    const draft = translateAgentConfigToV2Draft("oracle", config)
    // then
    expect(draft).toBeUndefined()
  })

  it.each([
    ["call_omo_agent", "subagent"],
    ["task", "subagent"],
    ["bash", "shell"],
    ["write", "edit"],
    ["apply_patch", "edit"],
  ])("retains denied %s action alongside native %s", (original, native) => {
    // given
    const config = { tools: { [original]: false }, permission: { [original]: { "/protected/*": "deny" } } }
    // when
    const draft = translateAgentConfigToV2Draft("explore", config)
    // then
    expect(draft?.permissions).toEqual([
      { action: original, resource: "*", effect: "deny" },
      { action: native, resource: "*", effect: "deny" },
      { action: original, resource: "/protected/*", effect: "deny" },
      { action: native, resource: "/protected/*", effect: "deny" },
    ])
  })
})

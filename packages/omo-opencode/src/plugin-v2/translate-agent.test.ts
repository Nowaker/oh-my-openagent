import { describe, expect, it } from "bun:test"
import { translateAgentConfigToV2Draft } from "./translate-agent"

describe("V1 agent translation", () => {
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

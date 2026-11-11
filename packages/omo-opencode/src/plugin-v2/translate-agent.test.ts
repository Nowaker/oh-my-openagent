import { describe, expect, it } from "bun:test"
import { translateAgentConfigToV2Draft } from "./translate-agent"

describe("V1 agent translation", () => {
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
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
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
})

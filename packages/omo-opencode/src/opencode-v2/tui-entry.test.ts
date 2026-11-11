import { describe, expect, it } from "bun:test"

import tuiModule from "../tui"
describe("OpenCode 2 TUI entry", () => {
  it("retains the V1 entry and loads on V2 without showing a startup toast", async () => {
    // given
    const definition: Record<string, unknown> = tuiModule
    const shown: unknown[] = []
    const context = { ui: { toast: { show: (options: unknown) => shown.push(options) } } }
    const setup = definition["setup"]

    // when
    if (typeof setup !== "function") throw new Error("setup missing")
    await setup(context)
    await setup(context)

    // then
    expect(definition["id"]).toBe("oh-my-openagent:tui")
    expect(typeof definition["tui"]).toBe("function")
    expect(shown).toHaveLength(0)
  })
})

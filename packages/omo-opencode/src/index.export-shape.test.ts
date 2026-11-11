import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"
import { setupV2Bridge } from "./plugin-v2"

describe("oh-my-openagent plugin export shape", () => {
  it("keeps default module and named server exports aligned", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
  })

  it("exposes the OpenCode 2 id + setup entry beside the V1 server entry", async () => {
    // given
    const definition: Record<string, unknown> = pluginModule

    // when
    const setup = definition["setup"]

    // then
    expect(definition["id"]).toBe("oh-my-openagent")
    expect(typeof definition["server"]).toBe("function")
    expect(typeof setup).toBe("function")
    expect(setup).toBe(setupV2Bridge)
  })
})

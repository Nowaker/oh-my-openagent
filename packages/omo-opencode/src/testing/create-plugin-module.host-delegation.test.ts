import { describe, expect, test } from "bun:test"
import { createPluginModule } from "./create-plugin-module"
import { createHostDelegationFixture, LegacyConstructorCalledError } from "./host-delegation-test-fixture"
import { createManagers, UnsupportedHostDelegationError } from "../create-managers"
import { OhMyOpenCodeConfigSchema } from "../config/schema/oh-my-opencode-config"
import type { Managers } from "../create-managers"

describe("plugin factory delegation ownership", () => {
  test("host ownership boots the real pipeline without a legacy manager and disposes common resources", async () => {
    const fixture = createHostDelegationFixture()
    let managers: Managers | undefined
    const module = createPluginModule({
      startOmoProcessSweep: async () => {},
      recordPluginTelemetry: () => {},
      warmLiveServerProbe: () => {},
      detectDuplicateOmoPlugin: () => ({ detected: false, pluginName: null, duplicatePlugins: [], allPlugins: [] }),
      loadConfigChain: () => ({ valid: true, config: fixture.args.pluginConfig, path: null, messages: [], warnings: [] }),
      createManagers: (args) => {
        managers = createManagers({ ...args, deps: fixture.args.deps })
        return managers
      },
    }, { delegationOwner: "host" })

    const hooks = await module.server(fixture.ctx)
    try {
      expect(managers?.backgroundManager).toBeUndefined()
      expect(hooks.tool?.task).toBeUndefined()
      expect(typeof hooks.tool?.skill?.execute).toBe("function")
      expect(typeof hooks.config).toBe("function")
    } finally {
      await hooks.dispose?.()
      await hooks.dispose?.()
    }

    expect(fixture.cleanup).toEqual(["diagnostics", "tmux"])
  })

  test("default ownership reaches the legacy constructor dependency", async () => {
    const fixture = createHostDelegationFixture()
    const module = createPluginModule({
      startOmoProcessSweep: async () => {},
      recordPluginTelemetry: () => {},
      warmLiveServerProbe: () => {},
      detectDuplicateOmoPlugin: () => ({ detected: false, pluginName: null, duplicatePlugins: [], allPlugins: [] }),
      loadConfigChain: () => ({ valid: true, config: fixture.args.pluginConfig, path: null, messages: [], warnings: [] }),
      createManagers: (args) => createManagers({ ...args, deps: fixture.args.deps }),
    })

    await expect(module.server(fixture.ctx)).rejects.toBeInstanceOf(LegacyConstructorCalledError)
  })

  test("host teams fail with the typed unsupported error before manager acquisition", async () => {
    const fixture = createHostDelegationFixture()
    const module = createPluginModule({
      startOmoProcessSweep: async () => {},
      detectDuplicateOmoPlugin: () => ({ detected: false, pluginName: null, duplicatePlugins: [], allPlugins: [] }),
      loadConfigChain: () => ({ valid: true, config: OhMyOpenCodeConfigSchema.parse({ team_mode: { enabled: true } }), path: null, messages: [], warnings: [] }),
      createManagers: () => { throw new Error("Unsupported host team acquired managers") },
    }, { delegationOwner: "host" })

    await expect(module.server(fixture.ctx)).rejects.toBeInstanceOf(UnsupportedHostDelegationError)
  })
})

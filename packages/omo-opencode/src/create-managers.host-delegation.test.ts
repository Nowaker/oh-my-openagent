import { describe, expect, test } from "bun:test"
import { createManagers, UnsupportedHostDelegationError } from "./create-managers"
import { createPluginDispose } from "./plugin-dispose"
import { OhMyOpenCodeConfigSchema } from "./config/schema/oh-my-opencode-config"
import { createHostDelegationFixture, LegacyConstructorCalledError } from "./testing/host-delegation-test-fixture"

describe("host delegation manager ownership", () => {
  test("host ownership never constructs the legacy background runtime or dependent managers", async () => {
    const { args } = createHostDelegationFixture()

    const managers = createManagers({ ...args, delegationOwner: "host" })

    try {
      expect(managers.backgroundManager).toBeUndefined()
      expect(managers.bashBackgroundManager).toBeUndefined()
      expect(managers.tuiStateMirror).toBeUndefined()
      expect(managers.runningJobsLedger).toBeUndefined()
      expect(typeof managers.configHandler).toBe("function")
      expect(typeof managers.skillMcpManager.disconnectAll).toBe("function")
    } finally {
      await managers.shutdown?.()
      await managers.skillMcpManager.disconnectAll()
    }
  })

  test.each([undefined, "plugin"] as const)("default/plugin ownership (%s) invokes the real constructor dependency", (delegationOwner) => {
    const { args } = createHostDelegationFixture()

    expect(() => createManagers({ ...args, delegationOwner })).toThrow(LegacyConstructorCalledError)
  })

  test("host plugin disposal shuts down real common resources once across repeated and process disposal", async () => {
    const { args, cleanup, registrations, unregistered } = createHostDelegationFixture()
    const managers = createManagers({ ...args, delegationOwner: "host" })
    const dispose = createPluginDispose({
      backgroundManager: managers.backgroundManager,
      shutdownManagers: managers.shutdown,
      skillMcpManager: managers.skillMcpManager,
      disposeHooks: () => { cleanup.push("hooks") },
    })

    await Promise.all([dispose(), dispose()])
    await registrations[0]?.shutdown()

    expect(cleanup).toEqual(["diagnostics", "tmux", "hooks"])
    expect(registrations).toHaveLength(1)
    expect(unregistered).toHaveLength(1)
    expect(unregistered[0]).toBe(registrations[0])
  })

  test("host ownership rejects enabled legacy teams before acquiring resources", () => {
    const { args, cleanup, registrations } = createHostDelegationFixture()
    const pluginConfig = OhMyOpenCodeConfigSchema.parse({ team_mode: { enabled: true } })

    expect(() => createManagers({ ...args, pluginConfig, delegationOwner: "host" })).toThrow(UnsupportedHostDelegationError)

    expect(cleanup).toEqual([])
    expect(registrations).toEqual([])
  })
})

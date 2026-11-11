import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { createClientFixture } from "./v1-client-fixture.test"
import { setupV2Bridge } from "./setup"

let hooks: Hooks & { dispose: () => Promise<void> }
let runtimeDisposals = 0
let runtimeFailure: Error | undefined
let hookFailure: Error | undefined

function unused(): never {
  throw new Error("Unexpected fixture domain access")
}

function context(): Plugin.Context {
  const { ctx } = createClientFixture()
  const registered = async () => ({ dispose: async () => {} })
  return {
    ...ctx,
    options: {},
    agent: { ...ctx.agent, get: unused, transform: registered, reload: unused },
    model: { ...ctx.model, transform: registered, reload: unused },
    provider: { ...ctx.provider, get: unused, transform: registered, reload: unused },
    session: {
      ...ctx.session,
      generate: unused, command: unused, compact: unused, synthetic: unused,
      update: unused, move: unused, hook: unused,
      get instructions() { return unused() },
    },
    tool: {
      transform: registered, list: unused, reload: unused,
      hook: async () => ({ dispose: async () => { if (hookFailure) throw hookFailure } }),
    },
    mcp: { transform: registered, list: unused, reload: unused },
    get aisdk() { return unused() },
    get command() { return unused() },
    get credential() { return unused() },
    get event() { return unused() },
    get experimental() { return unused() },
    get generate() { return unused() },
    get integration() { return unused() },
    get permission() { return unused() },
    get plugin() { return unused() },
    get reference() { return unused() },
    get rpc() { return unused() },
    get shell() { return unused() },
    get skill() { return unused() },
    get storage() { return unused() },
    get vcs() { return unused() },
    get websearch() { return unused() },
    get worktree() { return unused() },
  }
}

beforeEach(() => {
  runtimeDisposals = 0
  runtimeFailure = undefined
  hookFailure = undefined
  hooks = { dispose: async () => { runtimeDisposals += 1; if (runtimeFailure) throw runtimeFailure } }
  mock.module("../testing/create-plugin-module", () => ({ createPluginModule: () => ({ server: async () => hooks }) }))
})
afterEach(() => { mock.restore() })

describe("V2 bridge runtime lifecycle", () => {
  test("disposes the constructed runtime when configuration fails", async () => {
    // given
    const failure = new Error("configuration failed")
    hooks.config = async () => { throw failure }
    // when
    const result = setupV2Bridge(context())
    // then
    await expect(result).rejects.toBe(failure)
    expect(runtimeDisposals).toBe(1)
  })

  test("disposes the runtime even when hook cleanup rejects", async () => {
    // given
    hookFailure = new Error("hook cleanup failed")
    hooks["tool.execute.before"] = async () => {}
    const dispose = await setupV2Bridge(context())
    // when
    const result = dispose()
    // then
    await expect(result).rejects.toBeInstanceOf(AggregateError)
    expect(runtimeDisposals).toBe(1)
  })

  test("preserves setup and cleanup failures together", async () => {
    // given
    const failure = new Error("configuration failed")
    runtimeFailure = new Error("runtime cleanup failed")
    hooks.config = async () => { throw failure }
    // when
    const result = setupV2Bridge(context())
    // then
    await expect(result).rejects.toMatchObject({
      errors: [failure, expect.objectContaining({ errors: [runtimeFailure] })],
    })
    expect(runtimeDisposals).toBe(1)
  })
})

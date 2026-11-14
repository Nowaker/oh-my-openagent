import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { createClientFixture } from "./v1-client-fixture.test"
import { setupV2Bridge } from "./setup"
import { Model, Provider } from "@opencode/plugin"
import { lowerReasoningForModel } from "../shared/agent-variant"
import * as dataPath from "../shared/data-path"
import { _resetMemCacheForTesting } from "../shared/connected-providers-cache"

let hooks: Hooks & { dispose: () => Promise<void> }
let runtimeDisposals = 0
let runtimeFailure: Error | undefined
let hookFailure: Error | undefined
let cacheDirectory: string

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
      update: unused, move: unused, hook: registered,
      get instructions() { return unused() },
    },
    tool: {
      transform: async (callback) => {
        const native = { id: "subagent", name: "subagent", description: "Fixture native tool", input: { type: "object" }, execute: unused }
        callback({ add: () => {}, get: () => native, list: () => [native], namespace: unused, update: unused, remove: () => {} })
        return registered()
      }, list: unused, reload: unused,
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
  cacheDirectory = mkdtempSync(join(tmpdir(), "v2-setup-"))
  spyOn(dataPath, "getOmoOpenCodeCacheDir").mockReturnValue(cacheDirectory)
  _resetMemCacheForTesting()
  runtimeDisposals = 0
  runtimeFailure = undefined
  hookFailure = undefined
  hooks = { dispose: async () => { runtimeDisposals += 1; if (runtimeFailure) throw runtimeFailure } }
  mock.module("../testing/create-plugin-module", () => ({ createPluginModule: () => ({ server: async () => hooks }) }))
})
afterEach(() => { mock.restore(); _resetMemCacheForTesting(); rmSync(cacheDirectory, { recursive: true }) })

describe("V2 bridge runtime lifecycle", () => {
  test("refreshes activated native model presets before OMO handles a prompt", async () => {
    // given
    const ctx = context()
    const model = { ...Model.Info.default(Provider.ID.make("boot-provider"), Model.ID.make("boot-child")), variants: [{ id: Model.VariantID.make("high"), body: { reasoning_effort: "high" } }] }
    let activated = false
    ctx.model.list = async () => ({ location: ctx.location, data: activated ? [model] : [] })
    ctx.provider.list = async () => ({ location: ctx.location, data: activated ? [{ id: model.providerID, name: "Boot provider", activation: "enabled", package: "fixture" }] : [] })
    let selected: ReturnType<typeof lowerReasoningForModel> | undefined
    hooks["chat.message"] = async () => { selected = lowerReasoningForModel("high", { providerID: model.providerID, modelID: model.id }) }
    // when
    const dispose = await setupV2Bridge(ctx)
    activated = true
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: { id: "msg_prompt", sessionID: "session-1", role: "user", time: { created: 1 }, agent: "sisyphus", model: { providerID: model.providerID, modelID: model.id } }, parts: [] })
    await dispose()
    // then
    expect(selected).toEqual({ variant: "high" })
  })

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

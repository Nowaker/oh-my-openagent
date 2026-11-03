import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { captureContinuationPermit } from "../../features/run-continuation-state/host-authority"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { injectContinuation } from "./continuation-injection"
import { handleSessionIdle } from "./idle-event"
import { createSessionStateStore } from "./session-state"

const key = "__vibetermContinuationAuthorityV1"
const originalBridge: unknown = Reflect.get(globalThis, key)
const originalMachine = process.env.VIBETERM_MACHINE_ID
const stores: ReturnType<typeof createSessionStateStore>[] = []
afterEach(() => {
  Reflect.set(globalThis, key, originalBridge)
  if (originalMachine === undefined) delete process.env.VIBETERM_MACHINE_ID
  else process.env.VIBETERM_MACHINE_ID = originalMachine
  stores.splice(0).forEach(store => store.shutdown())
  releaseAllPromptAsyncReservationsForTesting()
})

function fixture() {
  let prompts = 0
  let toasts = 0
  let active = true
  let statusObserved = () => {}
  const binding = { version: 1, sessionId: "scoped", machineId: "host", generation: "generation", scopeId: "scope" }
  process.env.VIBETERM_MACHINE_ID = "host"
  Reflect.set(globalThis, key, {
    binding: () => active ? binding : null,
    capture: (_sessionId: string, plan: unknown) => active ? { binding, plan } : null,
    validate: () => active,
    stop: () => { active = false },
    freshPlan: () => { active = true },
  })
  const ctx = unsafeTestValue<PluginInput>({ directory: "/unwritten-continuation-fixture", client: {
    tui: { showToast: async () => { toasts++ } },
    session: {
      todo: async () => ({ data: [{ content: "new task", status: "pending", priority: "high" }] }),
      messages: async () => ({ data: [{ info: { role: "assistant", agent: "sisyphus", finish: "stop",
        time: { completed: 1 }, model: { providerID: "openai", modelID: "test" } }, parts: [] }] }),
      status: async () => { statusObserved(); return { data: {} } },
      promptAsync: async () => { prompts++; return {} },
    },
  } })
  const store = createSessionStateStore()
  stores.push(store)
  return { ctx, store, prompts: () => prompts, toasts: () => toasts,
    pause: () => { active = false }, onStatus: (action: () => void) => { statusObserved = action } }
}

describe("host scoped todo dispatch", () => {
  test("preserves native continuation with ordinary VT notes but rejects copied structured policy without its bridge", async () => {
    const f = fixture()
    Reflect.set(globalThis, key, undefined)
    delete process.env.VIBETERM_MACHINE_ID
    let vibeterm: Record<string, unknown> = { notes: [] }
    Reflect.set(f.ctx.client.session, "get", async () => ({ data: { metadata: { vibeterm } } }))
    expect(await captureContinuationPermit(f.ctx, "scoped", { kind: "todos", keys: ["new task"] })).toEqual({ kind: "native" })
    vibeterm = { continuationAuthority: { state: "historical", sessionId: "copied" } }
    expect(await captureContinuationPermit(f.ctx, "scoped", { kind: "todos", keys: ["new task"] })).toBeNull()
  })

  test("does not start a countdown for a session with no local authorization", async () => {
    const f = fixture()
    f.pause()
    await handleSessionIdle({ ctx: f.ctx, sessionID: "scoped", sessionStateStore: f.store })
    expect(f.toasts()).toBe(0)
    expect(f.prompts()).toBe(0)
  })

  test("rejects a captured countdown scope after a diagnostic wake invalidates it", async () => {
    const f = fixture()
    const permit = await captureContinuationPermit(f.ctx, "scoped", { kind: "todos", keys: ["new task"] })
    if (!permit) throw new Error("fixture did not authorize work")
    f.pause()
    await injectContinuation({ ctx: f.ctx, sessionID: "scoped", sessionStateStore: f.store,
      continuationPermit: permit, resolvedInfo: { agent: "sisyphus", model: { providerID: "openai", modelID: "test" } } })
    expect(f.prompts()).toBe(0)
  })

  test("rechecks scope at actual dispatch after the prompt gate observes idle", async () => {
    const f = fixture()
    f.onStatus(f.pause)
    await injectContinuation({ ctx: f.ctx, sessionID: "scoped", sessionStateStore: f.store,
      resolvedInfo: { agent: "sisyphus", model: { providerID: "openai", modelID: "test" } } })
    expect(f.prompts()).toBe(0)
  })

  test("dispatches an unchanged local authorized plan", async () => {
    const f = fixture()
    await injectContinuation({ ctx: f.ctx, sessionID: "scoped", sessionStateStore: f.store,
      resolvedInfo: { agent: "sisyphus", model: { providerID: "openai", modelID: "test" } } })
    expect(f.prompts()).toBe(1)
  })

  test("uses the local policy bridge when a bare OpenCode process has no Vibeterm machine environment", async () => {
    const f = fixture()
    delete process.env.VIBETERM_MACHINE_ID
    await injectContinuation({ ctx: f.ctx, sessionID: "scoped", sessionStateStore: f.store,
      resolvedInfo: { agent: "sisyphus", model: { providerID: "openai", modelID: "test" } } })
    expect(f.prompts()).toBe(1)
  })

  test("rejects a bridge binding that disagrees with an explicitly selected machine", async () => {
    const f = fixture()
    process.env.VIBETERM_MACHINE_ID = "another-host"
    await injectContinuation({ ctx: f.ctx, sessionID: "scoped", sessionStateStore: f.store,
      resolvedInfo: { agent: "sisyphus", model: { providerID: "openai", modelID: "test" } } })
    expect(f.prompts()).toBe(0)
  })
});

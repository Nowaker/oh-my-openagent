import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import { AssertInput } from "@opencode/plugin/permission"
import { z } from "zod"
import { bridgeHooks } from "./hook-bridge"
import { createClientFixture, sessionInfo } from "./v1-client-fixture.test"
import { resolveNativeSelection } from "./native-selection"

function unused(): never { throw new Error("Unexpected native domain access") }

function promptContext() {
  const { ctx: base, sessions } = createClientFixture()
  const handlers = new Map<string, unknown>()
  const registered = async () => ({ dispose: async () => {} })
  const ctx: Plugin.Context = {
    ...base, options: {},
    agent: { ...base.agent, get: unused, transform: registered, reload: unused },
    model: { ...base.model, transform: registered, reload: unused },
    provider: { ...base.provider, get: unused, transform: registered, reload: unused },
    session: { ...base.session, generate: unused, command: unused, compact: unused, move: unused,
      hook: async (name, callback) => { handlers.set(name, callback); return registered() },
    },
    tool: { list: unused, reload: unused, hook: registered, transform: registered },
    mcp: { transform: registered, list: unused, reload: unused },
    get aisdk() { return unused() }, get command() { return unused() }, get credential() { return unused() },
    get event() { return unused() }, get experimental() { return unused() }, get generate() { return unused() },
    get integration() { return unused() }, get permission() { return unused() }, get plugin() { return unused() },
    get reference() { return unused() }, get rpc() { return unused() }, get shell() { return unused() },
    get skill() { return unused() }, get storage() { return unused() }, get vcs() { return unused() },
    get websearch() { return unused() }, get worktree() { return unused() },
  }
  const event: SessionPrompt = {
    sessionID: AssertInput.fields.sessionID.make("session-1"),
    messageID: z.custom<SessionPrompt["messageID"]>((value) => typeof value === "string" && value.startsWith("msg_")).parse("msg_selection"),
    prompt: { text: "Use the native defaults." }, delivery: "queue",
  }
  return { ctx, sessions, event, handlers }
}

describe("native effective selection at the real prompt-hook boundary", () => {
  test.each(["both", "agent", "model"] as const)("passes the native getter's identity when stored %s selection is absent", async (missing) => {
    const fixture = promptContext()
    fixture.sessions.set("session-1", { ...sessionInfo, agent: missing === "model" ? sessionInfo.agent : undefined, model: missing === "agent" ? sessionInfo.model : undefined })
    const selected = { agent: `native-${crypto.randomUUID()}`, model: { providerID: "native-provider", id: `model-${crypto.randomUUID()}`, variant: "high" } }
    const calls: string[] = []
    Object.assign(fixture.ctx.app, { capabilities: { sessionSelection: true } })
    Object.assign(fixture.ctx.session, { selection: async ({ sessionID }: { readonly sessionID: string }) => { calls.push(sessionID); return selected } })
    let observed: Parameters<NonNullable<Hooks["chat.message"]>>[0] | undefined
    const dispose = await bridgeHooks(fixture.ctx, { "chat.message": async (input) => { observed = input } })
    try {
      const callback = z.custom<(event: SessionPrompt) => Promise<void>>((value) => typeof value === "function").parse(fixture.handlers.get("prompt"))
      await callback(fixture.event)
      expect(observed).toMatchObject({ agent: selected.agent, model: { providerID: selected.model.providerID, modelID: selected.model.id }, variant: selected.model.variant })
      expect(calls).toEqual(["session-1"])
      const stored = fixture.sessions.get("session-1")
      expect(stored?.agent).toBe(missing === "model" ? sessionInfo.agent : undefined)
      expect(stored?.model).toEqual(missing === "agent" ? sessionInfo.model : undefined)
    } finally { await dispose() }
  })

  test("retains explicit stored identity on a host without the selection capability", async () => {
    const { ctx, sessions } = promptContext()
    const explicit = { agent: "stored-agent", model: { providerID: "stored-provider", id: "stored-model", variant: "low" } }
    sessions.set("session-1", { ...sessionInfo, ...explicit })
    expect(await resolveNativeSelection(ctx, "session-1")).toEqual(explicit)
  })

  test("does not guess an absent default or silently trust an unadvertised method", async () => {
    const { ctx, sessions } = promptContext()
    sessions.set("session-1", { ...sessionInfo, agent: undefined, model: undefined })
    Object.assign(ctx.session, { selection: unused })
    await expect(resolveNativeSelection(ctx, "session-1")).rejects.toMatchObject({ mapping: "prompt.session-selection.capability" })
  })

  test("rejects a falsely advertised method and propagates native selection errors", async () => {
    const { ctx } = promptContext()
    Object.assign(ctx.app, { capabilities: { sessionSelection: true } })
    await expect(resolveNativeSelection(ctx, "session-1")).rejects.toMatchObject({ mapping: "prompt.session-selection.api" })
    const failure = new Error("Native selection is invalid")
    Object.assign(ctx.session, { selection: async () => { throw failure } })
    await expect(resolveNativeSelection(ctx, "session-1")).rejects.toBe(failure)
  })
})

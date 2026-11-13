import { describe, expect, test } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"
import { createClientFixture, sessionInfo } from "./v1-client-fixture.test"
import { createSyncSession } from "../tools/delegate-task/sync-session-creator"

describe("delegated session authority", () => {
  test.each([
    { stage: "create", tools: { task: false, call_omo_agent: true } },
    { stage: "create", tools: { call_omo_agent: true, task: false } },
    { stage: "prompt", tools: { task: false, call_omo_agent: true } },
    { stage: "prompt", tools: { call_omo_agent: true, task: false } },
  ])("keeps mixed launcher denies effective during $stage regardless of flag order", async ({ stage, tools }) => {
    // given
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    // when
    const sessionID = stage === "create"
      ? (await client.session.create({ body: { parentID: "session-1", permission: Object.entries(tools).map(([permission, enabled]) => ({ permission, pattern: "*", action: enabled ? "allow" : "deny" })) } })).data.id
      : "session-1"
    if (stage === "prompt") await client.session.promptAsync({ path: { id: sessionID }, body: { tools, parts: [{ type: "text", text: "mixed launcher policy" }] } })
    // then
    const rules = (await ctx.session.get({ sessionID })).permissions ?? []
    const decisions = ["task", "call_omo_agent", "subagent"].map((action) => rules.findLast((rule) => rule.action === action && rule.resource === "*")?.effect)
    expect(decisions).toEqual(["deny", "allow", "deny"])
  })

  test("retains the model reference emitted by the actual delegated-session creator", async () => {
    // given
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    // when
    const result = await createSyncSession(client, {
      parentSessionID: "session-1", agentToUse: "Sisyphus-Junior", description: "Delegated model",
      defaultDirectory: ctx.location.directory,
      categoryModel: { providerID: "configured-provider", modelID: "configured/model", variant: "max" },
    })
    // then
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect((await ctx.session.get({ sessionID: result.sessionID })).model).toEqual({ providerID: "configured-provider", id: "configured/model", variant: "max" })
  })

  test("creates a child with normalized agent and translated native permission rules", async () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    const result = await client.session.create({ body: {
      parentID: "session-1", agent: "Sisyphus (Ultraworker)",
      model: { providerID: "configured-provider", id: "configured/model", variant: "max" },
      permission: [
        { permission: "bash", pattern: "rm *", action: "deny" },
        { permission: "write", pattern: "/scratch/*", action: "ask" },
        { permission: "custom_tool", pattern: "*", action: "allow" },
        { permission: "call_omo_agent", pattern: "*", action: "deny" },
      ],
    } })
    const native = await ctx.session.get({ sessionID: result.data.id })
    expect(native).toMatchObject({ parentID: "session-1", agent: "sisyphus", model: { providerID: "configured-provider", id: "configured/model", variant: "max" }, permissions: [
      { action: "bash", resource: "rm *", effect: "deny" },
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "write", resource: "/scratch/*", effect: "ask" },
      { action: "edit", resource: "/scratch/*", effect: "ask" },
      { action: "custom_tool", resource: "*", effect: "allow" },
      { action: "call_omo_agent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ] })
  })

  test("retains existing explicit denies after prompt tools allow rules", async () => {
    const { ctx, sessions } = createClientFixture()
    sessions.set("session-1", { ...sessionInfo, permissions: [
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "read", resource: "*", effect: "ask" },
      { action: "edit", resource: "/protected/*", effect: "deny" },
    ] })
    const client = createV1ClientAdapter(ctx)
    await client.session.promptAsync({ path: { id: "session-1" }, body: { tools: { bash: true, write: true, task: false }, parts: [{ type: "text", text: "request" }] } })
    const native = await ctx.session.get({ sessionID: "session-1" })
    expect(native.permissions).toEqual([
      { action: "read", resource: "*", effect: "ask" },
      { action: "bash", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "write", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "task", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "edit", resource: "/protected/*", effect: "deny" },
    ])
  })

  test("commits the model-consumed instruction entry and exact selections before admission", async () => {
    const { ctx, admitted, instructions } = createClientFixture()
    const entryStarted = Promise.withResolvers<void>()
    const releaseEntry = Promise.withResolvers<void>()
    const originalPut = ctx.session.instructions.entry.put
    ctx.session.instructions.entry.put = async (input) => {
      entryStarted.resolve()
      await releaseEntry.promise
      await originalPut(input)
    }
    const originalPrompt = ctx.session.prompt
    const observations: { readonly agent?: string; readonly model: typeof sessionInfo.model; readonly instruction: unknown }[] = []
    ctx.session.prompt = async (input) => {
      const session = await ctx.session.get({ sessionID: input.sessionID })
      observations.push({ agent: session.agent, model: session.model, instruction: instructions.get(input.sessionID)?.get("omo-delegation-system") })
      return originalPrompt(input)
    }
    const client = createV1ClientAdapter(ctx)
    const operation = client.session.promptAsync({ path: { id: "session-1" }, body: {
      system: "delegated instruction input", agent: "Atlas (Plan Executor)",
      model: { providerID: "chosen-provider", modelID: "chosen/model" }, variant: "high",
      parts: [{ type: "text", text: "request" }],
    } })
    await entryStarted.promise
    expect(admitted).toEqual([])
    releaseEntry.resolve()
    await operation
    expect(observations).toEqual([{ agent: "atlas", model: { providerID: "chosen-provider", id: "chosen/model", variant: "high" }, instruction: "delegated instruction input" }])
  })

  test("keeps custom agent key case and applies a variant to the actual existing model", async () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    await client.session.promptAsync({ path: { id: "session-1" }, body: { agent: "MyCustomAgent", variant: "max", parts: [{ type: "text", text: "request" }] } })
    expect(await ctx.session.get({ sessionID: "session-1" })).toMatchObject({ agent: "MyCustomAgent", model: { providerID: "provider", id: "model", variant: "max" } })
  })

  test("does not admit input or change selection when instruction persistence fails", async () => {
    const { ctx, admitted, authority } = createClientFixture()
    const failure = new Error("native instruction failure")
    ctx.session.instructions.entry.put = async () => { throw failure }
    const client = createV1ClientAdapter(ctx)
    await expect(client.session.promptAsync({ path: { id: "session-1" }, body: { system: "input", agent: "worker", parts: [{ type: "text", text: "request" }] } })).rejects.toBe(failure)
    expect(admitted).toEqual([])
    expect(authority).toEqual([])
  })
})

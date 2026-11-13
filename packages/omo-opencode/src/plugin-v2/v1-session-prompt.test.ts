import { describe, expect, test } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"
import { createClientFixture, sessionInfo } from "./v1-client-fixture.test"
import type { PromptBody } from "./v1-session-prompt"

describe("delegated prompt admission", () => {
  test.each([true, false])("admits synthetic text with noReply=%s using native synthetic input", async (noReply) => {
    const { ctx, admitted, synthetic } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    const result = await client.session.promptAsync({ path: { id: "session-1" }, body: {
      messageID: "internal-message", noReply, parts: [{ type: "text", text: "continuation", synthetic: true }],
    } })
    expect(admitted).toEqual([])
    expect(synthetic).toEqual([{ sessionID: "session-1", id: "internal-message", text: "continuation", resume: !noReply }])
    expect(result.data).toMatchObject({ id: "internal-message", type: "synthetic", payload: { text: "continuation" } })
    expect((await ctx.session.context({ sessionID: "session-1" })).at(-1)).toMatchObject({ id: "internal-message", type: "synthetic", text: "continuation" })
  })

  test("projects a synchronous synthetic noReply receipt without waiting or fabricating a user", async () => {
    const { ctx } = createClientFixture()
    ctx.session.wait = async () => { throw new Error("noReply must not wait") }
    const client = createV1ClientAdapter(ctx)
    const result = await client.session.prompt({ path: { id: "session-1" }, body: { noReply: true, parts: [{ type: "text", text: "store", synthetic: true }] } })
    expect(result.data.info.v2.type).toBe("synthetic")
    expect(result.data.parts).toEqual([{ type: "text", text: "store", synthetic: true }])
  })

  const unsupported: readonly { readonly name: string; readonly parts: PromptBody["parts"]; readonly method: string }[] = [
    { name: "synthetic plus file", parts: [{ type: "text", text: "input", synthetic: true }, { type: "file", mime: "text/plain", url: "file:///scratch/file" }], method: "parts.mixed-synthetic" },
    { name: "synthetic plus ordinary text", parts: [{ type: "text", text: "input", synthetic: true }, { type: "text", text: "ordinary" }], method: "parts.mixed-synthetic" },
    { name: "ignored text", parts: [{ type: "text", text: "input", ignored: true }], method: "parts.text" },
    { name: "text metadata", parts: [{ type: "text", text: "input", metadata: { semantic: "value" } }], method: "parts.text" },
    { name: "text time", parts: [{ type: "text", text: "input", time: { start: 1, end: 2 } }], method: "parts.text" },
  ]
  test.each(unsupported)("rejects $name before applying child authority", async ({ parts, method }) => {
    const { ctx, admitted, synthetic, authority, instructions } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    await expect(client.session.promptAsync({ path: { id: "session-1" }, body: { system: "instruction", agent: "worker", tools: { bash: true }, parts } })).rejects.toMatchObject({ method: `session.promptAsync.${method}` })
    expect({ admitted, synthetic, authority, instructions: instructions.size }).toEqual({ admitted: [], synthetic: [], authority: [], instructions: 0 })
  })

  test("serializes instruction and permission writes with selection and admission for each child", async () => {
    const { ctx, instructions } = createClientFixture()
    const originalPrompt = ctx.session.prompt
    const firstAdmitted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const observed: { readonly text: string; readonly agent?: string; readonly permissions: typeof sessionInfo.permissions; readonly instruction: unknown }[] = []
    ctx.session.prompt = async (input) => {
      const session = await ctx.session.get({ sessionID: input.sessionID })
      observed.push({ text: input.text, agent: session.agent, permissions: session.permissions, instruction: instructions.get(input.sessionID)?.get("omo-delegation-system") })
      if (input.text === "one") { firstAdmitted.resolve(); await releaseFirst.promise }
      return originalPrompt(input)
    }
    const client = createV1ClientAdapter(ctx)
    const first = client.session.promptAsync({ path: { id: "session-1" }, body: { agent: "one", system: "first input", tools: { read: true }, parts: [{ type: "text", text: "one" }] } })
    await firstAdmitted.promise
    const second = client.session.promptAsync({ path: { id: "session-1" }, body: { agent: "two", system: "second input", tools: { write: false }, parts: [{ type: "text", text: "two" }] } })
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(observed).toEqual([
      { text: "one", agent: "one", instruction: "first input", permissions: [{ action: "read", resource: "*", effect: "allow" }] },
      { text: "two", agent: "two", instruction: "second input", permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "write", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" }] },
    ])
  })
})

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createScriptedProvider, type ScriptedReply } from "./provider"

const input = { model: "model-alias", messages: [{ role: "user", content: "fixture request" }], tools: [{ type: "function", function: { name: "fixture_tool", parameters: { type: "object" } } }] }
const usage = { prompt_tokens: 18000, completion_tokens: 7, total_tokens: 18007 }
const chunk = z.object({
  choices: z.array(z.object({
    delta: z.object({ content: z.string().optional(), tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }),
    finish_reason: z.string().nullable(),
  })),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() }).optional(),
})
const replies: readonly ScriptedReply[] = [
  { kind: "text", text: "fixture answer", usage },
  { kind: "tools", calls: [{ id: "fixture-call", name: "fixture_tool", args: { nested: ["value", 3] } }], usage },
]

describe("scripted parity provider wire contract", () => {
  test.each(replies)("emits the selected reply and usage through a real stream: %j", async (reply) => {
    // given
    await using provider = createScriptedProvider((request, index) => {
      expect({ model: request.model, messages: request.messages, tools: request.tools, index }).toEqual({ ...input, index: 0 })
      return reply
    })
    // when
    const response = await fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify({ ...input, stream: true }) })
    const data = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => chunk.parse(JSON.parse(line.slice(6))))
    // then
    expect(response.status).toBe(200)
    expect(data[1]?.usage).toEqual(usage)
    switch (reply.kind) {
      case "text":
        expect(data[0]?.choices[0]?.delta.content).toBe("fixture answer")
        expect(data[1]?.choices[0]?.finish_reason).toBe("stop")
        break
      case "tools":
        expect(data[0]?.choices[0]?.delta.tool_calls?.[0]?.function).toEqual({ name: "fixture_tool", arguments: '{"nested":["value",3]}' })
        expect(data[1]?.choices[0]?.finish_reason).toBe("tool_calls")
        break
      case "error": throw new Error("This table contains successful replies only")
      default: throw new TypeError(`Unexpected fixture reply: ${reply satisfies never}`)
    }
    expect(provider.requests).toHaveLength(1)
  })

  test("supports non-stream responses without changing the request model", async () => {
    // given
    await using provider = createScriptedProvider(() => ({ kind: "text", text: "plain answer", usage }))
    // when
    const response = await fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify({ ...input, stream: false }) })
    // then
    expect(await response.json()).toMatchObject({ model: "model-alias", choices: [{ message: { role: "assistant", content: "plain answer" }, finish_reason: "stop" }], usage })
  })

  test("returns a scripted upstream error without treating it as a fixture failure", async () => {
    // given
    await using provider = createScriptedProvider(() => ({ kind: "error", status: 429, body: { error: { message: "fixture quota" } } }))
    // when
    const response = await fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify(input) })
    // then
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 429, body: { error: { message: "fixture quota" } } })
  })

  test("preserves a broken handler as a failed fixture on disposal", async () => {
    // given
    const cause = new Error("broken scenario")
    const provider = createScriptedProvider(() => { throw cause })
    try {
      // when
      const response = await fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify(input) })
      // then
      expect(response.status).toBe(500)
    } finally {
      await expect(provider[Symbol.asyncDispose]()).rejects.toMatchObject({ name: "ScriptedProviderFailure", cause })
    }
  })

  test("rejects a malformed wire request before calling the scenario", async () => {
    // given
    let reached = false
    const provider = createScriptedProvider(() => { reached = true; return { kind: "text", text: "unexpected" } })
    try {
      // when
      const response = await fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify({ messages: [] }) })
      // then
      expect({ status: response.status, reached }).toEqual({ status: 400, reached: false })
    } finally {
      await expect(provider[Symbol.asyncDispose]()).rejects.toMatchObject({ phase: "request" })
    }
  })

  test("cancels held work on client-disconnect before provider disposal", async () => {
    // given
    const entered = Promise.withResolvers<AbortSignal>()
    const cancelled = Promise.withResolvers<void>()
    const deadline = setTimeout(() => cancelled.reject(new Error("Held request did not observe client cancellation")), 5000)
    await using provider = createScriptedProvider(async (_request, _index, signal) => {
      const held = Promise.withResolvers<ScriptedReply>()
      signal.addEventListener("abort", () => { cancelled.resolve(); held.reject(signal.reason) }, { once: true })
      entered.resolve(signal)
      return held.promise
    })
    const controller = new AbortController()
    const request = fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify(input), signal: controller.signal })
    const settled = Promise.allSettled([request])
    try {
      const signal = await Promise.race([entered.promise, request.then(() => { throw new Error("Held request returned before cancellation") }), cancelled.promise.then(() => { throw new Error("Request cancelled before entering its handler") })])
      // when
      controller.abort()
      await cancelled.promise
      // then
      expect(signal.aborted).toBe(true)
      expect(provider.requests).toHaveLength(1)
    } finally {
      clearTimeout(deadline)
      controller.abort()
      await settled
    }
  })

  test("cancels an observed held request and reaps its server on disposal", async () => {
    // given
    const entered = Promise.withResolvers<AbortSignal>()
    const released = Promise.withResolvers<void>()
    const provider = createScriptedProvider(async (_request, _index, signal) => {
      entered.resolve(signal)
      const held = Promise.withResolvers<ScriptedReply>()
      signal.addEventListener("abort", () => { released.resolve(); held.reject(signal.reason) }, { once: true })
      return held.promise
    })
    const request = fetch(new URL("/chat/completions", provider.url), { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
    const settled = Promise.allSettled([request])
    try {
      const signal = await Promise.race([entered.promise, request.then(() => { throw new Error("Provider replied before the held scenario was entered") })])
      // when
      await provider[Symbol.asyncDispose]()
      await released.promise
      await settled
      // then
      expect(signal.aborted).toBe(true)
      await expect(fetch(provider.url)).rejects.toThrow()
    } finally {
      await provider[Symbol.asyncDispose]()
      await settled
    }
  })
})

import { z } from "zod"

const requestSchema = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.json().optional() })),
  tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string() }) })).optional(),
})
const jsonSchema = z.json()
export type ProviderRequest = Readonly<z.infer<typeof requestSchema>>
export type ToolCall = { readonly id: string; readonly name: string; readonly args: z.infer<typeof jsonSchema> }
export type ProviderUsage = { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number }
export type ScriptedReply =
  | { readonly kind: "text"; readonly text: string; readonly usage?: ProviderUsage }
  | { readonly kind: "tools"; readonly calls: readonly ToolCall[]; readonly usage?: ProviderUsage }
  | { readonly kind: "error"; readonly status: number; readonly body: z.infer<typeof jsonSchema> }
export type ProviderHandler = (request: ProviderRequest, index: number, signal: AbortSignal) => ScriptedReply | Promise<ScriptedReply>

export class ScriptedProviderFailure extends Error {
  constructor(readonly phase: "request" | "handler", cause: unknown) {
    super(`Parity provider ${phase} failed`, { cause })
    this.name = "ScriptedProviderFailure"
  }
}

export function createScriptedProvider(handler: ProviderHandler) {
  const requests: ProviderRequest[] = []
  const controller = new AbortController()
  let failure: ScriptedProviderFailure | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ data: [{ id: "fixture", object: "model" }] })
      const signal = AbortSignal.any([request.signal, controller.signal])
      let phase: "request" | "handler" = "request"
      try {
        const body = requestSchema.parse(await request.json())
        const index = requests.length
        requests.push(body)
        phase = "handler"
        const cancelled = Promise.withResolvers<never>()
        const abort = () => cancelled.reject(signal.reason)
        signal.throwIfAborted()
        signal.addEventListener("abort", abort, { once: true })
        let reply: ScriptedReply
        try { reply = await Promise.race([handler(body, index, signal), cancelled.promise]) }
        finally { signal.removeEventListener("abort", abort) }
        let delta: object
        let finish: string
        let usage: ProviderUsage
        switch (reply.kind) {
          case "error": return Response.json(reply.body, { status: reply.status })
          case "text":
            delta = { content: reply.text }
            finish = "stop"
            usage = reply.usage ?? { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
            break
          case "tools":
            delta = { tool_calls: reply.calls.map((call, ordinal) => ({
              index: ordinal, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
            })) }
            finish = "tool_calls"
            usage = reply.usage ?? { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
            break
          default: throw new TypeError(`Unexpected parity reply: ${reply satisfies never}`)
        }
        const id = `chatcmpl-parity-${index}`
        if (body.stream === false) return Response.json({
          id, object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage,
        })
        const chunk = (part: object, reason: string | null) => `data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created: 1, model: body.model,
          choices: [{ index: 0, delta: part, finish_reason: reason }], ...(reason === null ? {} : { usage }),
        })}\n\n`
        return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      } catch (error) {
        if (signal.aborted && error === signal.reason) return new Response(null, { status: 499 })
        failure = new ScriptedProviderFailure(phase, error instanceof Error ? error : new TypeError("Scenario threw a non-Error value", { cause: error }))
        return Response.json({ error: { message: failure.message } }, { status: phase === "request" ? 400 : 500 })
      }
    },
  })
  return {
    url: new URL("/v1", server.url).href,
    get requests(): readonly ProviderRequest[] { return requests },
    async [Symbol.asyncDispose]() {
      controller.abort(new DOMException("Parity provider disposed", "AbortError"))
      await server.stop(true)
      if (failure) throw failure
    },
  }
}

import { createScriptedProvider } from "./v2-parity/provider"
import { requireProof, NativeFillFailure } from "./v2-native-fills-contract"
import type { ProviderRequest, ProviderScript } from "./v2-native-fills-contract"

export function createProvider(save: (name: string, value: unknown) => void) {
  const requests: ProviderRequest[] = []
  const failures: string[] = []
  let script: ProviderScript = () => { throw new NativeFillFailure("Provider received a request before the scenario was armed") }
  const server = createScriptedProvider(async (request, index) => {
    try {
      requests.push(request)
      save("provider-requests.json", requests)
      const reply = await script(request)
      const usage = reply.inputTokens === undefined ? {} : { usage: { prompt_tokens: reply.inputTokens, completion_tokens: 20, total_tokens: reply.inputTokens + 20 } }
      return reply.call
        ? { kind: "tools", calls: [{ id: `call_native_fill_${index}`, ...reply.call }], ...usage }
        : { kind: "text", text: reply.text ?? "", ...usage }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      failures.push(error.message)
      save("provider-failures.json", failures)
      throw error
    }
  })
  const url = new URL(server.url)
  requireProof(url.hostname === "127.0.0.1", "Shared provider must bind loopback")
  return { server, url, requests, failures, script: (respond: ProviderScript) => { script = respond } }
}

import { z } from "zod"
import packageJson from "../../../../package.json" with { type: "json" }
import { PUBLISHED_PACKAGE_NAME } from "./plugin-identity"

const promptOriginSchema = z.object({
  client: z.literal(PUBLISHED_PACKAGE_NAME),
  version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
  purpose: z.enum(["subagent", "helper", "review"]),
}).readonly()

export type PromptOrigin = z.infer<typeof promptOriginSchema>

const supportedClients = new WeakSet<object>()

export function registerPromptOriginClient(client: object): void {
  supportedClients.add(client)
}

export function supportsPromptOrigin(client: unknown): boolean {
  return typeof client === "object" && client !== null && supportedClients.has(client)
}

export function createPromptOrigin(purpose: PromptOrigin["purpose"]): PromptOrigin {
  return Object.freeze({ client: PUBLISHED_PACKAGE_NAME, version: packageJson.version, purpose })
}

export function parseStoredPromptOrigin(value: unknown): PromptOrigin | undefined {
  return promptOriginSchema.safeParse(value).data
}

export function promptOriginDispatchOptions(promptOrigin: PromptOrigin | undefined) {
  if (promptOrigin === undefined) return {}

  return {
    mapInputForClient<TInput extends { readonly body?: object }>(client: unknown, input: TInput): TInput {
      if (input.body === undefined || !supportsPromptOrigin(client)) return input
      return { ...input, body: { ...input.body, promptOrigin } }
    },
  }
}

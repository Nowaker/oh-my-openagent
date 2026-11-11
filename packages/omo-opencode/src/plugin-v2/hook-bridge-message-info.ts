import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk"
type Identity = { readonly sessionID: string; readonly agent: string; readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string } }

// Context messages omit persistence timestamps, paths and usage. These fields are
// structural placeholders for v1 handlers, never lifecycle or accounting data.
export function userMessageInfo(identity: Identity, id: string): UserMessage & { variant?: string } {
  return {
    id, sessionID: identity.sessionID, role: "user", time: { created: 0 },
    agent: identity.agent,
    model: { providerID: identity.model.providerID, modelID: identity.model.id },
    ...(identity.model.variant === undefined ? {} : { variant: identity.model.variant }),
  }
}

export function assistantMessageInfo(identity: Identity, id: string): AssistantMessage {
  return {
    id, sessionID: identity.sessionID, role: "assistant", time: { created: 0 },
    parentID: "", providerID: identity.model.providerID, modelID: identity.model.id,
    mode: identity.agent, path: { cwd: "", root: "" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

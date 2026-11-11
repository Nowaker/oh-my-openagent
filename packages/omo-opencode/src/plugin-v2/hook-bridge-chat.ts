import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { Hooks } from "@opencode-ai/plugin"
import { userMessageInfo } from "./hook-bridge-message-info"
import { UnsupportedHookMappingError, type HookOutput } from "./hook-bridge-types"

type PromptEvent = { readonly sessionID: string; readonly messageID: string; prompt: SessionPrompt["prompt"] }

export function buildChatMessageView(event: PromptEvent, identity: Omit<Parameters<typeof userMessageInfo>[0], "sessionID">) {
  const output: HookOutput<"chat.message"> = {
    message: userMessageInfo({ ...identity, sessionID: event.sessionID }, event.messageID),
    parts: [{ id: `${event.messageID}:text`, sessionID: event.sessionID, messageID: event.messageID, type: "text", text: event.prompt.text }],
  }
  const input: Parameters<NonNullable<Hooks["chat.message"]>>[0] = {
    sessionID: event.sessionID, messageID: event.messageID,
    agent: identity.agent, model: { providerID: identity.model.providerID, modelID: identity.model.id },
    variant: identity.model.variant,
  }
  return { input, output }
}

export function applyChatMessageView(event: PromptEvent, output: HookOutput<"chat.message">): void {
  const texts: string[] = []
  for (const part of output.parts) {
    if (part.type !== "text") throw new UnsupportedHookMappingError(`prompt.inserted-${part.type}`)
    if (!part.ignored) texts.push(part.text)
  }
  event.prompt.text = texts.join("\n\n")
}

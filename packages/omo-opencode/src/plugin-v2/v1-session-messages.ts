import type { Plugin } from "@opencode/plugin"

export type V2SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]
type Assistant = Extract<V2SessionMessage, { readonly type: "assistant" }>
type AssistantPart = Assistant["content"][number]

export type V1MessageView = {
  readonly info: {
    readonly id: string
    readonly sessionID: string
    readonly role?: "user" | "assistant"
    readonly v2: V2SessionMessage
    readonly [key: string]: unknown
  }
  readonly parts: readonly { readonly type: string; readonly [key: string]: unknown }[]
}

function assistantPart(part: AssistantPart) {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part
    case "tool": {
      const state = part.state
      switch (state.status) {
        case "streaming":
          return { ...part, callID: part.id, tool: part.name, state: { ...state, status: "pending" as const } }
        case "running":
          return { ...part, callID: part.id, tool: part.name }
        case "completed":
          return {
            ...part,
            callID: part.id,
            tool: part.name,
            state: {
              ...state,
              output: state.content.filter((content) => content.type === "text").map((content) => content.text).join("\n"),
            },
          }
        case "error":
          return { ...part, callID: part.id, tool: part.name }
        default:
          return assertExhaustive(state)
      }
    }
    default:
      return assertExhaustive(part)
  }
}

function assertExhaustive(value: never): never {
  throw new TypeError("Unrecognized native session message variant")
}

export function projectV1Message(message: V2SessionMessage, sessionID: string): V1MessageView {
  const base = { ...message, sessionID, v2: message }
  switch (message.type) {
    case "assistant":
      return {
        info: { ...base, role: "assistant" as const, providerID: message.model.providerID, modelID: message.model.id },
        parts: message.content.map(assistantPart),
      }
    case "user":
      return {
        info: { ...base, role: "user" as const },
        parts: [
          { type: "text" as const, text: message.text },
          ...(message.files ?? []).map((file) => ({ ...file, type: "file" as const, url: file.source.type === "uri" ? file.source.uri : new URL(`data:${file.mime};base64,${file.data}`).href })),
          ...(message.agents ?? []).map((agent) => ({ ...agent, type: "agent" as const })),
          ...(message.skills ?? []).map((skill) => ({ ...skill, type: "skill" as const })),
        ],
      }
    case "synthetic":
    case "system":
      return { info: { ...base, role: "user" as const }, parts: [{ type: "text" as const, text: message.text, synthetic: true }] }
    case "agent-switched":
    case "model-switched":
    case "location-switched":
    case "skill":
    case "shell":
    case "compaction":
    case "idle":
      return { info: base, parts: [] }
    default:
      return assertExhaustive(message)
  }
}

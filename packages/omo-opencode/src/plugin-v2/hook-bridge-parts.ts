import type { Part } from "@opencode-ai/sdk"
import { assertExhaustive, UnsupportedHookMappingError, type ContextPart } from "./hook-bridge-types"

type PartIdentity = { readonly id: string; readonly sessionID: string; readonly messageID: string }
type ResultPart = Extract<ContextPart, { readonly type: "tool-result" }>

function resultText(part: ResultPart): string {
  switch (part.result.type) {
    case "content": return part.result.value.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n")
    case "text":
    case "error":
    case "json": return typeof part.result.value === "string" ? part.result.value : JSON.stringify(part.result.value) ?? ""
    default: return assertExhaustive(part.result)
  }
}

export function projectContextPart(part: ContextPart, identity: PartIdentity, result?: ResultPart): Part | undefined {
  switch (part.type) {
    case "text": return { ...identity, type: "text", text: part.text }
    case "reasoning": return { ...identity, type: "reasoning", text: part.text, time: { start: 0 } }
    case "tool-call":
      if (typeof part.input !== "object" || part.input === null || Array.isArray(part.input)) return undefined
      return {
        ...identity, type: "tool", callID: part.id, tool: part.name,
        state: result ? {
          status: "completed", input: Object.fromEntries(Object.entries(part.input)), output: resultText(result), title: part.name, metadata: {}, time: { start: 0, end: 0 },
        } : { status: "running", input: Object.fromEntries(Object.entries(part.input)), time: { start: 0 } },
        metadata: { providerExecuted: part.providerExecuted },
      }
    case "media":
    case "tool-result":
    case "compaction":
    case "effort": return undefined
    default: return assertExhaustive(part)
  }
}

export function restoreContextPart(part: Part, original?: ContextPart, result?: ResultPart): ContextPart {
  switch (part.type) {
    case "text":
      if (original?.type === "text") return part.text === original.text ? original : { ...original, text: part.text }
      return { type: "text", text: part.text }
    case "reasoning":
      if (original?.type === "reasoning") return part.text === original.text ? original : { ...original, text: part.text }
      return { type: "reasoning", text: part.text }
    case "tool":
      if (original?.type !== "tool-call") throw new UnsupportedHookMappingError("messages.inserted-tool")
      if (part.state.status === "completed") {
        if (!result || part.state.output !== resultText(result)) throw new UnsupportedHookMappingError("messages.tool-result-rewrite")
      } else if (part.state.status !== "running") throw new UnsupportedHookMappingError("messages.tool-state")
      return { ...original, id: part.callID, name: part.tool, input: part.state.input }
    case "file":
    case "snapshot":
    case "agent":
    case "step-start":
    case "step-finish":
    case "patch":
    case "subtask":
    case "retry":
    case "compaction": throw new UnsupportedHookMappingError(`messages.inserted-${part.type}`)
    default: return assertExhaustive(part)
  }
}

import type { SessionContext } from "@opencode/plugin/promise/session"
import { assistantMessageInfo, userMessageInfo } from "./hook-bridge-message-info"
import { projectContextPart, restoreContextPart } from "./hook-bridge-parts"
import { assertExhaustive, UnsupportedHookMappingError, type ContextMessage, type ContextPart, type HookOutput, type MessageView } from "./hook-bridge-types"

function withContent(original: ContextMessage | undefined, row: MessageView, content: ContextPart[]): ContextMessage {
  switch (original?.role ?? row.info.role) {
    case "user": {
      const allowed = content.filter((part) => part.type === "text" || part.type === "media")
      if (allowed.length !== content.length) throw new UnsupportedHookMappingError("messages.user-content")
      return { ...original, role: "user", id: original?.id ?? row.info.id, content: allowed }
    }
    case "assistant": {
      const allowed = content.filter((part) => part.type !== "tool-result" && part.type !== "effort")
      if (allowed.length !== content.length) throw new UnsupportedHookMappingError("messages.assistant-content")
      return { ...original, role: "assistant", id: original?.id ?? row.info.id, content: allowed }
    }
    case "system":
    case "tool": throw new UnsupportedHookMappingError("messages.opaque-role")
    default: throw new UnsupportedHookMappingError("messages.role")
  }
}

export function createMessagesView(event: Parameters<typeof userMessageInfo>[0] & Pick<SessionContext, "messages">) {
  const rows = new Map<string, ContextMessage>()
  const parts = new Map<string, ContextPart>()
  const opaqueParts = new Map<string, ContextPart[]>()
  const opaqueMessages = new Map<string, ContextMessage[]>()
  const results = new Map(event.messages.flatMap((message) => message.content.flatMap((part) => part.type === "tool-result" ? [[part.id, part] as const] : [])))
  const output: HookOutput<"experimental.chat.messages.transform"> = { messages: [] }
  let previousMessage = ""
  for (const message of event.messages) {
    switch (message.role) {
      case "system":
      case "tool": {
        const siblings = opaqueMessages.get(previousMessage) ?? []
        siblings.push(message)
        opaqueMessages.set(previousMessage, siblings)
        continue
      }
      case "user":
      case "assistant": break
      default: assertExhaustive(message)
    }
    const id = message.id ?? `omo-v2-context-${rows.size}`
    if (rows.has(id)) throw new UnsupportedHookMappingError("messages.duplicate-identity")
    rows.set(id, message)
    previousMessage = id
    const row: MessageView = {
      info: message.role === "user" ? userMessageInfo(event, id) : assistantMessageInfo(event, id),
      parts: [],
    }
    let previousPart = `${id}:leading`
    for (const original of message.content) {
      const partID = `${id}:part-${parts.size}`
      parts.set(partID, original)
      const projected = projectContextPart(original, { id: partID, messageID: id, sessionID: event.sessionID }, original.type === "tool-call" ? results.get(original.id) : undefined)
      if (projected) {
        row.parts.push(projected)
        previousPart = partID
      } else {
        const siblings = opaqueParts.get(previousPart) ?? []
        siblings.push(original)
        opaqueParts.set(previousPart, siblings)
      }
    }
    output.messages.push(row)
  }
  return {
    output,
    restore(): ContextMessage[] {
      const result: ContextMessage[] = [...(opaqueMessages.get("") ?? [])]
      for (const row of output.messages) {
        const original = rows.get(row.info.id)
        const content: ContextPart[] = [...(opaqueParts.get(`${row.info.id}:leading`) ?? [])]
        for (const part of row.parts) {
          content.push(restoreContextPart(part, parts.get(part.id), part.type === "tool" ? results.get(part.callID) : undefined), ...(opaqueParts.get(part.id) ?? []))
        }
        const retained = new Set(row.parts.map((part) => part.id))
        for (const [id, attached] of opaqueParts) {
          if (id.startsWith(`${row.info.id}:part-`) && !retained.has(id)) content.push(...attached)
        }
        result.push(withContent(original, row, content), ...(opaqueMessages.get(row.info.id) ?? []))
      }
      return result
    },
  }
}

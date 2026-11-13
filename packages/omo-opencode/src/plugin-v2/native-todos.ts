import type { Todo } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { V2SessionMessage } from "./v1-session-messages"

const NativeTodos = z.array(z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).catch("pending"),
}).optional().catch(undefined))

export class NativeTodoHistoryUnavailableError extends Error {
  constructor(readonly sessionID: string) {
    super("Native todo history before completed compaction is unavailable through session.context")
    this.name = "NativeTodoHistoryUnavailableError"
  }
}

export type NativeTodoSession = Pick<Plugin.Context["session"], "context"> & {
  readonly messages?: (input: {
    readonly sessionID: string
    readonly type: "assistant"
    readonly order?: "desc"
    readonly limit: number
    readonly cursor?: string
  }) => Promise<{ readonly data: readonly V2SessionMessage[]; readonly cursor: { readonly next?: string | null; readonly previous?: string | null } }>
}

function latestSuccessfulTodos(messages: readonly V2SessionMessage[]): Todo[] | undefined {
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content.toReversed()) {
      if (part.type !== "tool" || part.name !== "todowrite" || part.state.status !== "completed") continue
      const parsed = NativeTodos.parse(part.state.metadata?.todos)
      // Native todos have no identity. Positional ids stay stable across status and wording edits.
      return parsed.flatMap((todo, index) => todo ? [{ ...todo, id: String(index), priority: "medium" }] : [])
    }
  }
  return undefined
}

export async function nativeTodos(session: NativeTodoSession, sessionID: string): Promise<Todo[]> {
  if (typeof session.messages === "function") {
    let cursor: string | undefined
    for (;;) {
      const page = await session.messages({ sessionID, type: "assistant", limit: 100, ...(cursor ? { cursor } : { order: "desc" }) })
      const todos = latestSuccessfulTodos(page.data)
      if (todos !== undefined) return todos
      cursor = page.cursor.next ?? undefined
      if (cursor === undefined) return []
    }
  }
  const messages = await session.context({ sessionID })
  const todos = latestSuccessfulTodos(messages.toReversed())
  if (todos !== undefined) return todos
  if (messages.some((message) => message.type === "compaction" && message.status === "completed")) {
    throw new NativeTodoHistoryUnavailableError(sessionID)
  }
  return []
}

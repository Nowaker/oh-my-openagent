import type { Plugin } from "@opencode/plugin"
import type { NativeInstructions } from "./native-instructions"
import { nativeTodos, NativeTodoHistoryUnavailableError } from "./native-todos"

export async function registerNativeCompaction(ctx: Pick<Plugin.Context, "session">, instructions: NativeInstructions): Promise<Plugin.Cleanup> {
  const registration = await ctx.session.hook("compaction", async (event) => {
    const [session, todos] = await Promise.all([
      ctx.session.get({ sessionID: event.sessionID }),
      nativeTodos(ctx.session, event.sessionID).catch((error: unknown) => {
        if (error instanceof NativeTodoHistoryUnavailableError) return undefined
        throw error
      }),
    ])
    const snapshot = {
      agent: session.agent ?? null,
      model: session.model ?? null,
      ...(todos === undefined ? { todoHistory: "unavailable-on-this-host" } : { todos: todos.map(({ content, status }) => ({ content, status })) }),
    }
    await instructions.put(event.sessionID, "omo-compaction-context", snapshot)
    event.system.push({ type: "text", text: JSON.stringify(snapshot) })
  })
  return () => registration.dispose()
}

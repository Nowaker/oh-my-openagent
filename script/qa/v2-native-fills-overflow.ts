import { captureMessages, createSession, isTodoContinuation, latestTodos, requireProof, settle, todoList } from "./v2-native-fills-contract"
import { todoState } from "./v2-native-fills-todos"
import type { ScenarioHost } from "./v2-native-fills-contract"
import { z } from "zod"

export async function overflowScenario(host: ScenarioHost) {
  const info = z.object({ capabilities: z.object({ sessionMessages: z.boolean().optional() }).passthrough() }).passthrough().parse(await host.api("/api/info"))
  host.save("overflow-capabilities.json", info)
  if (info.capabilities.sessionMessages !== true) return {
    status: "skipped" as const,
    reason: "Installed host lacks sessionMessages; compacted native todos cannot be recovered from the plugin context API",
  }
  const sessionID = await createSession(host)
  let mainStep = 0
  let summaryRequests = 0
  let stoppedAt = -1
  let overflowBoundary = 0
  host.script(async (request) => {
    if (mainStep === 1 && summaryRequests === 0) {
      await host.waitEvent((event) => event.type === "session.compaction.started" && event.data["sessionID"] === sessionID && event.data["reason"] === "auto", overflowBoundary)
      summaryRequests++
      return { text: "## Objective\nComplete three native todo items.\n\n## Work State\nThe first item is complete. Two items remain pending.\n\n## Next Move\nContinue the two pending items and preserve the native todo list." }
    }
    if (!request.tools?.length) return { text: "Native overflow fixture." }
    requireProof(request.tools.some((tool) => tool.function.name === "todowrite"), "Overflow scenario requires real native todowrite")
    mainStep++
    switch (mainStep) {
      case 1:
        overflowBoundary = host.events.length
        return { call: { name: "todowrite", args: { todos: todoState(1) } }, inputTokens: 60000 }
      case 2:
        await host.waitEvent((event) => event.type === "session.compaction.ended" && event.data["sessionID"] === sessionID && event.data["reason"] === "auto", overflowBoundary)
        stoppedAt = host.events.length
        return { text: "Stopping this response with two native todo items still unfinished." }
      case 3:
        await host.waitEvent((event) => isTodoContinuation(event, sessionID), stoppedAt)
        return { call: { name: "todowrite", args: { todos: todoState(3) } } }
      case 4: return { text: "All native todos are complete after automatic compaction." }
      default: throw new Error("Unexpected extra overflow scenario model step")
    }
  })
  const after = host.events.length
  const compacted = host.waitEvent((event) => event.type === "session.compaction.ended" && event.data["sessionID"] === sessionID && event.data["reason"] === "auto", after)
  const complete = host.waitEvent((event) => {
    if (event.type !== "session.tool.success" || event.data["sessionID"] !== sessionID) return false
    const metadata = event.data["metadata"]
    const todos = todoList.safeParse(typeof metadata === "object" && metadata !== null && "todos" in metadata ? metadata.todos : undefined)
    return todos.success && todos.data.length === 3 && todos.data.every((todo) => todo.status === "completed")
  }, after)
  void compacted.catch(() => undefined)
  void complete.catch(() => undefined)
  await host.api(`/api/session/${sessionID}/prompt`, { text: "Track three fixture items with native todowrite, mark one complete, and stop. Preserve the two pending items across automatic compaction and complete them only after harness continuation." })
  const event = await compacted
  await complete
  await settle(host, sessionID)
  const messages = await captureMessages(host, sessionID, "overflow-messages.json")
  requireProof(messages.filter((message) => message.type === "user").length === 1, "Automatic compaction continuation required another user prompt")
  requireProof(!host.events.slice(after).some((entry) => entry.type === "session.compaction.started" && entry.data["sessionID"] === sessionID && entry.data["reason"] === "manual"), "A manual compact request contaminated automatic overflow proof")
  const todos = latestTodos(messages)
  requireProof(todos.length === 3 && todos.every((todo) => todo.status === "completed"), "Native todos were lost or remained incomplete across automatic compaction")
  requireProof(summaryRequests > 0, "Automatic compaction never reached the model")
  host.save("overflow-active-context.json", await host.api(`/api/session/${sessionID}/context`))
  return { sessionID, contextLimit: 64000, reportedInputTokens: 60000, automaticCompaction: event, summaryRequests, mainStep, userPrompts: 1, todos, nativeIdleContinuation: true, manualCompactCalls: 0 }
}

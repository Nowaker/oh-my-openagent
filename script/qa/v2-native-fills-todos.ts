import { captureMessages, createSession, isTodoContinuation, latestTodos, requireProof, settle, todoList, toolsIn } from "./v2-native-fills-contract"
import type { ScenarioHost } from "./v2-native-fills-contract"

export const fixtureTodos = [
  { content: "fixture/one: Read the first input to establish progress - expect the first result", status: "pending" },
  { content: "fixture/two: Read the second input to advance the task - expect the second result", status: "pending" },
  { content: "fixture/three: Read the last input to finish the task - expect all results", status: "pending" },
] as const

export function todoState(completed: number) {
  return fixtureTodos.map((todo, index) => ({ ...todo, status: index < completed ? "completed" : "pending" }))
}

export async function todosScenario(host: ScenarioHost) {
  const sessionID = await createSession(host)
  let step = 0
  let stoppedAt = -1
  host.script(async (request) => {
    if (!request.tools?.length) return { text: "Native todo fixture summary." }
    requireProof(request.tools.some((tool) => tool.function.name === "todowrite"), "Native todowrite tool was not advertised")
    step++
    switch (step) {
      case 1: return { call: { name: "todowrite", args: { todos: todoState(0) } } }
      case 2: return { call: { name: "todowrite", args: { todos: todoState(1) } } }
      case 3:
        stoppedAt = host.events.length
        return { text: "The first item is complete. Stopping this response with two items unfinished." }
      case 4:
        await host.waitEvent((event) => isTodoContinuation(event, sessionID), stoppedAt)
        return { call: { name: "todowrite", args: { todos: todoState(3) } } }
      case 5: return { text: "All three native todo items are complete." }
      default: throw new Error("Unexpected extra model step after native todo completion")
    }
  })
  const after = host.events.length
  const finished = host.waitEvent((event) => {
    if (event.type !== "session.tool.success" || event.data["sessionID"] !== sessionID) return false
    const metadata = event.data["metadata"]
    const parsed = todoList.safeParse(typeof metadata === "object" && metadata !== null && "todos" in metadata ? metadata.todos : undefined)
    return parsed.success && parsed.data.length === 3 && parsed.data.every((todo) => todo.status === "completed")
  }, after)
  void finished.catch(() => undefined)
  await host.api(`/api/session/${sessionID}/prompt`, { text: "Create the three fixture todos, complete only the first, and stop your response. Finish the rest when your harness tells you to continue." })
  await finished
  await settle(host, sessionID)
  const messages = await captureMessages(host, sessionID, "todos-messages.json")
  requireProof(messages.filter((message) => message.type === "user").length === 1, "Todo completion required an additional user prompt")
  requireProof(messages.some((message) => message.type === "synthetic"), "No native synthetic continuation was persisted")
  requireProof(toolsIn(messages, "todowrite").length === 3, "Expected initial, partial and complete native todo writes")
  const todos = latestTodos(messages)
  requireProof(todos.length === 3 && todos.every((todo) => todo.status === "completed"), "Latest successful native todo metadata is incomplete")
  const stoppedSessionID = await createSession(host)
  await host.api(`/api/session/${stoppedSessionID}/command`, { name: "stop-continuation", text: "" })
  let stoppedSteps = 0
  host.script((request) => {
    if (!request.tools?.length) return { text: "Stopped native todo fixture." }
    stoppedSteps++
    if (stoppedSteps === 1) return { call: { name: "todowrite", args: { todos: todoState(0) } } }
    requireProof(stoppedSteps === 2, "A stopped session made an unexpected continuation request")
    return { text: "The native stop command keeps these pending todos paused." }
  })
  const stoppedBoundary = host.events.length
  await host.api(`/api/session/${stoppedSessionID}/prompt`, { text: "Create the three fixture todos and stop this response." })
  await settle(host, stoppedSessionID)
  const stoppedMessages = await captureMessages(host, stoppedSessionID, "todos-stopped-messages.json")
  requireProof(latestTodos(stoppedMessages).every((todo) => todo.status === "pending"), "Stopped todo state unexpectedly changed")
  requireProof(!host.events.slice(stoppedBoundary).some((event) => isTodoContinuation(event, stoppedSessionID)), "Native stop command failed to suppress idle continuation")
  return { sessionID, modelSteps: step, userPrompts: 1, todos, syntheticContinuation: true, stoppedSessionID, stoppedSteps, stopCommandHonored: true }
}

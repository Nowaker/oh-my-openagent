import type { PluginInput } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import type { SessionIdle } from "@opencode/plugin/promise/session"
import { captureContinuationPermit, continuationBridge, continuationPermitCurrent } from "../features/run-continuation-state/host-authority"
import { CONTINUATION_PROMPT, DEFAULT_SKIP_AGENTS } from "../hooks/todo-continuation-enforcer/constants"
import { createSessionStateStore } from "../hooks/todo-continuation-enforcer/session-state"
import { shouldStopForStagnation } from "../hooks/todo-continuation-enforcer/stagnation-detection"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { nativeTodos, NativeTodoHistoryUnavailableError } from "./native-todos"

type NativeIdleContext = {
  readonly session: Pick<Plugin.Context["session"], "get" | "context" | "synthetic"> & {
    readonly hook: (name: "experimental.idle", callback: (event: SessionIdle) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> }>
  }
}
type NativeIdleDependencies = {
  readonly input: PluginInput
  readonly enabled: boolean
  readonly isStopped?: (sessionID: string) => boolean
}

export async function registerNativeIdle(ctx: NativeIdleContext, dependencies: NativeIdleDependencies): Promise<() => Promise<void>> {
  if (!dependencies.enabled) return async () => {}
  const states = createSessionStateStore()
  let disposed = false
  const registration = await ctx.session.hook("experimental.idle", async ({ sessionID, background }) => {
    if (disposed || dependencies.isStopped?.(sessionID)) return
    // Only work owned by this session wakes it on completion. Descendants wake their own owner.
    if (background.some((work) => work.sessionID === sessionID)) return
    const generation = continuationBridge()?.binding(sessionID)?.generation
    if (generation && states.getExistingState(sessionID)?.continuationGeneration !== generation) states.cleanup(sessionID)
    const state = states.getState(sessionID)
    if (generation) state.continuationGeneration = generation
    if (state.inFlight) return
    state.inFlight = true
    try {
      const session = await ctx.session.get({ sessionID })
      const agent = session.agent ?? (await ctx.session.context({ sessionID })).findLast((message) => message.type === "assistant")?.agent
      if (agent && DEFAULT_SKIP_AGENTS.some((skip) => getAgentConfigKey(skip) === getAgentConfigKey(agent))) return
      let todos: Awaited<ReturnType<typeof nativeTodos>>
      try {
        todos = await nativeTodos(ctx.session, sessionID)
      } catch (error) {
        if (error instanceof NativeTodoHistoryUnavailableError) return
        throw error
      }
      const incomplete = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
      if (incomplete.length === 0) {
        states.resetContinuationProgress(sessionID)
        return
      }
      const permit = await captureContinuationPermit(dependencies.input, sessionID, {
        kind: "todos", keys: incomplete.map((todo) => todo.content).sort(),
      })
      if (!permit) return
      const plan = permit.kind === "scoped" ? permit.lease.plan : undefined
      const eligible = plan?.kind === "todos" ? todos.filter((todo) => plan.keys.includes(todo.content)) : todos
      const remaining = eligible.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
      if (remaining.length === 0) return
      const progressUpdate = states.trackContinuationProgress(sessionID, remaining.length, eligible)
      if (state.continuationBlockReason || shouldStopForStagnation({ sessionID, incompleteCount: remaining.length, progressUpdate })) return
      if (!(await continuationPermitCurrent(dependencies.input, sessionID, permit))) return
      if (disposed || dependencies.isStopped?.(sessionID)) return
      await ctx.session.synthetic({
        sessionID,
        text: `${CONTINUATION_PROMPT}\n\nRemaining tasks:\n${remaining.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")}`,
        metadata: { source: "omo.todo-continuation" },
      })
      // The next native idle follows model work, so unchanged todos mean the directive did not advance it.
      state.awaitingPostInjectionProgressCheck = true
      state.continuationResponseObserved = true
    } finally {
      state.inFlight = false
    }
  })
  states.startPruneInterval()
  return async () => {
    disposed = true
    states.shutdown()
    await registration.dispose()
  }
}

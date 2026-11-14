import {
  dispatchInternalPrompt as dispatchPrompt,
  type InternalPromptDispatchArgs,
  type InternalPromptDispatchResult,
} from "../../shared/prompt-async-gate"
import { isSessionPaused } from "./session-paused"

export * from "../../shared/prompt-async-gate"

const CONTINUATION_SOURCES = new Set(["todo-continuation-enforcer", "atlas", "ralph-loop"])

export function dispatchInternalPrompt<TInput>(
  args: InternalPromptDispatchArgs<TInput>,
): Promise<InternalPromptDispatchResult> {
  if (!CONTINUATION_SOURCES.has(args.source)) return dispatchPrompt(args)

  return dispatchPrompt({
    ...args,
    shouldDispatch: async () => {
      if (await args.shouldDispatch?.() === false) return false
      return !await isSessionPaused(args.client, args.sessionID)
    },
  })
}

import type { DelegatedModelConfig, OpencodeClient } from "./types"
import type { ParentContext } from "./executor-types"
import { resolvePromptContextFromSessionMessages } from "../../features/background-agent/compaction-aware-message-resolver"
import { log, normalizeSDKResponse } from "../../shared"

type PromptContextMessage = Parameters<typeof resolvePromptContextFromSessionMessages>[0][number]

/** `task(subagent_type: "fork")`: the child starts from a copy of the parent session, on the parent's agent and model. */
export const FORK_SUBAGENT_TYPE = "fork"

export function isForkSubagent(subagentType: string | undefined): boolean {
  return subagentType === FORK_SUBAGENT_TYPE
}

/**
 * The model the parent's last turn ran on, read from its messages: a fork that misses it would run on its agent's
 * configured model instead of the parent's.
 */
export async function readParentModel(
  client: OpencodeClient,
  sessionID: string,
): Promise<ParentContext["model"]> {
  try {
    const messages = normalizeSDKResponse(await client.session.messages({ path: { id: sessionID } }), [] as PromptContextMessage[])
    const model = resolvePromptContextFromSessionMessages(Array.isArray(messages) ? messages : [], sessionID)?.model
    if (!model?.providerID || !model.modelID) return undefined
    return { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
  } catch (error) {
    log("[task] Could not read the parent's model for a fork:", { sessionID, error: String(error) })
    return undefined
  }
}

export function resolveForkExecution(
  parentContext: ParentContext,
): { agentToUse: string; categoryModel: DelegatedModelConfig | undefined; error?: undefined } | { error: string } {
  if (!parentContext.agent) {
    return { error: `Cannot fork: this session's agent is unknown. Use a category or a named subagent_type instead.` }
  }
  return {
    agentToUse: parentContext.agent,
    categoryModel: parentContext.model
      ? {
          providerID: parentContext.model.providerID,
          modelID: parentContext.model.modelID,
          ...(parentContext.model.variant ? { variant: parentContext.model.variant } : {}),
        }
      : undefined,
  }
}

/** The fork's first own message: it already has the whole conversation, so it is told what it is and what to do. */
export function buildForkTaskPrompt(prompt: string): string {
  return [
    "You are a fork of the conversation above, started by its task tool as a separate subagent. Everything above is your context; the turn that started you is not part of it. Do only the task below, without asking the user anything, and end with your result as your final message: it is sent back to the session you were forked from.",
    "",
    prompt,
  ].join("\n")
}

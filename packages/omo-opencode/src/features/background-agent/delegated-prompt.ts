import { delegationAgentForClient } from "../../shared/native-delegation-client"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"

export function buildDelegatedPrompt(
  client: object,
  task: { readonly agent: string; readonly prompt: string; readonly skillContent?: string },
  tuning: { readonly model?: { readonly providerID: string; readonly modelID: string }; readonly variant?: string; readonly tools: Record<string, boolean> },
) {
  return {
    agent: delegationAgentForClient(client, task.agent),
    ...(tuning.model ? { model: tuning.model } : {}),
    ...(tuning.variant ? { variant: tuning.variant } : {}),
    system: task.skillContent,
    tools: tuning.tools,
    parts: [createInternalAgentTextPart(task.prompt)],
  }
}

import { prepareDelegateTaskArgs } from "../tools/delegate-task/tool-argument-preparation"
import { validateSubagentRequest } from "../tools/delegate-task/subagent-request-preflight"
import { resolveSkillContent } from "../tools/delegate-task/skill-resolver"
import { createDelegateTaskPresentation } from "../tools/delegate-task/tool-description"
import { buildSystemContent, buildTaskPrompt } from "../tools/delegate-task/prompt-builder"
import { buildForkTaskPrompt } from "../tools/delegate-task/fork-subagent"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { resolveNativeTaskModel } from "./native-task-model"
import type { NativeTaskArguments } from "./native-task-arguments"
import type { NativeTaskContext, NativeTaskBindings, NativeToolContext, NativeTaskPlan, NativeTaskMetadata, NativeSession } from "./native-task-types"
import { NativeTaskError } from "./native-task-types"

export async function buildNativeTaskPlan(ctx: NativeTaskContext, input: {
  readonly args: NativeTaskArguments; readonly context: NativeToolContext; readonly bindings: NativeTaskBindings; readonly previous?: NativeTaskMetadata; readonly previousSession?: NativeSession;
}): Promise<{ readonly plan: NativeTaskPlan; readonly prompt: string; readonly description: string; readonly background: boolean; readonly fork: boolean }> {
  const { bindings, context, previous } = input
  const inheritedContinuation = previous !== undefined && input.args.category === undefined && input.args.subagent_type === undefined
  const normalized = await prepareDelegateTaskArgs({ ...input.args, category: input.args.category ?? (input.args.subagent_type === undefined ? previous?.category : undefined) }, { sessionID: context.sessionID, messageID: context.messageID, agent: context.agent, abort: context.signal })
  const parent = await ctx.session.get({ sessionID: context.sessionID })
  const fork = !normalized.category && normalized.subagent_type === "fork"
  const requested = inheritedContinuation ? input.previousSession?.agent ?? previous?.agent
    : normalized.category ? "sisyphus-junior" : fork ? parent.agent ?? context.agent : normalized.subagent_type ?? previous?.agent
  if (!requested) throw new NativeTaskError("missing-agent", "Provide category, subagent_type or a durable continuation task_id")
  const presentation = createDelegateTaskPresentation({ userCategories: bindings.config.categories, availableCategories: bindings.tools.availableCategories, availableSkills: bindings.tools.availableSkills })
  if (!normalized.category && !fork && !inheritedContinuation) {
    const validation = validateSubagentRequest({ ...normalized, subagent_type: requested }, parent.agent ?? context.agent, presentation.categoryExamples, {})
    if (validation.kind === "invalid") throw new NativeTaskError("invalid-agent", validation.result.error ?? "Invalid subagent")
  }
  const agents = (await ctx.agent.list()).data
  const agent = agents.find((entry) => getAgentConfigKey(entry.id) === getAgentConfigKey(requested) || getAgentConfigKey(entry.name) === getAgentConfigKey(requested))
  if (!agent || (!fork && !inheritedContinuation && (agent.mode === "primary" || agent.hidden))) throw new NativeTaskError("unavailable-agent", `Agent cannot be delegated: ${requested}`)
  if (bindings.config.disabled_agents?.some((name) => getAgentConfigKey(name) === getAgentConfigKey(agent.id))) throw new NativeTaskError("disabled-agent", `Agent is disabled: ${agent.id}`)
  const inherited = inheritedContinuation ? input.previousSession?.model : parent.model
  const resolved = fork || inheritedContinuation ? {
    model: inherited ? { ...previous?.settings, providerID: inherited.providerID, modelID: inherited.id, variant: inherited.variant } : undefined,
    fallbackChain: previous?.fallbackChain, category: previous?.category, promptAppend: previous?.categoryPromptAppend, maxPromptTokens: previous?.maxPromptTokens, forceBackground: false,
  } : await resolveNativeTaskModel(ctx, { bindings, category: normalized.category, agent, inherited: parent.model ? `${parent.model.providerID}/${parent.model.id}` : undefined })
  const skills = input.args.load_skills ?? previous?.skills ?? normalized.load_skills
  const loaded = await resolveSkillContent(skills, {
    directory: ctx.location.directory, targetAgent: agent.id, gitMasterConfig: bindings.config.git_master,
    disabledSkills: bindings.tools.disabledSkills, browserProvider: bindings.tools.browserProvider,
    teamModeEnabled: bindings.config.team_mode?.enabled ?? false, getLoadedSkills: async () => bindings.tools.mergedSkills,
  })
  if (loaded.error) throw new NativeTaskError("skills-unavailable", loaded.error)
  const system = buildSystemContent({ skillContent: loaded.content, skillContents: loaded.contents, categoryPromptAppend: resolved.promptAppend,
    maxPromptTokens: resolved.maxPromptTokens, model: resolved.model, agentName: agent.id, availableCategories: presentation.availableCategories, availableSkills: presentation.availableSkills })
  return {
    plan: { agent: agent.id, skills, model: resolved.model, system, category: resolved.category,
      categoryPromptAppend: resolved.promptAppend, maxPromptTokens: resolved.maxPromptTokens, fallbackChain: resolved.fallbackChain },
    prompt: fork ? buildForkTaskPrompt(normalized.prompt) : buildTaskPrompt(normalized.prompt, agent.id),
    description: normalized.description, background: normalized.run_in_background || resolved.forceBackground === true, fork,
  }
}

import { z } from "zod"
import { expandPermissionRules, type PermissionRule } from "./permission-actions"
import { mergeHostPermissionRules } from "./host-permissions"
import type { NativeTaskContext, NativeTaskBindings, NativeTaskPlan, NativeTaskMetadata, NativeToolContext } from "./native-task-types"
import { NATIVE_TASK_METADATA_KEY, nativeTaskMetadata, NativeTaskCapabilityError, NativeTaskError } from "./native-task-types"

export async function persistNativeTaskProgress(ctx: NativeTaskContext, input: {
  readonly sessionID: string; readonly context: NativeToolContext; readonly bindings: NativeTaskBindings;
  readonly plan: NativeTaskPlan; readonly description: string; readonly fork: boolean; readonly previous?: NativeTaskMetadata;
}): Promise<void> {
  const child = await ctx.session.get({ sessionID: input.sessionID })
  if (child.parentID !== input.context.sessionID) throw new NativeTaskError("parent-mismatch", "Native engine created or selected a child owned by another parent")
  let ownMessagesSince = input.previous?.ownMessagesSince
  if (input.fork && !input.previous) {
    if (ctx.app.capabilities?.sessionMessages !== true || !ctx.session.messages) throw new NativeTaskCapabilityError("sessionMessages for fork boundary")
    const existing = await ctx.session.messages({ sessionID: child.id, order: "desc", limit: 1 })
    ownMessagesSince = existing.data[0]?.id
  }
  const model = input.plan.model
  const settings = model ? {
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(model.top_p === undefined ? {} : { top_p: model.top_p }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
  } : input.previous?.settings
  const metadata = nativeTaskMetadata.parse({ version: 1, parentSessionID: input.context.sessionID, agent: input.plan.agent,
    description: input.description, skills: input.plan.skills, fork: input.previous?.fork ?? input.fork,
    ...(input.plan.category === undefined ? {} : { category: input.plan.category }),
    ...(input.plan.categoryPromptAppend === undefined ? {} : { categoryPromptAppend: input.plan.categoryPromptAppend }),
    ...(input.plan.maxPromptTokens === undefined ? {} : { maxPromptTokens: input.plan.maxPromptTokens }),
    ...(input.plan.fallbackChain === undefined ? {} : { fallbackChain: input.plan.fallbackChain }),
    ...(ownMessagesSince === undefined ? {} : { ownMessagesSince }), ...(settings === undefined ? {} : { settings }) })
  let permissions: PermissionRule[] | undefined
  if (model?.tools) {
    const agent = (await ctx.agent.list({ location: { directory: child.location.directory } })).data.find((entry) => entry.id === input.plan.agent)
    if (!agent) throw new NativeTaskError("missing-agent-policy", "Native task model policy requires the selected agent's native permissions")
    const rules = expandPermissionRules(Object.entries(model.tools).map(([action, enabled]) => ({ action, resource: "*", effect: enabled ? "allow" as const : "deny" as const })), { delegationOwner: "host" })
    permissions = mergeHostPermissionRules(rules, { agent: agent.permissions ?? [], session: child.permissions ?? [] })
  }
  const durableMetadata = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify({ ...child.metadata, [NATIVE_TASK_METADATA_KEY]: metadata })))
  await ctx.session.update({ sessionID: child.id, metadata: durableMetadata,
    ...(permissions === undefined ? {} : { permissions }) })
  if (input.plan.system !== undefined) await ctx.session.instructions.entry.put({ sessionID: child.id, key: "omo-task-policy", value: input.plan.system })
  else if (input.previous) await ctx.session.instructions.entry.remove({ sessionID: child.id, key: "omo-task-policy" })
  input.bindings.managers.modelFallbackControllerAccessor.setSessionFallbackChain(child.id, input.plan.fallbackChain ? [...input.plan.fallbackChain] : undefined)
}

export async function applyNativeTaskSettings(ctx: NativeTaskContext, event: Parameters<Parameters<NativeTaskContext["session"]["hook"]>[1]>[0]): Promise<void> {
  const child = await ctx.session.get({ sessionID: event.sessionID })
  const parsed = nativeTaskMetadata.safeParse(child.metadata?.[NATIVE_TASK_METADATA_KEY])
  if (!parsed.success || parsed.data.parentSessionID !== child.parentID) return
  const settings = parsed.data.settings
  if (!settings) return
  if (settings.temperature !== undefined) event.options.temperature = settings.temperature
  if (settings.top_p !== undefined) event.options.topP = settings.top_p
  if (settings.maxTokens !== undefined) event.options.maxOutputTokens = settings.maxTokens
  if (settings.reasoningEffort !== undefined) event.options.reasoningEffort = settings.reasoningEffort
  if (settings.thinking !== undefined) event.options.thinking = settings.thinking
}

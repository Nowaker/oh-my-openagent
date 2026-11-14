import { resolveModelForDelegateTask } from "@oh-my-opencode/delegate-core"
import type { CategoryConfig } from "../config/schema"
import { canonicalCategoryName } from "@oh-my-opencode/omo-config-core"
import { resolveCategoryConfig } from "../tools/delegate-task/categories"
import { distributeTaskModels } from "../tools/delegate-task/models-distribution"
import { applyCategoryParams } from "../tools/delegate-task/delegated-model-config"
import { applyFallbackEntrySettings } from "../tools/delegate-task/fallback-entry-settings"
import { CATEGORY_PROMPT_APPEND_RESOLVERS } from "../tools/delegate-task/constants"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { parseModelString } from "../shared/model-string-parser"
import { normalizeFallbackModels, flattenToFallbackModelStrings } from "../shared/model-resolver"
import { buildFallbackChainFromModels, findMostSpecificFallbackEntry } from "../shared/fallback-chain-from-models"
import { AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS } from "../shared/model-requirements"
import { lowerReasoningForModel } from "../shared/agent-variant"
import type { NativeTaskContext, NativeTaskBindings, NativeTaskPlan } from "./native-task-types"
import { NativeTaskError } from "./native-task-types"

type NativeAgent = Awaited<ReturnType<NativeTaskContext["agent"]["list"]>>["data"][number]
type ModelConfig = Pick<CategoryConfig, "model" | "models" | "models_distribution" | "fallback_models" | "variant" | "reasoning" | "reasoningEffort" | "temperature" | "top_p" | "maxTokens" | "thinking" | "tools">

function selectModel(input: {
  readonly name: string; readonly config: ModelConfig; readonly inherited?: string; readonly available: Set<string>;
  readonly requirement?: typeof CATEGORY_MODEL_REQUIREMENTS[string]; readonly explicit: boolean;
}): Pick<NativeTaskPlan, "model" | "fallbackChain"> {
  if (!input.config.model && !input.config.models?.length && !input.inherited && !input.requirement) return {}
  const configuredModels = input.config.models
  const models = configuredModels && input.config.models_distribution === "round_robin"
    ? [...distributeTaskModels(input.name, configuredModels, "round_robin")]
    : configuredModels
  const first = models?.[0]
  const configured = (typeof first === "string" ? first : first?.model) ?? (input.explicit ? input.config.model : undefined)
  const fallbacks = normalizeFallbackModels(models?.slice(1) ?? input.config.fallback_models)
  const result = resolveModelForDelegateTask({
    userModel: configured, userFallbackModels: flattenToFallbackModelStrings(fallbacks),
    categoryDefaultModel: input.config.model ?? input.inherited,
    fallbackChain: input.requirement?.fallbackChain, availableModels: input.available,
  }, { connectedProviders: null, hasConnectedProvidersCache: true, hasProviderModelsCache: true })
  if (!result || "skipped" in result) throw new NativeTaskError("model-unavailable", `No available model for ${input.name}`)
  const parsed = parseModelString(result.model)
  if (!parsed) throw new NativeTaskError("invalid-model", `Invalid resolved model for ${input.name}`)
  let model = applyCategoryParams({ ...parsed, variant: input.config.variant ?? result.variant ?? parsed.variant }, input.config)
  const canonical = buildFallbackChainFromModels(models, model.providerID)
  const configuredFallback = buildFallbackChainFromModels(fallbacks, model.providerID)
  const effective = findMostSpecificFallbackEntry(model.providerID, model.modelID, canonical ?? configuredFallback ?? [])
  if (effective && (canonical || result.matchedFallback)) model = applyFallbackEntrySettings({ categoryModel: model, effectiveEntry: effective, variantOverride: input.config.variant })
  if (model.reasoning !== undefined) {
    const lowered = lowerReasoningForModel(model.reasoning, model)
    model = { ...model, variant: lowered.variant, reasoningEffort: lowered.reasoningEffort }
  }
  const index = effective && canonical ? canonical.indexOf(effective) : -1
  return { model, fallbackChain: index >= 0 ? canonical?.slice(index + 1) : configuredFallback ?? (configured ? undefined : input.requirement?.fallbackChain) }
}

export async function resolveNativeTaskModel(ctx: NativeTaskContext, input: {
  readonly bindings: NativeTaskBindings; readonly category?: string; readonly agent: NativeAgent; readonly inherited?: string;
}): Promise<Pick<NativeTaskPlan, "model" | "fallbackChain"> & { readonly category?: string; readonly promptAppend?: string; readonly maxPromptTokens?: number; readonly forceBackground?: boolean }> {
  const available = new Set((await ctx.model.list()).data.filter((model) => model.enabled).map((model) => `${model.providerID}/${model.id}`))
  const config = input.bindings.config
  if (input.category) {
    const category = config.categories?.[input.category] ? input.category : canonicalCategoryName(input.category)
    const nativeDefault = (await ctx.model.default()).data
    const resolved = resolveCategoryConfig(category, { userCategories: config.categories, availableModels: available,
      systemDefaultModel: nativeDefault ? `${nativeDefault.providerID}/${nativeDefault.id}` : undefined })
    if (!resolved) throw new NativeTaskError("category-unavailable", `Category is disabled, unknown or unavailable: ${category}`)
    const override = config.agents?.["sisyphus-junior"]?.model
    const user = config.categories?.[category]
    const selected = selectModel({
      name: `category:${category}`, config: { ...resolved.config, model: user?.model ?? override ?? resolved.config.model },
      available, requirement: CATEGORY_MODEL_REQUIREMENTS[category], explicit: resolved.isUserConfiguredModel || override !== undefined,
    })
    const modelID = selected.model ? `${selected.model.providerID}/${selected.model.modelID}` : undefined
    const dynamic = CATEGORY_PROMPT_APPEND_RESOLVERS[category]
    const promptAppend = dynamic ? [dynamic(modelID), user?.prompt_append].filter(Boolean).join("\n\n") : resolved.promptAppend
    return { ...selected, category, promptAppend, maxPromptTokens: resolved.config.max_prompt_tokens,
      forceBackground: resolved.config.is_unstable_agent ?? (modelID?.includes("gemini") || modelID?.includes("minimax")) }
  }
  const key = getAgentConfigKey(input.agent.id)
  const override = config.agents?.[key]
  const category = override?.category ? config.categories?.[override.category] : undefined
  const inherited = input.agent.model ? `${input.agent.model.providerID}/${input.agent.model.id}` : input.inherited
  const variant = override?.variant ?? category?.variant ?? input.agent.model?.variant
  return selectModel({
    name: `agent:${key}`, config: { ...category, ...override, models: override?.models?.length ? override.models : override?.model ? undefined : category?.models, variant }, inherited,
    available, requirement: AGENT_MODEL_REQUIREMENTS[key], explicit: override?.model !== undefined || override?.models !== undefined || category?.model !== undefined,
  })
}

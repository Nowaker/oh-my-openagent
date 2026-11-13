import { Agent, Model, Provider, type Plugin } from "@opencode/plugin"
import { z } from "zod"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { log } from "../shared/logger"
import { expandPermissionRules } from "./permission-actions"

const effect = z.enum(["allow", "ask", "deny"])
const agentConfig = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  model: z.string().optional(),
  variant: z.string().optional(),
  color: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  prompt: z.string().optional(),
  hidden: z.boolean().optional(),
  disable: z.boolean().optional(),
  permission: z.record(z.string(), z.union([effect, z.record(z.string(), effect)])).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
})

type AgentDraft = Omit<z.infer<typeof agentConfig>, "model"> & {
  readonly id: string
  readonly model: Agent.Info["model"]
  readonly permissions: Agent.Info["permissions"]
}

export function translateAgentConfigToV2Draft(name: string, raw: unknown): AgentDraft | undefined {
  const config = agentConfig.parse(raw)
  if (config.disable) return undefined
  const permissions: { action: string; resource: string; effect: z.infer<typeof effect> }[] = []
  for (const [tool, enabled] of Object.entries(config.tools ?? {})) {
    if (!enabled) permissions.push({ action: tool, resource: "*", effect: "deny" })
  }
  for (const [action, rule] of Object.entries(config.permission ?? {})) {
    const resources = typeof rule === "string" ? { "*": rule } : rule
    for (const [resource, decision] of Object.entries(resources)) {
      permissions.push({ action, resource, effect: decision })
    }
  }
  const slash = config.model?.indexOf("/") ?? -1
  const model = config.model !== undefined && slash > 0
    ? { providerID: Provider.ID.make(config.model.slice(0, slash)), id: Model.ID.make(config.model.slice(slash + 1)), ...(config.variant === undefined ? {} : { variant: Model.VariantID.make(config.variant) }) }
    : undefined
  return { ...config, id: getAgentConfigKey(name), model, permissions: expandPermissionRules(permissions) }
}

export async function registerV1Agents(ctx: Plugin.Context, value: unknown, defaultAgent: unknown): Promise<void> {
  const configs = z.record(z.string(), z.unknown()).parse(value ?? {})
  const drafts = new Map<string, NonNullable<ReturnType<typeof translateAgentConfigToV2Draft>>>()
  const aliases = new Map<string, string>()
  for (const [name, raw] of Object.entries(configs)) {
    if (raw === undefined) continue
    const config = agentConfig.parse(raw)
    if (config.hidden && config.name !== undefined && config.name !== name) aliases.set(config.name, name)
  }
  for (const [name, raw] of Object.entries(configs)) {
    if (raw === undefined) continue
    const draft = translateAgentConfigToV2Draft(aliases.get(name) ?? name, raw)
    if (draft === undefined) continue
    // V1 adds hidden config-key aliases after its display entries. Keep the display entry.
    if (!drafts.has(draft.id)) drafts.set(draft.id, draft)
  }
  await ctx.agent.transform((editor) => {
    for (const draft of drafts.values()) {
      editor.update(draft.id, (agent) => {
        agent.name = Agent.Name.make(draft.name ?? draft.id)
        agent.description = draft.description
        agent.mode = draft.mode ?? "all"
        agent.model = draft.model
        agent.color = draft.color
        agent.hidden = draft.hidden ?? false
        agent.steps = draft.maxSteps ?? draft.steps
        agent.system = draft.prompt
        agent.permissions = draft.permissions.map((rule) => ({ ...rule }))
        if (draft.temperature !== undefined) agent.request.settings.temperature = draft.temperature
        if (draft.top_p !== undefined) agent.request.settings.topP = draft.top_p
      })
    }
    if (typeof defaultAgent === "string") editor.default(aliases.get(defaultAgent) ?? getAgentConfigKey(defaultAgent))
  })
  log("[plugin-v2] agents registered", { names: [...drafts.keys()] })
}

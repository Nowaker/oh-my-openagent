import type { Config, Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { createPluginModule } from "../testing/create-plugin-module"
import { log } from "../shared/logger"
import { bridgeHooks } from "./hook-bridge"
import { registerV1Mcps } from "./mcp-bridge-register"
import { registerV1Tools } from "./tool-bridge-register"
import { registerV1Agents } from "./translate-agent"
import { createV1ClientAdapter } from "./v1-client"
import { buildV1Input } from "./v1-input"

type ProjectedConfig = Config & { default_agent?: string }

async function projectConfig(ctx: Plugin.Context): Promise<ProjectedConfig> {
  const [models, selected] = await Promise.all([ctx.model.list(), ctx.model.default()])
  const provider: NonNullable<Config["provider"]> = {}
  for (const model of models.data) {
    const entry = provider[model.providerID] ?? { models: {} }
    entry.models = {
      ...entry.models,
      [model.id]: { name: model.name, limit: model.limit },
    }
    provider[model.providerID] = entry
  }
  return {
    provider,
    ...(selected.data === null ? {} : { model: `${selected.data.providerID}/${selected.data.id}` }),
  }
}

export async function setupV2Bridge(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const input = buildV1Input(ctx, createV1ClientAdapter(ctx))
  const hooks: Hooks & { dispose?: () => Promise<void> } = await createPluginModule().server(input, {})
  let disposeHooks: (() => Promise<void>) | undefined
  const dispose = async () => {
    const results = await Promise.allSettled([disposeHooks?.(), hooks.dispose?.()])
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, "V2 bridge cleanup failed")
  }
  try {
    const projected = await projectConfig(ctx)
    await hooks.config?.(projected)
    await registerV1Agents(ctx, projected.agent, projected.default_agent)
    const tools = Object.fromEntries(Object.entries(hooks.tool ?? {}).filter(([name]) => projected.tools?.[name] !== false))
    await registerV1Tools(ctx, tools)
    await registerV1Mcps(ctx, projected.mcp)
    disposeHooks = await bridgeHooks(ctx, hooks)
    log("[plugin-v2] bridge ready", { directory: ctx.location.directory, hooks: Object.keys(hooks) })
    return dispose
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "V2 bridge setup and cleanup failed")
    }
    throw error
  }
}

import type { Plugin } from "@opencode/plugin"
import { guardV1Surface, unsupportedV1Call } from "./v1-client-errors"
import { createV1SessionAdapter, type V1SessionContext, type V1SessionAdapter, type V1Envelope } from "./v1-session"

export { UnsupportedV1ClientCallError } from "./v1-client-errors"

export type V1ClientContext = V1SessionContext & Pick<Plugin.Context, "app"> & {
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly model: Pick<Plugin.Context["model"], "list" | "default">
  readonly provider: Pick<Plugin.Context["provider"], "list">
}

type NativeModel = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
type NativeProvider = Awaited<ReturnType<Plugin.Context["provider"]["list"]>>["data"][number]
type NativeAgent = Awaited<ReturnType<Plugin.Context["agent"]["list"]>>["data"][number]
type ProviderInventory = {
  readonly all: readonly (NativeProvider & { readonly models: Record<string, NativeModel> })[]
  readonly connected: readonly string[]
  readonly default: Readonly<Record<string, string>>
}
type ProjectedAgent = Omit<NativeAgent, "model"> & { readonly prompt?: string; readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string } }
export type V1ClientAdapter = {
  readonly session: V1SessionAdapter
  readonly app: { readonly get: () => Promise<V1Envelope<Plugin.Context["app"]>>; readonly agents: () => Promise<V1Envelope<ProjectedAgent[]>> }
  readonly model: { readonly list: () => Promise<V1Envelope<(NativeModel & { readonly provider: string })[]>> }
  readonly provider: { readonly list: () => Promise<V1Envelope<ProviderInventory>> }
  readonly config: { readonly get: () => Promise<never>; readonly providers: () => Promise<V1Envelope<{ readonly providers: ProviderInventory["all"]; readonly default: ProviderInventory["default"] }>> }
  readonly tui: { readonly showToast: () => Promise<never> }
}

export function createV1ClientAdapter(ctx: V1ClientContext): V1ClientAdapter {
  const providerList = async () => {
    const [providers, models, defaultModel] = await Promise.all([ctx.provider.list(), ctx.model.list(), ctx.model.default()])
    const all = providers.data.map((provider) => ({
      ...provider,
      models: Object.fromEntries(models.data.filter((model) => model.providerID === provider.id).map((model) => [model.id, model])),
    }))
    return { data: {
      all,
      connected: providers.data.filter((provider) => models.data.some((model) => model.providerID === provider.id && model.enabled)).map((provider) => provider.id),
      default: defaultModel.data ? { [defaultModel.data.providerID]: defaultModel.data.id } : {},
    } }
  }
  return guardV1Surface({
    session: createV1SessionAdapter(ctx),
    app: guardV1Surface({
      get: async () => ({ data: ctx.app }),
      agents: async () => {
        const agents = await ctx.agent.list()
        return { data: agents.data.map((agent) => ({
          ...agent,
          name: agent.id,
          prompt: agent.system,
          model: agent.model ? { providerID: agent.model.providerID, modelID: agent.model.id, variant: agent.model.variant } : undefined,
        })) }
      },
    }, "app"),
    model: guardV1Surface({
      list: async () => {
        const models = await ctx.model.list()
        return { data: models.data.map((model) => ({ ...model, provider: model.providerID })) }
      },
    }, "model"),
    provider: guardV1Surface({ list: providerList }, "provider"),
    config: guardV1Surface({
      get: async () => unsupportedV1Call("config.get"),
      providers: async () => {
        const result = await providerList()
        return { data: { providers: result.data.all, default: result.data.default } }
      },
    }, "config"),
    tui: guardV1Surface({ showToast: async () => unsupportedV1Call("tui.showToast") }, "tui"),
  }, "")
}

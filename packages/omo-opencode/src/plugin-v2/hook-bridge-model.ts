import type { Model } from "@opencode-ai/sdk"
import type { ProviderContext } from "@opencode-ai/plugin"
import type { BridgeContext } from "./hook-bridge-types"
import { UnsupportedHookMappingError } from "./hook-bridge-types"

type NativeModel = Awaited<ReturnType<BridgeContext["model"]["list"]>>["data"][number]
type NativeProvider = Awaited<ReturnType<BridgeContext["provider"]["list"]>>["data"][number]

export function projectHookModel(model: NativeModel, provider: NativeProvider): Model {
  const modalities = (values: readonly string[]) => ({
    text: values.includes("text"), image: values.includes("image"),
    audio: values.includes("audio"), video: values.includes("video"), pdf: values.includes("pdf"),
  })
  return {
    id: model.id, providerID: model.providerID, name: model.name,
    api: { id: model.modelID, url: "", npm: model.package ?? provider.package },
    capabilities: {
      temperature: model.capabilities.temperature ?? false,
      reasoning: model.compatibility?.requireReasoning ?? false,
      attachment: model.capabilities.input.some((value) => value !== "text"),
      toolcall: model.capabilities.tools,
      input: modalities(model.capabilities.input), output: modalities(model.capabilities.output),
    },
    cost: model.cost.find((tier) => tier.tier === undefined) ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { ...model.limit }, status: model.status,
    options: { ...provider.settings, ...model.settings }, headers: { ...provider.headers, ...model.headers },
  }
}

export async function resolveHookModel(ctx: { readonly model: Pick<BridgeContext["model"], "list">; readonly provider: Pick<BridgeContext["provider"], "list"> }, reference: { readonly providerID: string; readonly id: string }): Promise<{ model: Model; provider: ProviderContext & { id: string } }> {
  const [models, providers] = await Promise.all([ctx.model.list(), ctx.provider.list()])
  const model = models.data.find((entry) => entry.id === reference.id && entry.providerID === reference.providerID)
  const provider = providers.data.find((entry) => entry.id === reference.providerID)
  if (!model || !provider) throw new UnsupportedHookMappingError("request.model-inventory")
  return { model: projectHookModel(model, provider), provider: {
    source: "custom" as const,
    info: { id: provider.id, name: provider.name, source: "custom" as const, env: [], options: { ...provider.settings }, models: {} },
    options: { ...provider.settings }, id: provider.id,
  } }
}

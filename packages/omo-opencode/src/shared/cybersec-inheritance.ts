import type { FallbackEntry } from "./model-requirements"
import { findProviderModelMetadata, readProviderModelsCache } from "./connected-providers-cache"
import { log } from "./logger"

/**
 * A parent running on `anthropic-cybersec/<model>` keeps its subagents there.
 *
 * `anthropic-cybersec` is a provider Vibeterm adds to opencode's config: the
 * Claude models some Meridian account holds Cyber Verification Program access
 * on, each sent with `x-meridian-require: cvp` so Meridian routes it only to
 * such an account. A subagent whose model comes from a category, an agent pin,
 * a `provider` pin or a fallback chain naming plain `anthropic/<model>` would
 * send the same work to any account. So when the parent runs on
 * `anthropic-cybersec`, such a child model moves to `anthropic-cybersec/<model>`
 * if the engine loaded that model under the provider, and stays on
 * `anthropic/<model>`, logged, if it did not (no account has CVP on it).
 *
 * `anthropic-restricted` is the opposite route: the same Claude models sent
 * with `x-meridian-require: restricted`, which Meridian routes only to accounts
 * WITHOUT CVP access, so their allowance is kept for cybersec work. Its
 * children follow the same rule, so a restricted session's subagents never
 * spend a CVP account's allowance through plain `anthropic/<model>`.
 *
 * Vibeterm applies the same rule to the sessions it spawns and prompts
 * (opencode-tools `_lib/cybersec-inheritance`).
 */
export const CYBERSEC_PROVIDER = "anthropic-cybersec"
export const RESTRICTED_PROVIDER = "anthropic-restricted"
const INHERITED_PROVIDERS: ReadonlySet<string> = new Set([CYBERSEC_PROVIDER, RESTRICTED_PROVIDER])
const CYBERSEC_SOURCE_PROVIDER = "anthropic"

type ModelRef = { readonly providerID: string; readonly modelID: string }

export type CybersecListed = (modelID: string) => boolean

/** Whether the parent runs on a provider its anthropic children inherit (`anthropic-cybersec` or `anthropic-restricted`). */
export function isCybersecModel(model: { readonly providerID?: string } | undefined): boolean {
  return model?.providerID !== undefined && INHERITED_PROVIDERS.has(model.providerID)
}

/** Whether the engine loaded `modelID` under `providerID` (the provider-models cache it reported). */
export function isCybersecListed(modelID: string, providerID: string = CYBERSEC_PROVIDER): boolean {
  return findProviderModelMetadata(providerID, modelID, readProviderModelsCache()) !== undefined
}

export interface CybersecContext {
  readonly sessionID: string
  readonly agent?: string
  readonly listed?: CybersecListed
}

/** The child's model, moved from `anthropic` to the parent's provider (cybersec or restricted) when listed there. */
export function inheritCybersecModel<T extends ModelRef>(
  parent: ModelRef | undefined,
  child: T | undefined,
  context: CybersecContext,
): T | undefined {
  if (!child || !parent || !isCybersecModel(parent) || child.providerID !== CYBERSEC_SOURCE_PROVIDER) return child
  const target = parent.providerID
  const listed = context.listed ?? ((modelID: string) => isCybersecListed(modelID, target))
  const fields = { sessionID: context.sessionID, agent: context.agent, model: `${child.providerID}/${child.modelID}` }
  if (!listed(child.modelID)) {
    log(`[cybersec] child kept on anthropic: model not listed under ${target}`, fields)
    return child
  }
  log(`[cybersec] child moved to ${target}`, fields)
  return { ...child, providerID: target }
}

/**
 * The child's fallback chain with `anthropic` replaced by the parent's provider
 * in every entry whose model is listed there. An entry whose model is not
 * listed keeps `anthropic`, logged.
 */
export function inheritCybersecFallbackChain(
  parent: ModelRef | undefined,
  chain: FallbackEntry[] | undefined,
  context: CybersecContext,
): FallbackEntry[] | undefined {
  if (!chain || !parent || !isCybersecModel(parent)) return chain
  const target = parent.providerID
  const listed = context.listed ?? ((modelID: string) => isCybersecListed(modelID, target))
  return chain.map((entry) => {
    if (!entry.providers.includes(CYBERSEC_SOURCE_PROVIDER)) return entry
    if (!listed(entry.model)) {
      log(`[cybersec] fallback entry kept on anthropic: model not listed under ${target}`, {
        sessionID: context.sessionID,
        agent: context.agent,
        model: entry.model,
      })
      return entry
    }
    const providers = entry.providers.map((provider) => (provider === CYBERSEC_SOURCE_PROVIDER ? target : provider))
    return { ...entry, providers: [...new Set(providers)] }
  })
}

import type { Plugin } from "@opencode/plugin"
import { normalizeAgentForPromptKey } from "../shared/agent-display-names"
import { unsupportedV1Call } from "./v1-client-errors"
import { expandPermissionRules } from "./permission-actions"
import type { V1SessionContext } from "./v1-session"
import type { PromptInput } from "./v1-session-prompt"

type NativeSession = Plugin.Context["session"]
export type NativePermissions = NonNullable<Parameters<NativeSession["update"]>[0]["permissions"]>
export type LegacyPermission = { readonly permission: string; readonly pattern: string; readonly action: "allow" | "deny" | "ask" }
export type CreateInput = {
  readonly body?: {
    readonly parentID?: string
    readonly title?: string
    readonly agent?: string
    readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
    readonly variant?: string
    readonly permission?: readonly LegacyPermission[]
  }
  readonly query?: { readonly directory?: string }
}

export function translateSessionPermissions(rules: readonly LegacyPermission[]): NativePermissions {
  return expandPermissionRules(rules.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })))
}

export async function applyPromptAuthority(ctx: V1SessionContext, input: PromptInput, method: string): Promise<void> {
  const body = input.body
  if (!body) return unsupportedV1Call(`${method}.body`)
  const sessionID = input.path.id
  const session = body.tools !== undefined || (body.variant !== undefined && body.model === undefined)
    ? await ctx.session.get({ sessionID }) : undefined
  if (body.variant !== undefined && body.model === undefined && !session?.model) return unsupportedV1Call(`${method}.variant`)
  if (body.tools !== undefined) {
    const previous = session?.permissions ?? []
    const permissions: NativePermissions = [
      ...previous.filter((rule) => rule.effect !== "deny"),
      ...expandPermissionRules(Object.entries(body.tools).map(([action, allowed]) => ({ action, resource: "*", effect: allowed ? "allow" as const : "deny" as const }))),
      ...previous.filter((rule) => rule.effect === "deny"),
    ]
    await ctx.session.update({ sessionID, permissions })
  }
  if (body.system !== undefined) await ctx.session.instructions.entry.put({ sessionID, key: "omo-delegation-system", value: body.system })
  const agent = normalizeAgentForPromptKey(body.agent)
  if (agent !== undefined) await ctx.session.switchAgent({ sessionID, agent })
  const model = body.model ? {
    id: body.model.modelID, providerID: body.model.providerID, variant: body.variant,
  } : body.variant !== undefined && session?.model ? { ...session.model, variant: body.variant } : undefined
  if (model !== undefined) await ctx.session.switchModel({ sessionID, model })
}

export async function createDelegatedSession(ctx: V1SessionContext, input?: CreateInput): Promise<Awaited<ReturnType<NativeSession["create"]>>> {
  const body = input?.body
  if (body?.variant !== undefined && body.model === undefined) return unsupportedV1Call("session.create.variant")
  return ctx.session.create({
    parentID: body?.parentID, title: body?.title, agent: normalizeAgentForPromptKey(body?.agent),
    model: body?.model ? { id: body.model.id, providerID: body.model.providerID, variant: body.variant ?? body.model.variant } : undefined,
    permissions: body?.permission === undefined ? undefined : translateSessionPermissions(body.permission),
    location: { directory: input?.query?.directory ?? ctx.location.directory },
  })
}

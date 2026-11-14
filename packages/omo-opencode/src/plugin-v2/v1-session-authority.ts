import type { Plugin } from "@opencode/plugin"
import { normalizeAgentForPromptKey } from "../shared/agent-display-names"
import { unsupportedV1Call } from "./v1-client-errors"
import { expandPermissionRules, type DelegationOptions } from "./permission-actions"
import { mergeHostPermissionRules } from "./host-permissions"
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

export function translateSessionPermissions(rules: readonly LegacyPermission[], options: DelegationOptions = {}): NativePermissions {
  return expandPermissionRules(rules.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })), options)
}

export async function applyPromptAuthority(ctx: V1SessionContext, input: PromptInput, options: DelegationOptions & { readonly method: string }): Promise<void> {
  const { method } = options
  const body = input.body
  if (!body) return unsupportedV1Call(`${method}.body`)
  const sessionID = input.path.id
  const session = body.tools !== undefined || (body.variant !== undefined && body.model === undefined)
    ? await ctx.session.get({ sessionID }) : undefined
  if (body.variant !== undefined && body.model === undefined && !session?.model) return unsupportedV1Call(`${method}.variant`)
  if (body.tools !== undefined) {
    const previous = session?.permissions ?? []
    const projected = expandPermissionRules(Object.entries(body.tools).map(([action, allowed]) => ({ action, resource: "*", effect: allowed ? "allow" as const : "deny" as const })), options)
    const agent = options.delegationOwner === "host"
      ? (await ctx.agent.list({ location: { directory: session?.location.directory ?? ctx.location.directory } })).data.find((entry) => entry.id === normalizeAgentForPromptKey(body.agent ?? session?.agent)) : undefined
    if (options.delegationOwner === "host" && !agent) return unsupportedV1Call(`${method}.agent-permissions`)
    const permissions: NativePermissions = options.delegationOwner === "host" ? mergeHostPermissionRules(projected, { agent: agent?.permissions ?? [], session: previous }) : [
      ...previous.filter((rule) => rule.effect !== "deny"),
      ...projected,
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

export async function createDelegatedSession(ctx: V1SessionContext, input?: CreateInput, options: DelegationOptions = {}): Promise<Awaited<ReturnType<NativeSession["create"]>>> {
  const body = input?.body
  if (body?.variant !== undefined && body.model === undefined) return unsupportedV1Call("session.create.variant")
  const session = await ctx.session.create({
    parentID: body?.parentID, title: body?.title, agent: normalizeAgentForPromptKey(body?.agent),
    model: body?.model ? { id: body.model.id, providerID: body.model.providerID, variant: body.variant ?? body.model.variant } : undefined,
    permissions: body?.permission === undefined ? undefined : translateSessionPermissions(body.permission, options),
    location: { directory: input?.query?.directory ?? ctx.location.directory },
  })
  if (options.delegationOwner !== "host" || body?.permission === undefined) return session
  const agent = (await ctx.agent.list({ location: { directory: session.location.directory } })).data.find((entry) => entry.id === normalizeAgentForPromptKey(session.agent))
  if (!agent) return unsupportedV1Call("session.create.agent-permissions")
  const permissions = mergeHostPermissionRules(translateSessionPermissions(body.permission, options), { agent: agent.permissions ?? [], session: [] })
  await ctx.session.update({ sessionID: session.id, permissions })
  return { ...session, permissions }
}

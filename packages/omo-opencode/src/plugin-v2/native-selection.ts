import type { Plugin } from "@opencode/plugin"
import { UnsupportedHookMappingError } from "./hook-bridge-types"

type NativeSession = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
export type NativeSelection = { readonly agent: NonNullable<NativeSession["agent"]>; readonly model: NonNullable<NativeSession["model"]> }
export type NativeSelectionContext = {
  readonly app?: Plugin.Context["app"] & { readonly capabilities?: { readonly sessionSelection?: boolean } }
  readonly session: Pick<Plugin.Context["session"], "get"> & {
    readonly selection?: (input: { readonly sessionID: string }) => Promise<NativeSelection>
  }
}

export async function resolveNativeSelection(ctx: NativeSelectionContext, sessionID: string): Promise<NativeSelection> {
  if (ctx.app?.capabilities?.sessionSelection === true) {
    if (!ctx.session.selection) throw new UnsupportedHookMappingError("prompt.session-selection.api")
    return ctx.session.selection({ sessionID })
  }
  const session = await ctx.session.get({ sessionID })
  if (session.agent && session.model) return { agent: session.agent, model: session.model }
  throw new UnsupportedHookMappingError("prompt.session-selection.capability")
}

import type { PluginInput } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import type { V1ClientAdapter } from "./v1-client"
import { unsupportedV1Call } from "./v1-client-errors"

export type V2Context = Plugin.Context
export type V1BridgeInput = {
  readonly client: V1ClientAdapter
  readonly project: V2Context["location"]["project"] & { readonly worktree: string }
  readonly directory: string
  readonly worktree: string
  readonly experimental_workspace: { readonly register: () => never }
  readonly serverUrl: undefined
  readonly $: PluginInput["$"]
}

export function v2LocationDirectory(ctx: Pick<V2Context, "location">): string {
  return ctx.location.directory
}

export function projectV1Input(ctx: Pick<V2Context, "location">, client: V1ClientAdapter): V1BridgeInput {
  return {
    client,
    project: {
      ...ctx.location.project,
      worktree: ctx.location.project.canonical,
    },
    directory: ctx.location.directory,
    worktree: ctx.location.project.canonical,
    experimental_workspace: {
      register: () => unsupportedV1Call("experimental_workspace.register"),
    },
    serverUrl: undefined,
    $: typeof Bun === "undefined" ? unsupportedV1Call("$.bun") : Bun.$,
  }
}

export function buildV1Input(ctx: V2Context, client: V1ClientAdapter): PluginInput {
  // The v1 SDK requires its complete HTTP client, server URL and project timestamps.
  // V2 has only the typed facade and real location data. Keep absent data absent;
  // unsupported calls fail through the facade instead of fabricating values.
  const input: object = projectV1Input(ctx, client)
  return input as PluginInput
}

import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { OhMyOpenCodeConfigSchema } from "../config/schema/oh-my-opencode-config"
import { createManagers } from "../create-managers"
import { BackgroundManager } from "../features/background-agent"
import { TmuxSessionManager } from "../features/tmux-subagent"
import { createModelCacheState } from "../plugin-state"

export class LegacyConstructorCalledError extends Error {}

export class UnavailableBackgroundManager extends BackgroundManager {
  constructor(..._args: ConstructorParameters<typeof BackgroundManager>) {
    super((() => { throw new LegacyConstructorCalledError("Legacy background constructor called") })())
  }
}

export function createHostDelegationFixture(): {
  readonly ctx: PluginInput
  readonly args: Parameters<typeof createManagers>[0]
  readonly cleanup: string[]
  readonly registrations: { readonly shutdown: () => void | Promise<void> }[]
  readonly unregistered: { readonly shutdown: () => void | Promise<void> }[]
} {
  const directory = process.env.HOME ?? process.cwd()
  const ctx: PluginInput = {
    client: createOpencodeClient({ baseUrl: "http://127.0.0.1:1" }),
    project: { id: "host-delegation", worktree: directory, time: { created: 1 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => { throw new Error("Workspace registration is outside this fixture") } },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: Bun.$,
  }
  const cleanup: string[] = []
  const registrations: { readonly shutdown: () => void | Promise<void> }[] = []
  const unregistered: { readonly shutdown: () => void | Promise<void> }[] = []
  class TrackedTmuxSessionManager extends TmuxSessionManager {
    override async cleanup(): Promise<void> {
      cleanup.push("tmux")
      await super.cleanup()
    }
  }
  const args = {
    ctx,
    pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
    tmuxConfig: { enabled: false, layout: "main-vertical", main_pane_size: 60, main_pane_min_width: 120, agent_pane_min_width: 40, isolation: "inline" } as const,
    modelCacheState: createModelCacheState(),
    backgroundNotificationHookEnabled: true,
    deps: {
      BackgroundManagerClass: UnavailableBackgroundManager,
      TmuxSessionManagerClass: TrackedTmuxSessionManager,
      subscribeSkillDiagnosticsFn: () => () => { cleanup.push("diagnostics") },
      registerManagerForCleanupFn: (manager: { readonly shutdown: () => void | Promise<void> }) => { registrations.push(manager) },
      unregisterManagerForCleanupFn: (manager: { readonly shutdown: () => void | Promise<void> }) => { unregistered.push(manager) },
    },
  } satisfies Parameters<typeof createManagers>[0]
  return { ctx, args, cleanup, registrations, unregistered }
}

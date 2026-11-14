import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import type { HookName } from "../config"
import { UnsupportedHostDelegationError } from "../create-managers"
import { ensureTuiPluginEntry } from "../cli/config-manager/add-tui-plugin-to-tui-config"
import { selectRuntimeSecuritySkills } from "../features/opencode-runtime-skills"
import { createPluginDispose } from "../plugin-dispose"
import {
  createCompactionAutocontinueHandler,
  createSessionCompactingHandler,
  type CompactionAutocontinueHook,
} from "../plugin/session-compacting"
import { registerContinuationConsumer } from "../features/run-continuation-state/loaded-consumer"
import { defaultPluginModuleDeps, type PluginModuleDeps } from "./plugin-module-dependencies"

export type { PluginModuleDeps } from "./plugin-module-dependencies"

type StartupToastClient = {
  readonly tui?: {
    readonly showToast?: (input: { readonly body: Record<string, unknown> }) => Promise<unknown>
  }
}

type HooksWithRuntimeLifecycle = Hooks & {
  "experimental.compaction.autocontinue"?: CompactionAutocontinueHook
  dispose?: () => Promise<void>
}

function showStartupToast(
  client: unknown,
  body: Record<string, unknown>,
  onFailure: (message: string, context: Record<string, unknown>) => void,
): void {
  const tui = (client as StartupToastClient).tui
  if (tui?.showToast === undefined) return
  void tui.showToast({ body }).catch((error: unknown) => {
    onFailure("[config-migration] startup toast failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

function startupToastBody(input: {
  readonly diagnostics: readonly string[]
  readonly error?: string
  readonly migratedFrom: readonly string[]
  readonly skippedConflictCount: number
  readonly targetBackupPaths: readonly string[]
}): Record<string, unknown> | undefined {
  const summary = input.migratedFrom.length === 0
    ? ""
    : `Migrated ${input.migratedFrom.length} legacy source${input.migratedFrom.length === 1 ? "" : "s"}.`
  const conflicts = input.skippedConflictCount === 0
    ? ""
    : ` Kept ${input.skippedConflictCount} existing value${input.skippedConflictCount === 1 ? "" : "s"}.`
  const diagnostics = input.diagnostics.length === 0 ? "" : ` ${input.diagnostics.join(" ")}`
  const backups = input.targetBackupPaths.length === 0 ? "" : ` Previous config saved as ${input.targetBackupPaths.join(", ")}.`
  if (input.error !== undefined) {
    return { title: "Configuration migration failed", message: `${input.error}${backups}${diagnostics}`, variant: "error" }
  }
  if (summary.length > 0 || backups.length > 0) return { title: "Configuration migrated", message: `${summary}${conflicts}${backups}${diagnostics}`.trim(), variant: "success" }
  if (diagnostics.length > 0) return { title: "Configuration diagnostics", message: input.diagnostics.join(" "), variant: "warning" }
  return undefined
}

export function createPluginModule(
  overrides: Partial<PluginModuleDeps> = {},
  runtimeOptions: { readonly delegationOwner?: "plugin" | "host" } = { delegationOwner: "plugin" },
): PluginModule {
  const deps = { ...defaultPluginModuleDeps, ...overrides }
  let startupMigration: ReturnType<PluginModuleDeps["runOpenCodeStartupMigration"]> | undefined
  const serverPlugin: Plugin = async (input, _options): Promise<Hooks> => {
    deps.installAgentSortShim()
    deps.initConfigContext("opencode", null)
    deps.log("[oh-my-openagent] ENTRY - plugin loading", {
      directory: input.directory,
    })
    deps.logLegacyPluginStartupWarning()
    deps.migrateLegacyWorkspaceDirectory(input.directory)
    startupMigration ??= deps.runOpenCodeStartupMigration({ cwd: input.directory })
    const startupValidation = deps.loadConfigChain(input.directory)
    const startupDiagnostics = startupValidation.valid ? [] : startupValidation.messages
    deps.log("[config-migration] startup completed", {
      error: startupMigration.error,
      journalResumed: startupMigration.journalResumed,
      migratedFrom: startupMigration.migratedFrom,
      skippedConflictCount: startupMigration.skippedConflictCount,
      targetBackupPaths: startupMigration.targetBackupPaths,
    })
    if (startupMigration.error !== undefined) {
      console.warn(`[config-migration] legacy configuration changes were not applied: ${startupMigration.error}`)
    }
    const toast = startupToastBody({
      diagnostics: startupDiagnostics,
      ...(startupMigration.error === undefined ? {} : { error: startupMigration.error }),
      migratedFrom: startupMigration.migratedFrom,
      skippedConflictCount: startupMigration.skippedConflictCount,
      targetBackupPaths: startupMigration.targetBackupPaths,
    })
    if (toast !== undefined) showStartupToast(input.client, toast, deps.log)

    // Unconditional omo process hygiene (T16): fire-and-forget family sweep,
    // throttled per-family inside the sweep functions. Never awaited and
    // never allowed to reject into startup.
    try {
      void deps
        .startOmoProcessSweep()
        .catch((error: unknown) => {
          deps.log("[oh-my-openagent] omo process sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
    } catch (error) {
      deps.log("[oh-my-openagent] omo process sweep failed to start", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    const duplicateOmoPluginCheck = deps.detectDuplicateOmoPlugin(input.directory)
    if (duplicateOmoPluginCheck.detected) {
      console.warn(deps.getDuplicateOmoPluginWarning(duplicateOmoPluginCheck.duplicatePlugins))
      return {}
    }

    const skillPluginCheck = deps.detectExternalSkillPlugin(input.directory)
    if (skillPluginCheck.detected && skillPluginCheck.pluginName) {
      console.warn(deps.getSkillPluginConflictWarning(skillPluginCheck.pluginName))
    }

    deps.injectServerAuthIntoClient(input.client)

    const pluginConfig = startupValidation.config
    if (runtimeOptions.delegationOwner === "host" && pluginConfig.team_mode?.enabled) throw new UnsupportedHostDelegationError()
    try {
      deps.recordPluginTelemetry({ configEnabled: pluginConfig.telemetry })
    } catch (error) {
      deps.log("[posthog] plugin telemetry failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      ensureTuiPluginEntry()
    } catch (error) {
      deps.log("[tui] tui.json self-heal failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    deps.initLiveServerRoute({ serverUrl: input.serverUrl, directory: input.directory, inProcessClient: input.client })
    deps.setLiveParentWakeRoutingDisabled(pluginConfig.experimental?.disable_live_parent_wake_routing === true)
    deps.warmLiveServerProbe()
    const runtimeSecuritySkills = selectRuntimeSecuritySkills(pluginConfig)
    let runtimeSkillSource: Awaited<ReturnType<PluginModuleDeps["createRuntimeSkillSourceServer"]>> | undefined
    if (runtimeSecuritySkills.length > 0) {
      try {
        runtimeSkillSource = await deps.createRuntimeSkillSourceServer({ skills: runtimeSecuritySkills })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[runtime-skills] bundled security skill source unavailable; continuing without config.skills.urls: ${detail}`)
      }
    }
    deps.initI18n(pluginConfig.i18n?.locale ? { locale: pluginConfig.i18n.locale } : undefined)
    deps.setAgentSortOrder(pluginConfig.agent_order)

    if (pluginConfig.openclaw) {
      await deps.initializeOpenClaw(pluginConfig.openclaw)
    }
    if (pluginConfig.team_mode?.enabled) {
      const teamModeConfig = pluginConfig.team_mode
      try {
        const { ensureBaseDirs, resolveBaseDir } = await import("../features/team-mode/team-registry/paths")
        const { checkTeamModeDependencies } = await import("../features/team-mode/deps")
        await checkTeamModeDependencies(teamModeConfig)
        await ensureBaseDirs(resolveBaseDir(teamModeConfig))
        if (pluginConfig.disabled_skills?.includes("team-mode")) {
          console.warn(
            "[team-mode] enabled=true but team-mode skill is disabled; skill docs hidden but tools still registered (D-29)",
          )
        }
      } catch (error) {
        if (error instanceof Error) {
          console.warn("[team-mode] init failed:", error)
        } else {
          console.warn("[team-mode] init failed:", String(error))
        }
      }
    }
    const tmuxIntegrationEnabled = deps.isTmuxIntegrationEnabled(pluginConfig)
    if (tmuxIntegrationEnabled) {
      deps.startTmuxCheck()
    }
    const disabledHooks = new Set(pluginConfig.disabled_hooks ?? [])

    const isHookEnabled = (hookName: HookName): boolean => !disabledHooks.has(hookName)
    const safeHookEnabled = pluginConfig.experimental?.safe_hook_creation ?? true

    const firstMessageVariantGate = deps.createFirstMessageVariantGate()

    const tmuxConfig = deps.createRuntimeTmuxConfig(pluginConfig)

    const modelCacheState = deps.createModelCacheState()

    const managers = deps.createManagers({
      ctx: input,
      pluginConfig,
      tmuxConfig,
      modelCacheState,
      backgroundNotificationHookEnabled: isHookEnabled("background-notification"),
      delegationOwner: runtimeOptions.delegationOwner ?? "plugin",
      runtimeSkillSourceUrl: runtimeSkillSource?.url,
    })

    const toolsResult = await deps.createTools({
      ctx: input,
      pluginConfig,
      managers,
    })

    const hooks = deps.createHooks({
      ctx: input,
      pluginConfig,
      modelCacheState,
      backgroundManager: managers.backgroundManager,
      modelFallbackControllerAccessor: managers.modelFallbackControllerAccessor,
      monitorManager: managers.monitorManager,
      isHookEnabled,
      safeHookEnabled,
      mergedSkills: toolsResult.mergedSkills,
      availableSkills: toolsResult.availableSkills,
    })

    const pluginInterface = deps.createPluginInterface({
      ctx: input,
      pluginConfig,
      firstMessageVariantGate,
      managers,
      hooks,
      tools: toolsResult.filteredTools,
    })

    const dispose = createPluginDispose({
      backgroundManager: managers.backgroundManager,
      shutdownManagers: managers.shutdown,
      skillMcpManager: managers.skillMcpManager,
      tuiStateMirror: managers.tuiStateMirror,
      runningJobsLedger: managers.runningJobsLedger,
      disposeHooks: hooks.disposeHooks,
    })

    const pluginHooks: HooksWithRuntimeLifecycle = {
      ...pluginInterface,

      "experimental.session.compacting": createSessionCompactingHandler(hooks),

      "experimental.compaction.autocontinue": createCompactionAutocontinueHandler(hooks),

      dispose: async (): Promise<void> => {
        unregisterContinuationConsumer()
        runtimeSkillSource?.stop()
        await dispose()
      },
    }

    const unregisterContinuationConsumer = registerContinuationConsumer(input.client)
    return pluginHooks
  }

  return {
    id: "oh-my-openagent",
    server: serverPlugin,
  }
}

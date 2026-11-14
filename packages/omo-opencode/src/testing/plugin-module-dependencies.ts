import { validatePluginConfig } from "../config/validate"
import { initConfigContext } from "../cli/config-manager/config-context"
import { createHooks } from "../create-hooks"
import { createManagers } from "../create-managers"
import { createRuntimeTmuxConfig, isTmuxIntegrationEnabled } from "../create-runtime-tmux-config"
import { createTools } from "../create-tools"
import { createRuntimeSkillSourceServer } from "../features/opencode-runtime-skills"
import { initializeOpenClaw } from "../openclaw"
import { createPluginInterface } from "../plugin-interface"
import { loadPluginConfig } from "../plugin-config"
import { createModelCacheState } from "../plugin-state"
import { installAgentSortShim, setAgentSortOrder } from "../shared/agent-sort-shim"
import {
  detectDuplicateOmoPlugin,
  detectExternalSkillPlugin,
  getDuplicateOmoPluginWarning,
  getSkillPluginConflictWarning,
} from "../shared/external-plugin-detector"
import { createFirstMessageVariantGate } from "../shared/first-message-variant"
import { initI18n } from "../shared/i18n"
import { log } from "../shared/logger"
import { logLegacyPluginStartupWarning } from "../shared/log-legacy-plugin-startup-warning"
import { migrateLegacyWorkspaceDirectory } from "../shared/legacy-workspace-migration"
import { sweepOmoFamiliesBestEffort } from "../shared/omo-process-sweep"
import { injectServerAuthIntoClient } from "../shared/opencode-server-auth"
import { recordPluginTelemetry } from "../shared/posthog"
import {
  initLiveServerRoute,
  setLiveParentWakeRoutingDisabled,
  warmLiveServerProbe,
} from "../shared/live-server-route"
import { startBackgroundCheck as startTmuxCheck } from "../tools/interactive-bash"
import { runOpenCodeStartupMigration } from "../startup-migration"

export type PluginModuleDeps = {
  readonly initConfigContext: typeof initConfigContext
  readonly installAgentSortShim: typeof installAgentSortShim
  readonly setAgentSortOrder: typeof setAgentSortOrder
  readonly log: typeof log
  readonly logLegacyPluginStartupWarning: typeof logLegacyPluginStartupWarning
  readonly migrateLegacyWorkspaceDirectory: typeof migrateLegacyWorkspaceDirectory
  readonly runOpenCodeStartupMigration: typeof runOpenCodeStartupMigration
  readonly startOmoProcessSweep: () => Promise<void>
  readonly detectDuplicateOmoPlugin: typeof detectDuplicateOmoPlugin
  readonly getDuplicateOmoPluginWarning: typeof getDuplicateOmoPluginWarning
  readonly detectExternalSkillPlugin: typeof detectExternalSkillPlugin
  readonly getSkillPluginConflictWarning: typeof getSkillPluginConflictWarning
  readonly injectServerAuthIntoClient: typeof injectServerAuthIntoClient
  readonly initLiveServerRoute: typeof initLiveServerRoute
  readonly setLiveParentWakeRoutingDisabled: typeof setLiveParentWakeRoutingDisabled
  readonly warmLiveServerProbe: typeof warmLiveServerProbe
  readonly loadConfigChain: typeof validatePluginConfig
  readonly loadPluginConfig: typeof loadPluginConfig
  readonly recordPluginTelemetry: typeof recordPluginTelemetry
  readonly initI18n: typeof initI18n
  readonly initializeOpenClaw: typeof initializeOpenClaw
  readonly isTmuxIntegrationEnabled: typeof isTmuxIntegrationEnabled
  readonly startTmuxCheck: typeof startTmuxCheck
  readonly createFirstMessageVariantGate: typeof createFirstMessageVariantGate
  readonly createRuntimeTmuxConfig: typeof createRuntimeTmuxConfig
  readonly createModelCacheState: typeof createModelCacheState
  readonly createManagers: typeof createManagers
  readonly createTools: typeof createTools
  readonly createRuntimeSkillSourceServer: typeof createRuntimeSkillSourceServer
  readonly createHooks: typeof createHooks
  readonly createPluginInterface: typeof createPluginInterface
}

export const defaultPluginModuleDeps: PluginModuleDeps = {
  initConfigContext,
  installAgentSortShim,
  setAgentSortOrder,
  log,
  logLegacyPluginStartupWarning,
  migrateLegacyWorkspaceDirectory,
  runOpenCodeStartupMigration,
  startOmoProcessSweep: () => sweepOmoFamiliesBestEffort({ log }),
  detectDuplicateOmoPlugin,
  getDuplicateOmoPluginWarning,
  detectExternalSkillPlugin,
  getSkillPluginConflictWarning,
  injectServerAuthIntoClient,
  initLiveServerRoute,
  setLiveParentWakeRoutingDisabled,
  warmLiveServerProbe,
  loadConfigChain: validatePluginConfig,
  loadPluginConfig,
  recordPluginTelemetry,
  initI18n,
  initializeOpenClaw,
  isTmuxIntegrationEnabled,
  startTmuxCheck,
  createFirstMessageVariantGate,
  createRuntimeTmuxConfig,
  createModelCacheState,
  createManagers,
  createTools,
  createRuntimeSkillSourceServer,
  createHooks,
  createPluginInterface,
}

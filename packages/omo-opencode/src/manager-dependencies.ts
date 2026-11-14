import { BackgroundManager } from "./features/background-agent"
import { registerManagerForCleanup, unregisterManagerForCleanup } from "./features/background-agent/process-cleanup"
import { createMonitorManager } from "./features/monitor"
import { SkillMcpManager } from "./features/skill-mcp-manager"
import { initTaskToastManager } from "./features/task-toast-manager"
import { cleanupSessionTeamRuns } from "./features/team-mode/team-runtime/session-cleanup"
import { TmuxSessionManager } from "./features/tmux-subagent"
import { TuiStateMirror } from "./features/tui-sidebar/mirror-manager"
import { createConfigHandler } from "./plugin-handlers"
import { markServerRunningInProcess } from "./shared/tmux/tmux-utils/server-health"
import { subscribeSkillDiagnostics } from "@oh-my-opencode/skills-loader-core/opencode-skill-loader"

export type CreateManagersDeps = {
  readonly BackgroundManagerClass: typeof BackgroundManager
  readonly SkillMcpManagerClass: typeof SkillMcpManager
  readonly TmuxSessionManagerClass: typeof TmuxSessionManager
  readonly TuiStateMirrorClass: typeof TuiStateMirror
  readonly createMonitorManagerFn: typeof createMonitorManager
  readonly initTaskToastManagerFn: typeof initTaskToastManager
  readonly registerManagerForCleanupFn: typeof registerManagerForCleanup
  readonly unregisterManagerForCleanupFn: typeof unregisterManagerForCleanup
  readonly cleanupSessionTeamRunsFn: typeof cleanupSessionTeamRuns
  readonly createConfigHandlerFn: typeof createConfigHandler
  readonly markServerRunningInProcessFn: typeof markServerRunningInProcess
  readonly subscribeSkillDiagnosticsFn: typeof subscribeSkillDiagnostics
}

export const defaultCreateManagersDeps: CreateManagersDeps = {
  BackgroundManagerClass: BackgroundManager,
  SkillMcpManagerClass: SkillMcpManager,
  TmuxSessionManagerClass: TmuxSessionManager,
  TuiStateMirrorClass: TuiStateMirror,
  createMonitorManagerFn: createMonitorManager,
  initTaskToastManagerFn: initTaskToastManager,
  registerManagerForCleanupFn: registerManagerForCleanup,
  unregisterManagerForCleanupFn: unregisterManagerForCleanup,
  cleanupSessionTeamRunsFn: cleanupSessionTeamRuns,
  createConfigHandlerFn: createConfigHandler,
  markServerRunningInProcessFn: markServerRunningInProcess,
  subscribeSkillDiagnosticsFn: subscribeSkillDiagnostics,
}

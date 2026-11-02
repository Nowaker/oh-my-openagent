import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { releaseDelegatedSessionRuntime } from "../../shared/delegated-session-runtime"
import { log } from "../../shared/logger"

const pendingCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function cancelSyncSessionCleanup(sessionID: string): void {
  const timer = pendingCleanupTimers.get(sessionID)
  if (!timer) return
  clearTimeout(timer)
  pendingCleanupTimers.delete(sessionID)
}

export function scheduleSyncSessionCleanup(
  sessionID: string,
  delayMs = TASK_CLEANUP_DELAY_MS,
  retire: (sessionID: string) => void | Promise<void> = releaseDelegatedSessionRuntime,
): void {
  cancelSyncSessionCleanup(sessionID)
  const timer = setTimeout(async () => {
    pendingCleanupTimers.delete(sessionID)
    handedBackSyncSessions.delete(sessionID)
    try {
      await retire(sessionID)
    } catch (error: unknown) {
      log("[task] Failed to retire sync session runtime:", { sessionID, error: String(error) })
    }
  }, delayMs)
  pendingCleanupTimers.set(sessionID, timer)
  timer.unref()
}

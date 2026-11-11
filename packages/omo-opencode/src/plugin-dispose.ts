import { log } from "./shared"

export type PluginDispose = () => Promise<void>

export function createPluginDispose(args: {
  backgroundManager: {
    shutdown: () => void | Promise<void>
  }
  skillMcpManager: {
    disconnectAll: () => Promise<void>
  }
  tuiStateMirror?: {
    stop: () => void
  }
  runningJobsLedger?: {
    shutdown: () => void
  }
  disposeHooks: () => void
}): PluginDispose {
  const { backgroundManager, skillMcpManager, tuiStateMirror, runningJobsLedger, disposeHooks } = args
  let disposePromise: Promise<void> | null = null

  return async (): Promise<void> => {
    if (disposePromise) {
      await disposePromise
      return
    }

    disposePromise = (async (): Promise<void> => {
      // Frozen first: the managers below stop the jobs, which must stay recorded for the next process to report lost.
      try {
        runningJobsLedger?.shutdown()
      } catch (error) {
        log("[plugin-dispose] runningJobsLedger.shutdown() error:", error)
      }
      try {
        tuiStateMirror?.stop()
      } catch (error) {
        log("[plugin-dispose] tuiStateMirror.stop() error:", error)
      }
      try {
        await backgroundManager.shutdown()
      } catch (error) {
        log("[plugin-dispose] backgroundManager.shutdown() error:", error)
      }
      try {
        await skillMcpManager.disconnectAll()
      } catch (error) {
        log("[plugin-dispose] skillMcpManager.disconnectAll() error:", error)
      }
      try {
        disposeHooks()
      } catch (error) {
        log("[plugin-dispose] disposeHooks() error:", error)
      }
    })()

    await disposePromise
  }
}

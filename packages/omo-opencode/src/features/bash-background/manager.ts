import { log } from "../../shared/logger"
import { formatBashExitNotice } from "./envelope"
import type { BashBackgroundExited, BashBackgroundRecord, BashBackgroundStarted } from "./types"

export const BASH_BACKGROUND_STARTED_EVENT = "shell.background.started"
export const BASH_BACKGROUND_EXITED_EVENT = "shell.background.exited"

export type BashBackgroundManagerDeps = {
  /** Delivers one exit notice to the session that started the command. */
  readonly notify: (sessionID: string, notice: string) => Promise<void>
  /** Stops a running background job; true when one was stopped. */
  readonly cancelJob: (id: string) => Promise<boolean>
  readonly now?: () => number
}

type PluginEvent = { type: string; properties?: unknown }

/**
 * Tracks the bash commands the opencode fork runs in the background (`bash run_in_background`, or a foreground command
 * moved there at its timeout) and turns each exit into a notice for the session that started it.
 */
export class BashBackgroundManager {
  private readonly running = new Map<string, BashBackgroundRecord>()
  /** Commands stopped through background_cancel: the tool result already reports it, so the exit sends no notice. */
  private readonly silenced = new Set<string>()

  constructor(private readonly deps: BashBackgroundManagerDeps) {}

  async handleEvent(event: PluginEvent): Promise<void> {
    if (event.type === BASH_BACKGROUND_STARTED_EVENT) {
      const started = event.properties as BashBackgroundStarted
      this.running.set(started.id, { ...started, startedAt: (this.deps.now ?? Date.now)() })
      return
    }
    if (event.type !== BASH_BACKGROUND_EXITED_EVENT) return
    const exited = event.properties as BashBackgroundExited
    this.running.delete(exited.id)
    if (this.silenced.delete(exited.id)) return
    try {
      await this.deps.notify(exited.sessionID, formatBashExitNotice(exited))
    } catch (error) {
      log("[bash-background] Failed to deliver an exit notice:", { id: exited.id, error: String(error) })
    }
  }

  get(id: string): BashBackgroundRecord | undefined {
    return this.running.get(id)
  }

  /** The session's background commands that are still running, oldest first. */
  list(sessionID: string): BashBackgroundRecord[] {
    return [...this.running.values()].filter((record) => record.sessionID === sessionID)
  }

  async stop(id: string): Promise<boolean> {
    this.silenced.add(id)
    const stopped = await this.deps.cancelJob(id).catch((error: unknown) => {
      this.silenced.delete(id)
      throw error
    })
    if (!stopped) this.silenced.delete(id)
    this.running.delete(id)
    return stopped
  }

  forgetSession(sessionID: string): void {
    for (const record of this.list(sessionID)) this.running.delete(record.id)
  }
}

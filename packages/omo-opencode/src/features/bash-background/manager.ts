import { log } from "../../shared/logger"
import type { BashBackgroundExited, BashBackgroundRecord, BashBackgroundStarted } from "./types"

export const BASH_BACKGROUND_STARTED_EVENT = "shell.background.started"
export const BASH_BACKGROUND_EXITED_EVENT = "shell.background.exited"
/**
 * The bash tool stops a background command at its timeout, so a record older than that plus this margin missed its
 * exit event and no longer runs.
 */
export const BASH_BACKGROUND_EXPIRY_MARGIN_MS = 5 * 60_000
/** How many exits without a known start are remembered, oldest dropped first. */
const EXITED_UNSEEN_LIMIT = 1_000

export type BashBackgroundManagerDeps = {
  /** Stops a running background job; true when one was stopped. */
  readonly cancelJob: (id: string) => Promise<boolean>
  readonly now?: () => number
}

type PluginEvent = { type: string; properties?: unknown }

/**
 * Tracks the bash commands the opencode fork runs in the background (`bash run_in_background`, or a foreground command
 * moved there at its timeout), so `background_cancel` can stop one and the running-jobs ledger can list them. The exit
 * notice itself comes from the host's plugin (Vibeterm's opencode-vibeterm-spawn-plugin), not from OMO.
 */
export class BashBackgroundManager {
  private readonly running = new Map<string, BashBackgroundRecord>()
  /** Commands whose exit arrived before their start: a start that comes in later is for a command already gone. */
  private readonly exitedUnseen = new Set<string>()

  constructor(private readonly deps: BashBackgroundManagerDeps) {}

  async handleEvent(event: PluginEvent): Promise<void> {
    if (event.type === BASH_BACKGROUND_STARTED_EVENT) {
      const started = event.properties as BashBackgroundStarted
      if (this.exitedUnseen.delete(started.id)) {
        log("[bash-background] Ignoring the start of a command that already exited:", { id: started.id })
        return
      }
      this.running.set(started.id, { ...started, startedAt: (this.deps.now ?? Date.now)() })
      return
    }
    if (event.type !== BASH_BACKGROUND_EXITED_EVENT) return
    const exited = event.properties as BashBackgroundExited
    if (!this.running.delete(exited.id)) this.rememberExitedUnseen(exited.id)
  }

  get(id: string): BashBackgroundRecord | undefined {
    return this.live().find((record) => record.id === id)
  }

  /** Every background command still running, across sessions. */
  listAll(): BashBackgroundRecord[] {
    return this.live()
  }

  /** The session's background commands that are still running, oldest first. */
  list(sessionID: string): BashBackgroundRecord[] {
    return this.live().filter((record) => record.sessionID === sessionID)
  }

  async stop(id: string): Promise<boolean> {
    const stopped = await this.deps.cancelJob(id)
    this.running.delete(id)
    return stopped
  }

  /** The running records, after dropping those past their timeout plus the margin. */
  private live(): BashBackgroundRecord[] {
    const now = (this.deps.now ?? Date.now)()
    for (const record of this.running.values()) {
      if (record.timeoutMs === null || now - record.startedAt <= record.timeoutMs + BASH_BACKGROUND_EXPIRY_MARGIN_MS) continue
      log("[bash-background] Dropping a command past its timeout whose exit never arrived:", { id: record.id })
      this.running.delete(record.id)
    }
    return [...this.running.values()]
  }

  private rememberExitedUnseen(id: string): void {
    this.exitedUnseen.add(id)
    if (this.exitedUnseen.size <= EXITED_UNSEEN_LIMIT) return
    const oldest = this.exitedUnseen.values().next().value
    if (oldest !== undefined) this.exitedUnseen.delete(oldest)
  }

  forgetSession(sessionID: string): void {
    for (const record of this.list(sessionID)) this.running.delete(record.id)
  }
}

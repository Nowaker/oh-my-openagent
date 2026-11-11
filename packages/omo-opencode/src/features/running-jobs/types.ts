export type RunningJobKind = "task" | "monitor" | "bash"

/** One unfinished job of a session, as the ledger records it: enough to tell the session what was lost and how to resume it. */
export interface RunningJob {
  readonly kind: RunningJobKind
  readonly id: string
  /** The session the job reports to. */
  readonly sessionId: string
  readonly description: string
  readonly startedAt: string
  /** A task's child session, which keeps everything the task did. */
  readonly childSessionId?: string
  readonly agent?: string
  /** A task that never started has no child session; its prompt is what re-runs it. */
  readonly prompt?: string
  readonly command?: string
  readonly timeoutMs?: number
  readonly outputPath?: string
}

/** `shell.background.started`, published by the opencode fork's bash tool. */
export type BashBackgroundStarted = {
  sessionID: string
  messageID: string
  callID: string
  id: string
  command: string
  outputPath: string
  reason: "requested" | "timeout"
  timeoutMs: number | null
}

/** `shell.background.exited`: `output` is the tail of what the command printed. */
export type BashBackgroundExited = {
  sessionID: string
  id: string
  command: string
  status: "completed" | "failed" | "timeout" | "cancelled"
  exitCode?: number
  durationMs: number
  outputPath: string
  output: string
}

export type BashBackgroundRecord = BashBackgroundStarted & { startedAt: number }

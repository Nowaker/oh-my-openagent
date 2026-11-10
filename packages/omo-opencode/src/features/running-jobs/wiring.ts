import { log } from "../../shared/logger"
import { formatLostJobNotice } from "./lost-notice"
import { openedSession, RunningJobsLedger } from "./ledger"
import type { RunningJob } from "./types"

/** How long after start a process claims the session it opened: its server must answer before a notice can wake it. */
export const STARTUP_CLAIM_DELAY_MS = 5_000

type TaskSource = {
  listUnfinishedTasks(): ReadonlyArray<{
    id: string
    parentSessionId: string
    description: string
    agent: string
    sessionId?: string
    startedAt?: Date
    queuedAt?: Date
    prompt: string
    status: string
  }>
  queueSessionNotice(sessionID: string, notification: string): Promise<void>
}
type MonitorSource = {
  listRunning(): ReadonlyArray<{
    id: string
    parentSessionId: string
    label: string
    command: string
    startedAt: Date
    timeoutMs?: number
    outputFile?: string
  }>
}
type BashSource = {
  listAll(): ReadonlyArray<{
    id: string
    sessionID: string
    command: string
    outputPath: string
    startedAt: number
    timeoutMs: number | null
  }>
}

export function createRunningJobsLedger(input: {
  readonly backgroundManager: TaskSource
  readonly monitorManager?: MonitorSource
  readonly bashBackgroundManager: BashSource
  readonly argv?: readonly string[]
  readonly root?: string
  readonly pid?: number
  readonly isAlive?: (pid: number) => boolean
}): RunningJobsLedger {
  const tasks = (): RunningJob[] =>
    input.backgroundManager.listUnfinishedTasks().map((task) => ({
      kind: "task",
      id: task.id,
      sessionId: task.parentSessionId,
      description: task.description,
      startedAt: (task.startedAt ?? task.queuedAt ?? new Date()).toISOString(),
      agent: task.agent,
      ...(task.sessionId ? { childSessionId: task.sessionId } : { prompt: task.prompt }),
    }))
  const monitors = (): RunningJob[] =>
    (input.monitorManager?.listRunning() ?? []).map((record) => ({
      kind: "monitor",
      id: record.id,
      sessionId: record.parentSessionId,
      description: record.label,
      startedAt: record.startedAt.toISOString(),
      command: record.command,
      ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
      ...(record.outputFile ? { outputPath: record.outputFile } : {}),
    }))
  const commands = (): RunningJob[] =>
    input.bashBackgroundManager.listAll().map((record) => ({
      kind: "bash",
      id: record.id,
      sessionId: record.sessionID,
      description: record.command.slice(0, 80),
      startedAt: new Date(record.startedAt).toISOString(),
      command: record.command,
      outputPath: record.outputPath,
      ...(record.timeoutMs !== null ? { timeoutMs: record.timeoutMs } : {}),
    }))

  const ledger = new RunningJobsLedger({
    sources: [tasks, monitors, commands],
    ...(input.root ? { root: input.root } : {}),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.isAlive ? { isAlive: input.isAlive } : {}),
    onLost: (sessionID, jobs) => {
      log("[running-jobs] Reporting jobs an earlier process left unfinished:", { sessionID, jobs: jobs.map((job) => job.id) })
      for (const job of jobs) {
        input.backgroundManager.queueSessionNotice(sessionID, formatLostJobNotice(job)).catch((error) => {
          log("[running-jobs] Could not deliver a lost-job notice:", { sessionID, id: job.id, error: String(error) })
        })
      }
    },
  })

  const opened = input.argv ? openedSession(input.argv, () => undefined) : openedSession()
  if (opened) {
    setTimeout(() => ledger.claimSession(opened), STARTUP_CLAIM_DELAY_MS).unref?.()
  }
  return ledger
}

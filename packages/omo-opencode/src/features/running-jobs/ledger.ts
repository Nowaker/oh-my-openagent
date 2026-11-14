import { hostname as osHostname } from "node:os"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { getDataDir } from "../../shared/data-path"
import { log } from "../../shared/logger"
import type { RunningJob } from "./types"

export const RUNNING_JOBS_FLUSH_INTERVAL_MS = 1_000

const RunningJobSchema = z.object({
  kind: z.enum(["task", "monitor", "bash", "wake"]),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  description: z.string(),
  startedAt: z.string(),
  childSessionId: z.string().optional(),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutMs: z.number().optional(),
  outputPath: z.string().optional(),
  notifications: z.array(z.string()).readonly().optional(),
})

export const RunningJobsRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  owner: z.object({ pid: z.number().int(), hostname: z.string() }),
  updatedAt: z.string(),
  jobs: z.array(RunningJobSchema),
})
export type RunningJobsRecord = z.infer<typeof RunningJobsRecordSchema>

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

export function runningJobsRoot(): string {
  return join(getDataDir(), "omo", "running-jobs")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export interface RunningJobsLedgerDeps {
  /** Each source lists the unfinished jobs of one kind, across every session this process serves. */
  readonly sources: ReadonlyArray<() => RunningJob[]>
  /** Jobs a previous process of the session left unfinished. */
  readonly onLost: (sessionID: string, jobs: RunningJob[]) => void
  readonly root?: string
  readonly pid?: number
  readonly hostname?: string
  readonly isAlive?: (pid: number) => boolean
  readonly now?: () => number
}

/**
 * Background tasks, monitors and background bash commands run inside the opencode process of the session that started
 * them, so they end with it. This ledger writes one file per session that has unfinished jobs, which is what lets
 * Vibeterm hold a restart of that session's tab, and what the next process of the session reads to tell it which jobs
 * were lost and how to resume them. The file stops changing once the process shuts down, so jobs the shutdown itself
 * ends stay recorded; a killed process leaves its last state.
 */
export class RunningJobsLedger {
  private readonly written = new Map<string, string>()
  private readonly claimed = new Set<string>()
  private frozen = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: RunningJobsLedgerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), RUNNING_JOBS_FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  shutdown(): void {
    this.frozen = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  flush(): void {
    if (this.frozen) return
    const bySession = new Map<string, RunningJob[]>()
    for (const source of this.deps.sources) {
      let jobs: RunningJob[]
      try {
        jobs = source()
      } catch (error) {
        log("[running-jobs] A job source failed:", { error: String(error) })
        continue
      }
      for (const job of jobs) {
        if (!SAFE_SESSION_ID.test(job.sessionId)) continue
        bySession.set(job.sessionId, [...(bySession.get(job.sessionId) ?? []), job])
      }
    }
    for (const [sessionID, jobs] of bySession) {
      // An earlier process's record must be read before this one replaces it.
      this.claimSession(sessionID)
      const body = JSON.stringify(jobs)
      if (this.written.get(sessionID) === body) continue
      this.write(sessionID, jobs)
      this.written.set(sessionID, body)
    }
    for (const sessionID of [...this.written.keys()]) {
      if (bySession.has(sessionID)) continue
      this.remove(this.path(sessionID))
      this.written.delete(sessionID)
    }
  }

  /** Reports, once per session, the jobs an earlier process of that session left unfinished. */
  claimSession(sessionID: string): void {
    if (this.claimed.has(sessionID) || !SAFE_SESSION_ID.test(sessionID)) return
    this.claimed.add(sessionID)
    let lost: RunningJob[]
    try {
      lost = this.takeLost(sessionID)
    } catch (error) {
      log("[running-jobs] Could not read a session's unfinished jobs:", { sessionID, error: String(error) })
      return
    }
    if (lost.length > 0) this.deps.onLost(sessionID, lost)
  }

  path(sessionID: string): string {
    return join(this.deps.root ?? runningJobsRoot(), `${sessionID}.json`)
  }

  private takeLost(sessionID: string): RunningJob[] {
    const file = this.path(sessionID)
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const parsed = RunningJobsRecordSchema.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.sessionId !== sessionID) return []
    const { owner } = parsed.data
    const pid = this.deps.pid ?? process.pid
    const host = this.deps.hostname ?? osHostname()
    if (owner.hostname === host && (owner.pid === pid || (this.deps.isAlive ?? pidAlive)(owner.pid))) return []
    // Claiming by rename means only one process reports the loss, however many open the session at once.
    const claimedFile = `${file}.claimed-${pid}`
    try {
      renameSync(file, claimedFile)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    this.remove(claimedFile)
    return parsed.data.jobs
  }

  private write(sessionID: string, jobs: RunningJob[]): void {
    const root = this.deps.root ?? runningJobsRoot()
    const file = this.path(sessionID)
    const record: RunningJobsRecord = {
      version: 1,
      sessionId: sessionID,
      owner: { pid: this.deps.pid ?? process.pid, hostname: this.deps.hostname ?? osHostname() },
      updatedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
      jobs,
    }
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      log("[running-jobs] Could not write a session's unfinished jobs:", { sessionID, error: String(error) })
    }
  }

  private remove(file: string): void {
    try {
      unlinkSync(file)
    } catch (error) {
      if (!isMissing(error)) log("[running-jobs] Could not remove a jobs file:", { file, error: String(error) })
    }
  }
}

/** The session an `opencode -s <id>` / `--session <id>` process opened, which it claims as soon as it starts. */
export function sessionFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "-s" || arg === "--session") {
      const next = argv[index + 1]
      return next && next.startsWith("ses_") ? next : undefined
    }
    if (arg?.startsWith("--session=")) {
      const value = arg.slice("--session=".length)
      return value.startsWith("ses_") ? value : undefined
    }
  }
  return undefined
}

/**
 * The process's own command line. A plugin can run in a worker thread (opencode's TUI runs its server in one), whose
 * `process.argv` is the worker script's, so the `-s <session>` the tab was started with is only in the process's.
 */
function processCommandLine(): string[] | undefined {
  try {
    const raw = readFileSync("/proc/self/cmdline", "utf8")
    return raw.split("\0").filter((arg) => arg.length > 0)
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(process.pid)], { encoding: "utf8" }).trim().split(/\s+/)
  } catch (error) {
    log("[running-jobs] Could not read this process's command line:", { error: String(error) })
    return undefined
  }
}

/** The session this process was opened on: from its own argv, else from the process command line. */
export function openedSession(
  argv: readonly string[] = process.argv,
  commandLine: () => readonly string[] | undefined = processCommandLine,
): string | undefined {
  return sessionFromArgv(argv) ?? sessionFromArgv(commandLine() ?? [])
}

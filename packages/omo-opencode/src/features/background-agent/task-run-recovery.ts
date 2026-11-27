import { statSync } from "node:fs"
import { z } from "zod"
import { log } from "../../shared/logger"
import { hasInternalInitiatorMarker } from "../../shared/internal-initiator-marker"
import { TaskRunStore, type TaskRunRecord } from "../running-jobs/task-run-store"
import { buildBackgroundTaskNotificationText } from "./background-task-notification-template"
import { formatDuration } from "./duration-formatter"
import type { OpencodeClient } from "./opencode-client"
import { recoveryPointerText } from "./parent-wake-run-notice"
import { TaskRecoveryStore } from "./task-recovery-store"
import { probeTaskOwner } from "./task-worker-ownership"
import type { BackgroundTask } from "./types"

const RETRY_MS = 5_000
const MAX_RECOVERY_RETRIES = 24
const HISTORY = z.array(
  z.object({
    info: z.object({
      id: z.string().optional(),
      role: z.string(),
      parentID: z.string().nullish(),
      error: z.unknown().optional(),
      time: z.object({ completed: z.number().nullish() }).optional(),
    }),
    parts: z.array(z.object({ type: z.string(), text: z.string().nullish() })).optional(),
  }),
)
const STATUS = z.record(z.string(), z.object({ type: z.string() }))

type RecoveryDeps = {
  readonly client: OpencodeClient
  readonly directory: string
  readonly ownerIdentity: () => Promise<Pick<TaskRunRecord, "owner" | "ownerProcess">>
  readonly queue: (sessionId: string, notification: string, shouldReply: boolean) => Promise<void>
  readonly hasPendingWake: (sessionId: string) => boolean
}

export class TaskRunRecovery {
  private readonly store = new TaskRunStore()
  private readonly owners = new TaskRecoveryStore()
  private readonly local = new Set<string>()
  private readonly checking = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retries = new Map<string, number>()
  private closed = false

  constructor(private readonly deps: RecoveryDeps) {}

  start(task: BackgroundTask, ownership: Pick<TaskRunRecord, "owner" | "ownerProcess">): void {
    if (!task.runId || !task.parentSessionId) return
    const prior = this.store.read(task.parentSessionId, task.runId)
    if (prior?.terminal) return
    this.store.write({
      version: 1,
      runId: task.runId,
      taskId: task.id,
      parentSessionId: task.parentSessionId,
      directory: this.deps.directory,
      childSessionId: task.sessionId,
      childDirectory: task.cwd ?? this.deps.directory,
      agent: task.agent,
      description: task.description,
      startedAt: prior?.startedAt ?? (task.startedAt ?? task.queuedAt)?.getTime() ?? Date.now(),
      ...(task.sessionId ? {} : { prompt: task.prompt }),
      wake: task.wake,
      ...ownership,
    })
    this.local.add(task.runId)
  }

  terminal(task: Pick<BackgroundTask, "runId" | "parentSessionId">, terminal: NonNullable<TaskRunRecord["terminal"]>): void {
    if (!task.runId || !this.local.has(task.runId)) return
    const record = this.store.read(task.parentSessionId, task.runId)
    if (record && !record.terminal) this.store.write({ ...record, terminal })
    this.schedule(task.parentSessionId)
  }

  discard(task: Pick<BackgroundTask, "runId" | "parentSessionId">): void {
    if (task.runId && this.local.delete(task.runId)) this.store.remove(task.parentSessionId, task.runId)
  }

  recover(parentSessionId: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    const previous = this.checking.get(parentSessionId)
    if (previous) return previous
    const checking = this.reconcile(parentSessionId)
      .catch((error: unknown) => {
        if (!(error instanceof Error)) throw error
        log("[background-agent] Could not reconcile durable run notices:", { parentSessionId, error: error.message })
        this.schedule(parentSessionId)
      })
      .finally(() => this.checking.delete(parentSessionId))
    this.checking.set(parentSessionId, checking)
    return checking
  }

  private schedule(parentSessionId: string): void {
    if (this.closed || this.timers.has(parentSessionId)) return
    const attempts = this.retries.get(parentSessionId) ?? 0
    if (attempts >= MAX_RECOVERY_RETRIES) return
    this.retries.set(parentSessionId, attempts + 1)
    const timer = setTimeout(() => {
      this.timers.delete(parentSessionId)
      void this.recover(parentSessionId)
    }, RETRY_MS)
    timer.unref?.()
    this.timers.set(parentSessionId, timer)
  }

  private async reconcile(parentSessionId: string): Promise<void> {
    const records = this.store.list(parentSessionId).filter((record) => record.directory === this.deps.directory)
    if (records.length === 0) {
      this.retries.delete(parentSessionId)
      return
    }
    if (this.deps.hasPendingWake(parentSessionId)) {
      this.schedule(parentSessionId)
      return
    }
    const response = await this.deps.client.session.messages({ path: { id: parentSessionId }, query: { directory: this.deps.directory } })
    const parsed = HISTORY.safeParse(response.data ?? response)
    if (this.closed) return
    if (!parsed.success) {
      this.schedule(parentSessionId)
      return
    }
    for (const record of records) {
      if (this.closed) return
      const local = this.local.has(record.runId)
      if (local && !record.terminal) continue
      if (!local && !(await this.previousOwnerStopped(record))) {
        this.schedule(parentSessionId)
        continue
      }
      if (this.closed) return
      const terminal = record.terminal ?? { notification: interruptedNotice(record), shouldReply: true }
      if (!local) {
        const claimed = await this.store.claim(record, { ...await this.deps.ownerIdentity(), terminal })
        if (!claimed || this.closed) continue
        this.local.add(record.runId)
      }
      const seen = parsed.data.findIndex(({ info, parts }) =>
        info.role === "user" && parts?.some(({ type, text }) =>
          type === "text" && text && hasInternalInitiatorMarker(text) && text.includes(`<run-id>${record.runId}</run-id>`),
        ),
      )
      const delivered = seen < 0 ? undefined : parsed.data[seen]
      const followup = parsed.data.slice(seen + 1)
      const wakeInputs = new Set(followup.flatMap(({ info, parts }) =>
        info.role === "user" && info.id && parts?.some(({ type, text }) =>
          type === "text" && text && hasInternalInitiatorMarker(text) && text.includes(recoveryPointerText(record.runId)),
        ) ? [info.id] : [],
      ))
      if (delivered?.info.id) wakeInputs.add(delivered.info.id)
      const replied = delivered && followup.some(({ info, parts }) => {
        if (info.role !== "assistant") return false
        if (typeof info.parentID === "string" && wakeInputs.has(info.parentID)) return true
        return !info.error && typeof info.time?.completed === "number" &&
          parts?.some((part) => part.type === "text" && part.text)
      })
      if (delivered && (!terminal.shouldReply || replied)) {
        this.discard(record)
        continue
      }
      if (!local) {
        const notice = delivered ? recoveryPointerText(record.runId) : terminal.notification
        await this.deps.queue(parentSessionId, notice, terminal.shouldReply)
      }
      this.schedule(parentSessionId)
    }
  }

  private async previousOwnerStopped(record: TaskRunRecord): Promise<boolean> {
    const previousOwner = await probeTaskOwner({
      ...record,
      sessionId: record.childSessionId ?? record.runId,
      generation: record.runId,
    })
    if (previousOwner !== "dead") return false
    if (record.terminal || !record.childSessionId) return true
    const child = this.owners.read(record.childSessionId)
    if (child) {
      const childOwner = await probeTaskOwner({ ...child, recordedAt: statSync(this.owners.path(child.sessionId)).mtimeMs })
      if (childOwner !== "dead") return false
    }
    const directory = record.childDirectory ?? record.directory
    const response = await this.deps.client.session.status({ query: { directory } })
    if (response.error) return false
    const statuses = STATUS.safeParse(response.data)
    const status = statuses.data?.[record.childSessionId]
    return statuses.success && (status === undefined || status.type === "idle" || status.type === "interrupted")
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

function interruptedNotice(record: TaskRunRecord): string {
  return buildBackgroundTaskNotificationText({
    task: {
      id: record.taskId,
      runId: record.runId,
      sessionId: record.childSessionId,
      description: record.description,
      status: "interrupt",
      error: "The previous OpenCode process stopped before this background run reported its result.",
    },
    duration: formatDuration(new Date(record.startedAt)),
    statusText: "INTERRUPTED",
    allComplete: true,
    remainingCount: 0,
  })
}

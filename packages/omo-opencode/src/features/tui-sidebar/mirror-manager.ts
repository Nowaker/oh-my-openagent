import { MIRROR_KEEPALIVE_MS, WRITE_DEBOUNCE_MS } from "./constants"
import { log } from "../../shared/logger"
import { writeMirror } from "./mirror-io"
import { resolveMirrorTiming, type MirrorTiming } from "./mirror-timing"
import { buildTuiRuntimeSnapshot } from "./snapshot-builder"
import type {
  BuildTuiRuntimeSnapshotInput,
  SessionAgentResolver,
  SessionStatusMap,
  TuiBackgroundSnapshotProvider,
  TuiMirrorClient,
} from "./snapshot-builder"
import type { TuiRuntimeSnapshot } from "./snapshot-schema"

export type TuiStateMirrorInput = {
  readonly client: TuiMirrorClient
  readonly projectDir: string
  readonly backgroundManager: TuiBackgroundSnapshotProvider
  readonly getStatuses?: () => Promise<SessionStatusMap>
  readonly sessionAgentResolver?: SessionAgentResolver
  readonly reportFlushError?: (error: Error) => void
  readonly timing?: MirrorTiming
  readonly now?: () => number
}

function isActiveSnapshot(snapshot: TuiRuntimeSnapshot): boolean {
  return snapshot.activeAgents.length > 0 || snapshot.jobBoard.length > 0 || snapshot.loop !== null
}

function contentKey(snapshot: TuiRuntimeSnapshot): string {
  return JSON.stringify({ ...snapshot, updatedAt: 0 })
}

export class TuiStateMirror {
  private readonly snapshotInput: BuildTuiRuntimeSnapshotInput
  private readonly reportFlushError: (error: Error) => void
  private readonly timing: MirrorTiming
  private readonly now: () => number
  private lastWrittenKey: string | null = null
  private lastWrittenAt = 0
  private lastBuildStartedAt: number | null = null
  private lastSnapshotActive = false
  private heartbeatID: ReturnType<typeof setInterval> | null = null
  private debounceID: ReturnType<typeof setTimeout> | null = null
  private pendingFlush: Promise<void> | null = null
  private resolvePendingFlush: (() => void) | null = null
  private inFlightFlush: Promise<void> | null = null
  private stopped = false

  constructor(input: TuiStateMirrorInput) {
    this.snapshotInput = input
    this.reportFlushError = input.reportFlushError ?? ((error) => log("[tui-sidebar] mirror flush failed", { error }))
    this.timing = input.timing ?? resolveMirrorTiming()
    this.now = input.now ?? Date.now
  }

  buildSnapshot(): Promise<TuiRuntimeSnapshot> {
    return buildTuiRuntimeSnapshot(this.snapshotInput)
  }

  flush(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }

    if (this.pendingFlush) {
      return this.pendingFlush
    }

    const scheduledFlush = new Promise<void>((resolvePromise, rejectPromise) => {
      this.resolvePendingFlush = resolvePromise
      this.debounceID = setTimeout(() => {
        this.debounceID = null
        this.resolvePendingFlush = null
        this.runFlush().then(resolvePromise, rejectPromise)
      }, WRITE_DEBOUNCE_MS)
    })

    this.pendingFlush = scheduledFlush.then(
      () => {
        this.pendingFlush = null
      },
      (error: unknown) => {
        this.pendingFlush = null
        throw error
      },
    )
    return this.pendingFlush
  }

  onEvent(_event: unknown): void {
    void this.flush()
  }

  start(): void {
    this.stopped = false
    if (this.heartbeatID !== null) {
      return
    }
    this.heartbeatID = setInterval(() => {
      this.onHeartbeat()
    }, this.timing.heartbeatMs)
    this.heartbeatID.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatID !== null) {
      clearInterval(this.heartbeatID)
      this.heartbeatID = null
    }
    if (this.debounceID !== null) {
      clearTimeout(this.debounceID)
      this.debounceID = null
    }
    if (this.resolvePendingFlush) {
      this.resolvePendingFlush()
      this.resolvePendingFlush = null
    }
    this.pendingFlush = null
  }

  /**
   * Events flush on their own, so the heartbeat only keeps an active snapshot fresh for readers
   * (see MIRROR_KEEPALIVE_MS) and catches state that changes without an event, such as a loop's
   * goals file. With nothing active, readers render a missing or stale mirror exactly like an idle
   * one, so the heartbeat rebuilds only every `idleRecheckMs`.
   */
  private onHeartbeat(): void {
    const lastBuild = this.lastBuildStartedAt
    if (!this.lastSnapshotActive && lastBuild !== null && this.now() - lastBuild < this.timing.idleRecheckMs) {
      return
    }
    void this.flush()
  }

  private shouldWrite(key: string, active: boolean): boolean {
    if (key !== this.lastWrittenKey) return true
    return active && this.now() - this.lastWrittenAt >= MIRROR_KEEPALIVE_MS
  }

  private runFlush(): Promise<void> {
    if (this.inFlightFlush) {
      return this.inFlightFlush
    }

    const runningFlush = this.writeSnapshotNoThrow()
    this.inFlightFlush = runningFlush.then(
      () => {
        this.inFlightFlush = null
      },
      (error: unknown) => {
        this.inFlightFlush = null
        throw error
      },
    )
    return this.inFlightFlush
  }

  private async writeSnapshotNoThrow(): Promise<void> {
    try {
      this.lastBuildStartedAt = this.now()
      const snapshot = await this.buildSnapshot()
      if (this.stopped) {
        return
      }
      const active = isActiveSnapshot(snapshot)
      this.lastSnapshotActive = active
      const key = contentKey(snapshot)
      if (!this.shouldWrite(key, active)) {
        return
      }
      writeMirror(this.snapshotInput.projectDir, snapshot)
      this.lastWrittenKey = key
      this.lastWrittenAt = this.now()
    } catch (error) {
      if (error instanceof Error) {
        this.reportFlushError(error)
        return
      }
      throw error
    }
  }
}

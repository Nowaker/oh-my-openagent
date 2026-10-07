import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HEARTBEAT_MS, MIRROR_KEEPALIVE_MS, WRITE_DEBOUNCE_MS } from "./constants"
import { readMirror } from "./mirror-io"
import { mirrorFilePath } from "./mirror-path"
import type { MirrorTiming } from "./mirror-timing"
import { TuiStateMirror } from "./mirror-manager"
import type { SessionAgentResolver } from "./snapshot-builder"
import type { BackgroundTaskSnapshot } from "../background-agent/types"

type StatusRow = { readonly type: string }
type StatusMap = Record<string, StatusRow>

type FakeClient = {
  readonly session: {
    readonly status: () => Promise<{ readonly data: StatusMap }>
    readonly messages: (input: { readonly path: { readonly id: string } }) => Promise<unknown>
  }
}

type FakeBackgroundManager = {
  readonly getTasksSnapshot: () => readonly BackgroundTaskSnapshot[]
}

const originalXdgDataHome = process.env.XDG_DATA_HOME
const tempDirs: string[] = []

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omo-tui-mirror-manager-${label}-`))
  tempDirs.push(dir)
  return dir
}

function restoreXdgDataHome(): void {
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
    return
  }
  process.env.XDG_DATA_HOME = originalXdgDataHome
}

function createClient(statuses: StatusMap): FakeClient {
  return {
    session: {
      status: async () => ({ data: statuses }),
      messages: async () => ({ data: [] }),
    },
  }
}

function createBackgroundManager(tasks: readonly BackgroundTaskSnapshot[]): FakeBackgroundManager {
  return {
    getTasksSnapshot: () => tasks,
  }
}

function createMirror(input?: {
  readonly client?: FakeClient
  readonly projectDir?: string
  readonly backgroundManager?: FakeBackgroundManager
  readonly sessionAgentResolver?: SessionAgentResolver
  readonly reportFlushError?: (error: Error) => void
  readonly timing?: MirrorTiming
  readonly now?: () => number
}): TuiStateMirror {
  const projectDir = input?.projectDir ?? makeTempDir("project")
  return new TuiStateMirror({
    client: input?.client ?? createClient({}),
    projectDir,
    backgroundManager: input?.backgroundManager ?? createBackgroundManager([]),
    sessionAgentResolver: input?.sessionAgentResolver ?? resolveTestSessionAgent,
    reportFlushError: input?.reportFlushError,
    timing: input?.timing,
    now: input?.now,
  })
}

function writtenUpdatedAt(projectDir: string): number {
  const raw: unknown = JSON.parse(readFileSync(mirrorFilePath(projectDir), "utf-8"))
  if (typeof raw !== "object" || raw === null || !("updatedAt" in raw) || typeof raw.updatedAt !== "number") {
    throw new Error("mirror file has no numeric updatedAt")
  }
  return raw.updatedAt
}

function countingClient(statuses: () => StatusMap): { readonly client: FakeClient; readonly builds: () => number } {
  let builds = 0
  return {
    client: {
      session: {
        status: async () => {
          builds += 1
          return { data: statuses() }
        },
        messages: async () => ({ data: [] }),
      },
    },
    builds: () => builds,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

const resolveTestSessionAgent: SessionAgentResolver = async (sessionID) => {
  switch (sessionID) {
    case "ses-main":
      return "sisyphus"
    case "ses-sub":
      return "atlas"
    default:
      return null
  }
}

describe("TuiStateMirror", () => {
  beforeEach(() => {
    process.env.XDG_DATA_HOME = makeTempDir("xdg")
  })

  afterEach(() => {
    jest.useRealTimers()
    restoreXdgDataHome()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("#given a mirror manager #when flushing #then it writes a readable mirror", async () => {
    // given
    const projectDir = makeTempDir("flush-project")
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "running" } }),
    })

    // when
    await mirror.flush()

    // then
    expect(readMirror(projectDir)?.activeAgents).toEqual([{ name: "sisyphus", status: "running" }])
  })

  it("#given a started mirror #when heartbeat fires without events #then it writes the mirror", async () => {
    jest.useFakeTimers()
    // given
    const projectDir = makeTempDir("heartbeat-project")
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "busy" } }),
    })
    mirror.start()

    // when
    jest.advanceTimersByTime(HEARTBEAT_MS)
    const heartbeatWrite = mirror.flush()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await heartbeatWrite

    // then
    expect(readMirror(projectDir)?.activeAgents).toEqual([{ name: "sisyphus", status: "busy" }])
    mirror.stop()
  })

  it("#given a started mirror #when started #then heartbeat handle is unref'd", () => {
    jest.useFakeTimers()
    const mirror = createMirror()
    const unref = jest.fn()
    const originalSetInterval = globalThis.setInterval
    globalThis.setInterval = jest.fn(() => ({ unref })) as unknown as typeof setInterval

    try {
      mirror.start()
      expect(unref).toHaveBeenCalledTimes(1)
    } finally {
      mirror.stop()
      globalThis.setInterval = originalSetInterval
    }
  })

  it("#given a started mirror #when stopped #then timers are cleared and no later write occurs", async () => {
    jest.useFakeTimers()
    // given
    const projectDir = makeTempDir("stop-project")
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "busy" } }),
    })
    mirror.start()

    // when
    mirror.stop()
    jest.advanceTimersByTime(HEARTBEAT_MS)
    await Promise.resolve()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await Promise.resolve()

    // then
    expect(readMirror(projectDir)).toBeNull()
    mirror.stop()
  })

  it("#given client status throws #when flushing #then status throws no-op with no rejection and no mirror write", async () => {
    // given
    const projectDir = makeTempDir("throw-project")
    const statusError = new Error("status unavailable")
    const reportedErrors: Error[] = []
    const client: FakeClient = {
      session: {
        status: async () => {
          throw statusError
        },
        messages: async () => ({ data: [] }),
      },
    }
    const mirror = createMirror({
      projectDir,
      client,
      reportFlushError: (error) => {
        reportedErrors.push(error)
      },
    })

    // when
    await expect(mirror.flush()).resolves.toBeUndefined()

    // then
    expect(readMirror(projectDir)).toBeNull()
    expect(reportedErrors).toEqual([statusError])
  })

  it("#given mirror write fails #when flushing #then the write error is reported", async () => {
    // given
    const blockedDataHome = join(makeTempDir("blocked-parent"), "data-home-file")
    writeFileSync(blockedDataHome, "not a directory", "utf-8")
    process.env.XDG_DATA_HOME = blockedDataHome
    const projectDir = makeTempDir("write-failure")
    const reportedErrors: Error[] = []
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "running" } }),
      reportFlushError: (error) => {
        reportedErrors.push(error)
      },
    })

    // when
    await expect(mirror.flush()).resolves.toBeUndefined()

    // then
    expect(reportedErrors).toHaveLength(1)
    expect(reportedErrors[0]?.message).toContain("not a directory")
  })

  it("#given concurrent flush calls #when the first build is in flight #then it does not double-build", async () => {
    // given: real timers; the 250ms debounce elapses on its own, and the test
    // subscribes to the actual build start instead of assuming microtask counts
    // (the fake-timer + single-tick version of this test deadlocked on CI).
    const projectDir = makeTempDir("concurrent-project")
    let buildCount = 0
    let releaseBuilds: () => void = () => undefined
    let reportBuildStarted: () => void = () => undefined
    const buildGate = new Promise<void>((resolvePromise) => {
      releaseBuilds = resolvePromise
    })
    const buildStarted = new Promise<void>((resolvePromise) => {
      reportBuildStarted = resolvePromise
    })
    const mirror = createMirror({
      projectDir,
      client: {
        session: {
          status: async () => {
            buildCount += 1
            reportBuildStarted()
            await buildGate
            return { data: { "ses-main": { type: "busy" } } }
          },
          messages: async () => ({ data: [] }),
        },
      },
    })

    // when
    const firstFlush = mirror.flush()
    const secondFlush = mirror.flush()
    await buildStarted
    releaseBuilds()
    await Promise.all([firstFlush, secondFlush])

    // then
    expect(buildCount).toBe(1)
  })

  it("#given an unchanged idle snapshot #when flushed again #then the mirror file is not rewritten", async () => {
    // given
    const projectDir = makeTempDir("idle-unchanged")
    const mirror = createMirror({ projectDir })
    await mirror.flush()
    const firstUpdatedAt = writtenUpdatedAt(projectDir)
    await sleep(5)

    // when
    await mirror.flush()

    // then
    expect(writtenUpdatedAt(projectDir)).toBe(firstUpdatedAt)
  })

  it("#given a snapshot whose content changed #when flushed #then the mirror file is rewritten", async () => {
    // given
    const projectDir = makeTempDir("content-changed")
    let statuses: StatusMap = {}
    const mirror = createMirror({ projectDir, client: countingClient(() => statuses).client })
    await mirror.flush()

    // when
    statuses = { "ses-main": { type: "busy" } }
    await mirror.flush()

    // then
    expect(readMirror(projectDir)?.activeAgents).toEqual([{ name: "sisyphus", status: "busy" }])
  })

  it("#given an unchanged active snapshot #when flushed before and after the keepalive age #then only the late flush rewrites it", async () => {
    // given
    const projectDir = makeTempDir("active-keepalive")
    let clock = 1_000_000
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "busy" } }),
      now: () => clock,
    })
    await mirror.flush()
    const firstUpdatedAt = writtenUpdatedAt(projectDir)

    // when
    clock += MIRROR_KEEPALIVE_MS - 1
    await sleep(5)
    await mirror.flush()
    const beforeKeepalive = writtenUpdatedAt(projectDir)
    clock += 1
    await sleep(5)
    await mirror.flush()

    // then
    expect(beforeKeepalive).toBe(firstUpdatedAt)
    expect(writtenUpdatedAt(projectDir)).toBeGreaterThan(firstUpdatedAt)
  })

  it("#given an idle mirror with a long idle recheck #when heartbeats fire #then it rebuilds only once", async () => {
    // given
    const counting = countingClient(() => ({}))
    const mirror = createMirror({ client: counting.client, timing: { heartbeatMs: 20, idleRecheckMs: 60_000 } })

    // when
    mirror.start()
    await sleep(WRITE_DEBOUNCE_MS * 3)
    mirror.stop()

    // then
    expect(counting.builds()).toBe(1)
  })

  it("#given an active mirror #when heartbeats fire #then it keeps rebuilding on the heartbeat", async () => {
    // given
    const counting = countingClient(() => ({ "ses-main": { type: "busy" } }))
    const mirror = createMirror({ client: counting.client, timing: { heartbeatMs: 20, idleRecheckMs: 60_000 } })

    // when
    mirror.start()
    await sleep(WRITE_DEBOUNCE_MS * 3)
    mirror.stop()

    // then
    expect(counting.builds()).toBeGreaterThanOrEqual(2)
  })
})

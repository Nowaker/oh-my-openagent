import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRunningJobsLedger } from "./wiring"
import { RunningJobsLedger } from "./ledger"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("createRunningJobsLedger", () => {
  test("#given a running task, monitor and bash command #when flushed #then each is recorded under its session, and a later process reports all three with one notice each", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "omo-running-jobs-wiring-"))
    roots.push(root)
    const startedAt = new Date("2026-11-10T00:00:00.000Z")
    const ledger = createRunningJobsLedger({
      root,
      backgroundManager: {
        listUnfinishedTasks: () => [{ id: "bg_1", parentSessionId: "ses_p", description: "review", agent: "Sisyphus-Junior", sessionId: "ses_c", startedAt, prompt: "p", status: "running" }],
        queueSessionNotice: async () => {},
      },
      monitorManager: { listRunning: () => [{ id: "mon_1", parentSessionId: "ses_p", label: "ticks", command: "for i in 1 2; do echo $i; done", startedAt, timeoutMs: 60_000, outputFile: "/tmp/m" }] },
      bashBackgroundManager: { listAll: () => [{ id: "bash_1", sessionID: "ses_p", command: "make", outputPath: "/tmp/b", startedAt: startedAt.getTime(), timeoutMs: null }] },
      argv: [],
    })

    // when
    ledger.flush()

    // then
    const jobs = JSON.parse(readFileSync(join(root, "ses_p.json"), "utf8")).jobs
    expect(jobs.map((job: { kind: string; id: string }) => [job.kind, job.id])).toEqual([["task", "bg_1"], ["monitor", "mon_1"], ["bash", "bash_1"]])

    // when
    const notices: Array<[string, string]> = []
    const next = createRunningJobsLedger({
      root,
      backgroundManager: { listUnfinishedTasks: () => [], queueSessionNotice: async (s, n) => { notices.push([s, n]) } },
      bashBackgroundManager: { listAll: () => [] },
      argv: [],
      isAlive: () => false,
      pid: process.pid + 1,
    })
    next.claimSession("ses_p")
    await Promise.resolve()

    // then
    expect(next).toBeInstanceOf(RunningJobsLedger)
    expect(notices.map(([session, notice]) => [session, notice.split("\n")[1]])).toEqual([
      ["ses_p", "[BACKGROUND TASK LOST]"],
      ["ses_p", "[MONITOR LOST]"],
      ["ses_p", "[BASH COMMAND LOST]"],
    ])
  })

  test("#given a pending task #then it is recorded with its prompt and no child session", () => {
    const root = mkdtempSync(join(tmpdir(), "omo-running-jobs-wiring-"))
    roots.push(root)
    const ledger = createRunningJobsLedger({
      root,
      backgroundManager: {
        listUnfinishedTasks: () => [{ id: "bg_2", parentSessionId: "ses_p", description: "later", agent: "explore", queuedAt: new Date(0), prompt: "count", status: "pending" }],
        queueSessionNotice: async () => {},
      },
      bashBackgroundManager: { listAll: () => [] },
      argv: [],
    })
    ledger.flush()
    expect(JSON.parse(readFileSync(join(root, "ses_p.json"), "utf8")).jobs[0]).toMatchObject({ kind: "task", prompt: "count", startedAt: "1970-01-01T00:00:00.000Z" })
  })

  test("#given a finished task whose parent wake is not delivered yet #when flushed #then the session keeps its record, and a later process delivers the wake's notices again", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "omo-running-jobs-wiring-"))
    roots.push(root)
    const notice = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n<task-id>bg_7e6b181a</task-id>\n</system-reminder>"
    const ledger = createRunningJobsLedger({
      root,
      backgroundManager: {
        listUnfinishedTasks: () => [],
        listUndeliveredParentWakes: () => [{ sessionID: "ses_p", notifications: [notice], queuedAt: 0 }],
        queueSessionNotice: async () => {},
      },
      bashBackgroundManager: { listAll: () => [] },
      argv: [],
    })

    // when
    ledger.flush()

    // then
    const jobs = JSON.parse(readFileSync(join(root, "ses_p.json"), "utf8")).jobs
    expect(jobs).toEqual([{ kind: "wake", id: "wake_ses_p", sessionId: "ses_p", description: "1 undelivered background notice", startedAt: "1970-01-01T00:00:00.000Z", notifications: [notice] }])

    // when
    const notices: Array<[string, string]> = []
    const next = createRunningJobsLedger({
      root,
      backgroundManager: { listUnfinishedTasks: () => [], queueSessionNotice: async (s, n) => { notices.push([s, n]) } },
      bashBackgroundManager: { listAll: () => [] },
      argv: [],
      isAlive: () => false,
      pid: process.pid + 1,
    })
    next.claimSession("ses_p")
    await Promise.resolve()

    // then
    expect(notices).toHaveLength(1)
    expect(notices[0]?.[0]).toBe("ses_p")
    expect(notices[0]?.[1].split("\n")[1]).toBe("[BACKGROUND NOTICE UNDELIVERED]")
    expect(notices[0]?.[1]).toContain(notice)
  })
})

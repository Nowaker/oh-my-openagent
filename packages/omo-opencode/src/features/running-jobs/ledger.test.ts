import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openedSession, RunningJobsLedger, sessionFromArgv } from "./ledger"
import type { RunningJob } from "./types"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-running-jobs-"))
  roots.push(root)
  return root
}

const task: RunningJob = {
  kind: "task",
  id: "bg_1",
  sessionId: "ses_parent",
  description: "review",
  startedAt: "2026-11-10T00:00:00.000Z",
  childSessionId: "ses_child",
  agent: "Sisyphus-Junior",
}

function ledger(root: string, jobs: { current: RunningJob[] }, lost: Array<[string, RunningJob[]]>, alive = new Set<number>()) {
  return new RunningJobsLedger({
    root,
    pid: 100,
    hostname: "host",
    isAlive: (pid) => alive.has(pid),
    sources: [() => jobs.current],
    onLost: (sessionID, found) => lost.push([sessionID, found]),
  })
}

describe("RunningJobsLedger", () => {
  test("#given a session with an unfinished job #when flushed #then its file lists the job until the job ends", () => {
    // given
    const root = scratch()
    const jobs = { current: [task] }
    const subject = ledger(root, jobs, [])

    // when
    subject.flush()

    // then
    const record = JSON.parse(readFileSync(subject.path("ses_parent"), "utf8"))
    expect(record).toMatchObject({ version: 1, sessionId: "ses_parent", owner: { pid: 100, hostname: "host" }, jobs: [task] })

    // when
    jobs.current = []
    subject.flush()

    // then
    expect(existsSync(subject.path("ses_parent"))).toBe(false)
  })

  test("#given a shutdown #when the jobs end afterwards #then the file still lists them", () => {
    const root = scratch()
    const jobs = { current: [task] }
    const subject = ledger(root, jobs, [])
    subject.flush()

    subject.shutdown()
    jobs.current = []
    subject.flush()

    expect(JSON.parse(readFileSync(subject.path("ses_parent"), "utf8")).jobs).toEqual([task])
  })

  test("#given a file left by a dead process #when the session is claimed #then its jobs are reported once and the file is gone", () => {
    // given
    const root = scratch()
    const earlier = ledger(root, { current: [task] }, [])
    earlier.flush()
    const lost: Array<[string, RunningJob[]]> = []
    const next = new RunningJobsLedger({ root, pid: 200, hostname: "host", isAlive: () => false, sources: [], onLost: (s, j) => lost.push([s, j]) })

    // when
    next.claimSession("ses_parent")
    next.claimSession("ses_parent")

    // then
    expect(lost).toEqual([["ses_parent", [task]]])
    expect(existsSync(next.path("ses_parent"))).toBe(false)
  })

  test("#given a file whose owner still runs #when the session is claimed #then nothing is reported and the file stays", () => {
    const root = scratch()
    ledger(root, { current: [task] }, []).flush()
    const lost: Array<[string, RunningJob[]]> = []
    const next = new RunningJobsLedger({ root, pid: 200, hostname: "host", isAlive: (pid) => pid === 100, sources: [], onLost: (s, j) => lost.push([s, j]) })

    next.claimSession("ses_parent")

    expect(lost).toEqual([])
    expect(existsSync(next.path("ses_parent"))).toBe(true)
  })

  test("#given a file left by a dead process #when the new process records its own job for that session #then the old jobs are reported first", () => {
    // given
    const root = scratch()
    ledger(root, { current: [task] }, []).flush()
    const lost: Array<[string, RunningJob[]]> = []
    const fresh = { ...task, id: "bg_2", childSessionId: "ses_child2" }
    const next = new RunningJobsLedger({ root, pid: 200, hostname: "host", isAlive: () => false, sources: [() => [fresh]], onLost: (s, j) => lost.push([s, j]) })

    // when
    next.flush()

    // then
    expect(lost).toEqual([["ses_parent", [task]]])
    expect(JSON.parse(readFileSync(next.path("ses_parent"), "utf8")).jobs).toEqual([fresh])
  })

  test("#given an unreadable file #when claimed #then nothing is reported", () => {
    const root = scratch()
    const subject = ledger(root, { current: [] }, [])
    writeFileSync(subject.path("ses_parent"), "{not json")
    const lost: Array<[string, RunningJob[]]> = []
    const next = new RunningJobsLedger({ root, pid: 200, hostname: "host", isAlive: () => false, sources: [], onLost: (s, j) => lost.push([s, j]) })

    next.claimSession("ses_parent")

    expect(lost).toEqual([])
  })
})

describe("sessionFromArgv", () => {
  test("#given the ways opencode is told its session #then each is read", () => {
    expect(sessionFromArgv(["opencode", "-s", "ses_a", "/dir"])).toBe("ses_a")
    expect(sessionFromArgv(["opencode", "run", "--session", "ses_b"])).toBe("ses_b")
    expect(sessionFromArgv(["opencode", "--session=ses_c"])).toBe("ses_c")
    expect(sessionFromArgv(["opencode", "/dir"])).toBeUndefined()
  })

  test("#given a plugin in a worker thread, whose argv lacks the process's #when the opened session is read #then it comes from the process command line", () => {
    expect(openedSession(["/usr/bin/bun", "/worker.js"], () => ["opencode", "-s", "ses_tab", "/dir"])).toBe("ses_tab")
    expect(openedSession(["opencode", "-s", "ses_argv"], () => ["opencode"])).toBe("ses_argv")
    expect(openedSession(["/usr/bin/bun", "/worker.js"], () => undefined)).toBeUndefined()
  })
})

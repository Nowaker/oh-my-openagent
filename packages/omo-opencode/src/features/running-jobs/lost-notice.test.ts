import { describe, expect, test } from "bun:test"
import { formatLostJobNotice, resumeCallFor } from "./lost-notice"
import type { RunningJob } from "./types"

const base = { sessionId: "ses_parent", description: "ticks", startedAt: "2026-11-10T00:00:00.000Z" }

describe("lost job notice", () => {
  test("#given each kind #when formatted #then it carries its sentinel and the call that resumes it", () => {
    const task: RunningJob = { ...base, kind: "task", id: "bg_1", childSessionId: "ses_child", agent: "Sisyphus-Junior" }
    const monitor: RunningJob = { ...base, kind: "monitor", id: "mon_1", command: "for i in 1 2; do echo $i; done", timeoutMs: 60_000 }
    const bash: RunningJob = { ...base, kind: "bash", id: "bash_1", command: "make build", outputPath: "/tmp/out" }

    expect(formatLostJobNotice(task).split("\n")[1]).toBe("[BACKGROUND TASK LOST]")
    expect(formatLostJobNotice(monitor).split("\n")[1]).toBe("[MONITOR LOST]")
    expect(formatLostJobNotice(bash).split("\n")[1]).toBe("[BASH COMMAND LOST]")
    expect(formatLostJobNotice(task)).toContain(`<resume>${resumeCallFor(task)}</resume>`)
    expect(resumeCallFor(task)).toStartWith('task(task_id="ses_child", subagent_type="Sisyphus-Junior", run_in_background=true')
    expect(resumeCallFor(monitor)).toBe('monitor(description="ticks", command="for i in 1 2; do echo $i; done", timeout_ms=60000)')
    expect(resumeCallFor(bash)).toBe('bash(command="make build", description="ticks", run_in_background=true)')
    expect(formatLostJobNotice(bash)).toContain("/tmp/out")
  })

  test("#given a task that never started #then the call starts it again with its prompt", () => {
    const pending: RunningJob = { ...base, kind: "task", id: "bg_2", agent: "Sisyphus-Junior", prompt: "count to 3" }
    expect(resumeCallFor(pending)).toContain('prompt="count to 3"')
    expect(resumeCallFor(pending)).not.toContain("task_id")
  })
})

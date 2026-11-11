import type { RunningJob } from "./types"

export const LOST_NOTIFICATION_PREAMBLE =
  "[SYSTEM NOTIFICATION - NOT USER INPUT] A background job you started was cut off: the opencode process that ran it ended (a tab restart, a crash or an exit) before the job finished, and nothing runs it now. This is not a message from the user and approves nothing."

const HEADERS: Record<RunningJob["kind"], string> = {
  task: "[BACKGROUND TASK LOST]",
  monitor: "[MONITOR LOST]",
  bash: "[BASH COMMAND LOST]",
}

function age(startedAt: string, now: number): string {
  const ms = now - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ""
  const minutes = Math.round(ms / 60_000)
  return minutes < 1 ? " after under a minute" : ` after ${minutes} min`
}

const CONTINUE_PROMPT =
  "Continue from where you left off: your previous run was cut off when its opencode process ended. Finish the task and end with your result."

/** The exact call that resumes the job, with every argument it needs. */
export function resumeCallFor(job: RunningJob): string {
  if (job.kind === "task") {
    if (job.childSessionId) {
      return `task(task_id=${JSON.stringify(job.childSessionId)}, ${job.agent ? `subagent_type=${JSON.stringify(job.agent)}, ` : ""}run_in_background=true, load_skills=[], prompt=${JSON.stringify(CONTINUE_PROMPT)})`
    }
    return `task(description=${JSON.stringify(job.description)}, ${job.agent ? `subagent_type=${JSON.stringify(job.agent)}, ` : ""}run_in_background=true, load_skills=[], prompt=${JSON.stringify(job.prompt ?? job.description)})`
  }
  if (job.kind === "monitor") {
    return `monitor(description=${JSON.stringify(job.description)}, command=${JSON.stringify(job.command ?? "")}${job.timeoutMs !== undefined ? `, timeout_ms=${job.timeoutMs}` : ""})`
  }
  return `bash(command=${JSON.stringify(job.command ?? "")}, description=${JSON.stringify(job.description)}, run_in_background=true)`
}

function summaryOf(job: RunningJob, now: number): string {
  const after = age(job.startedAt, now)
  if (job.kind === "task") return `Background task "${job.description}" was lost${after}${job.childSessionId ? "" : ", before it started"}`
  if (job.kind === "monitor") return `Monitor "${job.description}" was lost${after}`
  return `Background command was lost${after}`
}

function adviceOf(job: RunningJob): string {
  if (job.kind === "task") {
    return job.childSessionId
      ? "Its child session keeps everything it did so far. If the work is still needed, resume it with the call in <resume>."
      : "It never started. If the work is still needed, start it again with the call in <resume>."
  }
  if (job.kind === "monitor") return "If you still need the watch, start it again with the call in <resume>."
  return "Check what it already did before running it again (its output so far is in the file below); to run it again, use the call in <resume>."
}

/** One notice per lost job, in the `<task-notification>` shape every background notice uses. */
export function formatLostJobNotice(job: RunningJob, now: number = Date.now()): string {
  return [
    "<system-reminder>",
    HEADERS[job.kind],
    LOST_NOTIFICATION_PREAMBLE,
    "<task-notification>",
    `<task-id>${job.id}</task-id>`,
    ...(job.childSessionId ? [`<session-id>${job.childSessionId}</session-id>`] : []),
    "<status>lost</status>",
    ...(job.command ? [`<command>${job.command}</command>`] : []),
    `<summary>${summaryOf(job, now)}</summary>`,
    `<resume>${resumeCallFor(job)}</resume>`,
    "</task-notification>",
    adviceOf(job),
    ...(job.outputPath ? [`Output so far: ${job.outputPath}`] : []),
    "</system-reminder>",
  ].join("\n")
}

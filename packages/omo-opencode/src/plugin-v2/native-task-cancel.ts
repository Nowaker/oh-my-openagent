import type { NativeCancelArguments } from "./native-task-arguments"
import type { NativeTaskContext, NativeTaskDependencies, NativeTaskBindings, NativeToolContext, NativeToolResult, NativeChildCancellation } from "./native-task-types"
import { NativeTaskCapabilityError, NativeTaskError, readNativeTaskMetadata } from "./native-task-types"
import { nativeSessionID } from "./native-task-output"

async function assertOwnedSession(ctx: NativeTaskContext, owner: string, caller: string): Promise<void> {
  const visited = new Set<string>()
  let current = owner
  while (current !== caller) {
    if (visited.has(current)) throw new NativeTaskError("invalid-parent-chain", "Native job parent chain contains a cycle")
    visited.add(current)
    const session = await ctx.session.get({ sessionID: current })
    if (!session.parentID) throw new NativeTaskError("parent-mismatch", "Native job belongs to another session tree")
    current = session.parentID
  }
}

export async function nativeTaskCancel(ctx: NativeTaskContext, deps: NativeTaskDependencies, bindings: NativeTaskBindings, args: NativeCancelArguments, context: NativeToolContext): Promise<NativeToolResult> {
  const monitors = bindings.managers.monitorManager
  if (!args.all && !args.taskId) throw new NativeTaskError("missing-task-id", "Provide taskId or all:true")
  if (!args.all && args.taskId?.startsWith("mon_")) {
    const monitor = monitors?.get(args.taskId)
    if (!monitors || !monitor) throw new NativeTaskError("monitor-not-found", "Monitor is unavailable")
    if (monitor.parentSessionId !== context.sessionID) throw new NativeTaskError("parent-mismatch", "Monitor belongs to another session")
    if (monitor.status !== "starting" && monitor.status !== "running") throw new NativeTaskError("monitor-not-running", `Monitor is ${monitor.status}`)
    await monitors.stop(monitor.id)
    return { content: `Monitor stopped: ${monitor.id}`, output: { id: monitor.id, stopped: true } }
  }
  const jobs: { readonly id: string; readonly parentID: string; readonly kind: "shell" | "subagent" | "image" }[] = []
  if (args.all) {
    if (!deps.listJobs) throw new NativeTaskCapabilityError("native job listing")
    for (const job of await deps.listJobs(context.sessionID, true)) {
      await assertOwnedSession(ctx, job.sessionID, context.sessionID)
      if (job.status === "running") jobs.push({ ...job, parentID: job.sessionID })
    }
  } else if (args.taskId) {
    const sessionID = nativeSessionID(args.taskId)
    const nativeJob = deps.listJobs ? (await deps.listJobs(context.sessionID, true)).find((job) => job.id === sessionID) : undefined
    if (nativeJob) {
      await assertOwnedSession(ctx, nativeJob.sessionID, context.sessionID)
      jobs.push({ id: nativeJob.id, parentID: nativeJob.sessionID, kind: nativeJob.kind })
    } else {
      if (!args.taskId.startsWith("bg_") && !sessionID.startsWith("ses_")) {
        if (!deps.listJobs) throw new NativeTaskCapabilityError("native job listing")
        throw new NativeTaskError("job-not-found", "Native job was not found in the caller's session tree")
      }
      readNativeTaskMetadata(await ctx.session.get({ sessionID }), context.sessionID)
      jobs.push({ id: sessionID, parentID: context.sessionID, kind: "subagent" })
    }
  }
  if (jobs.some((job) => job.kind === "subagent") && (ctx.app.capabilities?.childCancellation !== true || !ctx.session.cancelChild)) throw new NativeTaskCapabilityError("childCancellation")
  if (jobs.some((job) => job.kind !== "subagent") && !deps.cancelJob) throw new NativeTaskCapabilityError("native shell/image job cancellation")
  const results: { readonly id: string; readonly result: NativeChildCancellation }[] = []
  for (const job of jobs) {
    let result: NativeChildCancellation
    if (job.kind === "subagent") {
      if (!ctx.session.cancelChild) throw new NativeTaskCapabilityError("childCancellation")
      result = await ctx.session.cancelChild({ parentID: job.parentID, sessionID: job.id })
    } else {
      if (!deps.cancelJob) throw new NativeTaskCapabilityError("native shell/image job cancellation")
      result = await deps.cancelJob({ id: job.id, parentSessionID: job.parentID, signal: context.signal })
    }
    results.push({ id: job.id, result })
  }
  const stoppedMonitors: string[] = []
  if (args.all && monitors) {
    for (const monitor of monitors.list(context.sessionID)) {
      if (monitor.parentSessionId !== context.sessionID) throw new NativeTaskError("parent-mismatch", "Monitor listing returned another session's monitor")
      if (monitor.status === "starting" || monitor.status === "running") { await monitors.stop(monitor.id); stoppedMonitors.push(monitor.id) }
    }
  }
  return { content: JSON.stringify({ jobs: results, stoppedMonitors }), output: { jobs: results, stoppedMonitors } }
}

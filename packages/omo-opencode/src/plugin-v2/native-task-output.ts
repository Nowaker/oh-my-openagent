import type { NativeOutputArguments } from "./native-task-arguments"
import type { NativeTaskContext, NativeToolContext, NativeMessage, NativeTaskDependencies, NativeToolResult, NativeJobResult } from "./native-task-types"
import { NativeTaskCapabilityError, NativeTaskError, readNativeTaskMetadata } from "./native-task-types"
import { waitForNativeTask, withNativeWaitDeadline } from "./native-task-wait"

export function nativeSessionID(taskID: string): string {
  return taskID.startsWith("bg_") ? taskID.slice(3) : taskID
}

async function readNativeTaskMessages(ctx: NativeTaskContext, sessionID: string, boundary?: string): Promise<readonly NativeMessage[]> {
  if (ctx.app.capabilities?.sessionMessages !== true || !ctx.session.messages) throw new NativeTaskCapabilityError("sessionMessages")
  const messages: NativeMessage[] = []
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    const page = await ctx.session.messages({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" }) })
    const boundaryIndex = boundary ? page.data.findIndex((message) => message.id === boundary) : -1
    if (boundaryIndex >= 0) {
      messages.push(...page.data.slice(0, boundaryIndex))
      return messages.reverse()
    }
    messages.push(...page.data)
    cursor = page.cursor.next ?? undefined
    if (cursor && cursors.has(cursor)) throw new NativeTaskError("invalid-message-cursor", "Native message paging returned a repeated cursor")
    if (cursor) cursors.add(cursor)
  } while (cursor)
  if (boundary) throw new NativeTaskError("fork-boundary-unavailable", "Fork result boundary is absent from durable messages; inherited history cannot be exposed")
  return messages.reverse()
}

function renderMessage(message: NativeMessage, args: NativeOutputArguments): string {
  switch (message.type) {
    case "assistant":
      return message.content.map((part) => {
        switch (part.type) {
          case "text": return part.text
          case "reasoning": return args.include_thinking ? part.text.slice(0, args.thinking_max_chars ?? 2000) : ""
          case "tool": return args.include_tool_results ? JSON.stringify(part) : ""
          default: return exhaustive(part)
        }
      }).filter(Boolean).join("\n")
    case "user":
    case "synthetic":
    case "system": return args.full_session ? message.text : ""
    case "agent-switched":
    case "model-switched":
    case "location-switched":
    case "skill":
    case "shell":
    case "compaction":
    case "idle": return args.full_session && args.include_tool_results ? JSON.stringify(message) : ""
    default: return exhaustive(message)
  }
}

function exhaustive(value: never): never { throw new NativeTaskError("native-message-variant", "Unrecognized native message variant") }

export async function nativeTaskOutput(ctx: NativeTaskContext, deps: NativeTaskDependencies, args: NativeOutputArguments, context: NativeToolContext): Promise<NativeToolResult> {
  const sessionID = nativeSessionID(args.task_id)
  const initialJobs = deps.listJobs ? await deps.listJobs(context.sessionID) : undefined
  const nativeJob = initialJobs?.find((entry) => entry.id === sessionID)
  if (nativeJob && nativeJob.sessionID !== context.sessionID) throw new NativeTaskError("parent-mismatch", "Native job belongs to another session")
  if (nativeJob ? nativeJob.kind !== "subagent" : !sessionID.startsWith("ses_")) {
    if (args.full_session || args.include_thinking || args.include_tool_results || args.from_end || args.message_limit !== undefined || args.since_message_id !== undefined || args.thinking_max_chars !== undefined) throw new NativeTaskCapabilityError("native shell/image message filters")
    const read = deps.resultJob
    if (!read) throw new NativeTaskCapabilityError("jobResults")
    let waitTimedOut = false
    let result: NativeJobResult
    if (args.block) {
      const waited = await withNativeWaitDeadline((signal) => read({ id: sessionID, parentSessionID: context.sessionID, wait: true, signal }), { signal: context.signal, timeout: args.timeout })
      switch (waited.waitTimedOut) {
        case true:
          waitTimedOut = true
          result = await read({ id: sessionID, parentSessionID: context.sessionID, wait: false, signal: context.signal })
          break
        case false: result = waited.value; break
        default: throw new NativeTaskError("native-wait-result", `Unrecognized native wait result: ${waited satisfies never}`)
      }
    } else result = await read({ id: sessionID, parentSessionID: context.sessionID, wait: false, signal: context.signal })
    if (result.id !== sessionID || result.sessionID !== context.sessionID) throw new NativeTaskError("parent-mismatch", "Native result returned a different job or parent")
    return { output: { jobID: result.id, sessionID: result.sessionID, kind: result.kind, status: result.status,
      ...(waitTimedOut ? { waitTimedOut } : {}), ...(result.output === undefined ? {} : { output: result.output }), ...(result.error === undefined ? {} : { error: result.error }) },
      content: `Native ${result.kind} job ${result.id}: ${result.status}${result.error ? ` - ${result.error}` : ""}\n\n${waitTimedOut ? "Native wait deadline elapsed; job execution was not cancelled.\n\n" : ""}${result.output ?? "No native job output is available."}` }
  }
  const initial = await ctx.session.get({ sessionID })
  const metadata = readNativeTaskMetadata(initial, context.sessionID)
  const waitTimedOut = args.block ? await waitForNativeTask(ctx, { sessionID, context, timeout: args.timeout }) : false
  const session = args.block ? await ctx.session.get({ sessionID }) : initial
  const jobs = args.block && deps.listJobs ? await deps.listJobs(context.sessionID) : initialJobs
  const job = jobs?.find((entry) => entry.id === sessionID && entry.kind === "subagent" && entry.sessionID === context.sessionID)
  const active = session.time.busy !== undefined && (session.time.idle === undefined || session.time.busy > session.time.idle)
  const status = active ? "running" : job?.status ?? (session.outcome === "succeeded" ? "completed" : session.outcome === "failed" ? "error" : session.outcome === "interrupted" ? "cancelled" : undefined)
  let messages = [...await readNativeTaskMessages(ctx, sessionID, metadata.ownMessagesSince)]
  const latest = messages.findLast((message) => message.type === "assistant")
  const error = !active && latest?.type === "assistant" ? latest.error?.message : undefined
  if (args.since_message_id) {
    const since = messages.findIndex((message) => message.id === args.since_message_id)
    if (since < 0) throw new NativeTaskError("message-not-found", "Requested message boundary does not belong to this task's own work")
    messages = messages.slice(since + 1)
  }
  if (!args.full_session) messages = messages.filter((message) => message.type === "assistant").slice(-1)
  if (!args.include_tool_results) messages = messages.filter((message) => message.type === "assistant" || message.type === "user" || message.type === "synthetic" || message.type === "system")
  messages = messages.map((message) => {
    if (message.type !== "assistant") return message
    return { ...message, content: message.content.filter((part) => part.type === "text" || (part.type === "reasoning" && args.include_thinking) || (part.type === "tool" && args.include_tool_results))
      .map((part) => part.type === "reasoning" ? { ...part, text: part.text.slice(0, args.thinking_max_chars ?? 2000) } : part) }
  })
  const limit = Math.min(args.message_limit ?? 200, 200)
  messages = args.from_end ? messages.slice(-limit) : messages.slice(0, limit)
  const output = messages.map((message) => renderMessage(message, args)).filter(Boolean).join("\n\n")
  return { output: { sessionID, ...(status ? { status } : { status: "unconfirmed" }), ...(waitTimedOut ? { waitTimedOut } : {}), ...(error ? { error } : {}), messages },
    content: `Native task ${sessionID}: ${status ?? "execution state unconfirmed"}${error ? ` - ${error}` : ""}\n\n${waitTimedOut ? "Native wait deadline elapsed; showing available messages.\n\n" : ""}${output || "No task message content is available."}`,
    metadata: { sessionID, backgroundTaskId: `bg_${sessionID}` } }
}

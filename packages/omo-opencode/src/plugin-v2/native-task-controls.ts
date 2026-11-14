import type { NativeChildCancellation, NativeTaskContext, NativeTaskDependencies, NativeJobResult } from "./native-task-types"
import { NativeTaskCapabilityError } from "./native-task-types"

type NativeJob = Awaited<ReturnType<NonNullable<NativeTaskDependencies["listJobs"]>>>[number]
type NativeJobContext = NativeTaskContext & {
  readonly job?: {
    readonly list?: (input: { readonly parentSessionID: string; readonly descendants?: boolean }) => Promise<{ readonly data: readonly NativeJob[] }>
    readonly cancel?: (input: { readonly parentID: string; readonly jobID: string }, options?: { readonly signal: AbortSignal }) => Promise<NativeChildCancellation>
    readonly result?: (input: { readonly parentID: string; readonly jobID: string; readonly wait?: boolean }, options?: { readonly signal: AbortSignal }) => Promise<NativeJobResult>
  }
}

export function createNativeJobDependencies(ctx: NativeJobContext): NativeTaskDependencies {
  const controls = ctx.app.capabilities?.jobControl === true
  const results = ctx.app.capabilities?.jobResults === true
  const list = ctx.job?.list
  const cancel = ctx.job?.cancel
  const result = ctx.job?.result
  if (controls && (!list || !cancel)) throw new NativeTaskCapabilityError("advertised jobControl methods")
  if (results && !result) throw new NativeTaskCapabilityError("advertised jobResults method")
  return {
    ...(controls && list && cancel ? {
      listJobs: async (parentSessionID: string, descendants?: true) => (await list({ parentSessionID, ...(descendants ? { descendants } : {}) })).data,
      cancelJob: ({ id, parentSessionID, signal }: Parameters<NonNullable<NativeTaskDependencies["cancelJob"]>>[0]) => cancel({ parentID: parentSessionID, jobID: id }, { signal }),
    } : {}),
    ...(results && result ? {
      resultJob: ({ id, parentSessionID, wait, signal }: Parameters<NonNullable<NativeTaskDependencies["resultJob"]>>[0]) => result({ parentID: parentSessionID, jobID: id, wait }, { signal }),
    } : {}),
  }
}

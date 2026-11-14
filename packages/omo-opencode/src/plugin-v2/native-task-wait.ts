import type { NativeTaskContext, NativeToolContext } from "./native-task-types"

type NativeWaitResult<T> = { readonly waitTimedOut: true } | { readonly waitTimedOut: false; readonly value: T }

export async function withNativeWaitDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, input: {
  readonly signal: AbortSignal; readonly timeout?: number;
}): Promise<NativeWaitResult<T>> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([input.signal, deadline.signal])
  const interrupted = Promise.withResolvers<never>()
  const abort = () => interrupted.reject(signal.reason)
  const timer = setTimeout(() => deadline.abort(new DOMException("Native wait deadline elapsed", "TimeoutError")), Math.min(input.timeout ?? 60000, 600000))
  signal.addEventListener("abort", abort, { once: true })
  let pending: Promise<T> | undefined
  try {
    signal.throwIfAborted()
    pending = operation(signal)
    return { waitTimedOut: false, value: await Promise.race([pending, interrupted.promise]) }
  } catch (error) {
    if (input.signal.aborted || !deadline.signal.aborted || error !== deadline.signal.reason) throw error
    return { waitTimedOut: true }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    if (signal.aborted && pending) await Promise.allSettled([pending])
  }
}

export async function waitForNativeTask(ctx: NativeTaskContext, input: {
  readonly sessionID: string; readonly context: NativeToolContext; readonly timeout?: number;
}): Promise<boolean> {
  return (await withNativeWaitDeadline((signal) => ctx.session.wait({ sessionID: input.sessionID }, { signal }), { signal: input.context.signal, timeout: input.timeout })).waitTimedOut
}

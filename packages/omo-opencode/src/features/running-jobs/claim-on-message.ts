import type { RunningJobsLedger } from "./ledger"

/**
 * A session's first message in this process claims the jobs an earlier process of it left unfinished, so a session
 * opened without `-s` (a child resumed by `task(task_id=...)`, a tab switched to it) still hears about them.
 */
export function withRunningJobsClaim<Input extends { sessionID: string }, Output>(
  ledger: Pick<RunningJobsLedger, "claimSession"> | undefined,
  handler: (input: Input, output: Output) => Promise<void>,
): (input: Input, output: Output) => Promise<void> {
  if (!ledger) return handler
  return async (input, output) => {
    ledger.claimSession(input.sessionID)
    await handler(input, output)
  }
}

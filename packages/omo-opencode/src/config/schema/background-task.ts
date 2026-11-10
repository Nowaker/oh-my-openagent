import { z } from "zod"

/** A kill limit in milliseconds: `0` turns it off (never kill), anything else must be at least `minimum`. */
function killLimitMs(minimum: number) {
  return z.union([z.literal(0), z.number().min(minimum)])
}

const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxToolCalls: z.number().int().min(10).optional(),
  consecutiveThreshold: z.number().int().min(5).optional(),
})

export const BackgroundTaskConfigSchema = z.object({
  defaultConcurrency: z.number().min(0).optional(),
  providerConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  modelConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  maxDepth: z.number().int().min(1).optional(),
  maxLiveDescendantsPerRoot: z.number().int().min(0).optional(),
  /** Cancel a running background task that shows no activity for this long, in milliseconds (default: 2700000 = 45 minutes, minimum: 60000 = 1 minute, 0 = never). */
  staleTimeoutMs: killLimitMs(60000).optional(),
  /** Cancel a running background task that has not reported any progress this long after it started, in milliseconds (default: 3600000 = 60 minutes, minimum: 60000 = 1 minute, 0 = never). */
  messageStalenessTimeoutMs: killLimitMs(60000).optional(),
  /** Drop a queued or running background task whose last activity (or start, without progress) is this old, in milliseconds (default: 1800000 = 30 minutes, minimum: 300000 = 5 minutes, 0 = never). Pending parent notifications older than this are dropped with it. */
  taskTtlMs: killLimitMs(300000).optional(),
  /** Timeout for tasks whose session has completely disappeared from the status registry (default: 60000 = 1 minute, minimum: 10000 = 10 seconds). When a session is gone (likely crashed), this shorter timeout is used instead of the normal stale timeout. */
  sessionGoneTimeoutMs: z.number().min(10000).optional(),
  /** Delay before removing completed/cancelled/errored tasks from memory and deleting completed sync subagent sessions, in milliseconds (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). */
  taskCleanupDelayMs: z.number().min(60000).optional(),
  /** Abort a foreground (run_in_background=false) task child after this long without observable activity, in milliseconds (default: 1800000 = 30 minutes, minimum: 60000 = 1 minute, 0 = never). A foreground call_omo_agent waits at most this long in total (5 minutes when unset). */
  syncPollTimeoutMs: killLimitMs(60000).optional(),
  /** Abort a foreground task child after this many assistant turns, as a runaway loop (default: 300, 0 = no cap). */
  syncMaxAssistantTurns: z.number().int().min(0).optional(),
  /** Hand a foreground (run_in_background=false) task or call_omo_agent child that is still running after this long to the background, in milliseconds: the child keeps running under the same task id and its completion notice wakes the parent (default: 0 = never; the parent waits for it). */
  foregroundHandoffMs: z.number().int().min(0).optional(),
  /** How long a notice for a parent session whose turn is still running waits before OMO stores it in that session anyway, in milliseconds: the running turn reads it at its next tool step (default: 60000 = 1 minute, 0 = at once). Covers background task, background bash and monitor notices; until then a notice waits for the turn to end. */
  busyParentWakeDelayMs: z.number().int().min(0).optional(),
  /** Minimum age of a background-owners recovery file before the hourly sweep examines it, in milliseconds (default: 86400000 = 24 hours, minimum: 3600000 = 1 hour). The sweep removes a record only when its owner is dead and its child session is gone, plus abandoned lock and temp files. */
  recoverySweepMinAgeMs: z.number().min(3600000).optional(),
  /** Maximum tool calls per subagent task before circuit breaker triggers (default: 200, minimum: 10). Prevents runaway loops from burning unlimited tokens. */
  maxToolCalls: z.number().int().min(10).optional(),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
})

export type BackgroundTaskConfig = z.infer<typeof BackgroundTaskConfigSchema>

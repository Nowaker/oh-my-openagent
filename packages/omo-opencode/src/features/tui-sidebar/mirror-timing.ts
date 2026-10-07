import {
  HEARTBEAT_ENV,
  HEARTBEAT_MS,
  IDLE_RECHECK_ENV,
  IDLE_RECHECK_MS,
  MAX_IDLE_RECHECK_MS,
  MIN_HEARTBEAT_MS,
  MIRROR_KEEPALIVE_MS,
} from "./constants"

export type MirrorTiming = {
  readonly heartbeatMs: number
  readonly idleRecheckMs: number
}

type MirrorTimingEnv = Readonly<Record<string, string | undefined>>

function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value.trim())
  return parsed > 0 ? parsed : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// The heartbeat also carries the keepalive for an active snapshot, so it is capped at the
// keepalive age: a slower heartbeat would let readers drop a live snapshot as stale.
export function resolveMirrorTiming(env: MirrorTimingEnv = process.env): MirrorTiming {
  const heartbeatMs = clamp(readPositiveInt(env[HEARTBEAT_ENV]) ?? HEARTBEAT_MS, MIN_HEARTBEAT_MS, MIRROR_KEEPALIVE_MS)
  const idleRecheckMs = clamp(readPositiveInt(env[IDLE_RECHECK_ENV]) ?? IDLE_RECHECK_MS, heartbeatMs, MAX_IDLE_RECHECK_MS)
  return { heartbeatMs, idleRecheckMs }
}

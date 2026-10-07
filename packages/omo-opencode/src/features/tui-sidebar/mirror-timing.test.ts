import { describe, expect, it } from "bun:test"

import {
  HEARTBEAT_ENV,
  HEARTBEAT_MS,
  IDLE_RECHECK_ENV,
  IDLE_RECHECK_MS,
  MIN_HEARTBEAT_MS,
  MIRROR_KEEPALIVE_MS,
} from "./constants"
import { resolveMirrorTiming } from "./mirror-timing"

describe("resolveMirrorTiming", () => {
  it("#given no env overrides #when resolving #then it uses the defaults", () => {
    expect(resolveMirrorTiming({})).toEqual({ heartbeatMs: HEARTBEAT_MS, idleRecheckMs: IDLE_RECHECK_MS })
  })

  it("#given valid overrides #when resolving #then it uses them", () => {
    expect(resolveMirrorTiming({ [HEARTBEAT_ENV]: "1000", [IDLE_RECHECK_ENV]: "30000" }))
      .toEqual({ heartbeatMs: 1_000, idleRecheckMs: 30_000 })
  })

  it("#given a heartbeat slower than the keepalive age #when resolving #then it is capped so live snapshots never go stale", () => {
    expect(resolveMirrorTiming({ [HEARTBEAT_ENV]: "60000" }).heartbeatMs).toBe(MIRROR_KEEPALIVE_MS)
  })

  it("#given too-small or malformed values #when resolving #then they are clamped or ignored", () => {
    // given
    const env = { [HEARTBEAT_ENV]: "1", [IDLE_RECHECK_ENV]: "soon" }

    // when
    const timing = resolveMirrorTiming(env)

    // then
    expect(timing.heartbeatMs).toBe(MIN_HEARTBEAT_MS)
    expect(timing.idleRecheckMs).toBe(IDLE_RECHECK_MS)
  })

  it("#given an idle recheck shorter than the heartbeat #when resolving #then it is raised to the heartbeat", () => {
    expect(resolveMirrorTiming({ [HEARTBEAT_ENV]: "3000", [IDLE_RECHECK_ENV]: "500" }).idleRecheckMs).toBe(3_000)
  })
})

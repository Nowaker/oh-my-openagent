import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { writeBoulderState, type BoulderState } from "../../features/boulder-state"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import { injectBoulderContinuation } from "../atlas/boulder-continuation-injector"
import { handleCompletedBoulderIdle } from "../atlas/idle-completion-nudge"
import { injectContinuationPrompt } from "../ralph-loop/continuation-prompt-injector"
import { injectContinuation } from "../todo-continuation-enforcer/continuation-injection"
import { createSessionStateStore } from "../todo-continuation-enforcer/session-state"
import { dispatchInternalPrompt, releaseAllPromptAsyncReservationsForTesting } from "./prompt-async-gate"

type ContinuationCase = {
  readonly name: string
  readonly run: (ctx: PluginInput, sessionID: string, boulder: BoulderState) => Promise<unknown>
}

const continuations: readonly ContinuationCase[] = [
  {
    name: "todo continuation",
    run: (ctx, sessionID) => injectContinuation({
      ctx,
      sessionID,
      resolvedInfo: { agent: "sisyphus", model: { providerID: "test", modelID: "test" } },
      sessionStateStore: createSessionStateStore(),
    }),
  },
  {
    name: "Atlas/Boulder continuation",
    run: (ctx, sessionID) => injectBoulderContinuation({
      ctx, sessionID, planName: "pause-plan", remaining: 1, total: 2,
      agent: "atlas", sessionState: { promptFailureCount: 0 }, idleSettleMs: 0,
    }),
  },
  {
    name: "Ralph loop continuation",
    run: (ctx, sessionID) => injectContinuationPrompt(ctx, {
      sessionID, prompt: "continue", directory: ctx.directory, apiTimeoutMs: 100, idleSettleMs: 0,
    }),
  },
  {
    name: "idle completion nudge",
    run: (ctx, sessionID, boulder) => handleCompletedBoulderIdle({
      ctx, sessionID, boulderState: boulder, sessionState: { promptFailureCount: 0 },
      options: { idleSettleMs: 0 },
    }),
  },
]

const statusCases = [
  { name: "paused", status: { type: "idle", paused: { at: 1, mode: "soft", state: "paused", source: "user" } }, calls: 0 },
  { name: "pause pending", status: { type: "idle", paused: { at: 1, mode: "soft", state: "pending", source: "user" } }, calls: 0 },
  { name: "unpaused", status: { type: "idle", paused: null }, calls: 1 },
  { name: "older status without pause field", status: { type: "idle" }, calls: 1 },
  { name: "status read failure", status: undefined, calls: 1 },
  { name: "older client without status", status: undefined, calls: 1 },
] as const

describe("automatic continuation respects session pause", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paused-continuation-"))
    _resetForTesting()
    registerAgentName("atlas")
    registerAgentName("sisyphus")
  })

  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
    _resetForTesting()
    rmSync(directory, { recursive: true, force: true })
  })

  for (const continuation of continuations) {
    for (const statusCase of statusCases) {
      test(`${continuation.name}: ${statusCase.name} dispatches ${statusCase.calls} prompts`, async () => {
        // given
        const sessionID = "ses_pause"
        let promptCalls = 0
        const status = async () => {
          if (statusCase.name === "status read failure") throw new Error("status unavailable")
          return { data: { [sessionID]: statusCase.status } }
        }
        const ctx = unsafeTestValue<PluginInput>({
          directory,
          client: { session: {
            ...(statusCase.name === "older client without status" ? {} : { status }),
            get: async () => ({ data: { id: sessionID } }),
            todo: async () => ({ data: [{ id: "1", content: "pending work", status: "pending", priority: "high" }] }),
            messages: async () => ({ data: [] }),
            promptAsync: async () => { promptCalls += 1; return {} },
          } },
        })
        const boulder: BoulderState = {
          schema_version: 2, active_work_id: "work-pause", active_plan: join(directory, "plan.md"),
          started_at: "2026-11-14T00:00:00.000Z", session_ids: [sessionID], plan_name: "pause-plan", agent: "atlas",
          works: { "work-pause": {
            work_id: "work-pause", active_plan: join(directory, "plan.md"), plan_name: "pause-plan",
            started_at: "2026-11-14T00:00:00.000Z", session_ids: [sessionID], status: "active",
          } },
        }
        writeBoulderState(directory, boulder)

        // when
        const result = await continuation.run(ctx, sessionID, boulder)

        // then
        expect(promptCalls).toBe(statusCase.calls)
        if (continuation.name === "Ralph loop continuation" && statusCase.calls === 0) {
          expect(result).toEqual({ status: "deferred", reason: "active" })
        }
      })
    }
  }

  test("rechecks pause after the existing dispatch guard finishes", async () => {
    // given
    let paused = false
    let promptCalls = 0
    const client = { session: {
      status: async () => ({ data: { ses_late_pause: { type: "idle", paused: paused ? { state: "paused" } : null } } }),
      promptAsync: async () => { promptCalls += 1; return {} },
    } }

    // when
    await dispatchInternalPrompt({
      mode: "async", client, sessionID: "ses_late_pause", source: "todo-continuation-enforcer",
      input: {}, settleMs: 0, queueBehavior: "defer",
      shouldDispatch: async () => { paused = true; return true },
    })

    // then
    expect(promptCalls).toBe(0)
  })

  for (const source of ["background-agent", "session-recovery"]) {
    test(`preserves ${source} delivery to a paused session`, async () => {
      // given
      let promptCalls = 0
      const client = { session: {
        status: async () => ({ data: { ses_report: { type: "idle", paused: { state: "paused" } } } }),
        promptAsync: async () => { promptCalls += 1; return {} },
      } }

      // when
      await dispatchInternalPrompt({
        mode: "async", client, sessionID: "ses_report", source, input: {}, settleMs: 0, queueBehavior: "defer",
      })

      // then
      expect(promptCalls).toBe(1)
    })
  }
})

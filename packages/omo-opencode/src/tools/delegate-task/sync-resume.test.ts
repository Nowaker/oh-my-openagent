import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getDataDir } from "../../shared/data-path"
import { releaseDelegatedSessionRuntime } from "../../shared/delegated-session-runtime"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { getSessionModel } from "../../shared/session-model-state"
import { getSessionPromptParams } from "../../shared/session-prompt-params-state"
import { getSessionTools } from "../../shared/session-tools-store"
import { cancelSyncSessionCleanup } from "./sync-session-cleanup"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { SessionMessage } from "./executor-types"
import type { DelegatedModelConfig } from "./types"

const { executeSyncTask } = require("./sync-task")
const { executeSyncContinuation } = require("./sync-continuation")
const sessionID = "ses_cold_sync_resume"
const originalModel: DelegatedModelConfig = {
  providerID: "openai", modelID: "gpt-5.4", variant: "high",
  temperature: 0.27, top_p: 0.61, maxTokens: 1234,
  reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 512 },
  tools: { bash: false, read: false },
}

describe("sync resume configuration", () => {
  let dataHome: string
  let originalDataHome: string | undefined

  beforeEach(() => {
    originalDataHome = process.env.XDG_DATA_HOME
    dataHome = mkdtempSync(join(getDataDir(), "sync-resume-test-"))
    process.env.XDG_DATA_HOME = dataHome
    __setTimingConfig({ POLL_INTERVAL_MS: 0, MIN_STABILITY_TIME_MS: 0, STABILITY_POLLS_REQUIRED: 1 })
  })

  afterEach(() => {
    cancelSyncSessionCleanup(sessionID)
    releaseDelegatedSessionRuntime(sessionID)
    releasePromptAsyncReservation(sessionID, "model-suggestion-retry")
    __resetTimingConfig()
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalDataHome
    rmSync(dataHome, { recursive: true, force: true })
  })

  test.each([
    { name: "message context is absent", observed: undefined, model: { providerID: "openai", modelID: "gpt-5.4" }, variant: "high" },
    { name: "a runtime fallback is the latest observed model", observed: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "low" }, model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, variant: "low" },
  ])("restores configuration before generation after retirement when $name", async ({ observed, model, variant }) => {
    //#given - the production default dependency chain creates and sends the sync task
    const messages: SessionMessage[] = []
    const prompts: unknown[] = []
    const generations: unknown[] = []
    const client = {
      session: {
        get: async () => ({ data: { id: "parent", directory: "/fixture/project" } }),
        create: async () => ({ data: { id: sessionID } }),
        messages: async () => ({ data: messages }),
        status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        abort: async () => { releasePromptAsyncReservation(sessionID, "model-suggestion-retry") },
        promptAsync: async (input: { body: { agent?: string; model?: { providerID: string; modelID: string }; variant?: string } }) => {
          prompts.push(input.body)
          generations.push({
            agent: getSessionAgent(sessionID), model: getSessionModel(sessionID),
            params: getSessionPromptParams(sessionID), tools: getSessionTools(sessionID),
          })
          messages.push({ info: { id: `msg_${messages.length}_0`, role: "user" } })
          messages.push({
            info: { id: `msg_${messages.length}_1`, role: "assistant", finish: "stop", time: { created: messages.length + 1 } },
            parts: [{ type: "text", text: "fixture completion" }],
          })
        },
      },
    }
    const ctx = { sessionID: "parent", messageID: "parent_message", callID: "call", agent: "sisyphus", abort: new AbortController().signal, metadata: () => {} }
    const executor = { client, directory: "/fixture/project" }
    const parent = { sessionID: "parent", messageID: "parent_message" }
    const args = { description: "fixture", prompt: "fixture", load_skills: [], run_in_background: false }
    const initial = await executeSyncTask(args, ctx, executor, parent, "oracle", originalModel, undefined)
    expect(initial).toContain("fixture completion")
    releaseDelegatedSessionRuntime(sessionID)
    messages.length = 0
    if (observed) messages.push({ info: { id: "msg_fallback", role: "assistant", ...observed } })

    //#when - the continuation has no category, model, or tool configuration supplied
    const result = await executeSyncContinuation({ ...args, task_id: sessionID }, ctx, executor, parent)

    //#then - the request protocol and hook-visible caches agree before generation
    expect(result).toContain("fixture completion")
    const expectedParams = {
      temperature: 0.27, topP: 0.61, maxOutputTokens: 1234,
      options: { reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 512 } },
    }
    expect(prompts[1]).toMatchObject({ agent: "oracle", model, variant, ...expectedParams, tools: { bash: false, read: false, write: false, edit: false, task: false, question: false, call_omo_agent: false } })
    expect(generations[1]).toMatchObject({ agent: "oracle", model, params: expectedParams, tools: { bash: false, read: false, question: false, call_omo_agent: false } })
  })
})

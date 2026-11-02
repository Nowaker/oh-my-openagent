import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getDataDir } from "../../shared/data-path"
import { releaseDelegatedSessionRuntime } from "../../shared/delegated-session-runtime"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { getSessionModel } from "../../shared/session-model-state"
import { getSessionPromptParams } from "../../shared/session-prompt-params-state"
import { getSessionTools } from "../../shared/session-tools-store"
import * as syncSessionCleanup from "./sync-session-cleanup"
import { SyncResumeStore } from "./sync-resume-store"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { SessionMessage } from "./executor-types"
import type { DelegatedModelConfig } from "./types"

const { executeSyncTask } = require("./sync-task")
const { executeSyncContinuation } = require("./sync-continuation")
const { BackgroundManager } = require("../../features/background-agent/manager")
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
  const managers = new Set<{ shutdown(): Promise<void> }>()

  beforeEach(() => {
    originalDataHome = process.env.XDG_DATA_HOME
    dataHome = mkdtempSync(join(getDataDir(), "sync-resume-test-"))
    process.env.XDG_DATA_HOME = dataHome
    __setTimingConfig({ POLL_INTERVAL_MS: 0, MIN_STABILITY_TIME_MS: 0, STABILITY_POLLS_REQUIRED: 1 })
  })

  afterEach(async () => {
    await Promise.all(Array.from(managers, (manager) => manager.shutdown()))
    managers.clear()
    syncSessionCleanup.cancelSyncSessionCleanup(sessionID)
    releaseDelegatedSessionRuntime(sessionID)
    releasePromptAsyncReservation(sessionID, "model-suggestion-retry")
    __resetTimingConfig()
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalDataHome
    rmSync(dataHome, { recursive: true, force: true })
  })

  const observedCases = [
    { name: "message context is absent", observed: undefined, model: { providerID: "openai", modelID: "gpt-5.4" }, variant: "high" },
    { name: "a runtime fallback is the latest observed model", observed: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "low" }, model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, variant: "low" },
  ]
  test.each([
    ...observedCases.map((row) => ({ ...row, source: "sync" })),
    ...observedCases.map((row) => ({ ...row, source: "background" })),
    ...observedCases.map((row) => ({ ...row, source: "restarted background" })),
    { ...observedCases[0], source: "foreign background" },
    { ...observedCases[0], source: "background prompt failure" },
    { name: "reasoning is lowered for a new observed model", observed: { providerID: "fixture", modelID: "no-variants", variant: undefined }, model: { providerID: "fixture", modelID: "no-variants" }, variant: undefined, source: "background reasoning" },
  ])("applies $source continuation authority and configuration after retirement when $name", async ({ observed, model, variant, source }) => {
    //#given - the production default dependency chain creates and sends the sync task
    const messages: SessionMessage[] = []
    const prompts: unknown[] = []
    const generations: unknown[] = []
    const dispatched = Promise.withResolvers<void>()
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: path.id === sessionID ? "parent" : undefined, directory: dataHome } }),
        create: async () => ({ data: { id: sessionID } }),
        messages: async () => ({ data: messages }),
        status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        abort: async () => {
          releasePromptAsyncReservation(sessionID, "model-suggestion-retry")
          releasePromptAsyncReservation(sessionID, "background-agent-launch")
        },
        promptAsync: async (input: { body: { agent?: string; model?: { providerID: string; modelID: string }; variant?: string } }) => {
          if (source === "background prompt failure" && prompts.length === 1) throw new Error("fixture prompt failure")
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
          dispatched.resolve()
        },
      },
    }
    const ctx = { sessionID: "parent", messageID: "parent_message", callID: "call", agent: "sisyphus", abort: new AbortController().signal, metadata: () => {} }
    const manager = new BackgroundManager({ pluginContext: { client, directory: dataHome } })
    managers.add(manager)
    const executor = { client, directory: dataHome, manager }
    const parent = { sessionID: "parent", messageID: "parent_message" }
    const args = { description: "fixture", prompt: "fixture", load_skills: [], run_in_background: false }
    const delegatedModel = source === "background reasoning"
      ? { ...originalModel, reasoning: "medium", reasoningEffort: "stale" }
      : originalModel
    if (source === "sync") {
      const initial = await executeSyncTask(args, ctx, executor, parent, "oracle", originalModel, undefined)
      expect(initial).toContain("fixture completion")
      messages.length = 0
      manager.prepareSyncContinuation = async () => { throw new Error("Native sync must not claim background ownership") }
    } else {
      const task = await manager.launch({
        agent: "oracle", description: "fixture", prompt: "fixture", model: delegatedModel,
        parentSessionId: "parent", parentMessageId: "parent_message",
        userPermission: { bash: "deny", read: "deny", webfetch: "deny", call_omo_agent: "deny" },
      })
      await dispatched.promise
      expect(await manager.cancelTask(task.id, { skipNotification: true })).toBe(true)
    }
    await manager.retireSessionRuntime(sessionID)
    if (source === "restarted background" || source === "foreign background") {
      if (source === "restarted background") await manager.shutdown()
      executor.manager = new BackgroundManager({ pluginContext: { client, directory: dataHome } })
      managers.add(executor.manager)
    }
    expect(getSessionModel(sessionID)).toBeUndefined()
    expect(getSessionPromptParams(sessionID)).toBeUndefined()
    expect(getSessionTools(sessionID)).toBeUndefined()
    if (observed) messages.push({ info: { id: "msg_fallback", role: "assistant", agent: "explore", ...observed } })
    const retirements: string[] = []
    executor.manager.setSessionRuntimeRetirementHandler(async (id: string) => { retirements.push(id) })
    const cleanupSpy = spyOn(syncSessionCleanup, "scheduleSyncSessionCleanup")
    let cleanupCalls: Array<Parameters<typeof syncSessionCleanup.scheduleSyncSessionCleanup>> = []
    let result: string

    //#when - the continuation has no category, model, or tool configuration supplied
    try {
      result = await executeSyncContinuation({ description: "fixture", prompt: "fixture", load_skills: [], task_id: sessionID }, ctx, executor, parent)
      cleanupCalls = [...cleanupSpy.mock.calls]
    } finally {
      cleanupSpy.mockRestore()
    }

    //#then - the request protocol and hook-visible caches agree before generation
    if (source === "foreign background" || source === "background prompt failure") {
      for (const [id, , retire] of cleanupCalls) await retire?.(id)
      const foreign = source === "foreign background"
      expect(result).toContain(foreign ? "owner is live or its liveness is unknown" : "fixture prompt failure")
      expect(prompts).toHaveLength(1)
      expect(generations).toHaveLength(1)
      expect(cleanupCalls).toHaveLength(foreign ? 0 : 1)
      expect(retirements).toEqual(foreign ? [] : [sessionID])
      expect(new SyncResumeStore().read(sessionID)).toBeUndefined()
      return
    }
    expect(result).toContain("fixture completion")
    const expectedParams = {
      temperature: 0.27, topP: 0.61, maxOutputTokens: 1234,
      options: { reasoningEffort: source === "background reasoning" ? "medium" : "high", thinking: { type: "enabled", budgetTokens: 512 } },
    }
    const agent = observed ? "explore" : "oracle"
    const tools = { bash: false, read: false, write: false, edit: false, task: false, question: false, call_omo_agent: false }
    expect(prompts[1]).toMatchObject({ agent, model, ...(variant !== undefined ? { variant } : {}), ...expectedParams, tools })
    if (variant === undefined) expect(prompts[1]).not.toHaveProperty("variant")
    expect(generations[1]).toMatchObject({ agent, model, params: expectedParams, tools })
    if (source !== "sync") {
      expect(generations[1]).toMatchObject({ tools: { webfetch: false } })
      expect(new SyncResumeStore().read(sessionID)).toBeUndefined()
    }
  })
})

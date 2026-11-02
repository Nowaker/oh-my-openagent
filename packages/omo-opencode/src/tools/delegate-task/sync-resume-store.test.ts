import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getDataDir } from "../../shared/data-path"
import { SyncResumeIdentityError, SyncResumeStore, type SyncResumeRecord } from "./sync-resume-store"

describe("SyncResumeStore storage boundary", () => {
  let dataHome: string
  let originalDataHome: string | undefined
  const record: SyncResumeRecord = {
    version: 1, sessionId: "ses_store_resume", agent: "oracle",
    model: { providerID: "fixture", modelID: "model", variant: "high", temperature: 0.17, top_p: 0.53, maxTokens: 321, reasoningEffort: "high" },
    tools: { bash: false, task: false, question: false },
  }

  beforeEach(() => {
    originalDataHome = process.env.XDG_DATA_HOME
    dataHome = mkdtempSync(join(getDataDir(), "sync-resume-store-test-"))
    process.env.XDG_DATA_HOME = dataHome
  })

  afterEach(() => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalDataHome
    rmSync(dataHome, { recursive: true, force: true })
  })

  test("publishes one private schema-parsed file with no temporary remainder", () => {
    //#given
    const store = new SyncResumeStore()
    const root = join(getDataDir(), "omo", "sync-resume")

    //#when
    store.write(record)

    //#then - the disk format is an independent recovery contract
    const filename = `${createHash("sha256").update(record.sessionId).digest("hex")}.json`
    expect(readdirSync(root)).toEqual([filename])
    expect(JSON.parse(readFileSync(join(root, filename), "utf8"))).toEqual(record)
    if (process.platform !== "win32") expect(statSync(join(root, filename)).mode & 0o777).toBe(0o600)
  })

  test("rejects mismatched session identity instead of applying another child's restrictions", () => {
    //#given
    const store = new SyncResumeStore()
    store.write(record)
    const path = join(getDataDir(), "omo", "sync-resume", `${createHash("sha256").update(record.sessionId).digest("hex")}.json`)
    writeFileSync(path, JSON.stringify({ ...record, sessionId: "another_session" }))

    //#when / #then
    expect(() => store.read(record.sessionId)).toThrow(SyncResumeIdentityError)
  })

  test("rejects an invalid update without replacing the recoverable record", () => {
    //#given
    const store = new SyncResumeStore()
    store.write(record)

    //#when / #then
    expect(() => store.write({ ...record, model: { providerID: "fixture", modelID: "" } })).toThrow()
    expect(new SyncResumeStore().read(record.sessionId)).toEqual(record)
    expect(new SyncResumeStore().read("missing_session")).toBeUndefined()
  })

  test("hydrates continuation generation in a fresh process without category configuration", async () => {
    //#given - only the durable record crosses the process boundary
    new SyncResumeStore().write(record)
    const continuationPath = new URL("./sync-continuation.ts", import.meta.url).pathname
    const modelStatePath = new URL("../../shared/session-model-state.ts", import.meta.url).pathname
    const paramsStatePath = new URL("../../shared/session-prompt-params-state.ts", import.meta.url).pathname
    const toolsStatePath = new URL("../../shared/session-tools-store.ts", import.meta.url).pathname
    const agentStatePath = new URL("../../features/claude-code-session-state/index.ts", import.meta.url).pathname
    const source = `
      const { executeSyncContinuation } = await import(${JSON.stringify(continuationPath)})
      const { getSessionModel } = await import(${JSON.stringify(modelStatePath)})
      const { getSessionPromptParams } = await import(${JSON.stringify(paramsStatePath)})
      const { getSessionTools } = await import(${JSON.stringify(toolsStatePath)})
      const { getSessionAgent } = await import(${JSON.stringify(agentStatePath)})
      const id = ${JSON.stringify(record.sessionId)}
      let generation
      const client = { session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        promptAsync: async ({ body }) => { generation = {
          body, agent: getSessionAgent(id), model: getSessionModel(id),
          params: getSessionPromptParams(id), tools: getSessionTools(id),
        } },
      } }
      await executeSyncContinuation(
        { task_id: id, prompt: "fixture", description: "fixture", load_skills: [], run_in_background: false },
        { sessionID: "parent", metadata() {} },
        { client, directory: "/fixture" }, { sessionID: "parent", messageID: "parent_message" },
        { pollSyncSession: async () => null, fetchSyncResult: async () => ({ ok: true, textContent: "completed" }) },
      )
      console.log(JSON.stringify(generation))
    `

    //#when
    const child = Bun.spawn([process.execPath, "--eval", source], {
      env: { ...process.env, XDG_DATA_HOME: dataHome }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    })
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    //#then
    expect({ error, exit }).toEqual({ error: "", exit: 0 })
    expect(JSON.parse(output)).toMatchObject({
      body: { agent: "oracle", model: { providerID: "fixture", modelID: "model" }, variant: "high", temperature: 0.17, topP: 0.53, maxOutputTokens: 321, tools: { bash: false, write: false, call_omo_agent: false } },
      agent: "oracle", model: { providerID: "fixture", modelID: "model" },
      params: { temperature: 0.17, topP: 0.53, maxOutputTokens: 321, options: { reasoningEffort: "high" } },
      tools: { bash: false, write: false, call_omo_agent: false },
    })
  })
})

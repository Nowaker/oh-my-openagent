import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { SessionIdle } from "@opencode/plugin/promise/session"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { DEFAULT_SKIP_AGENTS } from "../hooks/todo-continuation-enforcer/constants"
import { getAgentDisplayName } from "../shared/agent-display-names"
import { registerNativeIdle } from "./native-idle"
import { nativeTodos } from "./native-todos"
import { assistantMessage, createClientFixture, sessionInfo } from "./v1-client-fixture.test"
import type { V2SessionMessage } from "./v1-session-messages"

const authorityKey = "__vibetermContinuationAuthorityV1"
const originalAuthority: unknown = Reflect.get(globalThis, authorityKey)
const originalMachine = process.env.VIBETERM_MACHINE_ID
const sessionID = unsafeTestValue<SessionIdle["sessionID"]>("session")
const childSessionID = unsafeTestValue<SessionIdle["sessionID"]>("child")
const descendantSessionID = unsafeTestValue<SessionIdle["sessionID"]>("descendant")
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  Reflect.set(globalThis, authorityKey, originalAuthority)
  if (originalMachine === undefined) delete process.env.VIBETERM_MACHINE_ID
  else process.env.VIBETERM_MACHINE_ID = originalMachine
})

function fixture() {
  Reflect.set(globalThis, authorityKey, undefined)
  delete process.env.VIBETERM_MACHINE_ID
  const { ctx: client } = createClientFixture()
  const callbacks = new Set<(event: SessionIdle) => Promise<void>>()
  const admitted: Parameters<Parameters<typeof registerNativeIdle>[0]["session"]["synthetic"]>[0][] = []
  let messages: readonly V2SessionMessage[] = []
  let stopped = false
  const ctx = { session: {
    get: client.session.get,
    context: async () => [...messages],
    synthetic: async (input) => {
      admitted.push(input)
      return { id: "synthetic", sessionID: input.sessionID, type: "synthetic" as const,
        time: { created: 3 }, delivery: "queue" as const, payload: { text: input.text } }
    },
    hook: async (_name, callback) => {
      callbacks.add(callback)
      return { dispose: async () => { callbacks.delete(callback) } }
    },
  } } satisfies Parameters<typeof registerNativeIdle>[0]
  const input = unsafeTestValue<PluginInput>({ directory: "/scratch/project", client: { session: {
    get: async () => ({ data: await ctx.session.get({ sessionID: "session" }) }),
    todo: async () => ({ data: await nativeTodos(ctx.session, "session") }),
  } } })
  const setTodos = (statuses: readonly string[], content = "task") => {
    messages = [{ ...assistantMessage, content: [{ type: "tool", id: "todo", name: "todowrite", time: { created: 1 },
      state: { status: "completed", input: {}, metadata: { todos: statuses.map((status, index) => ({ content: `${content} ${index}`, status })) },
        content: [{ type: "text", text: "Todos updated" }] } }] }]
  }
  setTodos(["pending", "in_progress"])
  return { ctx, input, admitted, setTodos, stop: () => { stopped = true },
    idle: async (background: SessionIdle["background"] = []) => {
      for (const callback of callbacks) await callback({ sessionID, background })
    },
    register: async (enabled = true) => {
      const cleanup = await registerNativeIdle(ctx, { input, enabled, isStopped: () => stopped })
      cleanups.push(cleanup)
      return cleanup
    },
  }
}

function authority() {
  let active = true
  let generation = "one"
  const binding = () => ({ version: 1, sessionId: "session", machineId: "machine", generation, scopeId: "scope" })
  process.env.VIBETERM_MACHINE_ID = "machine"
  Reflect.set(globalThis, authorityKey, {
    binding,
    capture: (_id: string, plan: unknown) => active ? { binding: binding(), plan } : null,
    validate: () => active,
    stop: () => { active = false }, freshPlan: () => { generation = "two" },
  })
  return { revoke: () => { active = false }, fresh: () => { generation = "two" } }
}

describe("native todo idle continuation", () => {
  test("admits a native continuation with current incomplete tasks", async () => {
    // given
    const f = fixture()
    f.setTodos(["completed", "pending", "cancelled", "in_progress"])
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toHaveLength(1)
    expect(f.admitted[0]?.text).toContain("task 1")
    expect(f.admitted[0]?.text).toContain("task 3")
    expect(f.admitted[0]?.text).not.toContain("task 0")
    expect(f.admitted[0]?.text).not.toContain("task 2")
  })

  test.each([{ statuses: [] }, { statuses: ["completed", "cancelled"] }])("stays quiet for finished todos: %j", async ({ statuses }) => {
    // given
    const f = fixture()
    f.setTodos(statuses)
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  test.each(["disabled", "stopped", "disposed"] as const)("stays quiet when %s", async (guard) => {
    // given
    const f = fixture()
    const cleanup = await f.register(guard !== "disabled")
    if (guard === "stopped") f.stop()
    if (guard === "disposed") await cleanup()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  test.each(DEFAULT_SKIP_AGENTS)("skips the native %s agent including its display name", async (agent) => {
    // given
    const f = fixture()
    f.ctx.session.get = async () => ({ ...sessionInfo, agent: getAgentDisplayName(agent) })
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  test("uses the actual assistant agent when the session uses a default selection", async () => {
    // given
    const f = fixture()
    f.ctx.session.get = async () => ({ ...sessionInfo, agent: undefined })
    const context = f.ctx.session.context
    f.ctx.session.context = async () => (await context()).map((message) => message.type === "assistant" ? { ...message, agent: "plan" } : message)
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  const background: SessionIdle["background"] = [
    { kind: "shell", sessionID, shellID: "shell", command: "build" },
    { kind: "subagent", sessionID, childSessionID, agent: "worker", description: "work" },
    { kind: "image", sessionID, path: "image.png", model: "image" },
  ]
  test.each(background)("waits for its own native background job: %j", async (work) => {
    // given
    const f = fixture()
    await f.register()
    // when
    await f.idle([work])
    // then
    expect(f.admitted).toEqual([])
  })

  test("does not wait for descendant-owned jobs or emit their completion notices", async () => {
    // given
    const f = fixture()
    await f.register()
    // when
    await f.idle(background.map((work) => ({ ...work, sessionID: descendantSessionID })))
    // then
    expect(f.admitted).toHaveLength(1)
    expect(f.admitted[0]?.metadata).toEqual({ source: "omo.todo-continuation" })
  })

  test("pauses after an unchanged response, including wording-only edits, and resumes on todo progress", async () => {
    // given
    const f = fixture()
    await f.register()
    await f.idle()
    f.setTodos(["pending", "in_progress"], "reworded")
    // when
    await f.idle()
    await f.idle()
    expect(f.admitted).toHaveLength(1)
    f.setTodos(["completed", "in_progress"])
    await f.idle()
    // then
    expect(f.admitted).toHaveLength(2)
  })

  test("rechecks the stop guard after reading native context", async () => {
    // given
    const f = fixture()
    const context = f.ctx.session.context
    f.ctx.session.context = async () => { f.stop(); return context() }
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  test("does not mistake compacted-away todos for a cleared list or reset the progress pause", async () => {
    // given
    const f = fixture()
    await f.register()
    await f.idle()
    const context = f.ctx.session.context
    f.ctx.session.context = async () => [{ type: "compaction", id: "compact", status: "completed", reason: "auto", time: { created: 5 }, summary: "Work remains" }]
    // when
    await f.idle()
    f.ctx.session.context = context
    await f.idle()
    // then
    expect(f.admitted).toHaveLength(1)
  })

  test.each(["missing", "revoked", "wrong-machine", "copied-policy"] as const)("rejects %s host continuation authority", async (guard) => {
    // given
    const f = fixture()
    if (guard === "missing") process.env.VIBETERM_MACHINE_ID = "machine"
    if (guard === "revoked") authority().revoke()
    if (guard === "wrong-machine") { authority(); process.env.VIBETERM_MACHINE_ID = "other" }
    if (guard === "copied-policy") f.ctx.session.get = async () => ({ ...sessionInfo, metadata: { vibeterm: { continuationAuthority: {} } } })
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  test("rechecks a scoped permit before native admission", async () => {
    // given
    const f = fixture()
    const scope = authority()
    const todo = f.input.client.session.todo
    f.input.client.session.todo = (...args) => { scope.revoke(); return todo(...args) }
    await f.register()
    // when
    await f.idle()
    // then
    expect(f.admitted).toEqual([])
  })

  test("accepts a fresh authorized generation after a no-progress pause", async () => {
    // given
    const f = fixture()
    const scope = authority()
    await f.register()
    await f.idle()
    await f.idle()
    expect(f.admitted).toHaveLength(1)
    scope.fresh()
    // when
    await f.idle()
    // then
    expect(f.admitted).toHaveLength(2)
  })

  test("serializes concurrent native idle admissions", async () => {
    // given
    const f = fixture()
    await f.register()
    // when
    await Promise.all([f.idle(), f.idle()])
    // then
    expect(f.admitted).toHaveLength(1)
  })

  test("propagates failed admission and allows the same plan after recovery", async () => {
    // given
    const f = fixture()
    const synthetic = f.ctx.session.synthetic
    const failure = new Error("admission failed")
    f.ctx.session.synthetic = async () => { throw failure }
    await f.register()
    await expect(f.idle()).rejects.toBe(failure)
    f.ctx.session.synthetic = synthetic
    // when
    await f.idle()
    // then
    expect(f.admitted).toHaveLength(1)
  })
})

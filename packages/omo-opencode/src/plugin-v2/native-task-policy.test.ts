import { describe, expect, test } from "bun:test"
import { Model, Agent } from "@opencode/plugin"
import { z } from "zod"
import { createNativeTaskFixture } from "./native-task-test-fixture"
import { nativeTaskMetadata, NATIVE_TASK_METADATA_KEY, type NativeSession } from "./native-task-types"
import { createNativeTaskRuntime } from "./native-task-runtime"

describe("native task OMO policy", () => {
  test.each([
    { stage: "launch", tools: { task: false, call_omo_agent: true }, expected: ["deny", "allow", "allow", "allow", "ask"] },
    { stage: "launch", tools: { call_omo_agent: false, task: true }, expected: ["allow", "deny", "allow", "allow", "allow"] },
    { stage: "resume", tools: { task: false, call_omo_agent: true }, expected: ["deny", "allow", "allow", "allow", "ask"] },
    { stage: "resume", tools: { call_omo_agent: false, task: true }, expected: ["allow", "deny", "allow", "allow", "allow"] },
  ])("projects independent host frontend model-tool policy during $stage", async ({ stage, tools, expected }) => {
    const fixture = await createNativeTaskFixture()
    try {
      fixture.runtime.bindManagers({ ...fixture.bindings.config, categories: { fixture: { model: "provider/chat", tools } } }, fixture.bindings.managers)
      if (stage === "resume") await fixture.call("task", { subagent_type: "worker", prompt: "initial child" })
      await fixture.call("task", { category: "fixture", prompt: "configured tools", ...(stage === "resume" ? { task_id: "ses_child_1" } : {}) })
      const rules = fixture.sessions.get("ses_child_1")?.permissions ?? []
      const requests = [["task", "*"], ["call_omo_agent", "*"], ["subagent", "explore"], ["subagent", "librarian"], ["subagent", "worker"]]
      expect(requests.map(([action, resource]) => rules.findLast((rule) => rule.action === action && (rule.resource === "*" || rule.resource === resource))?.effect ?? "ask")).toEqual([...expected])
    } finally { await fixture.close() }
  })

  test.each([
    { stage: "launch", source: "agent" }, { stage: "launch", source: "session" },
    { stage: "resume", source: "agent" }, { stage: "resume", source: "session" },
  ])("preserves ordered $source backend policy when model tools update during $stage", async ({ stage, source }) => {
    const backend = [
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "subagent", resource: "explore", effect: "deny" },
      { action: "subagent", resource: "librarian", effect: "ask" },
      { action: "subagent", resource: "worker", effect: "deny" },
      { action: "subagent", resource: "worker", effect: "allow" },
    ] satisfies NonNullable<NativeSession["permissions"]>
    const fixture = await createNativeTaskFixture({ childPermissions: source === "session" ? backend : undefined })
    try {
      const list = fixture.ctx.agent.list
      fixture.ctx.agent.list = async () => { const result = await list(); return { ...result, data: result.data.map((agent) => ({ ...agent, permissions: source === "agent" ? backend : [] })) } }
      fixture.runtime.bindManagers({ ...fixture.bindings.config, categories: { fixture: { model: "provider/chat", tools: { task: true, call_omo_agent: false } } } }, fixture.bindings.managers)
      if (stage === "resume") await fixture.call("task", { subagent_type: "worker", prompt: "initial child" })
      await fixture.call("task", { category: "fixture", prompt: "configured tools", ...(stage === "resume" ? { task_id: "ses_child_1" } : {}) })
      const rules = fixture.sessions.get("ses_child_1")?.permissions ?? []
      expect(["explore", "librarian", "worker"].map((target) => rules.findLast((rule) => rule.action === "subagent" && (rule.resource === "*" || rule.resource === target))?.effect)).toEqual(["deny", "ask", "allow"])
    } finally { await fixture.close() }
  })

  test.each([
    { stage: "launch", action: "read" }, { stage: "launch", action: "question" },
    { stage: "resume", action: "read" }, { stage: "resume", action: "question" },
  ])("keeps an explicit child $action deny authoritative during $stage with a model allow", async ({ stage, action }) => {
    const permissions: NativeSession["permissions"] = [{ action: "*", resource: "*", effect: "allow" }, { action, resource: "*", effect: "deny" }]
    const fixture = await createNativeTaskFixture({ childPermissions: stage === "launch" ? permissions : undefined })
    try {
      fixture.runtime.bindManagers({ ...fixture.bindings.config, categories: { fixture: { model: "provider/chat", tools: { [action]: true, grep: false } } } }, fixture.bindings.managers)
      if (stage === "resume") await fixture.call("task", { subagent_type: "worker", prompt: "first work" })
      if (stage === "resume") {
        const owner = fixture.sessions.get("ses_child_1")
        if (!owner) throw new Error("Missing native permission owner")
        fixture.sessions.set(owner.id, { ...owner, permissions })
      }

      await fixture.call("task", { category: "fixture", prompt: "model permits the tool", ...(stage === "resume" ? { task_id: "ses_child_1" } : {}) })

      const rules = fixture.sessions.get("ses_child_1")?.permissions ?? []
      // Native Permission.evaluate uses the last matching action/resource rule.
      const effects = [action, "grep"].map((requested) => rules.findLast((rule) => (rule.action === requested || rule.action === "*") && rule.resource === "*")?.effect)
      expect(effects).toEqual(["deny", "deny"])
    } finally { await fixture.close() }
  })

  test("canonical reasoning keeps the shared lowerer's provider effort representation", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      fixture.runtime.bindManagers({ ...fixture.bindings.config, categories: { fixture: { model: "provider/chat", reasoning: "high" } } }, fixture.bindings.managers)
      await fixture.call("task", { category: "fixture", prompt: "reasoning work" })
      const metadata = nativeTaskMetadata.parse(fixture.sessions.get("ses_child_1")?.metadata?.[NATIVE_TASK_METADATA_KEY])
      expect(metadata.settings?.reasoningEffort).toBe("high")
    } finally { await fixture.close() }
  })

  test("explicit agent continuation clears the old category and preserves the switch after recreation", async () => {
    const fixture = await createNativeTaskFixture()
    const recreated = createNativeTaskRuntime(fixture.ctx)
    try {
      await fixture.call("task", { category: "fixture", prompt: "category work" })
      await fixture.call("task", { task_id: "ses_child_1", subagent_type: "worker", prompt: "switch worker" })
      const metadata = nativeTaskMetadata.parse(fixture.sessions.get("ses_child_1")?.metadata?.[NATIVE_TASK_METADATA_KEY])
      expect(metadata.category).toBeUndefined()
      expect(fixture.instructions.has("ses_child_1")).toBe(false)
      await fixture.runtime.cleanup()
      recreated.bindManagers(fixture.bindings.config, fixture.bindings.managers)
      recreated.bindTools(fixture.bindings.tools)
      await recreated.install()
      await fixture.call("task", { task_id: "ses_child_1", prompt: "continue switched worker" })
      expect(fixture.launches[2]?.agent).toBe("worker")
    } finally { await recreated.cleanup(); await fixture.close() }
  })

  test("explicit agent model wins over its category model chain", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      fixture.runtime.bindManagers({ ...fixture.bindings.config, agents: { worker: { category: "other", model: "provider/chat", variant: "high" } }, categories: { other: { models: ["provider/missing"] } } }, fixture.bindings.managers)
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      expect(fixture.launches[0]?.model).toBe("provider/chat#high")
    } finally { await fixture.close() }
  })

  test("retains trusted category permissions, fallback settings and native request options durably", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      fixture.runtime.bindManagers({ ...fixture.bindings.config, categories: { fixture: {
        model: "provider/chat", temperature: 0.25, top_p: 0.8, maxTokens: 2000, tools: { read: false, grep: true },
        fallback_models: [{ model: "provider/chat", variant: "high", temperature: 0.4 }],
      } } }, fixture.bindings.managers)
      await fixture.call("task", { category: "fixture", prompt: "work" })
      const child = fixture.sessions.get("ses_child_1")
      expect(child?.permissions).toEqual([{ action: "read", resource: "*", effect: "deny" }, { action: "grep", resource: "*", effect: "allow" }])
      const metadata = nativeTaskMetadata.parse(child?.metadata?.[NATIVE_TASK_METADATA_KEY])
      expect(metadata.fallbackChain).toEqual([{ providers: ["provider"], model: "chat", variant: "high", temperature: 0.4 }])
      if (!child) throw new Error("Missing child")
      const sessionID = z.custom<typeof fixture.context.sessionID>((value) => typeof value === "string" && value.startsWith("ses_")).parse(child.id)
      const event = { sessionID, agent: Agent.ID.make("worker"), model: Model.Ref.parse("provider/chat"), system: [], messages: [], options: {}, tools: {} }
      await fixture.applyContext(event)
      expect(event.options).toMatchObject({ temperature: 0.25, topP: 0.8, maxOutputTokens: 2000 })
    } finally { await fixture.close() }
  })

  test("disabled agent and category policies fail before native admission", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      fixture.runtime.bindManagers({ ...fixture.bindings.config, disabled_agents: ["worker"], categories: { fixture: { disable: true } } }, fixture.bindings.managers)
      await expect(fixture.call("task", { subagent_type: "worker", prompt: "work" })).rejects.toMatchObject({ code: "disabled-agent" })
      await expect(fixture.call("task", { category: "fixture", prompt: "work" })).rejects.toMatchObject({ code: "category-unavailable" })
      expect(fixture.launches).toEqual([])
    } finally { await fixture.close() }
  })

  test("baseline each-notice delegation remains usable without extended capabilities", async () => {
    const fixture = await createNativeTaskFixture({ capabilities: {} })
    try {
      const result = await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      expect(result.output).toMatchObject({ status: "running", sessionID: "ses_child_1" })
      expect(fixture.launches[0]?.notice).toBeUndefined()
    } finally { await fixture.close() }
  })
})

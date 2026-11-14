import { describe, expect, test, spyOn } from "bun:test"
import { z } from "zod"
import { createNativeTaskFixture } from "./native-task-test-fixture"
import { nativeSubagentResult } from "./native-task-arguments"
import { nativeTaskMetadata, NATIVE_TASK_METADATA_KEY, NativeTaskCapabilityError, NativeTaskError } from "./native-task-types"
import { createNativeTaskRuntime } from "./native-task-runtime"

describe("native task implementation capture", () => {
  test.each([
    { action: "task", target: "worker", args: { subagent_type: "worker", prompt: "work" } },
    { action: "call_omo_agent", target: "explore", args: { subagent_type: "explore", prompt: "inspect", description: "inspect", run_in_background: false } },
  ])("asserts the original $action for its actual target and caller", async ({ action, target, args }) => {
    const fixture = await createNativeTaskFixture()
    try {
      await fixture.call(action, args)
      expect(fixture.assertions).toEqual([{ sessionID: fixture.context.sessionID, agent: fixture.context.agent,
        action, resources: [target], save: [target], source: { type: "tool", messageID: fixture.context.messageID, id: fixture.context.id } }])
    } finally { await fixture.close() }
  })

  test.each([false, true])("propagates original-action rejection before any native admission with fan-out=%s", async (fanout) => {
    const fixture = await createNativeTaskFixture()
    const rejected = new NativeTaskError("fixture-permission-rejected", "Original action was rejected")
    const permission = spyOn(fixture.ctx.permission, "assert").mockImplementation(async () => { throw rejected })
    try {
      await expect(fixture.call("task", { subagent_type: "worker", prompt: "work", ...(fanout ? { items: ["one", "two"] } : {}) })).rejects.toBe(rejected)
      expect(fixture.launches).toEqual([])
      expect([...fixture.sessions.keys()]).toEqual(["ses_parent"])
    } finally { permission.mockRestore(); await fixture.close() }
  })

  test("waits for one original-action approval before admitting a fan-out", async () => {
    const fixture = await createNativeTaskFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.ctx.permission.assert
    const permission = spyOn(fixture.ctx.permission, "assert").mockImplementation(async (input) => { await original(input); entered.resolve(); await release.promise })
    try {
      const operation = fixture.call("task", { subagent_type: "worker", prompt: "work", items: ["one", "two"] })
      await Promise.race([entered.promise, operation.then(() => { throw new Error("Native work was admitted before frontend approval") })])
      expect(fixture.launches).toEqual([])
      release.resolve()
      await operation
      expect(fixture.assertions).toHaveLength(1)
      expect(fixture.launches).toHaveLength(2)
    } finally { release.resolve(); permission.mockRestore(); await fixture.close() }
  })

  test("keeps the raw native launcher absent through registry reload and an independent transform", async () => {
    const fixture = await createNativeTaskFixture()
    const other = await fixture.ctx.tool.transform((editor) => editor.update("task", (tool) => { tool.description = "Independent task metadata" }))
    try {
      await fixture.ctx.tool.reload()
      expect((await fixture.ctx.tool.list()).some((tool) => tool.name === "subagent")).toBe(false)
      await expect(fixture.call("subagent", { agent: "worker", prompt: "bypass" })).rejects.toThrow("Missing registered native tool")
      await fixture.call("task", { subagent_type: "worker", prompt: "allowed route" })
      expect(fixture.launches).toHaveLength(1)
    } finally { await other.dispose(); await fixture.close() }
  })

  test("uses the captured native implementation and awaits durable policy before admission", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      fixture.runtime.bindTools({ ...fixture.bindings.tools, mergedSkills: [{ name: "fixture-skill", scope: "project", definition: { name: "fixture-skill", description: "fixture", template: "skill input from the caller" } }] })

      const result = await fixture.call("task", { category: "fixture", prompt: "do the work", load_skills: ["fixture-skill"] })

      const output = nativeSubagentResult.parse(result.output)
      expect(output).toMatchObject({ sessionID: "ses_child_1", status: "running" })
      expect(fixture.launches[0]).toMatchObject({ agent: "sisyphus-junior", model: "provider/chat#high", background: true })
      expect(fixture.trace).toEqual(["native.created:ses_child_1", "durable.write:ses_child_1", "instructions.write:ses_child_1", "host.progress", "native.admitted:ses_child_1"])
      expect(fixture.instructions.get(output.sessionID)).toContain("skill input from the caller")
      const stored = fixture.sessions.get(output.sessionID)
      expect(stored?.metadata?.engine).toBe("retained")
      expect(nativeTaskMetadata.parse(stored?.metadata?.[NATIVE_TASK_METADATA_KEY])).toMatchObject({ parentSessionID: "ses_parent", category: "fixture", skills: ["fixture-skill"], settings: { temperature: 0.2 } })
      expect(result.metadata?.backgroundTaskId).toBe("bg_ses_child_1")
    } finally { await fixture.close() }
  })

  test("does not admit native work when durable progress fails", async () => {
    const fixture = await createNativeTaskFixture()
    const failure = new Error("durable metadata unavailable")
    const update = spyOn(fixture.ctx.session, "update").mockImplementation(async () => { throw failure })
    try {
      await expect(fixture.call("task", { subagent_type: "worker", prompt: "work" })).rejects.toBe(failure)
      expect(fixture.trace).toEqual(["native.created:ses_child_1"])
      expect(fixture.messages.get("ses_child_1")).toEqual([])
    } finally { update.mockRestore(); await fixture.close() }
  })

  test("preserves an actual native execution failure instead of reporting an admitted success", async () => {
    const failure = new Error("native engine failed")
    const fixture = await createNativeTaskFixture({ beforeNativeResult: async () => { throw failure } })
    try {
      await expect(fixture.call("task", { subagent_type: "worker", prompt: "work" })).rejects.toBe(failure)
    } finally { await fixture.close() }
  })

  test("rejects null skills and unknown options at the real tool boundary", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      await expect(fixture.call("task", { subagent_type: "worker", prompt: "work", load_skills: null })).rejects.toBeInstanceOf(z.ZodError)
      await expect(fixture.call("task", { subagent_type: "worker", prompt: "work", discardedOption: true })).rejects.toBeInstanceOf(z.ZodError)
      expect(fixture.launches).toEqual([])
    } finally { await fixture.close() }
  })

  test("resumes the durable same-parent child after runtime recreation without a task registry", async () => {
    const fixture = await createNativeTaskFixture({ status: "completed" })
    const recreated = createNativeTaskRuntime(fixture.ctx)
    try {
      await fixture.call("task", { category: "fixture", prompt: "first" })
      await fixture.runtime.cleanup()
      recreated.bindManagers(fixture.bindings.config, fixture.bindings.managers)
      recreated.bindTools(fixture.bindings.tools)
      await recreated.install()
      const result = await fixture.call("task", { task_id: "ses_child_1", prompt: "follow-up", run_in_background: false })
      expect(nativeSubagentResult.parse(result.output).sessionID).toBe("ses_child_1")
      expect(fixture.launches[1]).toMatchObject({ sessionID: "ses_child_1", agent: "sisyphus-junior" })
      expect([...fixture.sessions.keys()]).toEqual(["ses_parent", "ses_child_1"])
      expect(fixture.instructions.get("ses_child_1")).toContain("category-specific input")
    } finally { await recreated.cleanup(); await fixture.close() }
  })

  test("rejects another parent's continuation before invoking native execution", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      const parent = fixture.sessions.get("ses_parent")
      if (!parent) throw new Error("Missing parent")
      fixture.sessions.set("ses_foreign", { ...parent, id: "ses_foreign", parentID: "ses_other" })
      await expect(fixture.call("task", { task_id: "ses_foreign", prompt: "follow-up" })).rejects.toMatchObject({ code: "parent-mismatch" })
      expect(fixture.launches).toEqual([])
    } finally { await fixture.close() }
  })

  test("continuation preserves the child's current native agent and model authority", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      await fixture.call("task", { category: "fixture", prompt: "first" })
      const child = fixture.sessions.get("ses_child_1")
      if (!child) throw new Error("Missing native child")
      fixture.sessions.set(child.id, { ...child, agent: "librarian", model: { providerID: "provider", id: "chat", variant: "high" } })
      await fixture.call("task", { task_id: child.id, prompt: "follow-up" })
      expect(fixture.launches[1]).toMatchObject({ sessionID: child.id, agent: "librarian", model: "provider/chat#high" })
    } finally { await fixture.close() }
  })

  test("call_omo_agent retains its callable-agent and continuation contracts", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      await expect(fixture.call("call_omo_agent", { subagent_type: "worker", prompt: "work", description: "work", run_in_background: true })).rejects.toBeInstanceOf(NativeTaskError)
      const result = await fixture.call("call_omo_agent", { subagent_type: "explore", prompt: "inspect", description: "inspect", run_in_background: false })
      expect(nativeSubagentResult.parse(result.output).status).toBe("completed")
      expect(fixture.launches[0]?.agent).toBe("explore")
    } finally { await fixture.close() }
  })

  test("cleanup removes only owned registrations once and prevents later invocation", async () => {
    const fixture = await createNativeTaskFixture()
    const task = fixture.tools.get("task")
    if (!task) throw new Error("Missing task")
    await Promise.all([fixture.runtime.cleanup(), fixture.runtime.cleanup()])
    expect(fixture.disposals.sort()).toEqual(["context", "tools"])
    expect([...fixture.tools.keys()]).toEqual(["subagent"])
    await expect(task.execute({ subagent_type: "worker", prompt: "work" }, fixture.context)).rejects.toMatchObject({ code: "runtime-disposed" })
    await fixture.close()
  })

  test("honors disabled tool configuration when registering native overrides", async () => {
    // given
    const fixture = await createNativeTaskFixture()
    const recreated = createNativeTaskRuntime(fixture.ctx, { getPluginConfig: () => ({ ...fixture.bindings.config, disabled_tools: ["task", "background_cancel"] }) })
    try {
      await fixture.runtime.cleanup()
      recreated.bindManagers(fixture.bindings.config, fixture.bindings.managers)
      recreated.bindTools(fixture.bindings.tools)
      // when
      await recreated.install()
      // then
      expect(fixture.tools.has("task")).toBe(false)
      expect(fixture.tools.has("background_cancel")).toBe(false)
      expect(fixture.tools.has("background_output")).toBe(true)
    } finally { await recreated.cleanup(); await fixture.close() }
  })
})

describe("advertised native subagent options", () => {
  test.each([
    { variant: undefined, model: "provider/chat" },
    { variant: "default", model: "provider/chat" },
    { variant: "high", model: "provider/chat#high" },
    { variant: "unavailable", model: "provider/chat#unavailable" },
  ])("serializes inherited variant $variant without changing the explicit model", async ({ variant, model }) => {
    // given
    const fixture = await createNativeTaskFixture()
    const parent = fixture.sessions.get("ses_parent")
    if (!parent) throw new Error("Missing native parent")
    fixture.sessions.set(parent.id, { ...parent, model: { providerID: "provider", id: "chat", variant } })
    try {
      // when
      await fixture.call("task", { subagent_type: "fork", prompt: "inherit the current model" })
      // then
      expect(fixture.launches[0]?.model).toBe(model)
    } finally { await fixture.close() }
  })

  test.each([
    { name: "none", args: { subagent_type: "worker", prompt: "work", wake: "none" } },
    { name: "group", args: { subagent_type: "worker", prompt: "work", items: ["a", "b"] } },
    { name: "fork", args: { subagent_type: "fork", prompt: "work" } },
    { name: "handoff", args: { subagent_type: "worker", prompt: "work", run_in_background: false } },
  ])("rejects $name when capability is omitted rather than inferring from version", async ({ args }) => {
    const fixture = await createNativeTaskFixture({ capabilities: { sessionMessages: true, childCancellation: true }, foregroundHandoffMs: 100 })
    try {
      await expect(fixture.call("task", args)).rejects.toBeInstanceOf(NativeTaskCapabilityError)
      expect(fixture.launches).toEqual([])
    } finally { await fixture.close() }
  })

  test("passes none, own-agent fork and foreground handoff to native execution", async () => {
    const fixture = await createNativeTaskFixture({ foregroundHandoffMs: 100, status: "running" })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "quiet", wake: "none" })
      await fixture.call("task", { subagent_type: "fork", prompt: "fork work" })
      const result = await fixture.call("task", { subagent_type: "worker", prompt: "foreground", run_in_background: false })
      expect(fixture.launches[0]?.notice).toBe("none")
      expect(fixture.launches[1]).toMatchObject({ fork: true, agent: "worker", model: "provider/chat" })
      expect(fixture.launches[2]).toMatchObject({ foregroundHandoffMs: 100, background: false })
      expect(nativeSubagentResult.parse(result.output).status).toBe("running")
    } finally { await fixture.close() }
  })

  test("fan-out partitions inputs and registers every native group slot without its own completion worker", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      const result = await fixture.call("task", { subagent_type: "worker", prompt: "partition work", items: ["one", "two", "three"], split: 2 })
      expect(fixture.launches).toHaveLength(2)
      const notices = fixture.launches.map((launch) => launch.notice)
      expect(notices[0]).toMatchObject({ group: { index: 0, total: 2 } })
      expect(notices[1]).toMatchObject({ group: { index: 1, total: 2 } })
      expect(fixture.launches[0]?.prompt).toContain("- one\n- two")
      expect(fixture.launches[1]?.prompt).toContain("- three")
      const output = z.object({ children: z.array(nativeSubagentResult), failures: z.array(z.unknown()) }).parse(result.output)
      expect(output.children.map((child) => child.sessionID)).toEqual(["ses_child_1", "ses_child_2"])
      expect(output.failures).toEqual([])
    } finally { await fixture.close() }
  })

  test("fan-out invokes every native slot and reports actual failed admissions", async () => {
    let nativeCalls = 0
    const fixture = await createNativeTaskFixture({ beforeNativeResult: async () => { if (nativeCalls++ === 0) throw new Error("native slot failed") } })
    try {
      const result = await fixture.call("task", { subagent_type: "worker", prompt: "work", items: ["one", "two"] })
      const output = z.object({ children: z.array(nativeSubagentResult), failures: z.array(z.object({ index: z.number(), error: z.string() })) }).parse(result.output)
      expect(fixture.launches).toHaveLength(2)
      expect(output.children).toHaveLength(1)
      expect(output.failures).toEqual([{ index: 0, error: "native slot failed" }])
    } finally { await fixture.close() }
  })
})

import { describe, expect, test, spyOn } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { MonitorManager } from "../features/monitor/manager"
import { createNativeTaskFixture } from "./native-task-test-fixture"
import { NativeTaskCapabilityError } from "./native-task-types"

async function monitorFixture(parentSessionId = "ses_parent"): Promise<{ readonly manager: MonitorManager; readonly id: string; readonly stopped: string[] }> {
  const stopped: string[] = []
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  const id = `mon_${crypto.randomUUID()}`
  const manager = new MonitorManager({ pluginContext: { client: createOpencodeClient({ baseUrl: "http://127.0.0.1:1" }), directory: process.env.HOME ?? process.cwd() }, deps: {
    randomId: () => id, registerManagerForCleanup: () => {}, unregisterManagerForCleanup: () => {},
    spawnMonitoredProcess: () => ({ stdout: new ReadableStream(), stderr: new ReadableStream(), exited: exited.promise,
      kill: (signal) => { stopped.push(id); exited.resolve({ code: null, signal: signal ?? null }) } }),
    createInjector: () => ({ queueBatch: () => {}, flushMonitor: async () => {} }),
  } })
  await manager.start({ command: "fixture", parentSessionId })
  return { stopped, manager, id }
}

describe("native task cancellation ownership", () => {
  test("forwards monitor cancellation to the retained manager without a native job shim", async () => {
    const fixture = await createNativeTaskFixture()
    const monitor = await monitorFixture()
    fixture.bindings.managers.monitorManager = monitor.manager
    try {
      const result = await fixture.call("background_cancel", { taskId: monitor.id })
      expect(monitor.stopped).toEqual([monitor.id])
      expect(monitor.manager.get(monitor.id)?.status).toBe("stopped")
      expect(result.content).toBe(`Monitor stopped: ${monitor.id}`)
    } finally { await monitor.manager.shutdown(); await fixture.close() }
  })

  test("rejects cancellation of a monitor owned by another session", async () => {
    const fixture = await createNativeTaskFixture()
    const monitor = await monitorFixture("ses_other")
    fixture.bindings.managers.monitorManager = monitor.manager
    try {
      await expect(fixture.call("background_cancel", { taskId: monitor.id })).rejects.toMatchObject({ code: "parent-mismatch" })
      expect(monitor.stopped).toEqual([])
    } finally { await monitor.manager.shutdown(); await fixture.close() }
  })

  test("does not report session interrupt acceptance as settled native cancellation", async () => {
    const fixture = await createNativeTaskFixture({ capabilities: { subagentOptions: true, sessionMessages: true } })
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      await expect(fixture.call("background_cancel", { taskId: "bg_ses_child_1" })).rejects.toBeInstanceOf(NativeTaskCapabilityError)
    } finally { await fixture.close() }
  })

  test("waits for actual native owner acknowledgement and preserves cancellation errors", async () => {
    const fixture = await createNativeTaskFixture()
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      await fixture.call("background_cancel", { taskId: "bg_ses_child_1" })
      expect(fixture.sessions.get("ses_child_1")?.outcome).toBe("interrupted")
      const terminal = await fixture.call("background_cancel", { taskId: "bg_ses_child_1" })
      expect(terminal.output).toMatchObject({ jobs: [{ result: { status: "terminal", state: "cancelled" } }] })
    } finally { await fixture.close() }
  })

  test("all cancellation uses native jobs and the same retained monitor manager", async () => {
    const fixture = await createNativeTaskFixture({ dependencies: {
      listJobs: async () => [{ id: "ses_child_1", sessionID: "ses_parent", kind: "subagent", status: "running" }],
    } })
    const monitor = await monitorFixture()
    fixture.bindings.managers.monitorManager = monitor.manager
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      await fixture.call("background_cancel", { all: true })
      expect(fixture.trace).toContain("native.cancelled:ses_child_1")
      expect(monitor.stopped).toEqual([monitor.id])
    } finally { await monitor.manager.shutdown(); await fixture.close() }
  })

  test.each([{ status: "requested" as const }, { status: "unsupported" as const, reason: "remote owner" }])("preserves unsettled/unsupported native result $status", async (result) => {
    const fixture = await createNativeTaskFixture()
    const native = spyOn(fixture.ctx.session, "cancelChild").mockImplementation(async () => result)
    try {
      await fixture.call("task", { subagent_type: "worker", prompt: "work" })
      const output = await fixture.call("background_cancel", { taskId: "bg_ses_child_1" })
      expect(output.output).toMatchObject({ jobs: [{ result }] })
      expect(JSON.stringify(output)).not.toContain('"status":"cancelled"')
    } finally { native.mockRestore(); await fixture.close() }
  })

  test("uses the native job kind and owner for opaque shell/image identifiers", async () => {
    const calls: { id: string; parentSessionID: string }[] = []
    const fixture = await createNativeTaskFixture({ dependencies: {
      listJobs: async () => [{ id: "opaque-image-id", sessionID: "ses_parent", kind: "image", status: "running" }],
      cancelJob: async (input) => { calls.push(input); return { status: "unsupported", reason: "remote owner" } },
    } })
    try {
      const result = await fixture.call("background_cancel", { taskId: "opaque-image-id" })
      expect(calls).toMatchObject([{ id: "opaque-image-id", parentSessionID: "ses_parent" }])
      expect(result.output).toMatchObject({ jobs: [{ result: { status: "unsupported", reason: "remote owner" } }] })
    } finally { await fixture.close() }
  })
})

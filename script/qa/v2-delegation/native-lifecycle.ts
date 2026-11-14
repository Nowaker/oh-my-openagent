import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import type { ToolCall } from "../v2-parity/provider"
import { created, latestTool, messages, sessionGet, sessions, toolText } from "./assertions"
import { delegationConfig, prepareDelegationFixture } from "./fixtures"

const modes = ["default", "fork", "notice", "group", "handoff", "cancel", "cancel-all", "restart"] as const
const capabilities = z.record(z.string(), z.boolean()).default({})
const childID = (value: unknown) => z.string().parse(latestTool(value, "task").state.metadata?.sessionID)
const noticeSource = (value: unknown) => z.object({ metadata: z.object({ source: z.string() }) }).safeParse(value)

export function createNativeLifecycleProbes(createHost: typeof createScenarioHost): readonly ParityProbe[] {
  return modes.map((mode) => ({
    id: `native-${mode}`, label: `Native OMO delegation ${mode}`,
    async run(context) {
      const token = randomUUID()
      const prompt = `native-child-${token}`
      const release = Promise.withResolvers<void>()
      let nextCall: ToolCall | undefined
      let restartedGeneration = false
      let inherited = false
      const reply = () => `${restartedGeneration ? "restarted" : "own"}-answer-${token}`
      await using host = await createHost(context, {
        id: `native-${mode}`, omo: { ...delegationConfig, background_task: { foregroundHandoffMs: mode === "handoff" ? 100 : 0 } },
        prepare: (sandbox) => prepareDelegationFixture(sandbox, `native-policy-${token}`),
        handler: async (request, _index, signal) => {
          const user = request.messages.filter((entry) => entry.role === "user").at(-1)
          if ((JSON.stringify(user?.content) ?? "").includes(prompt)) {
            inherited ||= JSON.stringify(request.messages).includes(`ancestor-answer-${token}`)
            signal.throwIfAborted()
            await release.promise
            signal.throwIfAborted()
            return { kind: "text", text: reply() }
          }
          if (!request.tools?.length) return { kind: "text", text: "Native delegation fixture" }
          if (nextCall) { const call = nextCall; nextCall = undefined; return { kind: "tools", calls: [call] } }
          return { kind: "text", text: `ancestor-answer-${token}` }
        },
      })
      const api = async (path: string, body?: unknown) => {
        appendFileSync(join(host.sandbox.root, "api-phases.jsonl"), JSON.stringify({ phase: "start", path }) + "\n")
        const result = await host.request(path, body === undefined ? {} : { method: "POST", body })
        appendFileSync(join(host.sandbox.root, "api-phases.jsonl"), JSON.stringify({ phase: "end", path, status: result.status }) + "\n")
        assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}`)
        return result.body
      }
      const info = z.object({ capabilities }).parse(await api("/api/info"))
      const cancelling = mode === "cancel" || mode === "cancel-all"
      const multiple = mode === "group" || mode === "cancel-all"
      const required = cancelling ? ["subagentOptions", "sessionMessages", "childCancellation", "jobControl"] : ["subagentOptions", "sessionMessages"]
      const missing = required.filter((key) => info.capabilities[key] !== true)
      if (missing.length) return { status: "skip", detail: `Installed host lacks advertised capabilities: ${missing.join(", ")}` }
      const parent = created.parse(await api("/api/session", { title: `Native ${mode}`, agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
      await api(`/api/session/${parent}/prompt`, { text: "Seed the parent context." })
      await api(`/api/experimental/session/${parent}/wait`, {})
      nextCall = { id: `launch-${token}`, name: "task", args: {
        prompt, description: `Native ${mode} fixture`, load_skills: [], ...(mode === "default" ? {} : { run_in_background: mode !== "handoff" }),
        ...(mode === "fork" ? { subagent_type: "fork" } : { category: "delegation-fixture" }),
        ...(multiple ? { items: ["alpha", "beta"] } : {}),
        ...(mode === "group" ? {} : { wake: mode === "handoff" || mode === "notice" ? "each" : "none" }),
      } }
      await api(`/api/session/${parent}/prompt`, { text: `Launch the ${mode} fixture.` })
      await api(`/api/experimental/session/${parent}/wait`, {})
      const launched = await api(`/api/session/${parent}/message`)
      writeFileSync(join(host.sandbox.root, "launch-messages.json"), JSON.stringify(launched, null, 2))
      assert.equal(latestTool(launched, "task").state.status, "completed")
      const children = sessions.parse(await api("/api/session")).data.filter((entry) => entry.parentID === parent)
      assert.equal(children.length, multiple ? 2 : 1)
      const child = multiple ? children[0]?.id : childID(launched)
      assert.ok(child)
      if (mode === "handoff" || mode === "default") assert.equal(latestTool(launched, "task").state.metadata?.status, "running")
      if (mode === "default") {
        nextCall = { id: `pending-output-${token}`, name: "background_output", args: { task_id: `bg_${child}`, block: true, timeout: 1 } }
        await api(`/api/session/${parent}/prompt`, { text: "Bound the pending native child read without cancelling it." })
        await api(`/api/experimental/session/${parent}/wait`, {})
        const pending = toolText(await api(`/api/session/${parent}/message`), "background_output")
        assert.match(pending, /Native task \S+: running/)
        assert.ok(pending.includes("Native wait deadline elapsed"))
        assert.notEqual(sessionGet.parse(await api(`/api/session/${child}`)).data.outcome, "interrupted")
      }
      if (cancelling) {
        const foreign = created.parse(await api("/api/session", { agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
        nextCall = { id: `wrong-parent-${token}`, name: "background_cancel", args: { taskId: `bg_${child}` } }
        await api(`/api/session/${foreign}/prompt`, { text: "Try the foreign task cancellation fixture." })
        await api(`/api/experimental/session/${foreign}/wait`, {})
        assert.equal(latestTool(await api(`/api/session/${foreign}/message`), "background_cancel").state.status, "error")
        assert.notEqual(sessionGet.parse(await api(`/api/session/${child}`)).data.outcome, "interrupted")
        nextCall = { id: `cancel-${token}`, name: "background_cancel", args: mode === "cancel-all" ? { all: true } : { taskId: `bg_${child}` } }
        await api(`/api/session/${parent}/prompt`, { text: "Cancel the owned task." })
        await api(`/api/experimental/session/${parent}/wait`, {})
        const cancelled = JSON.parse(toolText(await api(`/api/session/${parent}/message`), "background_cancel"))
        const stopped = z.object({ jobs: z.array(z.object({ result: z.object({ status: z.literal("cancelled") }) })) }).parse(cancelled)
        assert.equal(stopped.jobs.length, children.length)
        for (const entry of children) assert.equal(sessionGet.parse(await api(`/api/session/${entry.id}`)).data.outcome, "interrupted")
        release.resolve()
      } else if (mode === "restart") {
        await host.engine.stop()
        assert.notEqual(host.engine.process.exitCode, null)
        restartedGeneration = true
        await using engine = await context.harness.startEngine(context, host.sandbox)
        assert.notEqual(engine.process.pid, host.engine.process.pid)
        const request = async (path: string, body?: unknown) => {
          const result = await context.harness.request(engine, path, body === undefined ? {} : { method: "POST", body })
          assert.ok(result.status >= 200 && result.status < 300, `Restart ${path}: HTTP ${result.status}`)
          return result.body
        }
        await using activated = await context.harness.subscribeEvent(context, engine, (event) => event.type === "plugin.updated" && event.location?.directory === host.sandbox.project)
        await request("/api/agent")
        await activated.result
        nextCall = { id: `resume-${token}`, name: "task", args: { task_id: child, prompt: `${prompt} after restart`, run_in_background: false, wake: "none" } }
        release.resolve()
        await request(`/api/session/${parent}/prompt`, { text: "Continue the durable child from the new engine context." })
        await request(`/api/experimental/session/${parent}/wait`, {})
        const resumed = await request(`/api/session/${parent}/message`)
        writeFileSync(join(host.sandbox.root, "restart-messages.json"), JSON.stringify(resumed, null, 2))
        assert.equal(childID(resumed), child)
        assert.ok(toolText(resumed, "task").includes(reply()))
        const current = sessions.parse(await request("/api/session")).data.filter((entry) => entry.parentID === parent)
        assert.deepEqual(current.map((entry) => entry.id), [child])
      } else {
        const source = mode === "group" ? "subagent-group" : "subagent"
        const quiet = mode === "fork" || mode === "default"
        await using notice = quiet ? undefined : await host.subscribe((event) => event.type === "session.inbox.enqueued" && JSON.stringify(event.data).includes(parent) && JSON.stringify(event.data).includes(`"source":"${source}"`))
        release.resolve()
        for (const entry of children) await api(`/api/experimental/session/${entry.id}/wait`, {})
        if (notice) await notice.result
        await api(`/api/experimental/session/${parent}/wait`, {})
        const result = await api(`/api/session/${parent}/message`)
        const notices = messages.parse(result).data.filter((entry) => { const parsed = noticeSource(entry); return parsed.success && ["subagent", "subagent-group"].includes(parsed.data.metadata.source) })
        assert.equal(notices.length, quiet ? 0 : 1)
        if (mode === "group") { const group = noticeSource(notices[0]); assert.ok(group.success); assert.equal(group.data.metadata.source, "subagent-group") }
        if (mode === "notice") { const ordinary = noticeSource(notices[0]); assert.ok(ordinary.success); assert.equal(ordinary.data.metadata.source, "subagent") }
        nextCall = { id: `output-${token}`, name: "background_output", args: { task_id: `bg_${child}`, block: true, full_session: true } }
        await api(`/api/session/${parent}/prompt`, { text: "Read the native child's own work." })
        await api(`/api/experimental/session/${parent}/wait`, {})
        const output = toolText(await api(`/api/session/${parent}/message`), "background_output")
        assert.ok(output.includes(reply()))
        if (mode === "fork") { assert.ok(inherited, "Native fork did not retain settled parent context"); assert.ok(!output.includes(`ancestor-answer-${token}`), "Fork output exposed inherited parent answers") }
      }
      writeFileSync(join(host.sandbox.root, "native-receipt.json"), JSON.stringify({ mode, parent, child, children, inherited, version: context.version, capabilities: info.capabilities }, null, 2))
      writeFileSync(join(host.sandbox.root, "provider-requests.json"), JSON.stringify(host.provider.requests, null, 2))
      return { status: "pass", detail: `${mode}: actual native child ${child}, durable ownership and ${mode === "restart" ? "new engine continuation" : cancelling ? "settled cancellation" : "completion policy"} verified` }
    },
  }))
}

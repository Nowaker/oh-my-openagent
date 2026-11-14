import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import type { ToolCall } from "../v2-parity/provider"
import { created, latestTool, toolText } from "./assertions"

export function createNativeJobProbes(createHost: typeof createScenarioHost): readonly ParityProbe[] {
  return [false, true].map((result) => ({
    id: result ? "native-shell-result" : "native-shell-cancel",
    label: result ? "Native shell result reaches OMO background_output" : "OMO cancellation stops the owned native shell process",
    async run(context) {
      const token = randomUUID().replaceAll("-", "")
      const marker = `native_job_${token}`
      let next: ToolCall | undefined
      await using host = await createHost(context, {
        id: result ? "native-shell-result" : "native-shell-cancel",
        prepare(sandbox) {
          if (!result) return
          writeFileSync(join(sandbox.root, "omo-plugin/server.ts"), [
            `import plugin from ${JSON.stringify(pathToFileURL(context.pluginBundle).href)}`,
            'import { renameSync, writeFileSync } from "node:fs"',
            "export default { ...plugin, async setup(ctx) {",
            "  const native = ctx.job.result",
            "  const job = new Proxy(ctx.job, { get(target, key, receiver) {",
            "    if (key !== 'result') return Reflect.get(target, key, receiver)",
            "    return (input, options) => {",
            "      const pending = native.call(target, input, options)",
            `      if (input.wait) { writeFileSync(${JSON.stringify(join(sandbox.project, "result-reader.tmp"))}, JSON.stringify(input)); renameSync(${JSON.stringify(join(sandbox.project, "result-reader.tmp"))}, ${JSON.stringify(join(sandbox.project, "result-reader.json"))}) }`,
            "      return pending",
            "    }",
            "  } })",
            "  const observed = new Proxy(ctx, { get(target, key, receiver) { return key === 'job' ? job : Reflect.get(target, key, receiver) } })",
            "  return plugin.setup(observed)",
            "} }",
          ].join("\n"))
        },
        handler(request) {
          if (!request.tools?.length) return { kind: "text", text: "Native job fixture" }
          if (next) { const call = next; next = undefined; return { kind: "tools", calls: [call] } }
          return { kind: "text", text: "The native job fixture settled." }
        },
      })
      if (host.info.capabilities?.jobControl !== true || (result && host.info.capabilities?.jobResults !== true)) {
        return { status: "skip", detail: `Installed host lacks ${result ? "jobResults" : "jobControl"}; no native job result/cancellation claim` }
      }
      const api = async (path: string, body?: unknown) => {
        const response = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(response.status >= 200 && response.status < 300, `${path}: HTTP ${response.status}`)
        return response.body
      }
      const parent = created.parse(await api("/api/session", { title: "Native shell ownership", agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
      const processID = Promise.withResolvers<number>()
      const resultReader = Promise.withResolvers<void>()
      const pidFile = join(host.sandbox.project, "shell-owner.pid")
      const readerFile = join(host.sandbox.project, "result-reader.json")
      const watcher = watch(host.sandbox.project, (_event, filename) => {
        if (filename?.toString() === "result-reader.json" && existsSync(readerFile)) resultReader.resolve()
        if (filename && filename.toString() !== "shell-owner.pid") return
        if (!existsSync(pidFile)) return
        const value = readFileSync(pidFile, "utf8").trim()
        if (/^\d+$/.test(value)) processID.resolve(z.coerce.number().int().positive().parse(value))
      })
      using pidWatcher = { [Symbol.dispose]() { watcher.close() } }
      await using shellStarted = await host.subscribe((event) => event.type === "shell.created" && JSON.stringify(event.data).includes(parent))
      next = { id: `shell-${token}`, name: "shell", args: { command: result
        ? `mkfifo shell-result.pipe; printf "%s" "$$" > shell-owner.pid; read -r release < shell-result.pipe; printf ${marker}`
        : 'printf "%s" "$$" > shell-owner.pid; exec sleep 3600', workdir: host.sandbox.project, background: true } }
      await api(`/api/session/${parent}/prompt`, { text: "Run the owned native shell fixture." })
      await api(`/api/experimental/session/${parent}/wait`, {})
      const started = await api(`/api/session/${parent}/message`)
      const shell = latestTool(started, "shell")
      assert.equal(shell.state.status, "completed")
       const event = await shellStarted.result
       writeFileSync(join(host.sandbox.root, "shell-created.json"), JSON.stringify(event, null, 2))
       const info = z.object({ info: z.object({ id: z.string(), pid: z.number().int().positive().optional() }) }).parse(event.data).info
      const id = info.id
      if (result) {
        const pid = await context.harness.within(processID.promise, 30000, "held native shell process identity")
        process.kill(pid, 0)
        next = { id: `output-${token}`, name: "background_output", args: { task_id: id, block: true, timeout: 30000 } }
        await api(`/api/session/${parent}/prompt`, { text: "Read the actual native shell result." })
        await context.harness.within(resultReader.promise, 30000, "native shell result reader admission")
        const reader = z.object({ parentID: z.string(), jobID: z.string(), wait: z.literal(true) }).parse(JSON.parse(readFileSync(readerFile, "utf8")))
        assert.deepEqual(reader, { parentID: parent, jobID: id, wait: true })
        writeFileSync(join(host.sandbox.project, "shell-result.pipe"), "release\n")
        await api(`/api/experimental/session/${parent}/wait`, {})
        const output = await api(`/api/session/${parent}/message`)
        writeFileSync(join(host.sandbox.root, "job-output.json"), JSON.stringify(output, null, 2))
        const text = toolText(output, "background_output")
        assert.ok(text.includes(marker), "The actual native captured output was lost")
        assert.match(text, /Native shell job \S+: completed/)
      } else {
         const pid = await context.harness.within(processID.promise, 30000, "native shell self-reported process identity")
         if (info.pid !== undefined) assert.equal(info.pid, pid)
        process.kill(pid, 0)
        if (host.info.capabilities?.jobResults === true) {
          next = { id: `pending-job-${token}`, name: "background_output", args: { task_id: id, block: true, timeout: 1 } }
          await api(`/api/session/${parent}/prompt`, { text: "Bound the native job result wait without stopping execution." })
          await api(`/api/experimental/session/${parent}/wait`, {})
          const pending = toolText(await api(`/api/session/${parent}/message`), "background_output")
          assert.match(pending, /Native shell job \S+: running/)
          assert.ok(pending.includes("Native wait deadline elapsed"))
          process.kill(pid, 0)
        }
        const foreign = created.parse(await api("/api/session", { agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
        next = { id: `wrong-owner-${token}`, name: "background_cancel", args: { taskId: id } }
        await api(`/api/session/${foreign}/prompt`, { text: "Attempt the foreign native job cancellation." })
        await api(`/api/experimental/session/${foreign}/wait`, {})
        assert.equal(latestTool(await api(`/api/session/${foreign}/message`), "background_cancel").state.status, "error")
        process.kill(pid, 0)
        next = { id: `cancel-${token}`, name: "background_cancel", args: { taskId: id } }
        await api(`/api/session/${parent}/prompt`, { text: "Cancel the owned native shell." })
        await api(`/api/experimental/session/${parent}/wait`, {})
        const output = await api(`/api/session/${parent}/message`)
        const cancelled = z.object({ jobs: z.array(z.object({ id: z.string(), result: z.object({ status: z.literal("cancelled") }) })) }).parse(JSON.parse(toolText(output, "background_cancel")))
        assert.equal(cancelled.jobs[0]?.id, id)
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
        writeFileSync(join(host.sandbox.root, "job-cancellation.json"), JSON.stringify({ info, cancelled, output }, null, 2))
      }
      writeFileSync(join(host.sandbox.root, "job-receipt.json"), JSON.stringify({ parent, id, marker, result, version: context.version, capabilities: host.info.capabilities }, null, 2))
      return { status: "pass", detail: `${id}: actual native shell ${result ? "captured result" : "owner-checked physical cancellation"} through OMO` }
    },
  }))
}

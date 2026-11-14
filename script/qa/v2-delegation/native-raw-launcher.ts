import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import type { ToolCall } from "../v2-parity/provider"
import { created, latestTool, sessions, toolText } from "./assertions"

export function createNativeRawLauncherProbe(createHost: typeof createScenarioHost): ParityProbe {
  return {
    id: "native-raw-launcher", label: "Removed raw subagent is unreachable directly and through a working CodeMode runtime",
    async run(context) {
      const token = randomUUID()
      let next: ToolCall | undefined
      const admitted: string[][] = []
      await using host = await createHost(context, { id: "native-raw-launcher", handler(request) {
        if (!request.tools?.length) return { kind: "text", text: "Raw launcher fixture" }
        admitted.push(request.tools.map((entry) => entry.function.name))
        if (next) { const call = next; next = undefined; return { kind: "tools", calls: [call] } }
        return { kind: "text", text: "Raw launcher attempt settled." }
      } })
      const api = async (path: string, body?: unknown) => {
        const result = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}`)
        return result.body
      }
      const id = created.parse(await api("/api/session", { agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
      const args = { agent: "explore", description: "Unreachable raw child", prompt: `raw-child-${token}`, background: false, notice: "none" }
      next = { id: `raw-${token}`, name: "subagent", args }
      await api(`/api/session/${id}/prompt`, { text: "Force the removed raw native launcher." })
      await api(`/api/experimental/session/${id}/wait`, {})
      const direct = await api(`/api/session/${id}/message`)
      writeFileSync(join(host.sandbox.root, "direct-messages.json"), JSON.stringify(direct, null, 2))
      assert.equal(latestTool(direct, "subagent").state.status, "error")
      assert.match(JSON.stringify(latestTool(direct, "subagent").state), /unknown.tool|no.tool.named|not.available/i)
      next = { id: `codemode-control-${token}`, name: "execute", args: { code: "return await tools.opencode.models({ provider: 'fake', limit: 1 })" } }
      await api(`/api/session/${id}/prompt`, { text: "Run a real CodeMode model inventory control." })
      await api(`/api/experimental/session/${id}/wait`, {})
      const control = await api(`/api/session/${id}/message`)
      writeFileSync(join(host.sandbox.root, "control-messages.json"), JSON.stringify(control, null, 2))
      assert.notEqual(latestTool(control, "execute").state.metadata?.error, true, "CodeMode control failed before the raw-launcher test")
      assert.ok(toolText(control, "execute").includes("fake"), "The working CodeMode control did not return the native model inventory")
      next = { id: `codemode-raw-${token}`, name: "execute", args: { code: `return await tools.subagent(${JSON.stringify(args)})` } }
      await api(`/api/session/${id}/prompt`, { text: "Try reaching the private launcher through CodeMode." })
      await api(`/api/experimental/session/${id}/wait`, {})
      const indirect = await api(`/api/session/${id}/message`)
      writeFileSync(join(host.sandbox.root, "indirect-messages.json"), JSON.stringify(indirect, null, 2))
      const blocked = latestTool(indirect, "execute")
      assert.ok(blocked.state.status === "error" || blocked.state.metadata?.error === true, "CodeMode reached the private native launcher")
      assert.match(JSON.stringify(blocked.state), /subagent|unknown.tool|not.a.function/i)
      assert.ok(admitted.some((names) => names.includes("execute")), "The CodeMode control was absent from actual provider tools")
      assert.equal(admitted.some((names) => names.includes("subagent")), false, "The model received the private native launcher")
      const children = sessions.parse(await api("/api/session")).data.filter((entry) => entry.parentID === id)
      assert.equal(children.length, 0, "A direct or CodeMode raw-launcher attempt admitted a child")
      writeFileSync(join(host.sandbox.root, "raw-launcher-receipt.json"), JSON.stringify({ sessionID: id, direct, control, indirect, children, admitted, engine: host.info }, null, 2))
      return { status: "pass", detail: "Forced direct launcher unknown; CodeMode inventory succeeded; CodeMode subagent unavailable; no descendant admitted" }
    },
  }
}

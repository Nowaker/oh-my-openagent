import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import type { ToolCall } from "../v2-parity/provider"
import { created, latestTool, sessionGet, sessions, toolText } from "./assertions"
import { delegationConfig, prepareDelegationFixture } from "./fixtures"

export function createDelegationPermissionProbes(createHost: typeof createScenarioHost): readonly ParityProbe[] {
  return [false, true].map((mixed) => createPermissionProbe(createHost, mixed))
}

function createPermissionProbe(createHost: typeof createScenarioHost, mixed: boolean): ParityProbe {
  const id = mixed ? "delegation-mixed-permission" : "delegation-permission"
  return {
    id, label: mixed ? "Mixed legacy launcher flags cannot reopen the native launcher" : "Delegated launcher deny reaches the native permission boundary",
    async run(context) {
      const token = randomUUID()
      const prompt = `permission-child-${token}`
      const answer = `permission-result-${token}`
      let launched = false
      let attempted = false
      await using host = await createHost(context, {
        id, omo: { ...delegationConfig, categories: {
          "delegation-fixture": { ...delegationConfig.categories["delegation-fixture"], tools: mixed ? { task: false, call_omo_agent: true } : { call_omo_agent: false, task: false } },
        } },
        opencode: { experimental: { todo: true, subagent_depth: 3 } },
        prepare: (sandbox) => prepareDelegationFixture(sandbox, `permission-policy-${token}`),
        handler(request) {
          const child = request.messages.some((entry) => entry.role === "user" && (JSON.stringify(entry.content) ?? "").includes(prompt))
          if (child) {
            if (!attempted) {
              attempted = true
              const call: ToolCall = mixed ? {
                id: `blocked-${token}`, name: "subagent", args: { agent: "explore", description: "Blocked native child", prompt: `nested-child-${token}`, background: false, notice: "none" },
              } : {
                id: `blocked-${token}`, name: "call_omo_agent", args: { subagent_type: "explore", description: "Blocked nested child", prompt: `nested-child-${token}`, run_in_background: false },
              }
              return { kind: "tools", calls: [call] }
            }
            return { kind: "text", text: answer }
          }
          if (!request.tools?.length) return { kind: "text", text: "Permission fixture" }
          if (!launched) {
            launched = true
            return { kind: "tools", calls: [{ id: `launch-${token}`, name: "task", args: {
              category: "delegation-fixture", description: "Test delegated launcher denial", prompt, load_skills: [], run_in_background: false,
            } }] }
          }
          return { kind: "text", text: "The permission fixture settled." }
        },
      })
      const api = async (path: string, body?: unknown) => {
        const result = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}`)
        return result.body
      }
      const parent = created.parse(await api("/api/session", { title: "Delegation permission QA", agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
      await api(`/api/session/${parent}/prompt`, { text: "Run the delegated permission fixture." })
      await api(`/api/experimental/session/${parent}/wait`, {})
      assert.ok(toolText(await api(`/api/session/${parent}/message`), "task").includes(answer))
      const inventory = sessions.parse(await api("/api/session")).data
      const children = inventory.filter((entry) => entry.parentID === parent)
      assert.equal(children.length, 1)
      const child = children[0]
      assert.ok(child)
      const selected = sessionGet.parse(await api(`/api/session/${child.id}`)).data
      const permissions = z.array(z.object({ action: z.string(), resource: z.string(), effect: z.string() })).parse(selected.permissions)
      const transcript = await api(`/api/session/${child.id}/message`)
      const blocked = latestTool(transcript, mixed ? "subagent" : "call_omo_agent")
      writeFileSync(join(host.sandbox.root, "permission-messages.json"), JSON.stringify(transcript, null, 2))
      writeFileSync(join(host.sandbox.root, "permission-receipt.json"), JSON.stringify({ parent, child: selected, blocked, attempted, version: context.version }, null, 2))
      for (const action of mixed ? ["task", "subagent"] : ["call_omo_agent", "subagent"]) assert.equal(permissions.findLast((rule) => rule.action === action && rule.resource === "*")?.effect, "deny", `Effective ${action} deny was lost`)
      if (mixed) assert.equal(permissions.findLast((rule) => rule.action === "call_omo_agent" && rule.resource === "*")?.effect, "allow", "Original callable-agent allowance was lost")
      assert.equal(blocked.state.status, "error", "Denied launcher executed successfully")
      assert.match(JSON.stringify(blocked.state), /denied|permission|not.allowed|rejected|not.available|not.found|unknown.tool|no.tool.named.+currently.available/i)
      assert.equal(inventory.filter((entry) => entry.parentID === child.id).length, 0, "Denied launcher created a descendant")
      return { status: "pass", detail: `${child.id}: ${mixed ? "mixed flags retain original allow and effective native deny" : "original/native denies retained"}; actual nested launcher failed without creating a child` }
    },
  }
}

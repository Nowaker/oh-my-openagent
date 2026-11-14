import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import { created, latestTool, sessionGet, sessions, toolText } from "./assertions"
import { delegationConfig, prepareDelegationFixture } from "./fixtures"

const routes = ["call_omo_agent", "task", "backend-deny"] as const

export function createAllowedLauncherProbes(createHost: typeof createScenarioHost): readonly ParityProbe[] {
  return routes.map((route) => allowedLauncherProbe(createHost, route))
}

function allowedLauncherProbe(createHost: typeof createScenarioHost, route: typeof routes[number]): ParityProbe {
  const tool = route === "task" ? "task" : "call_omo_agent"
  const target = route === "task" ? "oracle" : "explore"
  const denied = route === "backend-deny"
  const id = `native-launcher-${route.replaceAll("_", "-")}`
  return {
    id, label: `Independent ${tool} route ${denied ? "preserves an explicit native backend deny" : "reaches its native child"}`,
    async run(context) {
      const token = randomUUID()
      const childPrompt = `allowed-parent-${token}`
      const nestedPrompt = `allowed-nested-${token}`
      const nestedAnswer = `allowed-answer-${token}`
      let launched = false
      let called = false
      let admitted: readonly string[] = []
      let observePolicies: () => Promise<void> = async () => { throw new Error("Policy observer was not initialized") }
      await using host = await createHost(context, {
        id, omo: { ...delegationConfig,
          agents: { ...delegationConfig.agents, oracle: { model: "fake/fake-model" } }, categories: {
          "delegation-fixture": { ...delegationConfig.categories["delegation-fixture"], tools: { task: tool === "task", call_omo_agent: tool === "call_omo_agent" } },
        } }, opencode: { experimental: { todo: true, subagent_depth: 3 } },
        prepare(sandbox) {
          prepareDelegationFixture(sandbox, `allowed-policy-${token}`)
          if (!denied) return
          writeFileSync(join(sandbox.root, "omo-plugin/server.ts"), [
            `import plugin from ${JSON.stringify(pathToFileURL(context.pluginBundle).href)}`,
            "export default { ...plugin, async setup(ctx) {",
            "  const cleanup = await plugin.setup(ctx)",
            "  let policy",
            "  try {",
            "    policy = await ctx.agent.transform((editor) => editor.update('sisyphus-junior', (agent) => {",
            "      agent.permissions = [...agent.permissions, { action: 'subagent', resource: 'explore', effect: 'deny' }]",
            "    }))",
            "  } catch (error) { await cleanup?.(); throw error }",
            "  return async () => { try { await policy.dispose() } finally { await cleanup?.() } }",
            "} }",
          ].join("\n"))
        },
        async handler(request) {
          if (!request.tools?.length) return { kind: "text", text: "Allowed launcher fixture" }
          const last = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content) ?? ""
          if (last.includes(nestedPrompt)) return { kind: "text", text: nestedAnswer }
          if (last.includes(childPrompt)) {
            admitted = (request.tools ?? []).map((entry) => entry.function.name)
            if (!called) {
              await observePolicies()
              called = true
              return { kind: "tools", calls: [{ id: `allowed-call-${token}`, name: tool, args: {
                subagent_type: target, description: "Allowed nested inspection", prompt: nestedPrompt, run_in_background: false,
                ...(tool === "task" ? { load_skills: [], wake: "none" } : {}),
              } }] }
            }
            return { kind: "text", text: "The allowed child route settled." }
          }
          if (!launched) {
            launched = true
            return { kind: "tools", calls: [{ id: `allowed-root-${token}`, name: "task", args: {
              category: "delegation-fixture", description: "Preserve mixed launcher authority", prompt: childPrompt, load_skills: [], run_in_background: false,
            } }] }
          }
          return { kind: "text", text: "The parent received the child route result." }
        },
      })
      const api = async (path: string, body?: unknown) => {
        const response = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(response.status >= 200 && response.status < 300, `${path}: HTTP ${response.status}`)
        return response.body
      }
      const parent = created.parse(await api("/api/session", { title: "Allowed original launcher QA", agent: "sisyphus", model: { providerID: "fake", id: "fake-model" },
        permissions: denied ? [{ action: "task", resource: "*", effect: "allow" }, { action: "subagent", resource: "sisyphus-junior", effect: "allow" }]
          : [{ action: "*", resource: "*", effect: "allow" }],
      })).data.id
      observePolicies = async () => {
        const inventory = sessions.parse(await api("/api/session")).data
        const caller = inventory.find((entry) => entry.parentID === parent)
        assert.ok(caller)
        const roster = z.object({ data: z.array(z.looseObject({ id: z.string(), permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.string() })) })) }).parse(await api("/api/agent"))
         const agent = roster.data.find((entry) => entry.id === caller.agent)
         if (denied) assert.deepEqual(agent?.permissions.findLast((rule) => rule.action === "subagent" && rule.resource === "explore"), { action: "subagent", resource: "explore", effect: "deny" }, "The actual native caller has no authored backend denial")
        const select = (value: unknown) => z.object({ data: z.object({ id: z.string(), parentID: z.string().optional(), agent: z.string().optional(), permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.string() })).optional() }) }).parse(value).data
        writeFileSync(join(host.sandbox.root, "policy-before-launch.json"), JSON.stringify({ agent, root: select(await api(`/api/session/${parent}`)), caller: select(await api(`/api/session/${caller.id}`)) }, null, 2))
      }
      await api(`/api/session/${parent}/prompt`, { text: "Prove the permitted original callable-agent route." })
      await api(`/api/experimental/session/${parent}/wait`, {})
      const inventory = sessions.parse(await api("/api/session")).data
      const child = inventory.find((entry) => entry.parentID === parent)
      assert.ok(child)
      const transcript = await api(`/api/session/${child.id}/message`)
      writeFileSync(join(host.sandbox.root, "allowed-launcher-messages.json"), JSON.stringify(transcript, null, 2))
      writeFileSync(join(host.sandbox.root, "provider-requests.json"), JSON.stringify(host.provider.requests, null, 2))
      assert.ok(admitted.includes(tool), "The permitted original launcher was absent from actual provider tools")
      assert.equal(admitted.includes(tool === "task" ? "call_omo_agent" : "task"), false, "The independently disabled launcher reached the model")
      assert.equal(admitted.includes("subagent"), false, "The raw native launcher remained reachable")
      const nested = inventory.filter((entry) => entry.parentID === child.id)
      if (denied) {
        assert.equal(latestTool(transcript, tool).state.status, "error", "An authored native backend deny was bypassed")
        assert.equal(nested.length, 0, "Backend denial admitted a descendant")
      } else {
        assert.equal(latestTool(transcript, tool).state.status, "completed", "The permitted original launcher was blocked by its native backend")
        assert.ok(toolText(transcript, tool).includes(nestedAnswer))
        assert.equal(nested.length, 1)
        assert.equal(nested[0]?.agent, target)
      }
      const selected = sessionGet.parse(await api(`/api/session/${child.id}`)).data
      writeFileSync(join(host.sandbox.root, "allowed-launcher-receipt.json"), JSON.stringify({ parent, child: selected, nested, admitted, route, version: context.version }, null, 2))
      return { status: "pass", detail: `${child.id}: ${tool} ${denied ? "honored the authored native backend deny with no descendant" : `reached actual native ${target} child ${nested[0]?.id}`}` }
    },
  }
}

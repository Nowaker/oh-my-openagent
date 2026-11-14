import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { NativeEvent, ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import type { ToolCall } from "../v2-parity/provider"
import { created, latestTool, sessions } from "./assertions"

const identity = z.object({ sessionID: z.string() })
const pending = z.object({ data: z.array(z.object({ id: z.string(), action: z.string(), resources: z.array(z.string()),
  source: z.object({ type: z.literal("tool"), id: z.string(), messageID: z.string() }),
})) })

export function createNativePermissionAskProbe(createHost: typeof createScenarioHost): ParityProbe {
  return {
    id: "native-permission-ask", label: "Original launcher asks persist independently and explicit backend asks remain authoritative",
    async run(context) {
      const token = randomUUID()
      let next: ToolCall | undefined
      await using host = await createHost(context, {
        id: "native-permission-ask", omo: { agents: { sisyphus: { model: "fake/fake-model" }, explore: { model: "fake/fake-model" } } },
        opencode: { experimental: { todo: true, subagent_depth: 3 } },
        handler(request) {
          const user = JSON.stringify(request.messages.findLast((entry) => entry.role === "user")?.content) ?? ""
          if (user.includes(`ask-child-${token}`)) return { kind: "text", text: `ask-answer-${token}` }
          if (!request.tools?.length) return { kind: "text", text: "Permission ask fixture" }
          if (next) { const call = next; next = undefined; return { kind: "tools", calls: [call] } }
          return { kind: "text", text: "Permission ask turn settled." }
        },
      })
      const api = async (path: string, body?: unknown) => {
        const result = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}`)
        return result.body
      }
      const create = async (backend: "allow" | "ask") => created.parse(await api("/api/session", {
        agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "subagent", resource: "explore", effect: backend },
          { action: "call_omo_agent", resource: "explore", effect: backend === "ask" ? "allow" : "ask" },
          { action: "task", resource: "explore", effect: "ask" },
        ],
      })).data.id
      const belongs = (event: NativeEvent, id: string) => {
        const parsed = identity.safeParse(event.data)
        return parsed.success && parsed.data.sessionID === id
      }
      const results: { readonly label: string; readonly sessionID: string; readonly asks: readonly NativeEvent[]; readonly state: ReturnType<typeof latestTool>["state"] }[] = []
      const turn = async (input: { readonly sessionID: string; readonly tool: "task" | "call_omo_agent"; readonly action?: string; readonly decision?: "always" | "once" | "reject"; readonly label: string }) => {
        const asks: NativeEvent[] = []
        await using audit = await host.subscribe((event) => {
          if (!belongs(event, input.sessionID)) return false
          appendFileSync(join(host.sandbox.root, "permission-events.jsonl"), JSON.stringify({ label: input.label, event }) + "\n")
          if (event.type === "permission.asked") asks.push(event)
          return event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted"
        })
        await using edge = await host.subscribe((event) => belongs(event, input.sessionID) && ["permission.asked", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type))
        const call: ToolCall = { id: `${input.label}-${token}`, name: input.tool, args: {
          subagent_type: "explore", description: "Native permission fixture", prompt: `ask-child-${token}`, run_in_background: false,
          ...(input.tool === "task" ? { load_skills: [], wake: "none" } : {}),
        } }
        next = call
        await api(`/api/session/${input.sessionID}/prompt`, { text: input.label })
        const observed = await edge.result
        writeFileSync(join(host.sandbox.root, `${input.label}-pending.json`), JSON.stringify({ observed, requests: await api(`/api/session/${input.sessionID}/permission`) }, null, 2))
        if (input.action) {
          assert.equal(observed.type, "permission.asked", "The protected original action completed without asking")
          const requests = pending.parse(await api(`/api/session/${input.sessionID}/permission`)).data
          assert.equal(requests.length, 1, "One invocation produced multiple pending permission requests")
          const request = requests[0]
          assert.ok(request)
          assert.equal(request.action, input.action)
          assert.deepEqual(request.resources, ["explore"])
          assert.ok(input.decision)
          await api(`/api/session/${input.sessionID}/permission/${request.id}/reply`, { decision: input.decision })
        } else assert.equal(observed.type, "session.execution.succeeded", "An always-saved original action asked again")
        await api(`/api/experimental/session/${input.sessionID}/wait`, {})
        assert.equal((await audit.result).type, input.decision === "reject" ? "session.execution.interrupted" : "session.execution.succeeded")
        assert.equal(asks.length, input.action ? 1 : 0, "Unexpected frontend or backend permission prompt")
        const messages = await api(`/api/session/${input.sessionID}/message`)
        const tool = latestTool(messages, input.tool)
        assert.equal(tool.state.status, input.decision === "reject" ? "error" : "completed")
        writeFileSync(join(host.sandbox.root, `${input.label}-messages.json`), JSON.stringify(messages, null, 2))
        results.push({ ...input, asks, state: tool.state })
      }
      const original = await create("allow")
      await turn({ sessionID: original, tool: "call_omo_agent", action: "call_omo_agent", decision: "always", label: "original-always" })
      await turn({ sessionID: original, tool: "call_omo_agent", label: "original-saved" })
      await turn({ sessionID: original, tool: "task", action: "task", decision: "reject", label: "independent-task" })
      const originalChildren = sessions.parse(await api("/api/session")).data.filter((entry) => entry.parentID === original)
      assert.equal(originalChildren.length, 2, "The rejected independent task admitted a child or an allowed call did not execute")
      const backend = await create("ask")
      await turn({ sessionID: backend, tool: "call_omo_agent", action: "subagent", decision: "once", label: "authored-backend" })
      const backendChildren = sessions.parse(await api("/api/session")).data.filter((entry) => entry.parentID === backend)
      assert.equal(backendChildren.length, 1)
      writeFileSync(join(host.sandbox.root, "permission-ask-receipt.json"), JSON.stringify({ original, backend, results, originalChildren, backendChildren, engine: host.info }, null, 2))
      return { status: "pass", detail: "One original call ask; always reused only for call_omo_agent; task asked independently; authored subagent ask remained intact" }
    },
  }
}

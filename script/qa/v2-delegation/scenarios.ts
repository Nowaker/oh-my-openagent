import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import { assistantText, created, sessionGet, sessions, toolText } from "./assertions"
import { delegationConfig, prepareDelegationFixture } from "./fixtures"

export function createDelegationProbes(createHost: typeof createScenarioHost, mode: "bridge" | "native" = "bridge"): readonly ParityProbe[] {
  return [false, true].map((background) => ({
    id: background ? "delegation-background" : "delegation-foreground",
    label: background ? "Bridged background child and output" : "Bridged foreground category authority",
    async run(context) {
      const token = randomUUID()
      const childPrompt = `delegation-child-${token}`
      const childReply = `delegation-result-${token}`
      const instruction = `delegation-instruction-${token}`
      let launched = false
      let reading = false
      let outputRequested = false
      let taskID = ""
      let instructionDelivered = false
      let childModelDelivered = false
      let childVariantDelivered = false
      const id = background ? "delegation-background" : "delegation-foreground"
      await using host = await createHost(context, {
        id, omo: delegationConfig, prepare: (sandbox) => prepareDelegationFixture(sandbox, instruction),
        handler(request) {
          const child = request.messages.some((entry) => entry.role === "user" && (JSON.stringify(entry.content) ?? "").includes(childPrompt))
          if (child) {
            if (request.tools?.length) {
              instructionDelivered ||= JSON.stringify(request.messages).includes(instruction)
              childModelDelivered ||= request.model === "child-model"
              childVariantDelivered ||= request.reasoning_effort === "high"
            }
            return { kind: "text", text: childReply }
          }
          if (!request.tools?.length) return { kind: "text", text: "Delegation fixture" }
          if (reading && !outputRequested) {
            outputRequested = true
            return { kind: "tools", calls: [{ id: `output-${token}`, name: "background_output", args: { task_id: taskID, block: true, timeout: 30000, full_session: true } }] }
          }
          if (!launched) {
            launched = true
            return { kind: "tools", calls: [{ id: `task-${token}`, name: "task", args: {
              description: "Read isolated delegation fixture", prompt: childPrompt, category: "delegation-fixture", load_skills: ["delegation-fixture"], run_in_background: background, wake: "none",
            } }] }
          }
          return { kind: "text", text: reading ? "Parent read the child result." : "Parent received the task result." }
        },
      })
      const api = async (path: string, body?: unknown) => {
        const response = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status}: ${JSON.stringify(response.body)}`)
        return response.body
      }
      const parentID = created.parse(await api("/api/session", { title: `Delegation ${background ? "background" : "foreground"}`, agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).data.id
      await using completion = await host.subscribe((event) => event.type === "session.execution.succeeded" && JSON.stringify(event.data).includes(parentID))
      await api(`/api/session/${parentID}/prompt`, { text: `Run delegation fixture ${token}` })
      await context.harness.within(completion.result, 90000, `${id} parent completion`)
      const parentMessages = await api(`/api/session/${parentID}/message`)
      writeFileSync(join(host.sandbox.root, "parent-messages.json"), JSON.stringify(parentMessages, null, 2))
      const task = toolText(parentMessages, "task")
      const children = sessions.parse(await api("/api/session")).data.filter((session) => session.parentID === parentID)
      assert.equal(children.length, 1, `Expected one actual child: ${task}`)
      const admitted = children[0]
      assert.ok(admitted)
      await api(`/api/experimental/session/${admitted.id}/wait`, {})
      const child = sessionGet.parse(await api(`/api/session/${admitted.id}`)).data
      const childMessages = await api(`/api/session/${child.id}/message`)
      assert.equal(child.agent, "sisyphus-junior")
      assert.deepEqual(child.model, { providerID: "fake", id: "child-model", variant: "high" })
      assert.ok(childModelDelivered, "The selected child model did not receive the actual model request")
      assert.ok(childVariantDelivered, "The selected child variant did not change the actual model request")
      assert.ok(assistantText(childMessages).includes(childReply), "Actual child reply missing")
      assert.ok(instructionDelivered, "Skill instruction never reached the child's real model request")
      if (background) {
        taskID = (mode === "native" ? /Background output\/cancel alias: (bg_[a-zA-Z0-9_-]+)/ : /Task ID: (bg_[a-zA-Z0-9_-]+)/).exec(task)?.[1] ?? ""
        assert.ok(taskID, `No background task ID: ${task}`)
        reading = true
        await api(`/api/session/${parentID}/prompt`, { text: `Read background fixture ${token}` })
        await api(`/api/experimental/session/${parentID}/wait`, {})
        const output = await api(`/api/session/${parentID}/message`)
        const result = toolText(output, "background_output")
        assert.equal((mode === "native" ? /^Native task \S+: (\w+)$/m : /^Status: (\w+)$/m).exec(result)?.[1], "completed", "Background output returned before terminal completion")
        assert.ok(result.includes(childReply), "Background result did not reach the parent")
        writeFileSync(join(host.sandbox.root, "background-output.json"), JSON.stringify(output, null, 2))
      } else assert.ok(task.includes(childReply), "Foreground task returned without its child's result")
      writeFileSync(join(host.sandbox.root, "child-messages.json"), JSON.stringify(childMessages, null, 2))
      writeFileSync(join(host.sandbox.root, "provider-requests.json"), JSON.stringify(host.provider.requests, null, 2))
      writeFileSync(join(host.sandbox.root, "receipt.json"), JSON.stringify({ parentID, child, taskID, instructionDelivered, childModelDelivered, childVariantDelivered, childReply, background, version: context.version }, null, 2))
      return { status: "pass", detail: `${child.id}: ${child.agent}, fake/child-model#high, real skill input and ${background ? "background_output" : "foreground result"} delivered` }
    },
  }))
}

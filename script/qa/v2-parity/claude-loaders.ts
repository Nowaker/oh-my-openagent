import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { turn } from "./agent-config"
import type { ParityContext, ParityProbe } from "./contracts"
import { createScenarioHost } from "./harness"
import type { ProviderHandler } from "./provider"

const agentsSchema = z.object({ data: z.array(z.looseObject({ id: z.string(), description: z.string().optional() })) })
const messagesSchema = z.object({ data: z.array(z.looseObject({ content: z.array(z.looseObject({
  type: z.string(), name: z.string().optional(), state: z.looseObject({ status: z.string(), content: z.json().optional() }).optional(),
})).optional() })) })
const loaders = (enabled: { readonly agents: boolean; readonly commands: boolean }) =>
  ({ claude_code: { mcp: false, skills: false, hooks: false, plugins: false, ...enabled } })

async function claudeAgent(context: ParityContext, enabled: boolean) {
  const suffix = randomUUID()
  const name = `claude-agent-${suffix}`
  const description = `claude-description-${suffix}`
  const system = `claude-system-${suffix}`
  await using host = await createScenarioHost(context, { id: `claude-agents-${enabled ? "enabled" : "disabled"}`,
    handler: () => ({ kind: "text", text: "Fixture acknowledged." }), omo: loaders({ agents: enabled, commands: false }),
    prepare(sandbox) {
      const directory = join(sandbox.project, ".claude", "agents")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\nmode: all\n---\n${system}\n`)
    },
  })
  const response = await host.request("/api/agent")
  assert.equal(response.status, 200, "Native roster request failed")
  const registered = agentsSchema.parse(response.body).data.find((agent) => agent.id === name)
  const direct = registered ? await turn(host, name) : undefined
  writeFileSync(join(host.sandbox.root, "claude-agent-receipt.json"), JSON.stringify({ engine: host.info, enabled, name,
    registered, directSystemPropagated: direct?.system.includes(system) ?? false, sessionID: direct?.sessionID }, null, 2) + "\n")
  return { registered, delivered: direct?.system.includes(system) ?? false, description }
}

async function claudeAgents(context: ParityContext) {
  const control = await claudeAgent(context, false)
  assert.equal(control.registered, undefined, "A .claude/agents definition registered with the OMO Claude agent loader disabled")
  const loaded = await claudeAgent(context, true)
  assert.ok(loaded.registered, "OMO Claude agent loader did not register the project .claude/agents definition natively")
  assert.ok(loaded.registered.description?.includes(loaded.description), "Claude agent lost its description in the native roster")
  assert.equal(loaded.delivered, true, "Claude agent body did not reach its direct session's provider system input")
  return { status: "pass" as const, detail: "Project .claude/agents definition registered natively and its body reached its session's system input only with the OMO loader enabled" }
}

async function claudeCommands(context: ParityContext) {
  const suffix = randomUUID().replaceAll("-", "")
  const name = `claude-command-${suffix}`
  const bodyToken = `claude-command-body-${suffix}`
  const handler: ProviderHandler = (request) => {
    const tools = (request.tools ?? []).map((tool) => tool.function.name)
    const invoked = request.messages.some((message) => message.role === "tool")
    if (!invoked && tools.includes("skill")) return { kind: "tools", calls: [{ id: `call_${suffix}`, name: "skill", args: { name } }] }
    return { kind: "text", text: "Fixture acknowledged." }
  }
  await using host = await createScenarioHost(context, { id: "claude-commands-loader", handler,
    omo: loaders({ agents: false, commands: true }),
    prepare(sandbox) {
      const directory = join(sandbox.project, ".claude", "commands")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `${name}.md`), `---\ndescription: Claude command fixture ${suffix}\n---\n${bodyToken}\n`)
    },
  })
  const { sessionID } = await turn(host, "sisyphus")
  const skill = host.provider.requests.flatMap((request) => request.tools ?? []).find((tool) => tool.function.name === "skill")
  const advertised = JSON.stringify(skill?.function ?? null).includes(`<name>/${name}</name>`)
  const response = await host.request(`/api/session/${sessionID}/message?order=asc&limit=100`)
  assert.equal(response.status, 200, "Native message read failed")
  const part = messagesSchema.parse(response.body).data.flatMap((message) => message.content ?? []).find((entry) => entry.type === "tool" && entry.name === "skill")
  const result = JSON.stringify(part?.state?.content ?? null)
  const nextInput = JSON.stringify(host.provider.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool")))
  const receipt = { engine: host.info, name, sessionID, advertised, status: part?.state?.status ?? null,
    resultDelivered: result.includes(bodyToken), providerDelivered: nextInput.includes(bodyToken) }
  writeFileSync(join(host.sandbox.root, "claude-command-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  const loaded = receipt
  assert.equal(loaded.advertised, true, "OMO Claude command loader did not advertise the project command on the skill tool")
  assert.equal(loaded.status, "completed", "Invoking the Claude command through skill did not complete")
  assert.equal(loaded.resultDelivered, true, "Claude command body did not reach the native tool result")
  assert.equal(loaded.providerDelivered, true, "Claude command body did not reach the next provider input")
  return { status: "pass" as const, detail: "Unique project .claude/commands file was advertised in OMO's skill item list; its body reached the native result and the next provider input" }
}

export const claudeLoaderProbes: readonly ParityProbe[] = [
  { id: "claude-agents-loader", label: "OMO Claude agent loader registers .claude/agents for native sessions", run: claudeAgents },
  { id: "claude-commands-loader", label: "OMO command discovery serves .claude/commands through skill", run: claudeCommands },
]

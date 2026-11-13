import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ParityContext, ParityProbe } from "./contracts"
import { createScenarioHost, type ScenarioHost } from "./harness"

const sessionSchema = z.object({ data: z.object({ id: z.string() }) })
const eventSession = z.object({ sessionID: z.string() })
const agentSchema = z.looseObject({ id: z.string(), name: z.string(), description: z.string().optional(), system: z.string().optional(),
  request: z.looseObject({ settings: z.record(z.string(), z.json()) }).optional(),
  model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }).optional() })
const agentsSchema = z.object({ data: z.array(agentSchema) })
const configSchema = z.looseObject({ "[opencode]": z.looseObject({ agents: z.record(z.string(), z.json()) }) })

export async function turn(host: ScenarioHost, agent: string, model: string | null = "fake-model") {
  const created = await host.request("/api/session", { method: "POST", body: { agent, title: `agent-parity-${randomUUID()}`,
    ...(model === null ? {} : { model: { providerID: "fake", id: model } }),
    permissions: [{ action: "*", resource: "*", effect: "allow" }] } })
  assert.equal(created.status, 200, "Agent parity session creation failed")
  const sessionID = sessionSchema.parse(created.body).data.id
  await using finished = await host.subscribe((event) => {
    const parsed = eventSession.safeParse(event.data)
    return parsed.success && parsed.data.sessionID === sessionID
      && (event.type === "session.execution.succeeded" || event.type === "session.execution.failed")
  })
  const offset = host.provider.requests.length
  const admitted = await host.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: `Return the fixture acknowledgment ${randomUUID()}.` } })
  writeFileSync(join(host.sandbox.root, `admission-${sessionID}.json`), JSON.stringify({ sessionID, agent, response: admitted }, null, 2) + "\n")
  assert.equal(admitted.status, 200, `Agent parity prompt admission failed: ${JSON.stringify(admitted.body)}`)
  const terminal = await finished.result
  assert.equal(terminal.type, "session.execution.succeeded", "Agent parity native turn failed")
  const request = host.provider.requests.slice(offset).find((entry) => entry.messages.some((message) => message.role === "user"))
  assert.ok(request, "Agent parity turn never reached the scripted provider")
  return { sessionID, terminal: terminal.type, model: request.model, temperature: request["temperature"],
    system: request.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message.content)).join("\n") }
}

async function roster(context: ParityContext) {
  const suffix = randomUUID()
  const name = `parity-agent-${suffix}`
  const description = `fixture-roster-${suffix}`
  const system = `fixture-agent-system-${suffix}`
  await using host = await createScenarioHost(context, { id: "agents-dynamic-roster", handler: () => ({ kind: "text", text: "Fixture acknowledged." }),
    prepare(sandbox) {
      const directory = join(sandbox.project, ".opencode", "agents")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\nmodel: fake/fake-model\n---\n${system}\n`)
    },
  })
  const response = await host.request("/api/agent")
  assert.equal(response.status, 200, "Native roster request failed")
  const agents = agentsSchema.parse(response.body).data
  const registered = agents.find((agent) => agent.id === name)
  writeFileSync(join(host.sandbox.root, "agent-registration.json"), JSON.stringify({ registered, agentIDs: agents.map((agent) => agent.id) }, null, 2) + "\n")
  const direct = registered ? await turn(host, name) : undefined
  const receipt = { engine: host.info, binaryVersion: context.version, input: { name, description, system },
    registered, directSystemPropagated: direct?.system.includes(system) ?? false, sessionID: direct?.sessionID }
  writeFileSync(join(host.sandbox.root, "agent-roster-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  assert.ok(registered, "Dynamic project agent was absent from native /api/agent")
  assert.ok(registered.description?.includes(description), "Dynamic project agent lost its description in the native roster")
  assert.equal(receipt.directSystemPropagated, true, "Dynamic agent system prompt did not reach its direct native session")
  return { status: "pass" as const, detail: "Unique project agent and description registered natively; its direct session delivered its unique system input" }
}

async function builtinRoster(context: ParityContext) {
  const description = `configured-explore-${randomUUID()}`
  let configured: readonly string[] = []
  await using host = await createScenarioHost(context, { id: "agents-configured-roster", handler: () => ({ kind: "text", text: "Fixture acknowledged." }),
    prepare(sandbox) {
      const file = join(sandbox.home, ".omo", "omo.jsonc")
      const base = configSchema.parse(JSON.parse(readFileSync(file, "utf8")))
      const agents = { ...base["[opencode]"].agents, explore: { model: "fake/fake-model", description } }
      writeFileSync(file, JSON.stringify({ ...base, "[opencode]": { ...base["[opencode]"], agents } }))
      configured = Object.keys(agents)
    },
  })
  const response = await host.request("/api/agent")
  assert.equal(response.status, 200)
  const roster = agentsSchema.parse(response.body).data
  const agent = roster.find((entry) => entry.id === "explore")
  const missing = configured.filter((id) => !roster.some((entry) => entry.id === id))
  const lead = await turn(host, "sisyphus")
  const propagated = lead.system.includes(description)
  writeFileSync(join(host.sandbox.root, "configured-roster-receipt.json"), JSON.stringify({ engine: host.info, binaryVersion: context.version,
    description, nativeDescription: agent?.description, propagated, sessionID: lead.sessionID, configured, missing }, null, 2) + "\n")
  assert.ok(configured.length > 0, "Fixture configured no built-in agents")
  assert.deepEqual(missing, [], "Configured built-in agents are missing from the native roster")
  assert.equal(agent?.description, description, "Configured built-in description did not reach native roster")
  assert.equal(propagated, true, "Configured built-in roster description did not reach lead provider system messages")
  return { status: "pass" as const, detail: `All ${configured.length} configured built-in agents listed natively; unique configured description reached the roster and lead system messages without delegation` }
}

type ConfigCase = "project" | "profile" | "catalog"
async function configuration(context: ParityContext, mode: ConfigCase) {
  const id = `config-${mode}-precedence`
  const suffix = randomUUID()
  const profile = `profile-${suffix}`
  const alias = `model-${suffix}`
  const markers = ["user-base", "user-harness", "project-base", "project-harness", "user-profile", "project-profile", "user-profile-harness", "project-profile-harness"]
    .map((layer) => `${layer}-${suffix}`)
  const expected = markers[mode === "project" ? 3 : 7]
  assert.ok(expected)
  const override = (prompt_append: string | undefined) => ({ agents: { oracle: { prompt_append } } })
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
  const files: string[] = []
  let before: readonly string[] = []
  await using host = await createScenarioHost(context, { id, handler: () => ({ kind: "text", text: "Fixture acknowledged." }),
    prepare(sandbox) {
      const file = join(sandbox.home, ".omo", "omo.jsonc")
      const base = configSchema.parse(JSON.parse(readFileSync(file, "utf8")))
      writeFileSync(file, JSON.stringify({ ...base, ...override(markers[0]),
        "[opencode]": { ...base["[opencode]"], agents: { ...base["[opencode]"].agents, oracle: { model: "fake/fake-model", prompt_append: markers[1] } } },
        models: { [alias]: { model: "fake/fake-model", temperature: 0.13, variant: "fixture-user" } },
        profiles: { [profile]: { ...override(markers[4]), "[opencode]": override(markers[6]) } },
      }))
      const directory = join(sandbox.project, ".omo")
      mkdirSync(directory)
      writeFileSync(join(directory, "omo.jsonc"), JSON.stringify({ ...override(markers[2]),
        "[opencode]": override(markers[3]),
        models: { [alias]: { model: "fake/gpt-6.1-sol", temperature: 0.37, variant: "fixture-project" } },
        profiles: { [profile]: { ...override(markers[5]), "[opencode]": {
          agents: { oracle: { prompt_append: markers[7], ...(mode === "catalog" ? { model: alias, temperature: 0.73, variant: "fixture-site" } : {}) } },
        } } },
      }))
      files.push(file, join(directory, "omo.jsonc"))
      before = files.map(digest)
      if (mode !== "project") { sandbox.env["OMO_PROFILE"] = profile; sandbox.env["OCX_PROFILE"] = `unused-${suffix}` }
      if (mode === "catalog") {
        const nativeFile = join(sandbox.config, "opencode.json")
        const native = z.looseObject({ providers: z.object({ fake: z.looseObject({ models: z.record(z.string(),
          z.looseObject({ capabilities: z.record(z.string(), z.boolean()) })) }) }) }).parse(JSON.parse(readFileSync(nativeFile, "utf8")))
        for (const model of Object.values(native.providers.fake.models)) model.capabilities["temperature"] = true
        writeFileSync(nativeFile, JSON.stringify(native))
      }
    },
  })
  const response = await host.request("/api/agent")
  assert.equal(response.status, 200)
  const agent = agentsSchema.parse(response.body).data.find((entry) => entry.id === "oracle")
  const actual = await turn(host, "oracle", mode === "catalog" ? "gpt-6.1-sol" : "fake-model")
  const selected = markers.filter((marker) => actual.system.includes(marker))
  writeFileSync(join(host.sandbox.root, "config-receipt.json"), JSON.stringify({ engine: host.info, binaryVersion: context.version,
    mode, expected, selected, nativeModel: agent?.model, nativeRequestSettings: agent?.request?.settings, providerModel: actual.model, temperature: actual.temperature,
    sessionID: actual.sessionID, inputAlias: alias, expectedNativeModel: mode === "catalog" ? "gpt-6.1-sol" : "fake-model",
    selectionScope: "Native agent model assertions; prompt delivery uses explicit fixture session model. Automatic agent-model selection is not claimed." }, null, 2) + "\n")
  assert.equal(files.length, 2, "Configuration fixture files were not recorded")
  assert.deepEqual(files.map(digest), before, "Loading the v1 configuration layers rewrote a config file")
  assert.deepEqual(selected, [expected], "User/project/harness/profile precedence delivered the wrong dynamic prompt_append")
  assert.equal(agent?.model?.id, mode === "catalog" ? "gpt-6.1-sol" : "fake-model", "Effective model catalog selection did not reach native agent configuration")
  if (mode === "catalog") {
    assert.deepEqual(agent?.model, { providerID: "fake", id: "gpt-6.1-sol", variant: "fixture-site" }, "Site tuning did not override project catalog variant")
    assert.equal(actual.temperature, 0.73, "Explicit agent temperature did not override catalog tuning on the provider wire")
  }
  return { status: "pass" as const, detail: `${mode} precedence delivered only its winning dynamic append; native agent model ${agent?.model?.id}${mode === "catalog" ? "; explicit site variant and wire temperature override catalog defaults" : ""}; config files byte-identical after the turn; explicit fixture session model` }
}

async function modelAuthority(context: ParityContext) {
  await using host = await createScenarioHost(context, { id: "agents-model-authority", handler: () => ({ kind: "text", text: "Fixture acknowledged." }),
    omo: { agents: { sisyphus: { model: "fake/fake-model" }, oracle: { model: "fake/gpt-6.1-sol" } } },
  })
  const response = await host.request("/api/agent")
  assert.equal(response.status, 200)
  const agent = agentsSchema.parse(response.body).data.find((entry) => entry.id === "oracle")
  const actual = await turn(host, "oracle", null)
  const control = await turn(host, "sisyphus", null)
  writeFileSync(join(host.sandbox.root, "model-authority-receipt.json"), JSON.stringify({ engine: host.info, binaryVersion: context.version,
    nativeModel: agent?.model, providerModel: actual.model, controlModel: control.model, sessions: [actual.sessionID, control.sessionID] }, null, 2) + "\n")
  assert.equal(agent?.model?.id, "gpt-6.1-sol", "Configured agent model did not reach native agent configuration")
  assert.equal(control.model, "fake-model", "Control session did not use the engine default model")
  assert.equal(actual.model, "gpt-6.1-sol", "A session created without a model ignored its agent's configured model on the provider wire")
  return { status: "pass" as const, detail: "Session without an explicit model sent the agent's configured model to the provider; a control agent on the default sent the default" }
}

async function categoryAppend(context: ParityContext) {
  const suffix = randomUUID()
  const category = `category-${suffix}`
  const categoryMarker = `category-append-${suffix}`
  const agentMarker = `agent-append-${suffix}`
  await using host = await createScenarioHost(context, { id: "agents-category-prompt-append", handler: () => ({ kind: "text", text: "Fixture acknowledged." }),
    omo: { categories: { [category]: { model: "fake/gpt-6.1-sol", prompt_append: categoryMarker } },
      agents: { oracle: { model: "fake/fake-model", category, prompt_append: agentMarker } } },
  })
  const response = await host.request("/api/agent")
  assert.equal(response.status, 200)
  const agent = agentsSchema.parse(response.body).data.find((entry) => entry.id === "oracle")
  const actual = await turn(host, "oracle")
  const receipt = { engine: host.info, binaryVersion: context.version, category, sessionID: actual.sessionID, nativeModel: agent?.model,
    categoryPropagated: actual.system.includes(categoryMarker), agentPropagated: actual.system.includes(agentMarker) }
  writeFileSync(join(host.sandbox.root, "category-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  assert.equal(receipt.categoryPropagated, true, "Selected category prompt_append did not reach provider system messages")
  assert.equal(receipt.agentPropagated, true, "Direct agent prompt_append did not reach provider system messages")
  assert.equal(agent?.model?.id, "fake-model", "Direct agent model did not override its category model in native configuration")
  return { status: "pass" as const, detail: "Unique category and agent append inputs both reached system messages; native agent model beat category without delegation; explicit fixture session model" }
}

export const agentConfigProbes: readonly ParityProbe[] = [
  { id: "agents-configured-roster", label: "Configured built-in roster reaches the lead's provider system", run: builtinRoster },
  { id: "agents-dynamic-roster", label: "Dynamic roster and agent system input reach real native sessions", run: roster },
  ...(["project", "profile", "catalog"] as const).map((mode) => ({ id: `config-${mode}-precedence`,
    label: `Effective ${mode} configuration reaches native agents and provider system messages`, run: (context: ParityContext) => configuration(context, mode) })),
  { id: "agents-category-prompt-append", label: "Category and agent appends propagate without delegation", run: categoryAppend },
  { id: "agents-model-authority", label: "An agent's configured model reaches the provider without a session model", run: modelAuthority },
]

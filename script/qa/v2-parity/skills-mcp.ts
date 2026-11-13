import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ParityContext, ParityProbe } from "./contracts"
import { createScenarioHost } from "./harness"
import type { ProviderHandler } from "./provider"
import { createMcpFixture } from "./skills-mcp-fixture"

const sessionSchema = z.object({ data: z.object({ id: z.string() }) })
const eventSession = z.object({ sessionID: z.string() })
const messagesSchema = z.object({ data: z.array(z.looseObject({ content: z.array(z.looseObject({
  type: z.string(), name: z.string().optional(), state: z.looseObject({ status: z.string(), input: z.json().optional(), content: z.json().optional(), error: z.json().optional() }).optional(),
})).optional() })) })
const toolParameters = z.object({ type: z.literal("object"), properties: z.record(z.string(), z.json()), required: z.array(z.string()).optional() })
const serversSchema = z.object({ data: z.array(z.object({ name: z.string(), status: z.looseObject({ status: z.string() }) })) })
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

async function runInterop(context: ParityContext, mode: "skill" | "registration") {
  const id = mode === "skill" ? "skills-claude-loader-mcp" : "mcp-v1-registration"
  const suffix = randomUUID().replaceAll("-", "")
  const skillName = `parity-skill-${suffix}`
  const serverName = `parity_${suffix}`
  const bodyToken = `fixture_body_${randomUUID()}`
  const challenge = `challenge_${randomUUID()}`
  const rejectedChallenge = `rejected_${randomUUID()}`
  const mcpArgs = (reject: boolean) => ({ challenge: reject ? rejectedChallenge : challenge, reject })
  const handler: ProviderHandler = (request) => {
    const names = (request.tools ?? []).map((tool) => tool.function.name)
    const count = request.messages.filter((message) => message.role === "tool").length
    switch (mode) {
      case "skill":
        if (count === 0 && names.includes("skill")) return { kind: "tools", calls: [{ id: "call_load_skill", name: "skill", args: { name: skillName } }] }
        if (count < 3 && names.includes("skill_mcp")) return { kind: "tools", calls: [{ id: `call_skill_mcp_${count}`, name: "skill_mcp", args: {
          mcp_name: serverName, tool_name: "roundtrip", arguments: JSON.stringify(mcpArgs(count === 2)),
        } }] }
        break
      case "registration":
        if (count === 0 && names.includes("execute")) return { kind: "tools", calls: [{ id: "call_registered_mcp", name: "execute", args: {
          code: `return await tools[${JSON.stringify(serverName)}].roundtrip(${JSON.stringify(mcpArgs(false))})`,
        } }] }
        break
      default: throw new TypeError(`Unexpected interop mode: ${mode satisfies never}`)
    }
    return { kind: "text", text: "Local interop fixture turn ended." }
  }
  await using fixture = createMcpFixture(context)
  await using host = await createScenarioHost(context, { id, handler,
    omo: { claude_code: { mcp: mode === "registration", commands: false, skills: mode === "skill", agents: false, hooks: false, plugins: false } },
    prepare(sandbox) {
      const mcp = fixture.prepare(sandbox)
      switch (mode) {
        case "skill": {
          const directory = join(sandbox.home, ".claude", "skills", skillName)
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, `${skillName}.md`), `---\nname: ${skillName}\ndescription: Local parity fixture ${suffix}\n---\n${bodyToken}\n`)
          writeFileSync(join(directory, "mcp.json"), JSON.stringify({ mcpServers: { [serverName]: mcp } }))
          break
        }
        case "registration": writeFileSync(join(sandbox.project, ".mcp.json"), JSON.stringify({ mcpServers: { [serverName]: mcp } })); break
        default: throw new TypeError(`Unexpected interop mode: ${mode satisfies never}`)
      }
    },
  })
  const created = await host.request("/api/session", { method: "POST", body: { title: id, agent: "sisyphus",
    model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
  } })
  assert.equal(created.status, 200, "Interop session creation failed")
  const sessionID = sessionSchema.parse(created.body).data.id
  const events: string[] = []
  await using finished = await host.subscribe((event) => {
    const parsed = eventSession.safeParse(event.data)
    if (!parsed.success || parsed.data.sessionID !== sessionID) return false
    events.push(event.type)
    return event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
  })
  const prompted = await host.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: {
    text: mode === "skill" ? `Load ${skillName}, then exercise its local MCP tool and its intentional error.` : "Exercise the registered local MCP fixture tool.",
  } })
  assert.equal(prompted.status, 200, "Interop prompt admission failed")
  const terminal = await finished.result
  const path = new URL(`/api/session/${sessionID}/message`, "http://127.0.0.1")
  path.search = new URLSearchParams({ order: "asc", limit: "100" }).toString()
  const response = await host.request(path.pathname + path.search)
  assert.equal(response.status, 200, "Native interop message read failed")
  const parts = messagesSchema.parse(response.body).data.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool")
  const requests = host.provider.requests.filter((request) => (request.tools?.length ?? 0) > 0)
  const schemas = requests.flatMap((request) => request.tools ?? [])
  const toolMessages = requests.flatMap((request) => request.messages.filter((message) => message.role === "tool"))
  const native = JSON.stringify(parts)
  const model = JSON.stringify(toolMessages)
  const registry = await host.request("/api/mcp")
  const receipt = { binaryVersion: context.version, bundleSha256: sha256(context.pluginBundle), sessionID, events, terminal: terminal.type,
    mode, skillName, serverName, bodyToken, challenge, rejectedChallenge, sandboxHome: host.sandbox.home,
    nativeClaudeSkillsDisabled: host.sandbox.env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"],
    sourceSha256: Object.fromEntries(["plugin-v2/mcp-bridge-register.ts", "plugin/skill-context.ts", "tools/skill-mcp/tools.ts"].map((file) => [file, sha256(join(context.sourceDirectory, "packages/omo-opencode/src", file))])),
    submittedTools: host.submittedTools(), schemas, requests, parts, mcpRegistry: registry, mcpEvents: fixture.events(),
  }
  writeFileSync(join(host.sandbox.root, "interop-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  assert.equal(terminal.type, "session.execution.succeeded", "Native interop turn failed")
  assert.ok(events.includes("session.tool.success"), "No native tool success event was observed")
  const started = fixture.events().filter((event) => event.kind === "start")
  assert.ok(started.length > 0, "Native tools never started the SDK stdio fixture")
  for (const start of started) {
    assert.equal(start.home, host.sandbox.home, "MCP child inherited a live HOME")
    context.harness.assertInside(host.sandbox.home, start.cwd)
  }
  assert.ok(fixture.events().some((event) => event.kind === "list"), "SDK fixture never received tools/list")
  fixture.assertRoundtrip(challenge, native, false)
  fixture.assertRoundtrip(challenge, model, false)
  switch (mode) {
    case "skill": {
      assert.equal(receipt.nativeClaudeSkillsDisabled, "1", "Native Claude loader fallback must remain disabled")
      for (const name of ["skill", "skill_mcp"]) {
        assert.ok(receipt.submittedTools.includes(name), `OMO never submitted ${name}`)
        const definition = schemas.find((tool) => tool.function.name === name)
        assert.ok(definition, `Native provider never received ${name}`)
        const parameters = toolParameters.parse(definition.function["parameters"])
        assert.ok(parameters.required?.includes(name === "skill" ? "name" : "mcp_name"), `${name} lost its required argument schema`)
      }
      const advertised = schemas.filter((tool) => tool.function.name === "skill").map((tool) => JSON.stringify(tool.function))
      assert.ok(advertised.some((text) => text.includes(`<name>/${skillName}</name>`)), "Fallback Claude skill was not advertised on the native skill tool before it was called")
      const skill = parts.find((part) => part.name === "skill")
      assert.equal(skill?.state?.status, "completed", "OMO skill did not complete")
      assert.ok(JSON.stringify(skill?.state?.content).includes(bodyToken), "Dynamic Claude fallback file body never reached the native skill result")
      assert.ok(model.includes(bodyToken), "Loaded dynamic skill body never reached the next provider input")
      assert.ok(JSON.stringify(skill?.state?.content).includes("roundtrip"), "Skill output lost the actual SDK tools/list capability")
      const mcp = parts.filter((part) => part.name === "skill_mcp")
      assert.deepEqual(mcp.map((part) => part.state?.status), ["completed", "error"], "skill_mcp must preserve both SDK success and intentional error")
      fixture.assertRoundtrip(rejectedChallenge, JSON.stringify(mcp[1]), true)
      fixture.assertRoundtrip(rejectedChallenge, model, true)
      break
    }
    case "registration": {
      assert.equal(registry.status, 200, "Native MCP registry request failed")
      const server = serversSchema.parse(registry.body).data.find((entry) => entry.name === serverName)
      assert.equal(server?.status.status, "connected", "OMO v1 .mcp.json did not become a connected native MCP registration")
      const catalog = requests.flatMap((request) => request.messages.filter((message) => message.role !== "tool"))
      assert.ok(JSON.stringify(catalog).includes(serverName), "Registered MCP was absent from the model's native Code Mode catalog")
      const execute = schemas.find((tool) => tool.function.name === "execute")
      assert.ok(execute, "Native Code Mode execute tool was not advertised")
      assert.ok(toolParameters.parse(execute.function["parameters"]).required?.includes("code"), "Native execute lost its code schema")
      assert.equal(parts.find((part) => part.name === "execute")?.state?.status, "completed", "Registered MCP did not execute through the native tool registry")
      break
    }
    default: throw new TypeError(`Unexpected interop mode: ${mode satisfies never}`)
  }
  return { status: "pass" as const, detail: mode === "skill"
    ? "OMO-only Claude fallback skill body reached native/provider output; SDK tools/list and skill_mcp success/error receipts matched; owned cleanup enforced"
    : "Scratch .mcp.json traversed OMO v1 config -> native MCP registry/catalog -> Code Mode tool -> independent SDK receipt; owned cleanup enforced" }
}

export const skillsMcpProbes: readonly ParityProbe[] = [
  { id: "skills-claude-loader-mcp", label: "Claude fallback skill and skill_mcp execute through native turns", run: (context) => runInterop(context, "skill") },
  { id: "mcp-v1-registration", label: "OMO MCP registration and tools/list execute a local SDK tool", run: (context) => runInterop(context, "registration") },
]

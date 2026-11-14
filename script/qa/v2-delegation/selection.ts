import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import type { ParityProbe } from "../v2-parity/contracts"
import type { createScenarioHost } from "../v2-parity/harness"
import { assistantText, created } from "./assertions"

const model = z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
const selection = z.object({ agent: z.string(), model })
const receipt = z.object({ sessionID: z.string(), selected: selection })
const transcript = z.object({ data: z.array(z.looseObject({ type: z.string(), agent: z.string().optional(), model: model.optional() })) })
const config = z.looseObject({ providers: z.looseObject({ fake: z.looseObject({ models: z.record(z.string(), z.json()) }) }) })

export function createSelectionProbe(createHost: typeof createScenarioHost): ParityProbe {
  return {
    id: "delegation-default-selection", label: "Effective native defaults reach the actual bridge prompt and provider",
    async run(context) {
      const answer = `native-selection-${randomUUID()}`
      await using host = await createHost(context, {
        id: "delegation-default-selection", handler: () => ({ kind: "text", text: answer }),
        omo: { agents: { hephaestus: { model: "fake/gpt-6.1-sol", variant: "high" } } },
        prepare(sandbox) {
          const file = join(sandbox.config, "opencode.json")
          const original = config.parse(JSON.parse(readFileSync(file, "utf8")))
          const fake = original.providers.fake
          writeFileSync(file, JSON.stringify({ ...original, providers: { ...original.providers, fake: { ...fake, models: {
            ...fake.models, "gpt-6.1-sol": { name: "Selection fixture", capabilities: { tools: true }, limit: { context: 200000, output: 8000 },
              variants: ["high", "low"].map((id) => ({ id, body: { reasoning_effort: id } })),
            },
          } } } }))
          const output = JSON.stringify(join(sandbox.root, "selection.jsonl"))
          writeFileSync(join(sandbox.root, "omo-plugin/server.ts"), [
            `import plugin from ${JSON.stringify(pathToFileURL(context.pluginBundle).href)}`,
            'import { appendFileSync } from "node:fs"',
            "export default { ...plugin, async setup(ctx) {",
            "  const native = ctx.session.selection",
            "  const session = new Proxy(ctx.session, { get(target, key, receiver) {",
            "    if (key !== 'selection' || typeof native !== 'function') return Reflect.get(target, key, receiver)",
            "    return async (input) => {",
            "      const selected = await native.call(target, input)",
            `      appendFileSync(${output}, JSON.stringify({ sessionID: input.sessionID, selected }) + '\\n')`,
            "      return selected",
            "    }",
            "  } })",
            "  const observed = new Proxy(ctx, { get(target, key, receiver) { return key === 'session' ? session : Reflect.get(target, key, receiver) } })",
            "  const cleanup = await plugin.setup(observed)",
            "  const defaults = await ctx.agent.transform((editor) => editor.default('hephaestus'))",
            "  return async () => { await defaults.dispose(); await cleanup?.() }",
            "} }",
          ].join("\n"))
        },
      })
      if (host.info.capabilities?.sessionSelection !== true) return { status: "skip", detail: "Installed engine does not advertise sessionSelection; omitted defaults remain an explicit native API gap" }
      const api = async (path: string, body?: unknown) => {
        const response = await host.request(path, body === undefined ? {} : { method: "POST", body })
        assert.ok(response.status === 200 || response.status === 204, `${path}: status ${response.status}`)
        return response.body
      }
      const cases = [
        { name: "omitted-agent-model", choices: {}, variant: "high" },
        { name: "omitted-model", choices: { agent: "hephaestus" }, variant: "high" },
        { name: "omitted-agent", choices: { model: { providerID: "fake", id: "gpt-6.1-sol", variant: "low" } }, variant: "low" },
      ] as const
      await api("/api/model")
      const results = []
      for (const row of cases) {
        const id = created.parse(await api("/api/session", { title: row.name, ...row.choices })).data.id
        await api(`/api/session/${id}/prompt`, { text: `Reply with the selection fixture answer for ${row.name}.` })
        await api(`/api/experimental/session/${id}/wait`, {})
        const messages = await api(`/api/session/${id}/message`)
        writeFileSync(join(host.sandbox.root, `${row.name}-messages.json`), JSON.stringify(messages, null, 2))
        const observed = readFileSync(join(host.sandbox.root, "selection.jsonl"), "utf8").trim().split("\n").map((line) => receipt.parse(JSON.parse(line))).filter((entry) => entry.sessionID === id)
        assert.equal(observed.length, 1, "The actual bridge did not resolve this prompt through the native getter exactly once")
        const effective = observed[0]?.selected
        const expected = { agent: "hephaestus", model: { providerID: "fake", id: "gpt-6.1-sol", variant: row.variant } }
        assert.deepEqual(effective, expected)
        const actual = transcript.parse(messages).data.findLast((entry) => entry.type === "assistant")
        assert.ok(actual, "The native assistant message was not persisted")
        assert.equal(actual.agent, expected.agent)
        assert.deepEqual(actual.model, expected.model)
        assert.ok(assistantText(messages).includes(answer), "The omitted-selection turn never completed")
        results.push({ case: row.name, sessionID: id, effective, actual: { agent: actual.agent, model: actual.model } })
      }
      const requests = host.provider.requests.filter((request) => request.tools?.length)
      assert.equal(requests.length, cases.length)
      assert.deepEqual(requests.map((request) => ({ model: request.model, variant: request.reasoning_effort })), cases.map((row) => ({ model: "gpt-6.1-sol", variant: row.variant })))
      writeFileSync(join(host.sandbox.root, "selection-receipt.json"), JSON.stringify({ results, requests, engine: host.info,
        bundleSha256: createHash("sha256").update(readFileSync(context.pluginBundle)).digest("hex"),
      }, null, 2))
      return { status: "pass", detail: "Three actual omitted/partial-selection turns matched native getter, assistant identity and provider variant" }
    },
  }
}
